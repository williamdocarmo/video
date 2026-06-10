# Changelog — Video Studio

---

## [2026-06-10] Correção da corrida orphan-detector ↔ worker-sync e concorrência na lane heavy

### Resumo
Eliminada a cascata de falhas em que o servidor re-ingeria as próprias escritas de `jobs.json`, ressuscitava registros terminais defasados e matava processos recém-iniciados. A lane heavy ganhou concorrência configurável (`HEAVY_LANE_CONCURRENCY`, default 1; produção em 2) para quase dobrar a vazão de lotes, já que o pipeline é majoritariamente limitado por APIs remotas. Detalhes em `docs/2026-06-10-confiabilidade-fila-e-concorrencia.md`.

### O que foi implementado

**Confiabilidade da fila**
- `persistJobs`/`persistJobsSync` atualizam `jobsFileMtimeMs` (disk-sync só processa escritas externas)
- status terminal do disco só é adotado/mata processo se for mais novo que `processStartedAt`
- orphan detector com keepalive de heartbeat (30s) para processos vivos, restauração de `processId` clobberado (`getJobProcessPid`) e liberação explícita do slot da lane ao resolver órfãos
- frescor do heartbeat calculado por `max(heartbeatAt, updatedAt, startedAt, processStartedAt, stageUpdatedAt)`

**Concorrência**
- lane heavy com N slots via `HEAVY_LANE_CONCURRENCY` (runner-loops com claim síncrono; preview segue 1 slot)
- `getActiveJobIds()` expõe `activeHeavyJobIds[]` (campos legados preservados)
- drop-in systemd `throughput.conf` com `HEAVY_LANE_CONCURRENCY=2`; `REMOTION_CONCURRENCY` mantido em 1 enquanto a VM tiver ≤16 GB

---

## [2026-04-22] Dual-channel mirror mode, timeout hardening, storyboard-first UI, publish copy split

### Resumo
Rodada de estabilização e alinhamento do fluxo real do produto: geração espelhada para `@ate2min + @quiet2min` com os mesmos assets, timeout por tipo de job e por inatividade, suporte real a storyboards com múltiplas imagens por cena, aba `Template`, limpeza da UI para o fluxo baseado em JSON pronto, e separação entre `title`, `publishTitle`, `caption` e `socialCaption` para publicação cross-platform.

### O que foi implementado

**Dual-channel**
- nova opção de geração dupla para `@ate2min + @quiet2min`
- storyboard-base em `pt-BR`
- tradução apenas do texto visível ao usuário para `en-US`
- job espelho em inglês reutiliza os assets via `reuseAssetsFromSlug`
- dependência explícita entre o job primário e o job espelho

**Fila e runtime**
- timeout por tipo de job (`generate`, `render-only`, `scene-regenerate`, `audio-prep`, `validate-only`)
- timeout por inatividade
- terminação da árvore inteira de processos em job travado
- mensagens de timeout/restart mais explícitas no estado do job

**Storyboard e assets**
- suporte real a `scene.shots[]` com múltiplas imagens por cena
- preservação da `duration` por shot
- `mustShow` com inferência/fallback robusto quando não vier explícito no shot
- template operacional consolidado em torno de `10–12` cenas, `28–32` imagens e `~54s–70s`

**UI**
- remoção do peso das opções antigas de idioma/estilo/tom como knobs primários
- aba `Template` com regras, prompt para Codex/Claude e JSON-base
- copy da tela ajustado para deixar claro quando o storyboard JSON pula a etapa de preview
- biblioteca com campos separados para título interno, título de publicação e legenda curta

**Publicação**
- `title`: uso interno na biblioteca
- `publishTitle`: título curto para YouTube/publicação
- `caption`: descrição base longa
- `socialCaption`: copy curta segura para cross-post/helper
- limites aplicados:
  - `publishTitle`: `100`
  - `caption`: `5000`
  - `socialCaption`: `2200`
- `agendador.online` passa a tentar enviar `title` separado
- TikTok helper passa a usar `publishTitle` + `socialCaption`

**Documentação**
- atualização de `README.md`, `PRODUCTION-RUNBOOK.md`, `docs/api-reference.md`, `docs/openapi.yaml`, `docs/operations-reference.md`
- novo consolidado em `docs/2026-04-22-dual-channel-publish-update.md`
- `top.md` revisto para o mapa de leitura atual

