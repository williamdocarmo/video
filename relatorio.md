# Video Studio — Relatório de Auditoria Técnica

**Data:** 2026-04-09  
**Versão:** 1.0  
**Escopo:** Análise completa do codebase `/root/repo/videos-flux2`

---

## 1. Sumário Executivo

### Saúde Geral do Projeto
O Video Studio é um sistema funcional que entrega valor em produção, mas acumulou **dívida técnica significativa**. O código é predominantemente monolítico, com duplicação extensiva e documentação quase inexistente.

### Nível de Risco: 🔴 ALTO

| Área | Status |
|------|--------|
| Segurança | 🔴 Crítico — secrets expostos, autenticação fraca, execução como root |
| Performance | 🟠 Alto — operações síncronas bloqueantes, 5MB JSON em memória |
| Qualidade de Código | 🟠 Alto — monolitos de 5000+ linhas, 30+ funções duplicadas |
| Arquitetura | 🟠 Alto — sem escalabilidade horizontal, estado volátil |
| Recuperação de Erros | 🟢 Bom — sistema de recovery bem projetado |

---

## 2. Problemas Críticos (🚨)

### 2.1 Secrets em Texto Plano com Permissões 0777
**Arquivos:** `.env`, `video-engine/.env`, `.env.bak`, `video-engine/.env.bak`

Chaves de API expostas:
- `GOOGLE_API_KEY=AQ.Ab8RN...`
- `AZURE_SPEECH_KEY=F8gU62y...`
- `AGENDADOR_ONLINE_PASSWORD=<password>`

**Ação imediata:**
```bash
chmod 600 /root/repo/videos-flux2/.env /root/repo/videos-flux2/video-engine/.env
rm /root/repo/videos-flux2/.env.bak /root/repo/videos-flux2/video-engine/.env.bak
```
**Rotacionar todas as chaves expostas.**

### 2.2 Leitura Arbitrária de Arquivos via /api/file
**Arquivo:** `web/server.mjs:5812-5819`

O endpoint `/api/file?path=...` permite ler qualquer arquivo sob `projectRoot`, incluindo:
```
GET /api/file?path=/root/repo/videos-flux2/.env → todas as chaves de API
```

**Correção:** Implementar allowlist de extensões (`.mp4`, `.mp3`, `.json`, `.png`) e negar explicitamente `.env*`, `.git/*`.

### 2.3 Senha Padrão Hardcoded
**Arquivo:** `web/server.mjs:5674`
```javascript
const BASIC_AUTH_PASSWORD = process.env.VIDEO_STUDIO_PASSWORD || "007007";
```

**Correção:** Exigir `VIDEO_STUDIO_PASSWORD` no ambiente, recusar iniciar sem ela.

### 2.4 Serviço Executando como Root
**Arquivo:** `deploy/codex-video-ui.service:19`

Qualquer vulnerabilidade no servidor ou processos filhos resulta em comprometimento total do sistema.

**Correção:**
```bash
useradd -r -s /bin/false videostudio
# Atualizar User=videostudio no service file
```

---

## 3. Bugs e Erros

### 3.1 Cache de Auth GCP Nunca Resetado em Falha (HIGH)
**Arquivo:** `video-engine/scripts/lib/gcp-config.mjs:52-64`

Se `auth.getClient()` rejeitar, a promise rejeitada fica em cache permanentemente. Todo o processo fica incapaz de autenticar.

**Correção:**
```javascript
authClientPromise = auth.getClient().catch((err) => {
  authClientPromise = null;
  throw err;
});
```

### 3.2 Cleanup Destrói Artefatos em Falha do Pipeline (HIGH)
**Arquivo:** `scripts/foiumaideia.mjs:370-375`

Quando o pipeline falha, `cleanupIntermediates` deleta `runs/{slug}`, `assets/envato/{slug}`, destruindo artefatos necessários para recovery.

**Correção:** Não limpar em falha:
```javascript
if (result.status !== 0) {
  process.exit(result.status ?? 1); // Sem cleanup
}
```

