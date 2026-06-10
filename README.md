# Video Studio

Sistema local de produção automatizada de vídeos curtos. Transforma um título ou texto em vídeo finalizado com storyboard, imagens geradas por IA, narração com voz sintética, legendas karaoke e render final — tudo via UI web.

URL pública: `https://video.vamostestar.online/`
URL local: `http://127.0.0.1:3210`
Repo: `https://github.com/williamdocarmo/video.git`

## Arquitetura geral

```
Internet
  │
  ▼
Traefik v3.6.11 (Docker/Coolify, :443, Let's Encrypt TLS)
  │  ├─ redirect HTTP → HTTPS
  │  └─ secure-headers (HSTS, X-Frame-Options, etc.)
  │
  ▼
Node.js runtime (:3210, 0.0.0.0)
  │
  ├─ web/server.mjs .............. runtime unificado (`VIDEO_STUDIO_ROLE=all`)
  ├─ web/api-server.mjs .......... entrypoint API/UI (`VIDEO_STUDIO_ROLE=api`)
  ├─ web/worker-engine.mjs ....... entrypoint worker (`VIDEO_STUDIO_ROLE=worker`)
  ├─ web/public/ ................. frontend: app.js, index.html, styles.css
  │
  ├─ web/lib/
  │   ├─ presets.mjs ............. vozes, modelos, canais, tons, modos de geração
  │   ├─ job-queue.mjs ........... fila dual-lane (preview + heavy)
  │   ├─ job-state.mjs ........... análise de estado, recovery, taxonomia de falhas
  │   ├─ job-execution.mjs ....... builders de comandos para child processes
  │   ├─ video-library.mjs ....... gestão de vídeos exportados, metadados
  │   ├─ agendador.mjs ........... integração com agendador.online (publicação/agendamento)
  │   ├─ tiktok-helper.mjs ....... drafts e helper HTML para TikTok
  │   ├─ routes.mjs .............. router pattern-based com :params
  │   └─ utils.mjs ............... I/O, slugify, IDs, managed files
  │
  ├─ scripts/
  │   ├─ foiumaideia.mjs ......... orquestrador principal (preview → assets → pipeline → export)
  │   ├─ generate-google-assets.mjs geração visual (Gemini planner + Vertex Imagen + ffmpeg, via API remota)
  │   └─ lib/
  │       ├─ scene-spec.mjs ...... compilador de especificação de cena (câmera, pose, afeto, risco)
  │       └─ scene-failure-taxonomy.mjs classificador de falhas visuais (12 categorias)
  │
  ├─ video-engine/
  │   ├─ scripts/
  │   │   ├─ make-plan1-video.mjs  pipeline core (storyboard → voz → render → QA)
  │   │   ├─ rerender-voice.mjs .. re-render de voz/áudio (--provider, --reuse-existing-audio)
  │   │   ├─ validate-run.mjs .... validação QA (20+ checks)
  │   │   └─ lib/
  │   │       ├─ llm-provider.mjs  LLM (Vertex Gemini, OpenRouter): storyboard, QA, repair, graphic plan
  │   │       ├─ tts.mjs ......... TTS multi-provider: Cloud Gemini TTS, Chirp3-HD, ElevenLabs, Azure
  │   │       ├─ timings.mjs ..... timeline, pacing, legendas karaoke, frame ranges
  │   │       ├─ alignment-utils.mjs normalização de timedWords para duração do áudio
  │   │       ├─ gcp-media.mjs ... Vertex AI image + multimodal
  │   │       ├─ gcp-config.mjs .. config GCP (projeto, location, credenciais, OAuth2)
  │   │       ├─ secrets.mjs ..... gestão de secrets (keychain + env)
  │   │       ├─ gemini-usage.mjs  tracking de uso/custo da API Gemini
  │   │       ├─ story-flow.mjs .. conectores de cena (pt-BR/en-US)
  │   │       ├─ used-assets.mjs . registro de assets usados (dedup com lock atômico)
  │   │       └─ clean-cli.mjs ... execução streaming com progress compacto
  │   ├─ src/
  │   │   ├─ ShortVideo.tsx ...... composição Remotion principal (Ken Burns, karaoke, 5 estilos)
  │   │   ├─ Root.tsx ............ registro de composições (CodexShort, CodexWide, CaptionStyleDemo)
  │   │   └─ types.ts ............ tipos TypeScript (Scene, CaptionChunk, ShortVideoProps)
  │   ├─ runs/{slug}/ ............ storyboard, voiceover, render-props, reports, QA
  │   ├─ public/runs/{slug}/ ..... áudio, vídeo, thumbnails servidos pelo Remotion
  │   ├─ assets/envato/{slug}/ ... scene-XX.mp4, imagens geradas (PNG), manifests
  │   └─ out/{slug}.mp4 .......... saída final do Remotion
  │
  ├─ config/
  │   ├─ output-profiles.mjs ..... perfis de saída (vertical-short, horizontal-5m, horizontal-10m)
  │   └─ visual-style-presets.mjs  10 presets visuais com ~17 campos de prompt cada
  │
  ├─ shared/utils.mjs ............ utilitários partilhados (normalizeText, sleep, slugify, extractJson)
  ├─ .web-ui/ .................... persistência: jobs.json, videos.json, inputs/, tiktok-drafts/, runtime-auth.json
  └─ /root/postar/{canal}/ ...... export final organizado por canal
```