---

## [2026-04-22] Runtime split, OpenAPI served by runtime, structured logs

### Resumo
Separação operacional do runtime em `all` / `api` / `worker`, novos entrypoints para API e worker, sincronização de jobs por snapshot em disco, health endpoint com role/auth source, OpenAPI e docs markdown servidos pelo próprio runtime, logging estruturado JSON para requests/jobs, e remoção do fallback hardcoded `007007` em favor de password explícita por env ou password forte gerada em `.web-ui/runtime-auth.json`.

### O que foi implementado

**Runtime split**
- `web/api-server.mjs` para modo `api`
- `web/worker-engine.mjs` para modo `worker`
- `web/server.mjs` continua a suportar o modo histórico `all`
- `VIDEO_STUDIO_ROLE=all|api|worker`
- `WEB_DATA_DIR` para isolar estado local por ambiente/teste

**Estado compartilhado**
- `jobs.json` continua a ser o snapshot partilhado entre processos
- merge por frescura (`updatedAt`/heartbeat) na persistência
- sincronização periódica de jobs a partir do snapshot em disco

**Observability**
- logs JSON para requests HTTP, startup, shutdown e eventos de job
- `GET /api/health` agora expõe também `role` e `auth.source`
- `GET /api/openapi.yaml`
- `GET /api/docs/:name`

**Auth**
- removido o fallback hardcoded `007007`
- prioridade: `VIDEO_STUDIO_PASSWORD`
- fallback seguro: password gerada e persistida em `.web-ui/runtime-auth.json`

**Deploy**
- novos unit files:
  - `deploy/codex-video-api.service`
  - `deploy/codex-video-worker.service`
- `deploy/codex-video-ui.service` mantém compatibilidade com modo unificado

---

## [2026-04-22] Storyboard upload, Gemini 3.x models, TTS migration, UX polish, hardening

### Resumo
Storyboard externo via UI (colar JSON ou carregar ficheiro), integração dos modelos Gemini 3.1 Flash Image e Pro Image como default de geração visual, migração do TTS de Gemini 2.5 para 3.1 Flash TTS, remoção do overlay de texto na thumbnail e do intro text no vídeo, redução do volume da música de fundo para 0.8%, fallback automático para tentativas rejeitadas de imagem, timeouts por lane na fila de jobs, bloqueio de ficheiros sensíveis no `/api/file`, paginação de jobs, toast notifications, limpeza de `.tmp` no startup, e vários ajustes de QA.

### O que foi implementado

**Storyboard externo via UI**
- Campo textarea + botão de upload de ficheiro `.json` na tab "Criar"
- Validação inline: parse de JSON, verificação de `scenes[]`, contagem de cenas com feedback visual
- Se fornecido, o pipeline salta a geração de storyboard pelo Gemini e vai direto para assets + render
- Se o storyboard externo incluir visual prompts por cena, o pipeline bypassa o preset visual selecionado
- `sceneCountOk` na QA relaxado para storyboards externos (aceita ≥1 cena em vez do mínimo do perfil)

**Modelos de imagem Gemini 3.x**
- `gemini-3.1-flash-image-preview` como modelo padrão (`DEFAULT_IMAGE_MODEL` em `presets.mjs`)
- `gemini-3-pro-image-preview` adicionado como opção no dropdown de modelos
- Modelos anteriores (Imagen 4.0 Fast/Full/Ultra, Gemini 2.5 Flash Image) continuam disponíveis
- Endpoint: `generativelanguage.googleapis.com` (API remota, sem processamento local)

**TTS — Migração para Gemini 3.1**
- Modelo TTS padrão atualizado de `gemini-2.5-flash-tts` para `gemini-3.1-flash-tts-preview`
- Fallback para Chirp3-HD mantido em caso de erro transiente

**Thumbnail e vídeo**
- Overlay de texto removido da thumbnail — agora usa imagem AI limpa (crop + resize, sem headline)
- Intro text overlay removido do vídeo (hook text já não aparece nos primeiros frames)
- Volume da música de fundo reduzido de 2% para 0.8% (`volume={0.008}`)

**Fallback para tentativas rejeitadas de imagem**
- Se todos os attempts de um segmento falharem no audit visual, o pipeline usa a melhor tentativa rejeitada em vez de falhar o job inteiro
- Log: `"FALLBACK using rejected attempt (audit failed but usable)"`