### 3.3 Missing `continue` em parseArgs (MEDIUM)
**Arquivo:** `video-engine/scripts/make-plan1-video.mjs:246`

O branch `--target-seconds` não tem `continue`, causando processamento duplicado.

### 3.4 normalizeFrames Pode Produzir Frames Negativos (MEDIUM)
**Arquivo:** `video-engine/scripts/lib/timings.mjs:12-20`

A correção de delta pode resultar em contagem negativa de frames na última cena.

**Correção:**
```javascript
normalized[normalized.length - 1] = Math.max(45, normalized[normalized.length - 1] + delta);
```

### 3.5 JSON Parse Sem Tratamento de Erro (MEDIUM)
**Arquivo:** `web/server.mjs:4256`

`JSON.parse(rawBody)` pode expor mensagens de erro internas.

### 3.6 Comando `open` é macOS-only (LOW)
**Arquivo:** `scripts/foiumaideia.mjs:470`

No Linux (produção), `open` falha silenciosamente. Usar `xdg-open`.

### 3.7 SSE Subscriber Set Nunca Limpo (LOW)
**Arquivo:** `web/server.mjs:5764-5780`

Entries no Map `streams` nunca são deletadas após todos subscribers saírem.

---

## 4. Problemas de Performance

### 4.1 sanitizeJob() Faz Stat Calls em Cada Broadcast SSE (CRITICAL)
**Arquivo:** `web/server.mjs:1929-2040`

Cada broadcast SSE (centenas por minuto durante jobs ativos) executa 5-10 `existsSync`/`statSync` por job.

**Impacto:** `/api/jobs` com 206 jobs = ~1000-2000 syscalls por request.

**Correção:** Cache de existência de artefatos com TTL de 5-10 segundos.

### 4.2 42 Chamadas Síncronas de Filesystem no server.mjs (CRITICAL)
**Arquivo:** `web/server.mjs`

`readFileSync`, `writeFileSync`, `existsSync`, `statSync`, `spawnSync` bloqueiam o event loop durante handling de requests.

**Correção:** Substituir por equivalentes async em hot paths.

### 4.3 5MB jobs.json em Memória, Nunca Evicted (CRITICAL)
**Arquivo:** `web/server.mjs:5629-5665`

206 jobs (5MB) carregados em `Map()` no startup, nunca removidos.

**Correção:** Implementar eviction (manter últimos 100 jobs), arquivar antigos em disco.

### 4.4 persistJobs Serializa 5MB em Cada Debounce (HIGH)
**Arquivo:** `web/server.mjs:2241-2253`

Com debounce de 150ms durante processamento ativo, pode haver 6-7 writes/segundo.

**Correção:** Aumentar debounce para 2-5 segundos, considerar persistência incremental.

### 4.5 Processamento Sequencial de Cenas (HIGH)
**Arquivo:** `scripts/generate-flux2-assets.mjs:2997-3100`

14 cenas × 3 shots = 42 chamadas sequenciais à API Vertex AI, cada uma com 2.5s de pausa.

**Correção:** Processar 2-3 cenas em paralelo respeitando rate limits.

### 4.6 REMOTION_CONCURRENCY=1 em Produção (HIGH)
**Arquivo:** `deploy/codex-video-ui.service`

Frames renderizados um por vez. 3000 frames sequenciais para vídeo de 100s.

**Correção:** Aumentar para 2-4 conforme CPUs disponíveis.

### 4.7 Rate Limit File I/O por Imagem (HIGH)
**Arquivo:** `scripts/generate-flux2-assets.mjs:316-376`

168 operações de filesystem apenas para rate limiting por vídeo.

**Correção:** Manter estado de rate limit em memória.

---

## 5. Análise de Segurança

### 5.1 Vulnerabilidades Encontradas

