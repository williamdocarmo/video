# Runtime Split

## Objetivo

Este documento descreve o split operacional agora suportado pelo runtime:

- `all`: HTTP API + worker no mesmo processo
- `api`: apenas servidor HTTP
- `worker`: apenas executor da fila

O split continua a usar `.web-ui/jobs.json` como snapshot compartilhado entre processos.

## Entry points

- `node web/server.mjs`
- `node web/api-server.mjs`
- `node web/worker-engine.mjs`

Scripts npm:

- `npm run web`
- `npm run web:api`
- `npm run web:worker`

## Variáveis relevantes

- `VIDEO_STUDIO_ROLE=all|api|worker`
- `WEB_PORT`
- `WEB_HOST`
- `WEB_DATA_DIR`

`WEB_DATA_DIR` permite isolar estado de jobs, drafts e auth runtime por ambiente ou teste.

## Modelo atual

### API mode

- expõe a UI e a API HTTP
- lê e sincroniza jobs a partir do snapshot em disco
- não executa a fila localmente

### Worker mode

- não abre porta HTTP
- sincroniza jobs a partir do snapshot em disco
- reconstrói a fila em memória e executa jobs queued

### All mode

- mantém o comportamento histórico
- útil para operação simples ou local

## Limites atuais

- não existe lock distribuído nem coordenação multi-worker
- o snapshot partilhado continua a ser `jobs.json`
- a solução é um passo intermédio de desacoplamento, não uma fila distribuída completa

## Arquivos de deploy

- `deploy/codex-video-api.service`
- `deploy/codex-video-worker.service`
- `deploy/codex-video-ui.service` permanece compatível com modo unificado