**Fila de jobs — Timeouts**
- Lane `preview`: timeout de 5 minutos
- Lane `heavy`: timeout de 30 minutos
- Processo morto com SIGTERM → SIGKILL após 5s se exceder o timeout

**Segurança — Bloqueio de ficheiros sensíveis**
- `/api/file` bloqueia acesso a: `.env`, `.key`, `secrets.mjs`, `secrets.json`, `gcp-ate.json`, `jobs.json`

**Persistência e performance**
- `logTail` limitado a 50 linhas na persistência de jobs (reduz tamanho de `jobs.json`)
- `/api/jobs` paginado: `?limit=50&offset=0` (default 50, max 500)
- Slug length aumentado de 60 para 80 caracteres

**Frontend / UX**
- Toast notifications substituem `window.alert()` em toda a UI (7 ocorrências)
- Botão de submit desabilitado durante request para evitar duplo-clique
- Botão duplicado "Aprovar edição e gerar vídeo" no fundo do formulário de preview

**Limpeza e startup**
- Limpeza automática de ficheiros em `.tmp/system/` com mais de 24h no startup do servidor
- Evita acumulação de frames Remotion temporários

**QA — Ajustes**
- `durationTargetOk` tornado não-bloqueante (warning em vez de falha)
- `sceneCountOk` relaxado para storyboards externos (aceita qualquer contagem ≥1)

---

## [2026-04-17] Recovery hardening, scene manual review, UI fixes, QA adjustment, music catalog

### Resumo
Pacote de estabilização operacional focado em bugs/configuração e recuperação de runs: limpeza de scripts quebrados, retenção de jobs e temp files, upload de vídeo sem carregar tudo em memória, correção de resume/render com payload grande, revisão manual de tentativas de imagem rejeitadas, correção de seleção ElevenLabs nos canais `ate2min`/`quiet2min`, ajuste do layout da tab Criar, QA menos arbitrário para shorts de 60s com 8 cenas válidas, remoção de trilhas quebradas e catalogação da biblioteca local de música.

### O que foi implementado

**Estabilidade do backend e recovery**
- `web/server.mjs`: retenção de jobs concluídos/falhados, limpeza de `jobs.json.*.tmp`, limpeza real de `streams`, consistência entre `:id` da rota e `body.jobId`
- Resume/render passou a usar arquivo de props em vez de payload inline enorme
- Novo fluxo de revisão manual de imagem rejeitada:
  - `GET /api/jobs/:id/scene-review`
  - `POST /api/jobs/:id/approve-scene-attempt`
- Aprovação manual reconstrói o clip da cena, atualiza manifestos e continua o recovery
- `web/lib/job-state.mjs`: recovery source passa a preferir o `generate` completo, não o preview

**Pipeline de imagem**
- `scripts/generate-google-assets.mjs`: cenas que pedem múltiplos braços de forma intencional deixaram de conflitar com o `negativePrompt`
- O audit visual ficou menos rígido para esse caso simbólico, mantendo reprovação quando a anatomia está realmente incoerente

**Frontend / UX**
- `web/public/index.html`, `web/public/styles.css`: aba Criar reestruturada para layout de workspace com coluna lateral sticky
- `web/public/app.js`: correção da persistência de `ElevenLabs` em `ate2min` e `quiet2min`
- UI de detalhe do job ganhou galeria de revisão manual das tentativas rejeitadas

**QA e validação**
- `video-engine/scripts/validate-run.mjs`: vídeos de até 60s passam a aceitar 8 cenas como mínimo válido
- Isso evita reprovação de vídeos bons por regra arbitrária de 9 cenas

**Áudio / música**
- `video-engine/src/ShortVideo.tsx`: volume da trilha manteve-se em `0.02`
- Confirmado que a opção de música depende do checkbox do site, não do texto do roteiro
- Removidas 8 trilhas corrompidas da pasta local de música
- Novo script `scripts/catalog-background-music.mjs` gera catálogo local da biblioteca

**Documentação e limpeza**
- `video-engine/package.json`: remoção dos scripts quebrados `envato:session` e `envato:download`
- `README.md`, `top.md`: documentação alinhada com o comportamento real
- `video-engine/src/ShortVideo.tsx`: remoção de prop duplicada

