# 2026-04-22 — Dual-channel, timeout hardening, publish copy, status

## Escopo

Resumo consolidado das mudanças implementadas nesta rodada e do estado operacional observado no runtime.

## O que foi implementado

### 1. Runtime e fila

- timeout por tipo de job, em vez de um único teto `heavy=30min`
- timeout por inatividade
- terminação da árvore inteira de processos em jobs travados
- mensagem de falha mais explícita em timeout/restart
- split operacional mantido em `all`, `api`, `worker`

### 2. UI principal

- simplificação da aba `Criar` para o fluxo real com storyboard JSON pronto
- remoção do peso operacional de idioma/estilo/tom como knobs primários no formulário
- nova aba `Template` com regras, prompt e JSON-base de storyboard
- opção de geração dupla para `@ate2min + @quiet2min`

### 3. Presets de canal

- `@ate2min` e `@quiet2min` agora seguem a mesma linha editorial:
  - verdade curta
  - tira da acomodação
  - não humilha
  - termina devolvendo dignidade, autoestima e força calma
- diferença principal: idioma
  - `@ate2min`: `pt-BR`
  - `@quiet2min`: `en-US`

### 4. Pipeline dual-channel

- a UI pode enviar um storyboard em `pt-BR` para os dois canais
- o backend cria:
  - job primário em `pt-BR` para `@ate2min`
  - job espelho em `en-US` para `@quiet2min`
- o job em inglês:
  - traduz apenas texto visível ao usuário
  - reaproveita os mesmos assets visuais via `reuseAssetsFromSlug`
  - depende da conclusão do job primário

### 5. Storyboard e assets

- suporte real a múltiplas imagens por cena via `scene.shots[]`
- `duration` por shot preservada
- `mustShow` por shot passou a aceitar inferência/fallback mais robusto
- template de Shorts ajustado para o padrão operacional atual:
  - `10–12` cenas
  - `28–32` imagens
  - `~54s–70s`

### 6. Publicação e copy

- separação entre:
  - `title`: título interno da biblioteca
  - `publishTitle`: título curto de publicação
  - `caption`: descrição base longa
  - `socialCaption`: legenda curta segura para cross-post fora do YouTube
- validação de limites:
  - `publishTitle`: `100` chars hard limit
  - `caption`: `5000`
  - `socialCaption`: `2200`
- `agendador.online` agora tenta enviar `title` separado no payload de publicação
- `TikTok helper` passa a usar `publishTitle` + `socialCaption`

### 7. Auth

- o runtime foi reconfigurado para aceitar novamente a password pedida pelo operador no arquivo de runtime local

## Limpeza e remoções

- remoção de informação de UI que já não fazia sentido no fluxo com storyboard pronto
- remoção de uma constante redundante no backend de publicação
- redução de drift documental entre README, runbook, API reference e OpenAPI

## Estado operacional observado

### Snapshot

- data de referência: `2026-04-22`
- runtime: saudável
- fila:
  - `1` job `running`
  - `1` job `queued`

### Par ativo de dual-channel

- primário `pt-BR`: `moaiscdm-3wtu1m`
- espelho `en-US`: `moaiscdm-18vil3`

### Situação observada

- o job primário avançou além do que a UI mostrava em alguns momentos
- a UI pode ficar defasada durante geração longa de assets
- o estado real deve ser confirmado com:
  - artefatos em `video-engine/assets/envato/<slug>/`
  - processo filho vivo
  - tempos de modificação recentes em `scene-XX.mp4`

## Pendência operacional

- as mudanças mais recentes de `publishTitle` / `socialCaption` já estão no código e validadas com `node --check`
- para entrarem em vigor no runtime HTTP atual, ainda é necessário reiniciar `web/server.mjs` depois que o job ativo terminar

## Arquivos principais afetados

- `web/server.mjs`
- `web/lib/job-execution.mjs`
- `web/lib/job-state.mjs`
- `web/lib/presets.mjs`
- `web/lib/video-library.mjs`
- `web/public/index.html`
- `web/public/app.js`
- `web/public/styles.css`
- `scripts/foiumaideia.mjs`
- `scripts/generate-google-assets.mjs`
- `video-engine/scripts/make-plan1-video.mjs`
- `video-engine/scripts/rerender-voice.mjs`
- `README.md`
- `PRODUCTION-RUNBOOK.md`
- `docs/api-reference.md`
- `docs/openapi.yaml`
- `docs/operations-reference.md`