## Runtime modes

O runtime agora suporta 3 papéis:

| Role | Comando | Uso |
|------|---------|-----|
| `all` | `node web/server.mjs` | modo histórico: API + worker no mesmo processo |
| `api` | `node web/api-server.mjs` | expõe UI/API HTTP, sincroniza jobs a partir do snapshot |
| `worker` | `node web/worker-engine.mjs` | executa a fila sem abrir porta HTTP |

Notas:
- O split continua a usar `.web-ui/jobs.json` como snapshot partilhado entre processos.
- `WEB_DATA_DIR` permite isolar o estado local por ambiente ou teste.
- Ainda não existe coordenação multi-worker distribuída; isto é desacoplamento operacional, não uma fila distribuída completa.

---

## Pipeline de produção

### Fluxo completo (título → vídeo)

```
1. UI envia POST /api/generate  ─────────────────────────────────────────┐
   { title, sourceText, language, voice, audioProvider,                  │
     outputProfile, channel, tone, imageModel, generationMode,           │
     storyboard (opcional — JSON externo), ... }                         │
                                                                         ▼
2. server.mjs cria job → enqueueAndStart() ──── job-queue.mjs (dual-lane)
   │  lane "preview" (storyboard only, rápido, timeout 5min)
   │  lane "heavy"   (pipeline completo, lento, timeout por tipo de job)
   │
   ▼
3. job-execution.mjs → spawn("node scripts/foiumaideia.mjs ...")
   │  Passa env vars: TTS_PROVIDER, ELEVENLABS_VOICE_ID, GOOGLE_TTS_VOICE,
   │  IMAGE_MODEL, GENERATION_MODE, VIDEO_LANGUAGE, etc.
   │
   ▼
4. foiumaideia.mjs (orquestrador)
   │
   ├─ PREVIEW: spawn make-plan1-video.mjs --preview-only
   │   └─ Gera storyboard + QA → retorna para aprovação na UI
   │
   ├─ ASSETS: spawn generate-google-assets.mjs
   │   ├─ Gemini planeja shots por cena (visual-plan.json)
   │   ├─ Gemini Flash Image / Pro Image / Vertex AI Imagen gera PNGs via API remota
   │   ├─ Gemini Vision audita cada imagem
   │   ├─ Retry com directivas progressivas se falhar
   │   ├─ Fallback: usa melhor tentativa rejeitada se todos os attempts falharem
   │   └─ ffmpeg converte PNGs → scene-XX.mp4 (local, leve)
   │
   └─ HEAVY: spawn make-plan1-video.mjs (pipeline completo)
       │
       ├─ 5a. Storyboard (Gemini LLM)
       │   ├─ generateStoryboard() → JSON com cenas, narração, hook, CTA, thumbnailPrompt
       │   ├─ evaluateStoryboardQa() → validação pré-visual
       │   └─ repairStoryboard() → até 3 tentativas de correção
       │
       ├─ 5b. Plano gráfico (Gemini LLM)
       │   ├─ generateGraphicPlanStrict() → queries de stock por cena
       │   └─ alignGraphicPlan() → normaliza e enriquece queries
       │
       ├─ 5c. Voz (TTS multi-provider)
       │   ├─ synthesizeVoiceover() → router de providers
       │   │   ├─ "elevenlabs"       → ElevenLabs /with-timestamps (alignment nativo)
       │   │   ├─ "google-gemini-tts" → Cloud Gemini TTS → STT para timestamps
       │   │   ├─ "gcloud"/"auto"    → Cloud TTS Chirp3-HD → STT para timestamps
       │   │   └─ "azure"            → Azure Speech (word boundaries nativos)
       │   ├─ compressAudioSilences() → limita silêncios a 0.4s
       │   ├─ sanitizeTimedWordsForAudio() → normaliza para duração real
       │   └─ analyzeSceneSpeechPacing() → detecta cenas apressadas (>7 palavras/s)
       │
       ├─ 5d. Assets visuais
       │   ├─ Resolve clips locais (assets/envato/{slug}/)
       │   ├─ Auditoria visual (Gemini Vision via API)
       │   └─ Resolve ilustrações geradas (Vertex Imagen / Gemini Image → still image)
       │
       ├─ 5e. Timeline (timings.mjs)
       │   ├─ buildTimeline() → frames por cena + legendas karaoke
       │   ├─ Atribui timedWords a cenas por char offset
       │   └─ Gera CaptionChunks com word-level timing
       │
       ├─ 5f. Render (Remotion)
       │   ├─ npx remotion render src/index.ts CodexShort out/{slug}.mp4
       │   ├─ Ken Burns em imagens, cross-fade entre cenas
       │   ├─ 5 estilos de legenda karaoke
       │   └─ Retry com concurrency=1 se fetch local falhar
       │
       └─ 5g. QA (validate-run.mjs)
           ├─ 20+ checks: output exists, scene count, captions, sync, pacing
           ├─ Extrai frames de amostra para inspeção
           ├─ Gera thumbnail AI via Vertex (thumbnailPrompt do storyboard) com fallback para frame do vídeo
           └─ Persiste agent-report.json + orchestration-report.json
```