### Artefatos gerados
- Catálogo de música:
  - `/root/Documents/scripts/envato/music/catalog.json`
  - `/root/Documents/scripts/envato/music/catalog.csv`
  - `/root/Documents/scripts/envato/music/catalog.md`

### Observações
- O vídeo `2026-04-16-voce-nao-esta-atrasado-voce-esta-distraido` foi recuperado com sucesso via aprovação manual da cena 2, render final e QA final concluída.
- A escolha de música continua aleatória entre as faixas válidas remanescentes, salvo quando `DEFAULT_MUSIC_FILE` estiver definido.

---

## [2026-04-14] AI-generated thumbnail via storyboard prompt

### Resumo
O LLM agora gera um campo `thumbnailPrompt` no storyboard — um prompt de imagem em inglês optimizado para criar capas de vídeo com alto CTR. Esse prompt é usado para gerar uma imagem nova via Vertex AI (Gemini Flash Image por padrão), que substitui o frame extraído do vídeo como base da thumbnail. Fallback silencioso se o campo estiver ausente ou a geração falhar.

### O que foi implementado

**Schema e regras LLM (`video-engine/scripts/lib/llm-provider.mjs`)**
- `thumbnailPrompt` adicionado ao schema Zod (string, max 300, optional), JSON schema (properties + required), e `requestedShape`
- 11 regras de thumbnail no `buildGenerationMessages`: sujeito dominante, emoção concreta, contraste de cores, sem texto, sujeito no terço superior, curiosity gap
- Regra de review (rule 15-16) no `buildReviewMessages`
- Preservação em `buildExpansionMessages` e `buildCompressionMessages`
- Preservação/melhoria em `buildRepairMessages`
- Fallback para string vazia em `normalizeStoryboard` e `fallbackStoryboard` (EN + PT)

**Geração de thumbnail AI (`video-engine/scripts/make-plan1-video.mjs`)**
- Nova função `generateThumbnail()`: lê `thumbnailPrompt` do storyboard, prepend do `stylePrompt` + `styleLockPrompt` do preset visual, gera imagem via `generateVertexImage()`
- Modelo configurável via `THUMBNAIL_IMAGE_MODEL` env (default: `gemini-2.5-flash-image`)
- Aspect ratio do perfil de saída (9:16 vertical, 16:9 horizontal)
- Crop pós-geração via sharp: remove 25% inferior, resize para 1080×1920 com `position: top` — força sujeito no terço superior independente do modelo
- Fallback silencioso: se `thumbnailPrompt` vazio/ausente, ou geração falhar, usa `qaFramePaths[0]` (comportamento anterior)
- Imagem AI passada como `sourceFramePath` ao `createThumbnailPoster()` existente (overlays de texto mantidos)

**Dependências**
- `sharp@0.33.5` adicionado ao `video-engine/package.json`

### Arquivos afetados

| Arquivo | Mudança |
|---------|---------|
| `video-engine/scripts/lib/llm-provider.mjs` | Schema Zod/JSON, regras em 5 builders de mensagens, normalização, fallback |
| `video-engine/scripts/make-plan1-video.mjs` | Import `generateVertexImage`, função `generateThumbnail()`, wiring no pipeline |
| `video-engine/package.json` | +sharp@0.33.5 |
| `video-engine/package-lock.json` | Lock atualizado |

### Custo adicional por vídeo
- LLM: $0 (campo extra na mesma chamada de storyboard)
- Imagem: ~$0.02–0.04 (1 chamada API)
- Tempo: +5–15s

---

## [2026-04-12b] UI autonomy features, image audit fix, model default update

### Resumo
Três novas features de autonomia no UI (republicar vídeo, regenerar cena específica, galeria de cenas), correção do Vision audit (falsos negativos por texto em speech bubbles), Imagen4 Full como padrão, e fix do publish mode para datas passadas.

### O que foi implementado

**UI — 3 novas features de autonomia**
- **Publicar novamente:** botão `resetPublishButton` que aparece quando um vídeo já foi publicado — chama `POST /api/videos/:slug/reset-publish` e limpa o estado de publicação sem precisar editar ficheiros manualmente
- **Regenerar cena específica:** campo numérico + botão para forçar a regeneração de qualquer cena por número (não só a "próxima faltante"), útil quando o audit falha numa cena específica
- **Galeria de cenas:** grid de miniaturas das imagens PNG geradas por cena, visível no detalhe do job/vídeo, permite comparar visualmente estilos e modelos sem aceder ao filesystem

