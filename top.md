# top.md — Documentation Map

> Repo: `/root/repo/videos-flux2`
> Last updated: 2026-04-22

## Scope

Este repositório já contém o sistema Node usado para a UI/API e para o worker de geração de vídeos:

- runtime unificado: `web/server.mjs`
- API/UI separada: `web/api-server.mjs`
- worker separado: `web/worker-engine.mjs`
- frontend estático: `web/public/`
- engine de voz/render/QA: `video-engine/`

Não existe `pipeline.py` neste checkout. Referências antigas a outro repositório local/macOS devem ser consideradas obsoletas.

## Reading Order

1. [README.md](/root/repo/videos-flux2/README.md)
2. [PRODUCTION-RUNBOOK.md](/root/repo/videos-flux2/PRODUCTION-RUNBOOK.md)
3. [docs/runtime-split.md](/root/repo/videos-flux2/docs/runtime-split.md)
4. [docs/operations-reference.md](/root/repo/videos-flux2/docs/operations-reference.md)
5. [docs/api-reference.md](/root/repo/videos-flux2/docs/api-reference.md)
6. [docs/openapi.yaml](/root/repo/videos-flux2/docs/openapi.yaml)
7. [docs/2026-04-22-dual-channel-publish-update.md](/root/repo/videos-flux2/docs/2026-04-22-dual-channel-publish-update.md)
8. [video-engine/README.md](/root/repo/videos-flux2/video-engine/README.md)

## Current Notes

- O `README.md` é a visão geral principal da arquitetura, fluxo, perfis e operação local.
- O `PRODUCTION-RUNBOOK.md` cobre operação em produção, recovery e workflow operacional.
- O `docs/runtime-split.md` descreve os papéis `all`, `api` e `worker`.
- O `docs/operations-reference.md` resume o modelo operacional atual, incluindo dual-channel, publicação e limitações reais da fila.
- O `docs/api-reference.md` e o `docs/openapi.yaml` formalizam o contrato HTTP atual.
- O `docs/2026-04-22-dual-channel-publish-update.md` consolida a rodada de timeout hardening, dual-channel e limites de publicação.
- O `video-engine/README.md` detalha o motor de storyboard, TTS, timings, render e QA.
- Documentos antigos de "style consistency" citados em versões anteriores deste arquivo não estão presentes neste repositório e não devem ser usados como fonte de verdade.

## Bottom Line

Se houver conflito entre notas antigas e o código atual, use o código, o `README.md`, o `PRODUCTION-RUNBOOK.md` e os documentos em `docs/` como referência.