---

## TTS — Providers de voz

O engine suporta 4 providers de TTS internamente. No fluxo atual da UI web, o dropdown "Provedor de áudio" expõe `gcp` e `elevenlabs`; os demais providers continuam acessíveis via scripts/engine.

| Provider | Env value | Timestamps | Fallback STT | Notas |
|----------|-----------|------------|--------------|-------|
| Cloud Gemini TTS | `google-gemini-tts` / `gemini-tts` / `gemini` | Via Google Cloud STT | `extractTimedWordsFromAudio()` | Provider padrão. Modelo `gemini-3.1-flash-tts-preview`. Fallback para Chirp3-HD se transiente. |
| Cloud TTS Chirp3-HD | `gcloud` / `google` / `auto` | Via Google Cloud STT | `extractTimedWordsFromAudio()` | Fallback do Gemini TTS. Vozes `pt-BR-Chirp3-HD-*`. |
| ElevenLabs | `elevenlabs` | Nativo (`/with-timestamps`) | `extractTimedWordsFromAudio()` se alignment vazio | Alignment character-level convertido para timedWords via `buildTimedWordsFromAlignment()`. |
| Azure Speech | `azure` | Nativo (word boundaries) | `extractTimedWordsFromAudio()` se cobertura incompleta | `microsoft-cognitiveservices-speech-sdk`. Padding de cauda automático. **Opcional — não configurado por padrão (requer `AZURE_SPEECH_KEY`).** |

### Fluxo de timestamps (timedWords)

Todos os providers produzem o mesmo formato `timedWords[]`:
```json
{
  "text": "palavra",
  "rawText": "palavra",
  "startSeconds": 0.42,
  "endSeconds": 0.78,
  "startChar": 15,
  "endChar": 21
}
```

Pós-processamento comum:
1. `sanitizeTimedWordsForAudio()` — escala timestamps se excedem duração do áudio
2. `compressAudioSilences()` — limita silêncios inter-frase a 0.4s
3. `anchorTimestampsToAudioSilences()` — re-alinha segmentos STT com silêncios reais
4. `analyzeSceneSpeechPacing()` — rejeita runs com >7 palavras/s por cena

### Trusted sources para QA
`TRUSTED_TIMED_WORD_SOURCES`: `gcloud-speech-stt`, `azure-word-boundary`, `elevenlabs-alignment`

---

## Remotion — Composições e estilos

### 3 composições registadas

| ID | Resolução | FPS | Uso |
|----|-----------|-----|-----|
| `CodexShort` | 1080×1920 (9:16) | 30 | Shorts verticais |
| `CodexWide` | 1920×1080 (16:9) | 30 | Vídeos horizontais |
| `CaptionStyleDemo` | 1080×1920 | 30 | Preview de estilos |

### 5 estilos de legenda karaoke

| Estilo | Visual |
|--------|--------|
| `clean-broadcast` | Palavra ativa amarela, fundo pill semi-transparente, centrado |
| `bold-tiktok-block` | Cada palavra é pill inline. Ativa = fundo amarelo + texto escuro |
| `soft-karaoke` | Ativa amarela com glow. Container frosted glass com borda |
| `outline-punch` | Stroke grosso preto, peso 900, sem container |
| `caption-strip` | Strip inferior com borda amarela, alinhado à esquerda |