**Fixes de audit e publicação**
- `auditWithGeminiVision`: sanitiza strings entre aspas da `visualGoal` antes de passar ao Gemini — evita que o audit rejeite imagens por texto diferente em speech bubbles (ex: "TOO WEAK" vs "TOO EXPENSIVE")
- Adicionado `"Speech bubble content that differs from the goal — only concept matters, not exact words"` à lista de exclusões do audit — aplica-se a todos os estilos
- Fix publish mode no UI: `scheduleAt` histórico (data passada) não força mais o modo "agendado" — só usa "scheduled" se a data for futura

**Defaults actualizados**
- `presets.mjs`: `DEFAULT_IMAGE_MODEL` → `imagen-4.0-generate-001` (Full, era Fast)
- `.env`: `GOOGLE_IMAGE_MODEL=imagen-4.0-generate-001` + `FLUX2_RENDER_RETRY_COUNT=5`
- Instrução positiva de anatomia em cenas com personagem: "show exactly one person with exactly two arms and two hands — do not add a second person, crowd, or background silhouette"

---

## [2026-04-12] Pipeline rename flux2→google, image quality improvements, bug fixes

### 1) Resumo Executivo

Renomeação completa do pipeline de geração de imagens de "flux2" para "google" (Vertex AI Imagen / Gemini Image), remoção de 7 ficheiros de documentação obsoletos, melhorias de qualidade de imagem (anatomia, ritmo visual, hooks), e correção de dois bugs em produção (data passada no publicador e resolução de voice IDs do ElevenLabs).

### 2) O que foi implementado

**Renomeação de scripts**
- `scripts/generate-flux2-assets.mjs` → `scripts/generate-google-assets.mjs`
- `scripts/test-generate-flux2-rules.mjs` → `scripts/test-generate-google-rules.mjs`
- Callers atualizados: `web/lib/job-execution.mjs`, `scripts/foiumaideia.mjs`, `package.json`
- Provider interno corrigido: `"flux2-local"` → `"google-imagen"` (3 ocorrências em generate-google-assets.mjs)

**Documentação limpa**
- Removidos 7 ficheiros obsoletos: `CHANGELOG-QUALITY.md`, `STYLE-CONSISTENCY-PLAN.md`, `STYLE-CONSISTENCY-STORIES.md`, `eleven.md`, `relatorio.md`, `docs/bathroom-motion-prompts.md`, `docs/ui-ux-redesign-task.md`
- `README.md`, `PRODUCTION-RUNBOOK.md`, `top.md`, `video.md` corrigidos: imagens geradas via Vertex AI Imagen / Gemini 2.5 Flash Image (API remota), não local MLX/FLUX2

**Qualidade de imagem**
- Instrução de anatomia positiva adicionada em `generate-google-assets.mjs`: cenas com personagens agora instruem o modelo a mostrar exactamente uma pessoa com dois braços e duas mãos (estilos normais), ou exactamente um stick figure (estilo stickman)
- `GOOGLE_IMAGE_MODEL=imagen-4.0-generate-001` definido como default no `.env` (Imagen 4 Full)
- `FLUX2_RENDER_RETRY_COUNT=5` aumentado no `.env`

**Qualidade de storyboard (`video-engine/scripts/lib/llm-provider.mjs`)**
- Regra de hook: exige hook provocativo com padrões de exemplo
- Regra de título único: proíbe títulos de cena duplicados
- Ritmo visual: alternância de tipos de cena (humano → simbólico → institucional → humano)
- Review pass: novos checks 10d (ritmo visual) e 10e (títulos únicos)
- QA detector: check `duplicate_scene_titles` com auto-repair

**Correções de bugs**
- `web/server.mjs`: quando `scheduleAt` armazenado está no passado, usa `now` em vez de enviar data passada ao agendador.online (corrige erro "A data não pode ser no passado")
- `web/server.mjs`: voice IDs do ElevenLabs (alfanuméricos, 10+ chars) são agora aceites directamente, sem cair no fallback de voz Google Cloud

### 3) Arquivos afetados

