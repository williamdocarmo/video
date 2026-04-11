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
Traefik (Docker, :443, Let's Encrypt TLS)
  │  ├─ redirect HTTP → HTTPS
  │  └─ secure-headers (HSTS, X-Frame-Options, etc.)
  │
  ▼
Node.js HTTP server (:3210, 0.0.0.0)
  │
  ├─ web/server.mjs .............. backend: API, fila, recovery, biblioteca, publicação
  ├─ web/public/ ................. frontend: app.js, index.html, styles.css
  │
  ├─ scripts/
  │   ├─ foiumaideia.mjs ......... orquestrador principal (preview → assets → pipeline → export)
  │   ├─ generate-flux2-assets.mjs geração visual (Gemini planner + Vertex Imagen + ffmpeg)
  │   └─ lib/ .................... scene-spec, scene-failure-taxonomy, etc.
  │
  ├─ video-engine/
  │   ├─ scripts/
  │   │   ├─ make-plan1-video.mjs  pipeline core (storyboard → voz → render → QA)
  │   │   ├─ rerender-voice.mjs .. re-render de voz/áudio
  │   │   ├─ validate-run.mjs .... validação QA (20+ checks)
  │   │   └─ lib/
  │   │       ├─ llm-provider.mjs  chamadas LLM (Vertex Gemini, OpenRouter, etc.)
  │   │       ├─ tts.mjs ......... TTS (Cloud Gemini TTS, Chirp3-HD, Azure, ElevenLabs)
  │   │       ├─ timings.mjs ..... timeline, pacing, legendas karaoke
  │   │       ├─ gcp-media.mjs ... Vertex AI image + multimodal
  │   │       └─ gcp-config.mjs .. config GCP (projeto, location, credenciais)
  │   ├─ src/
  │   │   ├─ ShortVideo.tsx ...... composição Remotion principal
  │   │   ├─ Root.tsx ............ registro de composições
  │   │   └─ types.ts ............ tipos dos render props
  │   ├─ runs/{slug}/ ............ storyboard, voiceover, render-props, reports
  │   ├─ public/runs/{slug}/ ..... áudio, vídeo servidos pelo Remotion
  │   ├─ assets/envato/{slug}/ ... scene-XX.mp4, _flux2_images/
  │   └─ out/{slug}.mp4 .......... saída final do Remotion
  │
  ├─ config/
  │   ├─ output-profiles.mjs ..... perfis de saída (vertical-short, horizontal-5m, horizontal-10m)
  │   └─ visual-style-presets.mjs  10 presets visuais (claude, kiro, ink, punk, etc.)
  │
  ├─ .web-ui/ .................... persistência: jobs.json, videos.json, inputs/, drafts
  └─ /root/postar/{canal}/ ...... export final organizado por canal
```

## Rede e acesso

O domínio `video.vamostestar.online` aponta para o servidor onde roda o app.

| Camada | Porta | Detalhe |
|--------|-------|---------|
| Traefik (Docker) | :443 / :80 | Reverse proxy com TLS via Let's Encrypt, redirect HTTP→HTTPS, headers de segurança |
| Node.js | :3210 | `http.createServer()` puro, sem TLS (TLS termina no Traefik) |

O Traefik encaminha `video.vamostestar.online` para `http://host.docker.internal:3210` com `passHostHeader: true`.

O serviço systemd (`codex-video-ui.service`) faz bind em `0.0.0.0:3210`:

```ini
[Service]
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

## Google Cloud Platform

Toda a geração de conteúdo passa pelo GCP:

| Serviço | Endpoint | Uso |
|---------|----------|-----|
| Vertex AI Gemini | `{location}-aiplatform.googleapis.com/.../models/{model}:generateContent` | Storyboard, plano visual, auditoria Vision, repair JSON |
| Vertex AI Imagen | `{location}-aiplatform.googleapis.com/.../models/{model}:predict` | Geração de imagens (Imagen 4 Fast, Imagen 4, Ultra) |
| Vertex AI Gemini Image | `{location}-aiplatform.googleapis.com/.../models/{model}:generateContent` | Geração de imagens via Gemini 2.5 Flash Image |
| Cloud TTS | `texttospeech.googleapis.com/v1/text:synthesize` | Voz (Gemini TTS + Chirp3-HD fallback) |
| Cloud STT | `speech.googleapis.com/v1/speech:recognize` | Timestamps palavra-a-palavra |
| Gemini API (público) | `generativelanguage.googleapis.com/v1beta/...` | Fallback LLM, fallback STT, TTS legacy |

Configuração:

```
Projeto:    project-79978184-3df0-40b2-b9f
Location:   us-central1
Auth:       Service account JSON → google-auth-library → OAuth2 Bearer tokens
LLM:        gemini-2.5-flash (Vertex)
TTS:        gemini-2.5-flash-tts (Cloud TTS) → Chirp3-HD fallback
Imagem:     imagen-4.0-fast-generate-001 (default) com fallbacks configuráveis
Vision:     gemini-2.5-flash (auditoria semântica de imagens)
```

APIs habilitadas: `aiplatform.googleapis.com`, `texttospeech.googleapis.com`, `speech.googleapis.com`, `cloudbilling.googleapis.com`

## Pipeline de vídeo

### Fluxo completo (heavy job)

```
1. UI: POST /api/generate
   └─ server.mjs cria job, enfileira na lane "heavy"

2. foiumaideia.mjs (orquestrador)
   ├─ 2a. Storyboard preview
   │   └─ make-plan1-video.mjs --preview-only
   │       └─ Gemini gera storyboard → QA local → repair automático (até 3x)
   │
   ├─ 2b. Assets visuais
   │   └─ generate-flux2-assets.mjs
   │       ├─ Para cada cena: Gemini planeja 1-8 shots
   │       ├─ Para cada shot: Vertex Imagen gera PNG
   │       ├─ Auditoria local + Gemini Vision por imagem
   │       ├─ Retry com directives progressivas (até 9 tentativas/shot)
   │       ├─ ffmpeg: PNG → clip estático MP4
   │       └─ ffmpeg: concat segmentos → scene-XX.mp4 (escrita atômica)
   │
   └─ 2c. Pipeline core
       └─ make-plan1-video.mjs
           ├─ Carrega storyboard aprovado
           ├─ Cloud TTS sintetiza narração → voiceover.mp3
           ├─ Cloud STT extrai timedWords (fallback: Gemini Flash STT → estimativa)
           ├─ buildTimeline() → frame ranges por cena + legendas karaoke
           ├─ Remotion renderiza MP4 final (x264, 1400k, 30fps)
           ├─ validate-run.mjs roda 20+ checks de QA
           └─ Copia para /root/postar/{canal}/
```

### Fluxo de preview

O preview gera apenas o storyboard (sem vídeo). Serve para inspeção e aprovação antes do heavy job.

### Fila e concorrência

Duas lanes independentes:
- `preview` — 1 job ativo por vez
- `heavy` — 1 job ativo por vez
- 1 preview + 1 heavy podem rodar em paralelo
- Jobs extras ficam em fila

## Render (Remotion)

Versão: Remotion 4.0.434

| Composição | Dimensões | FPS | Uso |
|------------|-----------|-----|-----|
| `CodexShort` | 1080×1920 | 30 | Vertical shorts (9:16) — default |
| `CodexWide` | 1920×1080 | 30 | Horizontal (16:9) |
| `CaptionStyleDemo` | 1080×1920 | 30 | Preview de estilos de legenda |

O componente `ShortVideo.tsx` renderiza:
- Backgrounds por cena (imagem com Ken Burns ou vídeo em loop)
- Overlay gradiente escuro
- Título/hook com animação spring
- Legendas karaoke com highlight palavra-a-palavra (5 estilos: `bold-tiktok-block`, `clean-broadcast`, `soft-karaoke`, `outline-punch`, `caption-strip`)
- Áudio: narração + música de fundo opcional (8% volume)

Encoding: x264 veryfast, 1400k video, 96k audio, timeout 30 min.

## Perfis de saída

| Perfil | Layout | Resolução | Duração default | Cenas |
|--------|--------|-----------|-----------------|-------|
| `vertical-short` | 9:16 | 1080×1920 | 100s | 14-18 |
| `horizontal-5m` | 16:9 | 1920×1080 | 300s | 20-30 |
| `horizontal-10m` | 16:9 | 1920×1080 | 600s | 30-42 |

## Estilos visuais

10 presets, cada um com ~15 campos de prompt (characterPrompt, stylePrompt, styleLockPrompt, compositionRules, etc.):

| Preset | Descrição |
|--------|-----------|
| `claude` | Stick figure flat, fundo branco, editorial corporativo |
| `kiro` | Stick figure dark/cinematic, contraste forte |
| `editorial_clean` | Ilustração editorial limpa |
| `realistic_film` | Look cinematográfico realista |
| `cartoon_3d` | Estilo cartoon 3D |
| `urban_sketching` | Sketch urbano / aquarela |
| `ink` | Ilustração a tinta |
| `editorial_line_green` | Line art editorial com acentos verdes |
| `time_split_bold` | Tratamento visual bold com split temporal |
| `punk` | Estética poster punk |

## Modelos de imagem

| Modelo | Id | Uso |
|--------|-----|-----|
| Imagen 4 Fast | `imagen-4.0-fast-generate-001` | padrão atual |
| Gemini 2.5 Flash Image | `gemini-2.5-flash-image` | iteração rápida |
| Imagen 4 | `imagen-4.0-generate-001` | qualidade equilibrada |
| Imagen 4 Ultra | `imagen-4.0-ultra-generate-001` | qualidade máxima |

## Vozes

Conjunto curado para Cloud TTS (Gemini TTS + Chirp3-HD):
- `Iapetus` (default pt-BR)
- `Charon` (default en-US)
- `Kore`
- `Puck`
- `Sulafat`

## Canais

| Canal | Idioma | Foco |
|-------|--------|------|
| `@foiumaideia` | pt-BR | internet / short-form / tech |
| `@quiet2min` | en-US | wellness / calm |
| `@ate2min` | pt-BR | geral |

## UI (Video Studio)

4 abas:

- **Criar** — formulário de criação, job atual, preview, checklist, ações de recovery
- **Pipeline** — lista de jobs com filtro/busca, log detalhado em tempo real (SSE)
- **Biblioteca** — grid de vídeos finais, metadados editáveis, publicação/agendamento, helper TikTok
- **Estilos** — galeria de estilos visuais, comparação de modelos

## Recovery pela UI

O backend analisa o estado em disco de cada job e oferece ações granulares:

| Ação | Quando usar |
|------|-------------|
| `Regenerar cena X` | Cena faltante ou corrompida |
| `Gerar áudio` | Todas as cenas OK, falta voz/timestamps |
| `Renderizar vídeo` | Áudio + render-props existem, falta MP4 |
| `Validar vídeo` | MP4 existe, falta QA |
| `Retomar a partir do ponto salvo` | Storyboard + cenas + áudio existem |
| `Refazer a partir do storyboard` | Storyboard reaproveitável, estado inconsistente |
| `Marcar como travado` | Processo preso, liberar fila |

Auto-continue: `Regenerar cena X` encadeia automaticamente → próxima cena faltante → áudio → render → QA.

Ordem preferida: Regenerar cena → Gerar áudio → Renderizar → Validar.

## Filosofia de QA

Bloqueia: storyboard inválido, incoerência estrutural, off-topic, falha técnica.
Aviso (não bloqueia): hook fraco, final fraco, CTA ruim, tom editorial fraco.

Gemini Vision Audit (`GEMINI_VISION_AUDIT=true` em produção):
- Bloqueia: assunto errado, imagem corrompida, anatomia impossível, texto legível
- Permite: estilo simplificado, telas com conteúdo abstrato, cues simbólicos de outage

## Estrutura de artefatos por slug

```
video-engine/runs/{slug}/storyboard.json ......... storyboard final
video-engine/runs/{slug}-preview/storyboard.json .. storyboard preview
video-engine/runs/{slug}/voiceover.json ........... metadados de voz + timedWords
video-engine/public/runs/{slug}/audio/voiceover.mp3 áudio final
video-engine/runs/{slug}/render-props.json ........ props do Remotion
video-engine/out/{slug}.mp4 ....................... saída do Remotion
video-engine/assets/envato/{slug}/scene-XX.mp4 .... clips de cena
video-engine/assets/envato/{slug}/_flux2_images/ ... PNGs e segmentos intermediários
/root/postar/{canal}/{arquivo}.mp4 ................ export final
```

## Serviço e operação

```bash
systemctl status codex-video-ui.service
systemctl restart codex-video-ui.service
journalctl -u codex-video-ui.service -f
```

Antes de reiniciar, verificar que não há jobs ativos:

```bash
python3 - <<'PY'
import urllib.request, json
with urllib.request.urlopen('http://127.0.0.1:3210/api/jobs') as r:
    data=json.load(r)
print({k:data.get(k) for k in ['activeJobId','activePreviewJobId','activeHeavyJobId','queueLength']})
PY
```

Só reiniciar quando todos forem `null` / `0`.

## Comandos úteis

```bash
npm run web                                          # subir a UI
node scripts/foiumaideia.mjs --title "TITULO AQUI"   # gerar vídeo via CLI
node video-engine/scripts/rerender-voice.mjs --slug SLUG --voice Charon  # re-render voz
node video-engine/scripts/validate-run.mjs --slug SLUG                   # validação manual
npm run test:flux2-rules                             # regressão regras de tela
npm run test:scene-spec                              # regressão scene spec
npm run test:scene-failure-taxonomy                  # regressão taxonomia de falhas
```

## Logs e diagnóstico

```bash
curl -s http://127.0.0.1:3210/api/jobs    # ver jobs
curl -s http://127.0.0.1:3210/api/videos  # ver vídeos
curl -s http://127.0.0.1:3210/api/config  # ver config
```

## Bugs conhecidos

1. **Slug compartilhado** — `runs/`, `assets/envato/`, `out/` são indexados por slug. Tentativas diferentes do mesmo slug compartilham artefatos.
2. **UI não lista clips de cena** — falta botão nativo para `scene-XX.mp4` no painel do job.
3. **`/tmp` pode saturar** — Remotion usa /tmp para frames intermediários. Mitigado com TMPDIR redirecionado para `.tmp/system`.
4. **Quotas 429** — podem acontecer em geração de imagem, Gemini Vision e TTS. Retry com backoff exponencial implementado.

## Próximas ondas

1. Criar modelo `video_case` + `job_attempt` (eliminar conflitos de slug)
2. Versionar artefatos por revisão
3. Listar clips de cena na UI
4. Tornar `Biblioteca` o cockpit principal

## Validação rápida

```bash
python3 - <<'PY'
import urllib.request, json
with urllib.request.urlopen('http://127.0.0.1:3210/api/jobs') as r:
    jobs=json.load(r)
with urllib.request.urlopen('http://127.0.0.1:3210/api/videos') as r:
    videos=json.load(r)
print({
  'activeJobId': jobs.get('activeJobId'),
  'queueLength': jobs.get('queueLength'),
  'jobs': len(jobs.get('jobs', [])),
  'videos': len(videos.get('videos', [])),
  'failedJobs': len(videos.get('failedJobs', []))
})
PY
```