### Efeitos visuais
- **Ken Burns**: 4 variantes de movimento (zoom in/out + pan) ciclando por cena
- **Cross-fade**: 12 frames (~400ms) de transição entre cenas
- **Overlay gradient**: Escurecimento topo/base para legibilidade
- **Hook/título**: Animação spring nos primeiros 48 frames
- **Música de fundo**: Volume 0.8% (`volume={0.008}`)

---

## Perfis de saída

| Perfil | Layout | Resolução | Composição | Duração padrão | Cenas |
|--------|--------|-----------|------------|----------------|-------|
| `vertical-short` | 9:16 | 1080×1920 | CodexShort | 100s | 8–18, dinâmico conforme `targetSeconds` |
| `horizontal-5m` | 16:9 | 1920×1080 | CodexWide | 300s | 20–30 |
| `horizontal-10m` | 16:9 | 1920×1080 | CodexWide | 600s | 30–42 |

---

## Presets visuais (10)

Cada preset define ~17 campos de prompt para guiar a geração de imagens.

| Preset | Estilo | Stickman |
|--------|--------|----------|
| `claude` (padrão) | Flat stick figure, white bg, corporate memphis | ✓ |
| `kiro` | Dark cinematic stick figure, strong contrast | ✓ |
| `editorial_clean` | Clean editorial illustration, crisp shapes | ✗ |
| `realistic_film` | Cinematic film still, documentary realism | ✗ |
| `cartoon_3d` | Stylized 3D cartoon, rounded forms | ✗ |
| `urban_sketching` | Ink line + watercolor wash, sketchbook feel | ✗ |
| `ink` | Editorial ink, crisp black brushwork | ✗ |
| `editorial_line_green` | B&W line art + subtle green accents | ✗ |
| `time_split_bold` | Bold comparison, hero object, past vs present | ✗ |
| `punk` | Punk poster, raw collage, torn-paper | ✗ |

---

## Web UI — Tabs e funcionalidades

### Tab "Criar"
- Formulário centrado em: título, texto-base, storyboard JSON externo, perfil de saída, duração, modo de geração, modelo de imagem, provedor de áudio, voz, canal e opções de execução
- Idioma, estilo visual e tom deixam de ser knobs primários no fluxo com storyboard pronto; o runtime resolve isso a partir do preset do canal e dos defaults do backend
- **Storyboard externo**: campo para colar ou carregar ficheiro JSON com storyboard pré-feito — salta a geração pelo Gemini e vai direto para assets + render. Se o storyboard externo incluir visual prompts por cena, o pipeline bypassa o preset visual selecionado. Validação inline mostra erros de JSON e contagem de cenas.
- **Modo dual-channel**: para `@ate2min` + `@quiet2min`, a UI aceita storyboard em `pt-BR`, cria o job base para `@ate2min`, traduz o pacote textual para inglês e enfileira um segundo job para `@quiet2min`, reaproveitando os mesmos assets visuais
- Submissão cria job na fila → SSE streaming de logs em tempo real
- Preview mode: gera só storyboard para aprovação antes do pipeline completo

### Tab "Pipeline"
- Lista de jobs com status, progresso, logs
- Ações: cancelar, retry, re-render voz, preparar áudio, render-only, validar-only, regenerar cena
- SSE streaming de logs por job
- Checklist de etapas por job (storyboard, assets, voz, render, QA)

### Tab "Biblioteca"
- Lista de vídeos exportados por canal
- Metadados editáveis: título interno, título de publicação, legenda curta para cross-post fora do YouTube, descrição base, hashtags, plataformas
- Publicação via agendador.online (Facebook, Instagram, YouTube)
- Download direto, preview de thumbnail
- TikTok helper: página HTML standalone para upload manual usando a legenda curta

### Tab "Estilos"
- Preview dos 10 presets visuais com imagens de exemplo
- Seleção de estilo para novas gerações

---

## API REST — Rotas principais