| Arquivo | Mudança |
|---------|---------|
| `scripts/generate-google-assets.mjs` | Renomeado de generate-flux2-assets.mjs; provider "flux2-local"→"google-imagen"; instrução de anatomia adicionada |
| `scripts/test-generate-google-rules.mjs` | Renomeado de test-generate-flux2-rules.mjs |
| `scripts/foiumaideia.mjs` | Referência ao script renomeado |
| `web/lib/job-execution.mjs` | Referência ao script renomeado |
| `package.json` | Scripts npm actualizados |
| `video-engine/scripts/lib/llm-provider.mjs` | Regras de hook, título único, ritmo visual, QA detector |
| `web/server.mjs` | Bug fix data passada; bug fix ElevenLabs voice ID |
| `README.md`, `PRODUCTION-RUNBOOK.md`, `top.md`, `video.md` | Descrição do pipeline corrigida |
| 7 ficheiros `.md` | Removidos (obsoletos) |

---

## [2026-04-12] Integração ElevenLabs TTS

### 1) Resumo Executivo

Integração do ElevenLabs como provider de TTS selecionável na UI e CLI, ao lado dos providers existentes (Google Cloud TTS, Azure Speech). A função `synthesizeWithElevenLabs()` já existia no código mas estava inacessível — o router `synthesizeVoiceover()` rejeitava qualquer provider que não fosse GCP. Esta mudança desbloqueia o routing, adiciona o dropdown na UI com listagem dinâmica de vozes via API, e propaga a escolha do provider por toda a cadeia (frontend → backend → queue → child process → TTS engine → QA).

### 2) O que foi implementado

**TTS Engine (`video-engine/scripts/lib/tts.mjs`)**
- Adicionado branch `elevenlabs` no router `synthesizeVoiceover()` (antes do guard que rejeitava providers desconhecidos)
- O branch resolve `apiKey` e `voiceId` do objeto `elevenlabs` ou de env vars
- Chama `synthesizeWithElevenLabs()` (já existente) → comprime silêncios → normaliza timedWords
- Se alignment nativo vier vazio, faz fallback para `extractTimedWordsFromAudio()` (Google Cloud STT)
- Retorna `timedWordsSource: "elevenlabs-alignment"` quando alignment nativo é usado

**QA — Trusted Sources (`make-plan1-video.mjs`, `rerender-voice.mjs`, `validate-run.mjs`)**
- `"elevenlabs-alignment"` adicionado ao `TRUSTED_TIMED_WORD_SOURCES` nos 3 ficheiros
- Sem isto, o check `timedWordsSourceTrusted` da QA reprovaria qualquer run com ElevenLabs

**Frontend HTML (`web/public/index.html`)**
- Novo `<select name="audioProvider" id="generateAudioProvider">` com opções "Google Cloud TTS" (default) e "ElevenLabs"
- Posicionado na secção "Voz, canal e execução", antes do dropdown de voz

**Frontend JS (`web/public/app.js`)**
- Registado elemento `audioProvider` no objeto `elements`
- `fetchElevenLabsVoices()` — busca vozes reais da conta via `GET /api/elevenlabs-voices`, com cache em memória
- `syncVoiceOptionsForProvider()` — ao trocar provider, repopula o `<select>` de voz:
  - ElevenLabs: mostra "Carregando vozes…", depois lista vozes reais com nome e categoria
  - GCP: restaura vozes Gemini TTS filtradas por idioma
- Event listener `change` no dropdown de provider
- `audioProvider` incluído no payload de `buildGeneratePayload()`

**Backend API (`web/server.mjs`)**
- `audioProvider` parseado do body em `handleGenerateRequest()` (sanitizado: `"elevenlabs"` ou `"gcp"`)
- `audioProvider` armazenado em `job.input`
- Novo handler `handleElevenLabsVoicesRequest`:
  - Proxy para `GET https://api.elevenlabs.io/v1/voices` com a API key do `.env`
  - Cache server-side de 5 minutos (`ELEVENLABS_VOICES_TTL_MS = 300_000`)
  - Retorna `{voices: [{value, label, category, languages}]}`
  - Graceful degradation: retorna `{voices: []}` se key ausente ou API falhar
- Nova rota `GET /api/elevenlabs-voices`

**Job Execution (`web/lib/job-execution.mjs`)**
- `TTS_PROVIDER` e `ELEVENLABS_VOICE_ID` adicionados ao env de 3 command builders:
  - `createGenerateJobCommand()` — pipeline completo
  - `createRerenderJobCommand()` — re-render de voz
  - `createAudioPrepJobCommand()` — preparação de áudio
