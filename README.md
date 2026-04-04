# APOS-KIRO — Pipeline Automatizada de Videos Curtos

Pipeline end-to-end para gerar videos curtos verticais (TikTok/Reels/Shorts) a partir de um titulo ou texto-base. O projeto hoje expõe uma UI web local para criar previews, render final, biblioteca de MP4 exportados, reprocessar jobs falhados e preparar publicação para `agenda.online`.

## Defaults atuais da UI

Para o canal `@foiumaideia`, a UI já sobe com estes defaults:

- duracao: `60s`
- motor de imagem: `Google Vertex`
- estilo de roteiro: `Short-form nativo`
- voz: `Iapetus`
- estilo de imagem do preset do canal: `Editorial Line Green`

Esses defaults são servidos por `web/server.mjs` e aplicados pela UI em `web/public/app.js`.

## Stack

| Componente | Tecnologia | Onde roda |
|---|---|---|
| **Roteiro** | Gemini 3.1 Pro Preview | API Google |
| **Visual Planning** | Gemini 2.0 Flash | API Google |
| **Vision QA** | Gemini 2.0 Flash | API Google |
| **Geracao de imagens** | FLUX2 Klein 9B (MLX 4-bit) | Local (Apple Silicon) |
| **Refinamento (opcional)** | SDXL Refiner (diffusers + MPS) | Local (Apple Silicon) |
| **Upscale (opcional)** | Lanczos + Unsharp Mask | Local |
| **Text-to-Speech** | Gemini 2.5 Flash Preview TTS (voz Schedar) | API Google |
| **Speech-to-Text** | Gemini Flash (timestamps palavra-a-palavra) | API Google |
| **Render de video** | Remotion + React | Local |
| **Audio/Video** | ffmpeg | Local |

## Estilo Visual

O projeto nao está mais preso a um unico visual. A UI expõe múltiplos presets, incluindo:

- `Editorial Clean`
- `Realistic Film`
- `Cartoon 3D`
- `Urban Sketching`
- `Ink`
- `Editorial Line Green`
- `Time Split Bold`
- `Punk Poster`

O preset padrão do canal `@foiumaideia` é `Editorial Line Green`: line art preto e branco com acentos verdes sutis, cara de editorial moderno e ambiente detalhado.

## Como funciona

```
Titulo
  |
  v
[Gemini] Gera roteiro (storyboard) com 14-18 cenas
  |         - 3 fases: gerar → revisar → ajustar duracao
  |         - Narracoes em PT-BR, queries de busca em ingles
  v
[Gemini] Planeia shots visuais por cena (1-8 shots cada)
  |         - Decompoe narracoes em beats visuais
  |         - Define objetos obrigatorios, composicao, iluminacao
  |         - Estilo stick figure com icones flat
  v
[FLUX2] Gera imagens localmente (576x1024, 8 steps)
  |         - Uma imagem por shot planejado
  |         - Estilo: stick figure / corporate memphis
  |         - Audit local (OCR, formato, tamanho)
  |         - Audit semantico (Gemini Vision valida vs narracoes)
  |         - Retry automatico com seed diferente se falhar
  v
[SDXL] Refina imagens em batch com img2img (denoise 0.3, float32 MPS)
  |         - Modelo carrega uma vez, processa todas as imagens
  |         - ~33s por imagem no Apple Silicon
  v
[Upscale] 2x Lanczos + unsharp mask para nitidez final
  v
[ffmpeg] Converte imagens em clips de video
  |         - Concatena clips por cena → scene-XX.mp4
  v
[Gemini TTS] Sintetiza narracao completa
  |         - Voz Schedar, estilo natural e fluido
  |         - Compressao de silencios entre frases
  v
[Gemini Flash STT] Extrai timestamps palavra-a-palavra
  |         - Ancoragem por silencio para sync preciso
  |         - Karaoke word-by-word com destaque amarelo
  v
[Remotion] Renderiza video final (1080x1920 @ 30fps)
  |         - Cenas com transicoes cross-fade
  |         - Legendas karaoke estilo TikTok
  |         - Titulo + hook animados na intro
  v
video.mp4
```

## Tempo por fase (benchmark real — video de 97s, 16 cenas, 20 imagens)