### Geração e pipeline
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/generate` | Cria job de geração (preview ou completo; aceita `storyboard` JSON externo e pode devolver dois jobs em modo dual-channel) |
| POST | `/api/approve-preview` | Aprova storyboard e lança pipeline completo |
| POST | `/api/rerender-voice` | Re-render com nova voz/provider |
| POST | `/api/jobs/:id/retry-from-storyboard` | Retry de job falhado a partir do storyboard existente |
| POST | `/api/jobs/:id/regenerate-missing-scene` | Regenera cena específica |
| POST | `/api/jobs/:id/approve-scene-attempt` | Aprova tentativa rejeitada de imagem para uma cena |
| POST | `/api/jobs/:id/generate-audio` | Prepara áudio sem render |
| POST | `/api/jobs/:id/render-only` | Render Remotion sem regenerar áudio |
| POST | `/api/jobs/:id/validate` | Executa QA sem re-render |
| POST | `/api/jobs/:id/force-fail` | Força job para estado falhado |
| POST | `/api/jobs/:id/resume` | Retoma job pausado/falhado |

### Consulta
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Snapshot operacional leve do processo/fila |
| GET | `/api/config` | Configuração da UI (vozes, modelos, canais, tons, perfis) |
| GET | `/api/openapi.yaml` | Spec OpenAPI servida pelo runtime |
| GET | `/api/docs/:name` | Docs markdown do runtime (`api-reference`, `operations-reference`) |
| GET | `/api/elevenlabs-voices` | Lista vozes ElevenLabs da conta (cache 5min) |
| GET | `/api/jobs` | Lista jobs (paginado: `?limit=50&offset=0`) |
| GET | `/api/jobs/:id` | Detalhes de um job |
| GET | `/api/jobs/:id/stream` | SSE streaming de logs |
| GET | `/api/jobs/:id/scenes` | Lista de cenas com assets do job |
| GET | `/api/jobs/:id/scene-review` | Galeria de tentativas rejeitadas para revisão manual |
| GET | `/api/runs` | Lista de runs com artefactos no disco |

### Biblioteca e publicação
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/videos` | Lista vídeos exportados |
| POST | `/api/videos/meta` | Atualiza metadados do vídeo, incluindo `publishTitle` e `socialCaption` |
| POST | `/api/videos/refazer` | Refaz vídeo existente |
| POST | `/api/videos/delete` | Remove vídeo da biblioteca |
| POST | `/api/videos/publish` | Publica via agendador.online, tentando enviar `title` separado quando suportado |
| POST | `/api/videos/tiktok-helper` | Gera draft TikTok para upload manual com título curto e legenda curta |
| POST | `/api/videos/:slug/reset-publish` | Limpa estado de publicação para republicar |

### Simulador
| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/api/simulador/generate` | Gera simulação de custo |
| GET | `/api/simulador/jobs` | Lista jobs do simulador |
| GET | `/api/simulador/video/:id` | Detalhes de vídeo simulado |
| DELETE | `/api/simulador/jobs/:id` | Remove job do simulador |

### Ficheiros
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/file` | Serve ficheiro por path (áudio, vídeo, imagem). Bloqueia `.env`, `.key`, `secrets.mjs`, `secrets.json`. |
| GET | `/tiktok-helper` | Página HTML standalone para upload TikTok |

Notas:
- O runtime aplica HTTP Basic Auth globalmente antes do dispatch das rotas.
- Se `VIDEO_STUDIO_PASSWORD` não estiver definido, o runtime gera uma password forte local e persiste em `.web-ui/runtime-auth.json`.

---

## Infraestrutura

### Serviço systemd

```ini
[Service]
Type=simple
WorkingDirectory=/root/repo/videos-flux2
Environment=WEB_HOST=0.0.0.0
Environment=WEB_PORT=3210
Environment=TMPDIR=/root/repo/videos-flux2/.tmp/system
Environment=REMOTION_CONCURRENCY=1
ExecStart=/usr/bin/node web/server.mjs
Restart=always
RestartSec=5
User=root
```

- TMPDIR redirecionado para `.tmp/system` (evita saturação do /tmp com frames Remotion)
- REMOTION_CONCURRENCY=1 em produção (override do .env)
- Auto-restart com 5s de delay

### Split opcional API + worker

O repo também suporta arranque separado:

- `deploy/codex-video-api.service`
- `deploy/codex-video-worker.service`

Papéis:
- `api`: UI/API HTTP, auth, docs, health, leitura/sync de jobs
- `worker`: execução da fila e child processes

O serviço legado `deploy/codex-video-ui.service` continua válido para modo unificado.

### Traefik (via Coolify)

```yaml
# /data/coolify/proxy/dynamic/video-vamostestar.yml
http:
  routers:
    video-vamostestar-https:
      rule: Host(`video.vamostestar.online`)
      entryPoints: [https]
      service: video-vamostestar-svc
      tls: {}
      middlewares: [secure-headers@file]
  services:
    video-vamostestar-svc:
      loadBalancer:
        servers:
          - url: 'http://host.docker.internal:3210'
```

Middlewares: HSTS (1 ano), X-Frame-Options DENY, X-Content-Type-Options nosniff, XSS filter.