- Lógica: se `job.input.audioProvider === "elevenlabs"`, seta `TTS_PROVIDER=elevenlabs` e `ELEVENLABS_VOICE_ID=<voice selecionada>`; caso contrário, usa o default do `.env`

**CLI — Rerender (`video-engine/scripts/rerender-voice.mjs`)**
- Novo flag `--provider` no `parseArgs()`
- `selectedProvider` agora lê de `args.provider || process.env.TTS_PROVIDER || "auto"`
- `ELEVENLABS_API_KEY` adicionado ao `loadSecretsIntoEnv()`
- Objeto `elevenlabs` no call a `synthesizeVoiceover()` agora passa config completa (antes era `{}`)

**CLI — Orquestrador (`scripts/foiumaideia.mjs`)**
- Novo flag `--provider` no `parseArgs()`
- Se passado, seta `runtimeEnv.TTS_PROVIDER` para propagar ao child process

**Configuração (`video-engine/.env`)**
- `ELEVENLABS_API_KEY` configurada
- 8 variáveis ElevenLabs adicionadas (VOICE_ID, MODEL_ID, LANGUAGE_CODE, STABILITY, SIMILARITY_BOOST, STYLE, USE_SPEAKER_BOOST, SPEED)

### 3) Como funciona agora

**Via UI:**
1. Na tab "Criar", o dropdown "Provedor de áudio" aparece antes do dropdown de voz
2. Ao selecionar "ElevenLabs", o dropdown de voz mostra "Carregando vozes…" e busca as vozes reais da conta via API
3. As vozes aparecem com nome e categoria (ex: "Liam - Energetic, Social Media Creator (premade)")
4. Ao submeter, o `audioProvider` e o `voice` (voice_id do ElevenLabs) são enviados no payload
5. O backend propaga `TTS_PROVIDER=elevenlabs` e `ELEVENLABS_VOICE_ID=<id>` para o child process
6. O pipeline usa `synthesizeWithElevenLabs()` que retorna áudio + timedWords nativos
7. A QA aceita `elevenlabs-alignment` como source confiável

**Via CLI:**
```bash
# Pipeline completo
node scripts/foiumaideia.mjs --title "Meu vídeo" --provider elevenlabs

# Re-render de voz existente
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --provider elevenlabs

# Com voice ID específico
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb node scripts/foiumaideia.mjs --title "Teste" --provider elevenlabs
```

**Fluxo de timedWords com ElevenLabs:**
```
ElevenLabs /with-timestamps API
  → alignment.character_start_times_seconds / character_end_times_seconds
  → buildTimedWordsFromAlignment() (já existia no código)
  → timedWords[] no formato padrão {text, startSeconds, endSeconds, startChar, endChar}
  → compressAudioSilences() (max 0.4s)
  → sanitizeTimedWordsForAudio() (normaliza para duração real)
  → timedWordsSource: "elevenlabs-alignment"
```

### 4) Impacto das mudanças

**Para utilizadores finais:**
- Novo dropdown "Provedor de áudio" na UI com 2 opções
- Vozes ElevenLabs listadas dinamicamente da conta real
- Sem impacto no fluxo existente — GCP continua como default

**Para desenvolvedores:**
- `job.input.audioProvider` é um novo campo nos jobs (valor: `"gcp"` ou `"elevenlabs"`)
- Jobs antigos sem `audioProvider` continuam a funcionar (fallback para GCP)
- `--provider` é um novo flag aceite pelo `foiumaideia.mjs` e `rerender-voice.mjs`

**Breaking changes:** Nenhum. Todos os defaults mantêm o comportamento anterior.

**Migração:** Não necessária. Jobs existentes sem `audioProvider` usam GCP automaticamente.

### 5) Como usar

**Pré-requisito:** `ELEVENLABS_API_KEY` configurada em `video-engine/.env`

**Na UI:**
1. Abrir `https://video.vamostestar.online/`
2. Tab "Criar" → secção "Voz, canal e execução"
3. "Provedor de áudio" → selecionar "ElevenLabs"
4. Dropdown de voz atualiza automaticamente com as vozes da conta
5. Escolher voz → preencher título → submeter

**Na CLI:**
```bash
# Usar ElevenLabs com voz default (ELEVENLABS_VOICE_ID do .env)
node scripts/foiumaideia.mjs --title "Meu título" --provider elevenlabs

# Re-render com ElevenLabs
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --provider elevenlabs
```

