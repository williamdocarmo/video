# Changelog — Video Studio

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