| Fase | Tempo | % | Detalhe |
|---|---|---|---|
| Storyboard (Gemini LLM) | ~15s | 1% | 3 fases: gerar + revisar + ajustar |
| Visual Planning (Gemini Flash) | ~20s | 1% | 16 cenas planejadas |
| **FLUX2 Imagens (20 imgs)** | **~11min** | **42%** | ~33s por imagem (576x1024, 8 steps, MLX 4-bit) |
| Audits (local + Gemini Vision) | ~60s | 4% | OCR + head detection + semantic check por img |
| **SDXL Refine (20 imgs, batch)** | **~11min** | **42%** | ~9s load + ~33s/img (float32, MPS, modelo carrega 1x) |
| Upscale (Lanczos 2x + sharpen) | ~5s | <1% | 576x1024 → 1152x2048 |
| ffmpeg clips | ~20s | 1% | PNG → MP4 static clip |
| TTS (Gemini) | ~30s | 2% | Narracao completa + compressao silencios |
| STT / Karaoke | ~10s | <1% | 272 palavras, timestamps palavra-a-palavra |
| **Remotion Render** | **~90s** | **6%** | ~3000 frames @ 6 threads concorrentes |
| **Total (run limpa)** | **~26min** | **100%** | Para um video de ~100 segundos |

**Nota**: Em caso de falha parcial, o pipeline reutiliza imagens e clips ja gerados (nao regenera do zero).
Os gargalos sao FLUX2 e SDXL (~42% cada). O SDXL usa batch mode (carrega modelo 1x, processa todas as imagens). O Remotion e o terceiro (6%).

## Uso

### UI web local

```bash
npm run web
```

A UI fica disponível por padrão em `http://127.0.0.1:3210` e pode ser exposta na rede com:

```bash
WEB_HOST=0.0.0.0 WEB_PORT=3210 npm run web
```

Na UI existem duas áreas principais:

- `Criar e fila`: preview, aprovação, render e logs em tempo real
- `Vídeos`: biblioteca dos MP4 exportados, jobs falhados, edição local de caption/hashtags, ação de refazer e publicação no `agenda.online`

### CLI

```bash
# Gerar um video completo
node scripts/foiumaideia.mjs --title "O titulo do video" --open

# Com opcoes
node scripts/foiumaideia.mjs \
  --title "Explicando AGI de forma simples" \
  --target-seconds 120 \
  --open

# Re-renderizar com voz diferente (reutiliza cenas existentes)
node video-engine/scripts/rerender-voice.mjs \
  --slug 2026-03-25-meu-video \
  --voice Schedar

# Gerar em lote
node scripts/make-batch.mjs
```

## Estrutura do Projeto