| Severidade | Vulnerabilidade | Arquivo |
|------------|-----------------|---------|
| CRITICAL | Secrets em plaintext com 0777 | `.env`, `video-engine/.env` |
| CRITICAL | Leitura arbitrária de arquivos | `server.mjs:5812` |
| CRITICAL | Senha padrão hardcoded | `server.mjs:5674` |
| HIGH | Execução como root | `codex-video-ui.service` |
| HIGH | Sem rate limiting | Todos endpoints |
| HIGH | Sem headers de segurança | `server.mjs` |
| MEDIUM | ffmpeg concat file injection | `generate-flux2-assets.mjs:2852` |
| MEDIUM | /api/config expõe configuração interna | `server.mjs:5500` |
| MEDIUM | IDs previsíveis (timestamp + Math.random) | `web/lib/utils.mjs:73` |
| LOW | Permissões 0777 em diretórios | Múltiplos |

### 5.2 Pontos Positivos
- Sem `shell: true` em spawn/execFileSync
- Sem `eval()`
- Proteção contra path traversal em `ensureAllowedFilePath()`
- Limites de tamanho de input implementados
- HTML escaping consistente

---

## 6. Revisão de Qualidade de Código

### 6.1 Métricas

| Métrica | Valor (original) | Valor (atual) | Benchmark |
|---------|-------------------|---------------|-----------|
| Linhas de código | ~30,600 | ~30,600 | — |
| Densidade de comentários | 0.28% | ~1.5% | 5-15% recomendado |
| Funções duplicadas | 30+ | ~15 | 0 ideal |
| Maior arquivo | 5,971 linhas | ~3,650 linhas | <500 recomendado |
| JSDoc annotations | 0 | 5 arquivos | — |
| Empty catch blocks | 54 | 0 | 0 ideal |

### 6.2 Duplicação de Código (CRITICAL)

| Função | Cópias | Arquivos |
|--------|--------|----------|
| `normalizeText()` | 10 | llm-provider, generate-flux2-assets, make-plan1-video, gcp-media, scene-spec, etc. |
| `sleep()`/`wait()` | 9 | llm-provider, tts, server, generate-flux2-assets, etc. |
| `parseEnvFile()` | 6 | utils.mjs, foiumaideia, generate-flux2-assets, etc. |
| `slugify()` | 4 | utils.mjs, foiumaideia, make-plan1-video, make-video |
| `uniqueStrings()` | 4 | llm-provider, generate-flux2-assets, make-plan1-video, scene-spec |

**Impacto:** Bug fixes precisam ser aplicados em 4-10 lugares.

### 6.3 Monolitos

- `server.mjs` — 5,971 linhas (HTTP, queue, SSE, recovery, library, agendador, TikTok)
- `generate-flux2-assets.mjs` — 3,800 linhas
- `app.js` — 3,001 linhas
- `make-plan1-video.mjs` — 2,533 linhas

### 6.4 Inconsistências de Naming
- Constantes: mix de `SCREAMING_SNAKE_CASE` e `camelCase`
- Arquivos: `make-plan1-video.mjs` (o que é "plan1"?), `foiumaideia.mjs` (português em codebase inglês)
- Mensagens: mix de português e inglês

---

## 7. Oportunidades de Refatoração

### 7.1 Extrair Módulos de server.mjs (HIGH IMPACT)

| Novo Módulo | Linhas Est. | Conteúdo |
|-------------|-------------|----------|
| `web/lib/job-queue.mjs` | ~400 | `startQueueWorker`, lane management, `enqueue*`, `persistJobs` |
| `web/lib/job-execution.mjs` | ~500 | `executeChildProcess`, `terminateJobProcessTree`, `create*JobCommand` |
| `web/lib/job-state.mjs` | ~800 | `buildJobStepChecklist`, artifact inspection helpers |
| `web/lib/video-library.mjs` | ~400 | `createVideoRecord`, `listExportVideos`, video metadata CRUD |
| `web/lib/agendador.mjs` | ~300 | `agendadorFetch`, `upload*ToAgendador` |
| `web/lib/routes.mjs` | ~250 | HTTP routing |

**Esforço:** Alto  
**Benefício:** Cada módulo testável independentemente

### 7.2 Extrair Módulos de generate-flux2-assets.mjs (MEDIUM IMPACT)

