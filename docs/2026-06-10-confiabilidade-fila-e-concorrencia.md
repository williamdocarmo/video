# 2026-06-10 — Confiabilidade da fila e concorrência na lane heavy

Registro da rodada de correções e do aumento de vazão aplicados durante o lote de 60 vídeos de 2026-06-09.

## Sintoma

Durante o lote, ~40 jobs `generate` falharam em cascata sem erro real de pipeline:

- jobs morriam ~3 min após iniciar, ainda na fase de storyboard, com `[worker-sync] job alterado externamente; encerrando processo local.` no `logTail` e `exitCode 1`;
- minutos depois o mesmo job era resolvido de novo pelo orphan detector (`Orphan detector: job sem processo vivo ha 8min.`);
- jobs longos e silenciosos (render, auditoria de imagem) eram marcados órfãos com 60–95 min de heartbeat parado;
- restarts do serviço derrubavam dezenas de registros `running` fantasmas de uma vez (`Worker reiniciado antes da conclusao deste job.`).

## Causa raiz

Uma corrida entre três mecanismos que compartilham `.web-ui/jobs.json`:

1. **Re-ingestão da própria escrita.** `persistJobs`/`persistJobsSync` não atualizavam `jobsFileMtimeMs` após gravar. O loop de disk-sync via o mtime novo e relia o arquivo que o próprio processo acabara de escrever, re-hidratando snapshots defasados (status terminal de tentativa anterior, `processId` nulo).
2. **Adoção cega de status terminal do disco.** Quando o registro em disco estava terminal e o job local rodava, o sync adotava o terminal e o worker-sync **matava o processo recém-iniciado** — mesmo o terminal sendo sobra da tentativa anterior.
3. **Heartbeat só em output.** O heartbeat só era atualizado quando o processo filho emitia log. Em fases silenciosas longas o orphan detector (limiar de 8 min) marcava o job como falho; a resolução era gravada em disco, realimentando o ciclo do item 2.

## Correções (`web/server.mjs`, `web/lib/job-execution.mjs`)

- `persistJobs`/`persistJobsSync` atualizam `jobsFileMtimeMs` após o rename — o disk-sync só processa escritas **externas**.
- Status terminal vindo do disco só é adotado (e o processo só é morto) se o timestamp terminal for **mais novo** que `processStartedAt` da tentativa atual. Cancelamentos externos legítimos continuam funcionando; sobras de tentativas anteriores não matam mais processos vivos.
- O orphan detector agora:
  - dá **keepalive de heartbeat** a cada ciclo (30s) para jobs cujo processo filho está vivo, e restaura `processId` clobberado (novo helper `getJobProcessPid` em `job-execution.mjs`);
  - usa `max(heartbeatAt, updatedAt, startedAt, processStartedAt, stageUpdatedAt)` como referência de frescor;
  - ao resolver um órfão, **libera o slot da lane** e dá kick no worker (antes dependia da re-ingestão do jobs.json para reconstruir o estado da fila).

Hangs genuínos continuam cobertos pelos timeouts do processo (idle 25 min / total 3h para `generate`).

## Concorrência na lane heavy

`web/lib/job-queue.mjs` deixou de ser single-slot fixo:

- a lane heavy passa a ter um conjunto de jobs ativos com capacidade `HEAVY_LANE_CONCURRENCY` (env, default **1** — comportamento idêntico ao histórico);
- `startQueueWorker` sobe até N runner-loops; cada runner reivindica o job de forma síncrona (shift + addActive) antes de ceder o event loop, então não há dupla execução;
- a lane preview segue com 1 slot;
- API: `getActiveJobIds()` ganhou `activeHeavyJobIds[]` (campos legados mantidos).

### Configuração em produção

Drop-in `/etc/systemd/system/codex-video-ui.service.d/throughput.conf`:

```ini
[Service]
Environment=HEAVY_LANE_CONCURRENCY=2
```

`REMOTION_CONCURRENCY` permanece **1** enquanto a VM tiver 13–16 GB: o pipeline é majoritariamente limitado por APIs remotas (storyboard LLM, geração de imagem, TTS), então dois jobs em paralelo quase dobram a vazão sem dobrar o pico de memória. Renders ocasionalmente coincidem — o cgroup tem `MemoryHigh=10G`/`MemoryMax=14G` como proteção.

### Limites de infra (não esquecer)

- A VM (Proxmox VM 102, host `192.168.1.100`) está com 16 GB e **o host está overcommitted** (62 GB, swap cheio). **Não** aumentar a RAM da VM sem antes liberar memória no host.
- Se o swap do guest crescer de forma sustentada ou houver OOM-kill: voltar `HEAVY_LANE_CONCURRENCY=1` no drop-in e reiniciar entre jobs.
- Com mais RAM no futuro: subir `REMOTION_CONCURRENCY` para 2–3 antes de pensar em lane 3.

## Requeue de jobs falhados

Helper `.tmp/requeue-failed-batch.mjs` (fora do versionamento): re-enfileira via `POST /api/generate` os jobs `generate` falhados de um lote, com:

- dedupe por slug-base (tentativas ganham sufixo `-2`/`-3`);
- dedupe por **título** contra jobs `queued/running/completed` de qualquer data (evita duplicar quando o requeue anterior criou slug com outra data);
- skip de slugs já exportados em `/root/postar/{channel}/`.

Uso: `node .tmp/requeue-failed-batch.mjs --dry-run` antes de rodar de verdade.

## Observabilidade

Sinais de recaída para vigiar no `journalctl -u codex-video-ui.service`:

- `worker-sync` matando job recém-iniciado (não deve mais acontecer sem cancelamento externo real);
- `orphan_job_resolved` com `heartbeatAge` < 10 min (indica heartbeat keepalive falhando);
- `job_process_failed` com `exitCode 1` aos ~3 min de execução em série.