```
APOS-KIRO/
├── .env                              # Config principal (paths, chaves e credenciais opcionais do agendador)
├── foiumaideia                       # Shell wrapper para o CLI
├── scripts/
│   ├── foiumaideia.mjs               # CLI principal — orquestra toda a pipeline
│   ├── generate-flux2-assets.mjs     # Gera imagens FLUX2 + visual planning + vision audit
│   ├── sdxl-refine-and-upscale.py    # Refinamento SDXL img2img + upscale (opcional)
│   ├── local-flux2-visual-audit.py   # Audit local de imagens (OpenCV + Tesseract)
│   ├── make-batch.mjs                # Execucao em lote de multiplos videos
│   ├── retry-batch-report.mjs        # Retry de falhas em batch
│   └── schedule-agendador-daily.mjs  # Agendamento de publicacao
│
├── video-engine/                     # Motor de video (Remotion + scripts de pipeline)
│   ├── .env                          # Config do motor (TTS, Remotion, cenas)
│   ├── package.json
│   ├── tsconfig.json
│   ├── remotion.config.ts
│   │
│   ├── src/                          # Componentes Remotion (React)
│   │   ├── index.ts                  # Entry point do Remotion
│   │   ├── Root.tsx                  # Composicao raiz
│   │   ├── ShortVideo.tsx            # Componente principal do video
│   │   └── types.ts                  # Tipos TypeScript
│   │
│   ├── scripts/
│   │   ├── make-video.mjs            # Orquestrador do Plano 1 (storyboard → render)
│   │   ├── make-plan1-video.mjs      # Geracao de storyboard com Gemini
│   │   ├── fetch-envato-overrides.mjs # Resolve assets locais (FLUX2) ou Envato
│   │   ├── rerender-voice.mjs        # Re-render com nova voz/estilo TTS
│   │   ├── validate-run.mjs          # Validacao E2E do video gerado
│   │   ├── generate-voice-samples.mjs # Gera amostras de voz para comparacao
│   │   ├── store-secrets-in-keychain.mjs # Armazena chaves no Keychain do macOS
│   │   └── retry-agendador-failed-posts.mjs # Retry de publicacoes falhadas
│   │
│   │   └── lib/
│   │       ├── llm-provider.mjs      # Integracao LLM (Gemini, OpenRouter)
│   │       ├── tts.mjs               # TTS (Gemini) + STT (timestamps) + sync
│   │       ├── timings.mjs           # Timeline, captions, karaoke timing
│   │       ├── story-flow.mjs        # Conectores entre cenas (PT-BR)
│   │       ├── secrets.mjs           # Gestao de credenciais (Keychain)
│   │       ├── used-assets.mjs       # Registro de assets usados
│   │       └── storage-cleanup.mjs   # Limpeza de artefatos temporarios
│   │
│   ├── public/                       # Assets estaticos para Remotion
│   │   └── runs/{slug}/             # Audio e video por execucao
│   │
│   └── runs/                         # Dados de cada execucao
│       └── {slug}/
│           ├── storyboard.json       # Roteiro gerado
│           ├── render-props.json     # Props finais para Remotion
│           ├── voiceover.json        # Dados de voz (timestamps, metadata)
│           ├── agent-report.json     # Relatorio de execucao
│           ├── audio/                # voiceover.mp3
│           └── qa/                   # Screenshots de validacao
│
├── assets/envato/{slug}/            # Imagens e clips gerados
│   ├── scene-XX.mp4                 # Clips de video por cena
│   ├── _flux2_images/               # PNGs gerados pelo FLUX2
│   ├── flux2-manifest.json          # Manifesto de geracao
│   └── visual-plan.json             # Plano visual do Gemini
│
├── web/                             # UI local para gerar, acompanhar e gerir a biblioteca
│   ├── server.mjs                   # API local + servidor estático da UI
│   └── public/                      # Frontend
│
└── test-styles/                     # Testes de estilos visuais
```

## Componentes Principais

### `scripts/foiumaideia.mjs` — CLI Principal
Ponto de entrada. Recebe titulo, gera slug com data, delega para `make-plan1-video.mjs` (storyboard) e `generate-flux2-assets.mjs` (imagens), depois renderiza com Remotion.

### `scripts/generate-flux2-assets.mjs` — Geracao de Imagens
Para cada cena do storyboard:
1. **Gemini** planeia shots visuais (composicao, objetos, iluminacao)
2. **FLUX2** gera imagem localmente no Apple Silicon (MLX 4-bit)
3. **Audit local** verifica formato, tamanho, OCR (Tesseract)
4. **Gemini Vision** valida se a imagem corresponde semanticamente a cena
5. Se falhar, regenera com seed diferente (ate 3 tentativas)
6. **(Opcional) SDXL** refina com img2img (denoise 0.3) + upscale Lanczos 2x
7. **ffmpeg** converte imagem em clip de video

### `scripts/sdxl-refine-and-upscale.py` — Refinamento SDXL (Opcional)
Pipeline em 2 fases:
1. **SDXL img2img** com denoise baixo (0.2-0.4) preserva composicao FLUX2, melhora texturas
2. **Lanczos upscale** 2x/4x com unsharp mask para nitidez final
- Usa diffusers + MPS (Apple Silicon)
- Ativado via `SDXL_ENABLED=true` e `UPSCALE_ENABLED=true` no `.env`

### `video-engine/scripts/lib/tts.mjs` — Voz e Sincronizacao
- Sintetiza narracao com **Gemini 2.5 Flash TTS** (voz Schedar)
- Comprime silencios longos entre frases (max 0.4s)
- Extrai timestamps palavra-a-palavra com **Gemini Flash STT**
- Ancora timestamps por detecao de silencio no audio (ffmpeg silencedetect)
- Sanity check: reverte ancoragem se timestamps ficarem inconsistentes

### `video-engine/scripts/lib/llm-provider.mjs` — Geracao de Roteiro
Pipeline LLM em 3 fases:
1. **Gerar** storyboard inicial (14-18 cenas com narracoes PT-BR)
2. **Revisar** alinhamento visual (cada narracao deve ser ilustravel como stick figure)
3. **Ajustar** duracao (expandir ou comprimir para atingir target de palavras)