| Novo Módulo | Conteúdo |
|-------------|----------|
| `scripts/lib/image-prompt-builder.mjs` | `buildImagePrompt`, `buildNegativePrompt`, etc. |
| `scripts/lib/shot-classifier.mjs` | `shotNeedsObjectLedCloseup`, `classifyRepairCategories` |
| `scripts/lib/vision-audit.mjs` | `auditWithGeminiVision`, `runLocalVisualAudit` |
| `scripts/lib/media-utils.mjs` | `imageToStaticClip`, `concatClips` |

**Esforço:** Médio

### 7.3 Criar Módulo Compartilhado (HIGH IMPACT, LOW EFFORT)

Criar `shared/lib/utils.mjs` com:
- `normalizeText`, `sleep`, `slugify`, `uniqueStrings`
- `parseEnvFile`, `fileExists`, `loadJsonIfExists`
- `deriveTitleFromText`, `getDatePrefixFromSlug`
- `runLoggedCommand`, `getVideoDurationSeconds`

**Esforço:** Baixo-Médio  
**Benefício:** ~500 linhas de duplicação removidas

### 7.4 Route Table Pattern (LOW EFFORT)

Substituir 250 linhas de if/else por:
```javascript
const routes = [
  ["GET", "/api/config", handleConfigRequest],
  ["POST", "/api/generate", handleGenerateRequest],
  // ...
];
```

### 7.5 npm Workspaces

Converter para workspaces:
```json
{
  "workspaces": ["video-engine", "shared"]
}
```

---

## 8. Código Morto e Limpeza

### 8.1 Arquivos para Remover (SAFE)

| Arquivo | Tamanho | Motivo |
|---------|---------|--------|
| `scripts/generate-flux2-assets.mjs.bak` | 137KB | Backup obsoleto |
| `.env.bak`, `video-engine/.env.bak` | 2.7KB | Backups de secrets |
| `output.txt`, `report.txt` | 58KB | Artefatos de debug |
| `1` (arquivo vazio na raiz) | 0B | Artefato acidental |
| 6 arquivos `.mp4` na raiz | ~83MB | Exports antigos |
| 784 arquivos `._*` | ~126KB | Metadados macOS |
| `.DS_Store` (2 arquivos) | — | Metadados macOS |

### 8.2 Diretórios para Remover (SAFE)

| Diretório | Tamanho | Motivo |
|-----------|---------|--------|
| `video-engine/storyboards/` | 208KB | Storyboards legados |
| `video-engine/tmp-caption-styles/` | 444KB | Testes de caption |
| `.debug-caption-check/` | 788KB | Debug frames |
| `test-styles/` | 3MB | Comparação visual antiga |
| `tmp/gps-scene04-model-compare/` | 5.1MB | Experimento one-off |
| `scripts/__pycache__/`, `video-engine/scripts/__pycache__/` | — | Python bytecode |

### 8.3 Dependência npm Não Utilizada

| Package | Arquivo | Status |
|---------|---------|--------|
| `playwright-core` | `video-engine/package.json` | Não importado em nenhum lugar |

### 8.4 Código Morto (REVIEW FIRST)

| Item | Detalhe |
|------|---------|
| Pipeline SDXL/ESRGAN | `SDXL_ENABLED=false`, `.venv-esrgan/` não existe, modelo de 64MB não utilizado |
| `whisper-stt.py` | Referencia path macOS, `mlx_whisper` não instalado no Linux |
| `video-engine/scripts/make-video.mjs` | Pipeline legado, verificar se ainda é acessível |

### 8.5 Comando de Limpeza