### 6) Changelog

## [2026-04-12]

### Added
- Dropdown "Provedor de áudio" (GCP / ElevenLabs) na UI de criação
- Endpoint `GET /api/elevenlabs-voices` — lista vozes reais da conta com cache de 5 min
- Listagem dinâmica de vozes ElevenLabs no dropdown de voz (fetch assíncrono com loading state)
- Branch `elevenlabs` no router `synthesizeVoiceover()` em `tts.mjs`
- `"elevenlabs-alignment"` como trusted timed word source na QA
- Flag `--provider` no CLI `foiumaideia.mjs` e `rerender-voice.mjs`
- `TTS_PROVIDER` e `ELEVENLABS_VOICE_ID` propagados via env nos command builders do job-execution
- Campo `audioProvider` no `job.input` e no payload do frontend
- Config completa ElevenLabs no `video-engine/.env` (API key + 8 parâmetros de voz)

### Changed
- `rerender-voice.mjs`: objeto `elevenlabs` no call a `synthesizeVoiceover()` agora passa config completa (antes era `{}`)
- `rerender-voice.mjs`: `selectedProvider` agora aceita `args.provider` como override
- `rerender-voice.mjs`: `loadSecretsIntoEnv` agora inclui `ELEVENLABS_API_KEY`
- `README.md` reescrito com documentação completa do sistema (547 linhas)

### Fixed
- Nada

### Removed
- Nada

### 7) Arquivos afetados

| Arquivo | Mudança |
|---------|---------|
| `video-engine/.env` | +10 linhas: ELEVENLABS_API_KEY e 8 parâmetros de voz |
| `video-engine/scripts/lib/tts.mjs` | +63 linhas: branch `elevenlabs` no router `synthesizeVoiceover()` |
| `video-engine/scripts/make-plan1-video.mjs` | +1 token: `"elevenlabs-alignment"` em TRUSTED_TIMED_WORD_SOURCES |
| `video-engine/scripts/rerender-voice.mjs` | +21 linhas: `--provider` flag, secrets, config ElevenLabs completa |
| `video-engine/scripts/validate-run.mjs` | +1 token: `"elevenlabs-alignment"` em TRUSTED_TIMED_WORD_SOURCES |
| `web/lib/job-execution.mjs` | +6 linhas: TTS_PROVIDER + ELEVENLABS_VOICE_ID em 3 command builders |
| `web/public/index.html` | +8 linhas: dropdown `<select name="audioProvider">` |
| `web/public/app.js` | +53 linhas: fetch de vozes, sync de dropdown, audioProvider no payload |
| `web/server.mjs` | +34 linhas: handler ElevenLabs voices, audioProvider no job.input, rota |
| `README.md` | Reescrito completo (654 inserções, 268 remoções) |

### 8) Observações técnicas

**Decisões importantes:**
- O endpoint `/api/elevenlabs-voices` faz proxy server-side para não expor a API key no frontend. Cache de 5 min evita rate limiting.
- O fallback para Google Cloud STT (`extractTimedWordsFromAudio()`) só é ativado se o alignment nativo do ElevenLabs vier vazio — cenário raro mas possível em edge cases.
- `compressAudioSilences()` é aplicado ao áudio ElevenLabs da mesma forma que ao GCP, garantindo consistência de pacing.
- Jobs antigos sem `audioProvider` são tratados como GCP pelo guard `job.input.audioProvider === "elevenlabs"` (falsy → usa default do .env).

**Limitações:**
- A quota do ElevenLabs é por conta (caracteres/mês). Vídeos longos (5–10 min) consomem quota significativa.
- O endpoint de vozes não filtra por idioma — mostra todas as vozes da conta. O utilizador precisa saber qual voz suporta pt-BR.
- Não há retry automático no `synthesizeWithElevenLabs()` para erros 429 (rate limit) — o ElevenLabs falha imediatamente e o job falha.

**Melhorias futuras possíveis:**
- Retry com backoff exponencial para erros 429/5xx no ElevenLabs (como já existe para Google TTS)
- Filtro de vozes por idioma no dropdown (usando metadata de `labels.language` da API)
- Preview de voz (play sample) no dropdown antes de submeter
- Suporte a vozes clonadas (custom voices) do ElevenLabs