Validacao Zod garante estrutura correta. Fallback hardcoded se LLM falhar.

### `video-engine/src/ShortVideo.tsx` — Componente Remotion
Video React renderizado frame-a-frame:
- Cenas com background video/gradiente e transicoes cross-fade
- Legendas karaoke (palavra ativa em amarelo, scale 1.06x)
- Titulo + hook animados com spring na intro
- Safe zone de 420px no fundo para UI do TikTok

### `video-engine/scripts/rerender-voice.mjs` — Re-render de Voz
Re-renderiza video existente com nova voz/estilo sem regenerar imagens. Util para iterar rapidamente sobre a voz.

## Configuracao

### `.env` (raiz) — FLUX2, SDXL e Gemini

| Variavel | Descricao | Default |
|---|---|---|
| `FLUX2_MODEL` | Modelo FLUX2 MLX | `AITRADER/FLUX2-klein-9B-mlx-4bit` |
| `FLUX2_WIDTH` / `FLUX2_HEIGHT` | Resolucao da imagem | `576` x `1024` |
| `FLUX2_STEPS` | Steps de inferencia | `8` |
| `FLUX2_GUIDANCE` | Guidance scale | `1.0` |
| `SDXL_ENABLED` | Ativar refinamento SDXL | `false` |
| `SDXL_MODEL` | Modelo SDXL refiner | `stabilityai/stable-diffusion-xl-refiner-1.0` |
| `SDXL_DENOISE` | Forca de denoise (0.0-1.0) | `0.3` |
| `SDXL_STEPS` | Steps SDXL | `25` |
| `UPSCALE_ENABLED` | Ativar upscale Lanczos | `false` |
| `UPSCALE_FACTOR` | Multiplicador de upscale | `2` |
| `GOOGLE_API_KEY` | Chave API Google (Gemini) | — |
| `GEMINI_MODEL` | Modelo LLM para roteiro/planning | `gemini-3.1-pro-preview` |
| `DEFAULT_ASSET_MODE` | Modo de geracao | `flux2` |

### `video-engine/.env` — TTS e Render

| Variavel | Descricao | Default |
|---|---|---|
| `TTS_PROVIDER` | Provider de voz | `google` |
| `GOOGLE_TTS_MODEL` | Modelo TTS | `gemini-2.5-flash-preview-tts` |
| `GOOGLE_TTS_VOICE` | Voz | `Schedar` |
| `REMOTION_CONCURRENCY` | Threads de render | `6` |
| `REMOTION_SCALE` | Escala de render | `0.75` |
| `MIN_SCENE_COUNT` / `MAX_SCENE_COUNT` | Limites de cenas | `14` / `18` |
| `TARGET_DURATION_SECONDS` | Duracao alvo | `100` |
| `VIDEO_LANGUAGE` | Idioma | `pt-BR` |

## Custo por Video

| Componente | Custo estimado |
|---|---|
| Gemini LLM (roteiro + planning) | ~$0.01 |
| Gemini Vision (audit de imagens) | ~$0.003 |
| Gemini TTS (narracao) | ~$0.01 |
| Gemini STT (timestamps) | ~$0.005 |
| FLUX2 (imagens) | $0 (local) |
| SDXL refine (opcional) | $0 (local) |
| Remotion (render) | $0 (local) |
| **Total** | **~$0.03/video** |

## Ultimo Video Gerado

**Titulo**: "Seu celular está ficando inteligente demais? Entenda isso"
**Data**: 2026-03-26
**Slug**: `2026-03-26-seu-celular-esta-ficando-inteligente-demais-entenda-isso`
**Duracao**: 97.1 segundos
**Cenas**: 16 cenas, 20 imagens stick figure
**Resolucao**: 810x1440 (scale 0.75) / 1080x1920 nativo
**Tamanho**: 18.4 MB
**Narrador**: 272 palavras, voz Schedar
**Estilo**: Stick figure / corporate memphis

## Requisitos

- macOS com Apple Silicon (M1/M2/M3/M4)
- Node.js 20+
- Python 3.10+ (para audit visual e SDXL)
- ffmpeg
- Tesseract OCR (`brew install tesseract`)
- OpenCV Python (`pip install opencv-python numpy`)
- FLUX2 MLX (`pip install mflux`)
- diffusers + torch (`pip install diffusers torch`) — para SDXL (opcional)
- Chave API Google (Gemini)