---

## Fila dual-lane (job-queue.mjs)

| Lane | Concorrência | Timeout efetivo | Uso |
|------|-------------|------------------|-----|
| `preview` | 1 | 5min | Storyboard-only (rápido, ~30s) |
| `heavy` | 1 | por tipo de job | Generate, rerender, render-only, validate, recovery |

- Jobs são enfileirados por lane e processados FIFO
- Apenas 1 job ativo por lane (sem paralelismo)
- Timeout atual por tipo:
  - `generate`: 90min
  - `render-only`: 60min
  - `scene-regenerate`: 45min
  - `audio-prep`: 20min
  - `validate-only`: 15min
- Além do timeout máximo, existe timeout por inatividade e terminação da árvore inteira do processo
- Recovery automático: jobs `running` sem processo vivo são marcados como `failed`
- Persistência em `.web-ui/jobs.json`
- Em split `api` + `worker`, ambos os processos sincronizam o estado a partir deste snapshot

---

## QA — Validação (validate-run.mjs)

20+ checks executados após cada render:

| Check | Descrição |
|-------|-----------|
| `outputExists` | MP4 final existe e tem tamanho mínimo |
| `sceneCountOk` | Número de cenas dentro do range do perfil |
| `captionsHaveCoverage` | Legendas cobrem ≥80% da duração |
| `captionTimelineMonotonic` | Timestamps de legendas são monotónicos |
| `captionWordBoundsOk` | Frames de palavras dentro dos bounds da legenda |
| `captionsBoundedToSingleScene` | Cada legenda pertence a uma única cena |
| `visualAuditOk` | Auditoria visual local passou |
| `karaokeReady` | timedWords disponíveis para karaoke |
| `wordTimedCaptions` | Legendas têm word-level timing |
| `alignmentAvailable` | Alignment source disponível |
| `timedWordsSourceTrusted` | Source é gcloud-speech-stt, azure-word-boundary ou elevenlabs-alignment |
| `sceneTimelineMonotonic` | Frames de cenas são monotónicos |
| `sceneStartWordSyncOk` | Início de cena alinhado com primeira palavra |
| `sceneSpeechPacingOk` | Nenhuma cena com >7 palavras/s |
| `transitionsOk` | Cross-fades entre cenas corretos |
| `linkedNarration` | Narração cobre todas as cenas |
| `audioVideoSyncOk` | Drift áudio/vídeo < 5s |
| `sttAudioSyncOk` | STT timestamps dentro da duração do áudio |
| `sceneResolutionOk` | Clips com resolução adequada |
| `envatoOnly` | Todos os clips são de fonte local/Envato |
| `noTextFallback` | Nenhuma cena caiu para text-only |
| `clipCoverageOk` | 100% das cenas têm clip |
| `voiceProviderOk` | Provider de voz é premium (não macOS local) |

---

## Asset pipeline visual (generate-google-assets.mjs)

Geração de imagens é **remota via API Google** (Vertex AI Imagen, Gemini Flash Image ou Gemini Pro Image). Não há geração local de imagens; o processamento pesado local é o Remotion (render Chromium) e o ffmpeg.

```
1. Gemini planeja shots por cena → visual-plan.json
   ├─ Segmentos por cena (1–3 shots)
   ├─ Prompt detalhado por segmento
   └─ Guiado pelo visual style preset selecionado (bypass se storyboard externo com visual prompts)

2. Modelo de imagem gera PNGs por segmento (via API remota)
   ├─ Modelo padrão: gemini-3.1-flash-image-preview
   ├─ Alternativas: gemini-3-pro-image-preview, gemini-2.5-flash-image, imagen-4.0-*
   ├─ Resolução: 1024×1024 (escalado para 1080×1920 ou 1920×1080)
   └─ Retry com directivas progressivas (até 6 tentativas)

3. Gemini Vision audita cada imagem
   ├─ Verifica: anatomia, texto legível, props, framing, emoção
   ├─ Classifica falhas em 12 categorias (scene-failure-taxonomy.mjs)
   └─ Sugere estratégia de repair (mask_edit, crop_repair, retry_with_constraints)

4. Fallback para tentativas rejeitadas
   ├─ Se todos os attempts de um segmento falharem no audit, usa a melhor tentativa rejeitada
   ├─ Evita matar o job inteiro por uma cena com audit marginal
   └─ Log: "FALLBACK using rejected attempt (audit failed but usable)"

5. ffmpeg converte PNGs → scene-XX.mp4
   ├─ Ken Burns motion aplicado via filtro de vídeo
   ├─ Segmentos concatenados por cena
   └─ Output: assets/envato/{slug}/scene-XX.mp4
```