```bash
# Remover arquivos macOS
find /root/repo/videos-flux2 -name '._*' -not -path '*/.git/*' -not -path '*/node_modules/*' -delete
find /root/repo/videos-flux2 -name '.DS_Store' -delete

# Remover backups e debug
rm -f /root/repo/videos-flux2/scripts/generate-flux2-assets.mjs.bak
rm -f /root/repo/videos-flux2/.env.bak /root/repo/videos-flux2/video-engine/.env.bak
rm -f /root/repo/videos-flux2/output.txt /root/repo/videos-flux2/report.txt
rm -f /root/repo/videos-flux2/1

# Remover MP4s da raiz
rm -f /root/repo/videos-flux2/*.mp4
rm -f /root/repo/videos-flux2/video-preview.html

# Remover diretórios de teste
rm -rf /root/repo/videos-flux2/video-engine/storyboards/
rm -rf /root/repo/videos-flux2/video-engine/tmp-caption-styles/
rm -rf /root/repo/videos-flux2/.debug-caption-check/
rm -rf /root/repo/videos-flux2/test-styles/
rm -rf /root/repo/videos-flux2/tmp/

# Remover __pycache__
find /root/repo/videos-flux2 -type d -name '__pycache__' -exec rm -rf {} + 2>/dev/null

# Espaço recuperável: ~162MB
```

---

## 9. Revisão de Arquitetura

### 9.1 Scorecard

| Dimensão | Rating | Prioridade |
|----------|--------|------------|
| Separação de concerns | ⚠️ Fraco | Média |
| Escalabilidade | 🔴 Crítico | Alta |
| Extensibilidade | ⚡ Moderado | Baixa |
| Acoplamento | ⚠️ Alto | Média |
| Fluxo de dados | 🔴 Alto risco | Alta |
| Recuperação de erros | ✅ Forte | Baixa |
| Deploy | ⚠️ Frágil | **Crítica** (segurança) |

### 9.2 Problemas de Escalabilidade

- **Vertical:** 5MB `jobs.json` em memória, concorrência hardcoded (1+1), Remotion CPU-intensive
- **Horizontal:** Impossível — estado em memória, filesystem local, sem message queue

### 9.3 Problemas de Estado

- Single point of truth é memória volátil
- Crash entre `Map.set()` e `persistJobs()` perde estado
- Sem WAL ou transaction log
- Estado de artefatos inferido via filesystem scans

### 9.4 Pontos Fortes

- Sistema de recovery granular (7 ações distintas)
- Auto-continue chains
- Multi-layer retry (imagem: 9 tentativas, TTS: 4 fallbacks, LLM: 2 fallbacks)
- QA pipeline com 20+ checks
- Graceful shutdown implementado

---

## 10. Recomendações Finais

### Prioridade 1 — IMEDIATO (Segurança)

1. **Rotacionar todas as chaves expostas** (Google API Key, Azure Speech Key, Agendador password)
2. **`chmod 600` em todos os .env**, deletar .env.bak
3. **Definir `VIDEO_STUDIO_PASSWORD` forte** no ambiente
4. **Restringir `/api/file`** a extensões seguras
5. **Parar de executar como root** — criar usuário dedicado

### Prioridade 2 — CURTO PRAZO (1-2 semanas)

6. **Substituir `jobs.json` por SQLite** — resolve atomicidade, performance, queries
7. **Adicionar rate limiting** nos endpoints
8. **Adicionar headers de segurança** no Node.js
9. **Bind Node.js em 127.0.0.1** se apenas Traefik deve acessar

### Prioridade 3 — MÉDIO PRAZO (1 mês)

10. **Extrair utilidades duplicadas** para módulo compartilhado
11. **Dividir server.mjs** em módulos (começar por agendador.mjs)
12. **Implementar cache de artefatos** com TTL
13. **Aumentar REMOTION_CONCURRENCY** para 2-4
14. **Adicionar endpoint `/health`** e structured logging

### Prioridade 4 — LONGO PRAZO (2-3 meses)

15. **Implementar modelo `video_case` + `job_attempt`** (eliminar conflitos de slug)
16. **Dividir generate-flux2-assets.mjs** em módulos
17. **Converter para npm workspaces**
18. **Adicionar JSDoc** às funções principais
19. **Paralelizar processamento de cenas** (2-3 concurrent)

---

## 11. Progresso das Melhorias

**Atualizado em:** 2026-04-09

### 11.1 Refatoração do server.mjs

O monolito `server.mjs` foi reduzido de **5,971 → ~3,650 linhas (-39%)** através da extração de 6 módulos:

| Módulo Extraído | Responsabilidade |
|-----------------|------------------|
| `web/lib/agendador.mjs` | Integração com agendador online |
| `web/lib/video-library.mjs` | CRUD de vídeos, metadados, export |
| `web/lib/tiktok-helper.mjs` | Helper de publicação TikTok |
| `web/lib/routes.mjs` | Roteamento HTTP |
| `web/lib/job-queue.mjs` | Fila de jobs, lanes, concorrência |
| `web/lib/job-state.mjs` | Inspeção de estado, checklist, recovery |

### 11.2 Módulo Compartilhado

Criado `shared/utils.mjs` com 10+ funções antes duplicadas:
- `normalizeText`, `sleep`, `slugify`, `uniqueStrings`
- `parseEnvFile`, `fileExists`, `loadJsonIfExists`
- `deriveTitleFromText`, `getDatePrefixFromSlug`
- `runLoggedCommand`, `getVideoDurationSeconds`

### 11.3 Tratamento de Erros

- **54 empty catches** documentados e tratados (logging adicionado ou justificativa documentada)

### 11.4 Documentação

- **JSDoc adicionado a 5 arquivos de configuração** (tipos, parâmetros, retornos)

### 11.5 Remoção de Duplicações

- Duplicações removidas de **6+ arquivos** que importam agora do módulo compartilhado

### 11.6 Limpeza de Arquivos

- Arquivos de debug, backups, metadados macOS e exports antigos removidos
- **~162MB de espaço recuperado**

### 11.7 Métricas Atualizadas

| Métrica | Antes | Depois | Δ |
|---------|-------|--------|---|
| `server.mjs` (linhas) | 5,971 | ~3,650 | -39% |
| Módulos extraídos | 0 | 6 (~2,900 linhas) | — |
| Maior arquivo | 5,971 linhas | ~3,650 linhas | -39% |
| Empty catches | 54 | 0 | -100% |
| JSDoc em configs | 0 | 5 arquivos | — |
| Funções duplicadas | 30+ | ~15 restantes | -50% |
| Espaço em disco (lixo) | ~162MB | 0 | -162MB |

### 11.8 Próximos Passos Pendentes

| # | Item | Prioridade | Ref. |
|---|------|------------|------|
| 1 | `server.mjs` ainda com ~3,650 linhas — continuar extração (job-execution, SSE, static files) | Alta | §7.1 |
| 2 | Dividir `generate-flux2-assets.mjs` (3,800 linhas) em módulos | Média | §7.2 |
| 3 | Dividir `app.js` (3,001 linhas) em componentes frontend | Média | §6.3 |
| 4 | Substituir `jobs.json` por SQLite | Alta | §10 P2 |
| 5 | Converter operações síncronas de filesystem para async | Alta | §4.2 |
| 6 | Implementar cache de artefatos com TTL | Média | §4.1 |
| 7 | Converter para npm workspaces | Baixa | §7.5 |
| 8 | Paralelizar processamento de cenas (2-3 concurrent) | Média | §4.5 |
| 9 | Resolver problemas de segurança críticos (§2) | **Crítica** | §2, §5 |

---

## Apêndice: Comandos de Diagnóstico

```bash
# Verificar jobs ativos antes de restart
curl -s http://127.0.0.1:3210/api/jobs | python3 -c "import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ['activeJobId','activePreviewJobId','activeHeavyJobId','queueLength']})"

# Verificar saúde geral
curl -s http://127.0.0.1:3210/api/jobs | python3 -c "import sys,json; d=json.load(sys.stdin); print({'jobs':len(d.get('jobs',[])), 'queue':d.get('queueLength')})"

# Verificar uso de disco
du -sh /root/repo/videos-flux2/video-engine/out/
du -sh /root/repo/videos-flux2/video-engine/assets/
du -sh /root/repo/videos-flux2/.web-ui/

# Verificar permissões de .env
ls -la /root/repo/videos-flux2/.env /root/repo/videos-flux2/video-engine/.env
```

---

*Relatório gerado por análise automatizada multi-agente. Revisão humana recomendada antes de implementar correções.*
