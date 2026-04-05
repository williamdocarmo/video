# video

Aplicação local para criar vídeos curtos com roteiro, imagens, voz, render final e publicação assistida. O foco atual é produção vertical para Shorts, Reels e TikTok, com geração via Google, render local via Remotion e operação por uma UI web em `:3210`.

## O que a aplicação faz

- cria preview de storyboard antes da render final
- gera imagens com Google Vertex
- valida storyboard antes das imagens e tenta se auto-corrigir quando a QA reprova
- sintetiza voz com Google Cloud Text-to-Speech usando Gemini-TTS
- extrai timestamps para legendas/karaokê
- renderiza o MP4 final com Remotion + ffmpeg
- guarda biblioteca local de vídeos finalizados e jobs falhados
- permite refazer jobs, editar metadados e publicar/agendar no `agendador.online`
- expõe helper local para upload manual no TikTok Web

## Defaults atuais

Para o fluxo principal `@foiumaideia`, a UI sobe com estes defaults:

- formato: `Vertical curto`
- duração: `60s`
- estilo de roteiro: `Short-form nativo`
- voz: `Iapetus`
- pipeline de imagem: `Google Vertex`

Presets de canal atuais:

- `@foiumaideia`: `pt-BR`, foco viral/history-tech
- `@quiet2min`: `en-US`, voz `Charon`
- `@ate2min`: `pt-BR`, voz `Iapetus`

## Stack

| Área | Tecnologia |
|---|---|
| UI local | Node.js + HTML/CSS/JS simples |
| Roteiro e QA textual | Gemini |
| Imagens | Google Vertex (`gemini-2.5-flash-image`) |
| QA visual | Gemini Vision + auditoria local |
| TTS | Google Cloud Text-to-Speech com modelo Gemini-TTS |
| STT / timestamps | Gemini |
| Render final | Remotion + React |
| Encodes | ffmpeg |
| Publicação | `agendador.online` |

## Fluxo da pipeline

1. O usuário cria um job na UI.
2. O backend grava o input e resolve preset de canal, idioma, voz e estilo.
3. O roteirista gera o storyboard.
4. A QA pre-visual valida hook, tom, final e coerência temática.
5. Se a QA reprovar, o pipeline reescreve o storyboard automaticamente e tenta de novo.
6. Com storyboard aprovado, o planner visual define cenas e exigências de imagem.
7. O gerador Vertex cria as imagens e a auditoria visual aprova ou pede retry.
8. O pipeline monta clipes por cena.
9. O TTS gera a narração e o STT extrai timestamps.
10. O Remotion gera o MP4 final.
11. A UI adiciona o vídeo à biblioteca local e permite publicação/agendamento.

## Estrutura principal

```text
/root/repo/videos-flux2
├── README.md
├── package.json
├── scripts/
│   ├── foiumaideia.mjs
│   ├── generate-flux2-assets.mjs
│   ├── generate-style-gallery.mjs
│   ├── make-batch.mjs
│   └── schedule-agendador-daily.mjs
├── video-engine/
│   ├── README.md
│   ├── scripts/
│   │   ├── make-plan1-video.mjs
│   │   ├── fetch-envato-overrides.mjs
│   │   ├── retry-agendador-failed-posts.mjs
│   │   └── lib/
│   │       ├── llm-provider.mjs
│   │       └── tts.mjs
│   ├── runs/
│   ├── out/
│   └── public/
├── web/
│   ├── server.mjs
│   └── public/
│       ├── index.html
│       ├── app.js
│       ├── styles.css
│       └── style-gallery/
└── .web-ui/
```

## Abas da UI

- `Criar`: novo vídeo, preview, fila e logs principais
- `Vídeos`: biblioteca de MP4 finalizados, falhados, metadados e publicação
- `Layout`: galeria de estilos visuais
- `Logs`: acompanhamento tipo `tail -f` dos jobs

## Estilos de roteiro

Hoje a UI expõe apenas os estilos que fazem sentido:

- `Natural limpo`
- `Short-form nativo`
- `Wellness • Calmo reconfortante`
- `Wellness • Soltar o peso do dia`

## Vozes expostas na UI

A UI foi reduzida para 5 vozes oficiais/recomendadas do conjunto usado no Google:

- `Iapetus` — melhor para `pt-BR` geral
- `Charon` — melhor para `en-US`
- `Kore` — tom firme
- `Puck` — shorts/energia
- `Sulafat` — acolhedora

O app usa Google Cloud TTS com modelo Gemini-TTS, não a Gemini API pública.

## Como rodar localmente

```bash
cd /root/repo/videos-flux2
npm run web
```

Ou exposto na rede:

```bash
cd /root/repo/videos-flux2
WEB_HOST=0.0.0.0 WEB_PORT=3210 npm run web
```

URL local de referência:

- `http://127.0.0.1:3210`
- `http://192.168.1.70:3210`

## Comandos úteis

```bash
# UI web
npm run web

# CLI principal
node scripts/foiumaideia.mjs --title "CHAMARAM O GPS DE PIADA"

# Lote
node scripts/make-batch.mjs

# Rerender de voz
node video-engine/scripts/rerender-voice.mjs --slug 2026-04-05-exemplo --voice Charon
```

## Publicação e thumbnails

- o pipeline gera thumbnail local para a biblioteca e para o helper do TikTok
- a biblioteca prioriza thumbnail local, não URL remota quebrada
- a aba `Vídeos` permite publicar/agendar no `agendador.online`
- o helper `TikTok Web` abre uma página local com MP4, descrição e thumbnail prontos

## O que foi ajustado recentemente

- defaults do app simplificados para Vertex
- limpeza do fluxo para não depender de motores antigos na UI
- auto-repair da QA do storyboard antes das imagens
- melhoria dos presets visuais
- galeria real dos estilos
- aba de logs com comportamento tipo `tail -f`
- biblioteca com jobs falhados e retry
- thumbnail local priorizada
- vozes reduzidas para um conjunto curado
- pacing do TTS mais conservador para reduzir `429`

## Serviço no boot

Este projeto agora usa um serviço `systemd` simples:

- nome: `codex-video-ui.service`
- working directory: `/root/repo/videos-flux2`
- porta: `3210`

Comandos de operação:

```bash
systemctl status codex-video-ui.service
systemctl restart codex-video-ui.service
journalctl -u codex-video-ui.service -f
```

## Repositório GitHub

O código pode ser publicado em:

- `https://github.com/williamdocarmo/video`

## Observações

- a UI é a fonte principal de operação
- runs antigas podem manter nomes legados como `generate-flux2-assets.mjs` e `_flux2_images`
- isso foi mantido por compatibilidade com jobs e artefatos já existentes
