# video-engine

Motor de storyboard, voz, timings, render e validação usado pela UI web e pelos wrappers do projeto.

Documento principal:
- para operação de produção, recovery, systemd, billing, modelos de imagem e bugs conhecidos, use primeiro [README.md](/root/repo/videos-flux2/README.md)

Este README foca no motor.

## Papel do engine

O `video-engine` recebe storyboard e assets e fecha:
- voz
- timestamps / karaoke
- render final
- QA final

Também participa da geração completa quando o wrapper/UI disparam o fluxo end-to-end.

## Fluxo atual

Hoje o engine é normalmente invocado por:
- [scripts/foiumaideia.mjs](/root/repo/videos-flux2/scripts/foiumaideia.mjs)
- [web/server.mjs](/root/repo/videos-flux2/web/server.mjs)

O caminho normal em produção **não** é mais um uso manual de `--asset-mode` como fonte principal de operação. O fluxo atual é UI-first + jobs parciais.

## Arquivos principais

- [scripts/make-plan1-video.mjs](/root/repo/videos-flux2/video-engine/scripts/make-plan1-video.mjs)
- [scripts/validate-run.mjs](/root/repo/videos-flux2/video-engine/scripts/validate-run.mjs)
- [scripts/rerender-voice.mjs](/root/repo/videos-flux2/video-engine/scripts/rerender-voice.mjs)
- [scripts/lib/llm-provider.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/llm-provider.mjs)
- [scripts/lib/tts.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/tts.mjs)
- [scripts/lib/timings.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/timings.mjs)
- [scripts/lib/gcp-media.mjs](/root/repo/videos-flux2/video-engine/scripts/lib/gcp-media.mjs)

## Scripts úteis

```bash
cd /root/repo/videos-flux2/video-engine

# make completo, se precisar usar o engine direto
npm run make -- --title "Exemplo"

# validar um run existente
npm run validate -- --slug "2026-04-06-exemplo"

# rerender de voz sem recriar imagens
node scripts/rerender-voice.mjs --slug 2026-04-06-exemplo --voice Charon
```

## Defaults relevantes

Os defaults reais vêm do backend/wrapper, não deste README.

Hoje, no app:
- TTS: Google Cloud Gemini-TTS
- LLM textual: Vertex/Gemini
- imagem: Vertex com seleção por modelo na UI
- render: Remotion + ffmpeg

## Recovery suportado

O engine já suporta partes do recovery:
- `audio-prep`
- `render-only`
- `validate-only`
- `scene-regenerate` no wrapper de assets

Mas a recuperação ainda é **job-centric**, não revision-centric. Em `same slug`, ainda existe risco de mistura de artefatos antigos.

## Custos e uso

Fontes locais de uso:
- `runs/<slug>/gemini-usage.json`
- `assets/envato/<slug>/gemini-usage.json`
- `runs/<slug>/agent-report.json`

Importante:
- o valor local é estimativa operacional
- não substitui billing oficial do GCP
- custos de imagem/TTS devem ser lidos no contexto do projeto e do billing export

## Known issues do engine

- `same slug` ainda compartilha namespace de artefatos
- partial regeneration ainda pode sobrescrever metadata global do slug
- reuso de render ainda não está totalmente pinado por revisão real de áudio/cenas/música
- quotas `429` podem ocorrer em Vertex/TTS

## Regra prática

Se o objetivo for operar o produto:
- use a UI e o `README` principal

Se o objetivo for depurar o motor:
- abra os arquivos acima
- valide os artefatos do `slug`
- confirme sempre se está a olhar para a tentativa certa, e não só para o `slug`