### Scene spec compiler (scene-spec.mjs)

Compila especificação estruturada por cena a partir do storyboard:
- **Subject**: person, device, animal, object, scene
- **Camera**: framing (closeup→wide), viewpoint (front→back), lens style
- **Pose**: body pose, hand/face visibility, interaction
- **Affect**: emotion, intensity, gaze direction
- **Environment**: location, allowed/forbidden props, clutter level
- **Risk flags**: 12 weighted flags (0–100+ score), 4 severity levels

---

## LLM — Providers e funções (llm-provider.mjs)

### Providers suportados
- `vertex` / `gemini` — Vertex AI Gemini (padrão em produção)
- `openrouter` — OpenRouter API (fallback)
- `codex` — Codex model (legacy)

### Funções principais
| Função | Uso |
|--------|-----|
| `generateStoryboard()` | Gera JSON com cenas, narração, hook, CTA, hashtags, thumbnailPrompt |

### Thumbnail Policy — TikTok Safe
- Thumbnail final continua em `1080x1920`, mas o layout assume recorte agressivo no TikTok.
- Usar apenas um bloco de texto no topo. Não repetir texto em baixo.
- Evitar texto no rodapé e não encostar headline na borda superior.
- O sujeito principal deve permanecer no centro visual da capa.
- Badge/handle de canal não entra mais no overlay final.
| `evaluateStoryboardQa()` | Valida storyboard pré-visual (word count, scene count, pacing) |
| `repairStoryboard()` | Reescreve storyboard com base no feedback da QA (até 3 tentativas) |
| `generateGraphicPlanStrict()` | Gera plano visual com queries de stock por cena |
| `callJsonProvider()` | Wrapper genérico para chamadas LLM com JSON schema |
| `pickSceneOverlay()` | Seleciona overlay text para cada cena |

### Tracking de custos (gemini-usage.mjs)
- Acumula tokens por modelo e contexto (storyboard, graphic-plan, repair)
- Pricing snapshot 2026-03-30: Flash $0.30/M input, $2.50/M output
- Persiste em `gemini-usage.json` por run

---

## Variáveis de ambiente

### Essenciais (video-engine/.env)

| Variável | Descrição | Default |
|----------|-----------|---------|
| `LLM_PROVIDER` | Provider LLM | `vertex` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path para service account JSON | — |
| `GOOGLE_CLOUD_PROJECT` | ID do projeto GCP | — |
| `TTS_PROVIDER` | Provider de voz | `google-gemini-tts` |
| `TTS_VOICE` | Voz padrão | `Iapetus` |
| `ELEVENLABS_API_KEY` | API key ElevenLabs | — |
| `ELEVENLABS_VOICE_ID` | Voice ID ElevenLabs | `TX3LPaxmHKxFdv7VOQHJ` |
| `AZURE_SPEECH_KEY` | API key Azure Speech | — |
| `VIDEO_LANGUAGE` | Idioma do vídeo | `pt-BR` |
| `MIN_SCENE_COUNT` | Mínimo de cenas | `14` |
| `MAX_SCENE_COUNT` | Máximo de cenas | `18` |
| `REMOTION_CONCURRENCY` | Threads de render | `2` (.env) / `1` (systemd) |
| `REMOTION_VIDEO_BITRATE` | Bitrate de vídeo | `1400k` |
| `CAPTION_WORDS_PER_CHUNK` | Palavras por legenda | `3` |

### ElevenLabs (completo)

| Variável | Default |
|----------|---------|
| `ELEVENLABS_API_KEY` | — |
| `ELEVENLABS_VOICE_ID` | `TX3LPaxmHKxFdv7VOQHJ` |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` |
| `ELEVENLABS_LANGUAGE_CODE` | `pt` |
| `ELEVENLABS_STABILITY` | `0.32` |
| `ELEVENLABS_SIMILARITY_BOOST` | `0.8` |
| `ELEVENLABS_STYLE` | `0.24` |
| `ELEVENLABS_USE_SPEAKER_BOOST` | `true` |
| `ELEVENLABS_SPEED` | `1` |

---

## Dependências principais

| Pacote | Versão | Uso |
|--------|--------|-----|
| `remotion` | 4.0.434 | Render de vídeo |
| `react` | ^19.1.0 | Composições Remotion |
| `dotenv` | ^16.6.1 | Env vars |
| `google-auth-library` | ^9.15.1 | Auth GCP |
| `microsoft-cognitiveservices-speech-sdk` | ^1.48.0 | Azure TTS |
| `zod` | 4.3.6 | Validação de schemas |
| `sharp` | 0.33.5 | Crop/resize de thumbnail AI |

---

## Comandos úteis

```bash
# Iniciar o servidor
node web/server.mjs

