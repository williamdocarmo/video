# Ops And Recovery Log — 2026-04-17

## Escopo

Este documento consolida o trabalho operacional e de produto executado nesta rodada de ajustes no projeto. O foco foi:

- bugs e configuração errada
- robustez de recovery e render
- correções de UI ligadas ao fluxo real de criação
- redução de falsos positivos no QA
- organização da biblioteca local de música

Não cobre revisão de segurança.

## 1. Auditoria inicial do `codex.md`

Foi feita uma validação prática dos apontamentos do `codex.md`, ignorando segurança e priorizando bugs/configuração.

### Confirmado como problema real

- scripts quebrados no `video-engine/package.json` (`envato:session`, `envato:download`)
- retenção infinita de jobs e vazamento do mapa de streams em `web/server.mjs`
- risco de `E2BIG` ao passar props enormes inline para resume/render
- upload de vídeo comprimido em `web/lib/agendador.mjs` carregando arquivo inteiro em memória
- arquivos temporários `jobs.json.*.tmp` acumulando em `.web-ui`
- inconsistência entre rota `:id` e `body.jobId`
- docs e runtime desalinhados em TTS providers
- default de voz do rerender preferindo Azure mesmo quando o provider era outro
- `top.md` desatualizado
- chave `background` duplicada em `video-engine/src/ShortVideo.tsx`

### Não confirmado / exagerado

- suposto problema geral de body size ilimitado
- suposta inconsistência entre implementações de `parseEnvFile`
- suposto leak simples de listeners no frontend por re-render
- alegação de race não atómica no queue worker
- alegação de que jobs retomados saltavam `handleAutoContinue`

## 2. Correções estruturais aplicadas

### Backend / queue / recovery

Arquivos principais:

- [web/server.mjs](/root/repo/videos-flux2/web/server.mjs)
- [web/lib/job-state.mjs](/root/repo/videos-flux2/web/lib/job-state.mjs)
- [web/lib/agendador.mjs](/root/repo/videos-flux2/web/lib/agendador.mjs)

### Mudanças

- retenção de jobs concluídos/falhados por tempo/quantidade
- limpeza de `jobs.json.*.tmp`
- limpeza efetiva de entradas vazias em `streams`
- validação consistente entre o ID da rota e o ID enviado no body
- resume/render passando a usar arquivo de props em vez de JSON inline
- upload de vídeo usando blob/stream em vez de ler o arquivo inteiro na memória
- remoção do arquivo comprimido temporário após upload
- recovery source ajustado para preferir o `generate` completo e não o preview

## 3. Correções no engine / render

Arquivos principais:

- [video-engine/scripts/rerender-voice.mjs](/root/repo/videos-flux2/video-engine/scripts/rerender-voice.mjs)
- [video-engine/scripts/make-plan1-video.mjs](/root/repo/videos-flux2/video-engine/scripts/make-plan1-video.mjs)
- [video-engine/scripts/validate-run.mjs](/root/repo/videos-flux2/video-engine/scripts/validate-run.mjs)
- [video-engine/src/ShortVideo.tsx](/root/repo/videos-flux2/video-engine/src/ShortVideo.tsx)

### Mudanças

- renderizações do engine também passaram a usar arquivo de props temporário
- default da voz no rerender passou a respeitar o provider selecionado
- QA final deixou de reprovar shorts de até 60s com 8 cenas válidas
- prop duplicada removida em `ShortVideo.tsx`

## 4. Correção do bug ElevenLabs em `ate2min` e `quiet2min`

Arquivo principal:

- [web/public/app.js](/root/repo/videos-flux2/web/public/app.js)

### Problema

Ao trocar canal ou idioma, o form reconstruía a lista de vozes como se o provider fosse sempre Google. Isso derrubava a seleção de `ElevenLabs`.

### Correção

- a UI passou a reconstruir as vozes respeitando o provider real
- o payload deixou de cair no fallback do canal quando o provider escolhido é `elevenlabs`

### Efeito

- `ate2min` e `quiet2min` mantêm corretamente a escolha de `ElevenLabs`

## 5. Ajuste visual da tab Criar a partir do `mac.txt`

Arquivos principais:

- [web/public/index.html](/root/repo/videos-flux2/web/public/index.html)
- [web/public/styles.css](/root/repo/videos-flux2/web/public/styles.css)

### Mudanças

- layout em formato de workspace
- coluna principal para briefing
- coluna lateral sticky para configurações e disparo
- status mantido abaixo em largura total
- sistema visual mais sóbrio e consistente

## 6. Falha real na cena 2 e solução implantada

Caso:

- slug: `2026-04-16-voce-nao-esta-atrasado-voce-esta-distraido`

### Problema encontrado

A cena 2, segmento 1, falhava na auditoria do Gemini Vision. O conceito era um personagem multitarefa com múltiplos braços simbólicos, mas a auditoria interpretava isso como anatomia quebrada.

Além disso, o prompt positivo pedia múltiplos braços, enquanto o `negativePrompt` também proibia `extra arms` e `duplicate limbs`.

### Mudanças aplicadas

Arquivo principal:

- [scripts/generate-google-assets.mjs](/root/repo/videos-flux2/scripts/generate-google-assets.mjs)