# Subir só a API/UI
node web/api-server.mjs

# Subir só o worker
node web/worker-engine.mjs

# Scripts npm equivalentes
npm run web
npm run web:api
npm run web:worker

# Gerar vídeo via CLI
node scripts/foiumaideia.mjs --title "Meu título"

# Gerar com ElevenLabs
node scripts/foiumaideia.mjs --title "Meu título" --provider elevenlabs

# Re-render com nova voz
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --provider elevenlabs

# Re-render reutilizando áudio existente
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --reuse-existing-audio

# Validar run existente
node video-engine/scripts/validate-run.mjs --slug MEU-SLUG

# Gerar apenas assets visuais (imagens via Vertex AI / Gemini API)
node scripts/generate-google-assets.mjs --slug MEU-SLUG

# Reiniciar serviço
systemctl restart codex-video-ui.service
```

---

## Changelog

### 2026-04-13 — Ajustes no preset `ink` e composição vertical

Contexto: o vídeo "A mulher que inventou o Wi-Fi" (estilo ink, modelo imagen-4.0-generate-001) apresentava fundo cinza degradê em vez de sólido, composição centralizada (rosto no meio do frame em vez do terço superior), e símbolos/ícones pouco legíveis em props.

#### Alterações em `config/visual-style-presets.mjs` (só preset `ink`)

| Campo | Antes | Depois |
|-------|-------|--------|
| `stylePrompt` | `...clean paper background...` | `...solid white or solid black background only, no gradient, no gray tones...` |
| `backgroundDirectives[0]` | `light paper or off-white neutral background...` | `solid white or solid black background only, no gradient, no gray fill, no degradé, no tonal transition` |
| `plannerGuidance` | (sem menção a ícones) | Adicionado: `When a prop carries a symbol or icon, describe it as large, bold, and immediately recognizable at thumbnail size.` |
| `scaleGuidance` | (sem menção a composição vertical) | Adicionado: `In vertical 9:16 frames, position the character's face and head in the upper third, leaving the lower third empty for captions.` |
| `attemptDirectives[4]` | `...clean paper contrast over muddy gray rendering` | `...solid white or solid black background, no gradient, no gray fill` |
| `refinePromptFinish` | `...clean paper background, no text` | `...solid white or black background, no gradient, no text` |

Nenhum outro preset foi alterado.

#### Alterações em `scripts/generate-google-assets.mjs`

- `buildImagePrompt()`: para layout vertical (9:16), o prompt de imagem agora inclui `Position the character's face and head in the upper third of the frame, leaving the lower third empty for caption overlays.` — esta instrução vai direto no prompt que o modelo de imagem lê.

#### Resultado do teste

Vídeo regenerado com os mesmos parâmetros (job `mnxg8ra1-e7nzca`, slug `-2`). QA passou (20+ checks ok). Resultado visual:

- **Fundo gradiente**: não resolvido. O prompt pede "solid white, no gradient" 3× (stylePrompt, backgroundDirectives, attemptDirectives) e o negative prompt inclui "gradient background", mas o modelo `imagen-4.0-generate-001` ignora e gera gradiente cinza em 16 de 20 imagens. Análise de pixels confirmou spread > 25 entre cantos e centro na maioria das imagens.
- **Composição vertical**: parcialmente melhor. ~30% das cenas com pessoa posicionaram o rosto no terço superior. As restantes mantiveram composição centralizada ou com sujeito no terço inferior.
- **Legibilidade de ícones**: sem dados comparativos suficientes para avaliar.

#### Conclusão e próximos passos identificados

O problema de fundo não é do prompt — é do modelo de geração. A galeria de estilos (`/estilos`) mostra que o `gemini-2.5-flash-image` respeita o estilo ink com fundo limpo, enquanto o `imagen-4.0-generate-001` adiciona gradientes. Opções identificadas:

1. **Modelo por preset**: usar `gemini-2.5-flash-image` para presets de ilustração (ink, claude, kiro, editorial_clean, etc.) e `imagen-4.0` para presets fotorealistas (realistic_film). Requer campo `preferredModel` no preset ou lógica de routing.
2. **Auditoria Gemini Vision**: adicionar check de fundo no bloco `STYLE_IS_INK` da auditoria visual para rejeitar imagens com gradiente e forçar regeneração.
3. **Pós-processamento**: threshold de fundo nas PNGs antes da conversão para MP4.