### Correções

- cenas que explicitamente pedem braços extras simbólicos deixam de receber termos negativos contraditórios
- o audit visual aceita múltiplos braços quando isso é intencional e legível
- ainda reprova quando a anatomia está fundida, incoerente ou ilegível

## 7. Revisão manual de imagem rejeitada no site

Arquivos principais:

- [web/server.mjs](/root/repo/videos-flux2/web/server.mjs)
- [web/public/app.js](/root/repo/videos-flux2/web/public/app.js)
- [web/public/index.html](/root/repo/videos-flux2/web/public/index.html)
- [web/public/styles.css](/root/repo/videos-flux2/web/public/styles.css)

### O que foi criado

- endpoint `GET /api/jobs/:id/scene-review`
- endpoint `POST /api/jobs/:id/approve-scene-attempt`
- painel de revisão no detalhe do job
- cards com todas as tentativas rejeitadas disponíveis
- botão `Aprovar e continuar`

### O que acontece ao aprovar

- a tentativa aprovada vira a imagem final do segmento
- o clip do segmento é reconstruído
- o clip final da cena é refeito
- os manifestos são atualizados com `approved-manual`
- o recovery continua sem precisar regenerar tudo

## 8. Recuperação completa do vídeo problemático

### Fluxo executado

- aprovação manual da cena 2, segmento 1, usando a tentativa 5
- geração do áudio de recovery
- render-only do vídeo final
- validação QA final

### Resultado

- o vídeo foi concluído com sucesso
- arquivo final:
  - [2026-04-16-voce-nao-esta-atrasado-voce-esta-distraido.mp4](/root/repo/videos-flux2/video-engine/out/2026-04-16-voce-nao-esta-atrasado-voce-esta-distraido.mp4)
- resolução confirmada:
  - `1080x1920`
- size aproximado:
  - `37 MB`

## 9. Música de fundo: estado atual

### Comportamento confirmado

- a opção de música depende do checkbox do site
- o texto do roteiro não força música
- se `Sem música de fundo` estiver marcado, o job sai sem trilha
- se o checkbox estiver desmarcado, o app tenta escolher uma `track-*` válida aleatoriamente

### Volume

- o volume da trilha está fixo em `0.02`
- arquivo:
  - [video-engine/src/ShortVideo.tsx](/root/repo/videos-flux2/video-engine/src/ShortVideo.tsx)

### Observação

- o render do vídeo recuperado saiu sem música
- `musicPath: null` em `render-props.json`

## 10. Limpeza da biblioteca de música

Pasta:

- `/root/Documents/scripts/envato/music`

### Trilhas quebradas removidas

- `track-001.mp3`
- `track-010.mp3`
- `track-026.mp3`
- `track-037.wav`
- `track-057.mp3`
- `track-058.wav`
- `track-092.mp3`
- `track-094.mp3`

### Estado após limpeza

- total restante de `track-*`: `92`

## 11. Catálogo da biblioteca de música

Script criado:

- [scripts/catalog-background-music.mjs](/root/repo/videos-flux2/scripts/catalog-background-music.mjs)

Arquivos gerados:

- [catalog.json](/root/Documents/scripts/envato/music/catalog.json)
- [catalog.csv](/root/Documents/scripts/envato/music/catalog.csv)
- [catalog.md](/root/Documents/scripts/envato/music/catalog.md)

### O que o catálogo registra

- nome do arquivo
- duração
- formato
- bitrate
- size
- metadata disponível
- classificação simples de uso sugerido

### Resumo do catálogo gerado

- `92` faixas válidas catalogadas
- `15` marcadas como `foiumaideia|shorts`
- `25` marcadas como `ate2min|quiet2min`
- `48` marcadas como `any`
- `3` marcadas como `stinger-only`

### Limitação atual

Quase todas as faixas não têm metadata rica de gênero/mood. Então a catalogação atual é boa para operação, mas não substitui curadoria manual de gosto.

## 12. Documentação atualizada

Arquivos alterados:

- [CHANGELOG.md](/root/repo/videos-flux2/CHANGELOG.md)
- [README.md](/root/repo/videos-flux2/README.md)
- [top.md](/root/repo/videos-flux2/top.md)

### Motivo

- alinhar documentação com o comportamento real do sistema
- deixar histórico das mudanças operacionais recentes

## 13. Próximo passo adiado

Ficou explicitamente adiado para depois:

- curadoria manual curta de 10–15 trilhas, marcando:
  - `calm / ate2min`
  - `calm / quiet2min`
  - `short / foiumaideia`
  - `avoid`

## 14. Estado final desta rodada

### Resolvido

- bloqueio de criação por cena rejeitada sem saída prática
- bug de seleção de ElevenLabs nos canais principais
- QA final arbitrário para vídeo curto com 8 cenas válidas
- presença de trilhas quebradas na biblioteca local
- falta de catálogo operacional da biblioteca de música

### Ainda não feito

- curadoria humana de gosto das trilhas
- classificação musical fina por canal/tom
- impedir por código que o randomizer use trilhas ruins apenas por metadata insuficiente, mesmo quando o arquivo é tecnicamente válido
