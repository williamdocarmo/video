# CHANGELOG — Quality Sprint

## 2026-04-09 · Refatoração, limpeza e documentação

Escopo: redução do monolito `server.mjs`, extração de módulos, criação de utilitários compartilhados, tratamento de erros, documentação JSDoc e limpeza de artefatos.

---

### Métricas antes/depois

| Métrica | Antes | Depois | Δ |
|---------|-------|--------|---|
| `web/server.mjs` | 5 752 linhas | 3 336 linhas | **−42%** |
| Módulos em `web/lib/` | 0 | 9 (3 395 linhas) | — |
| Módulo compartilhado (`shared/`) | 0 | 1 (89 linhas) | — |
| Empty catch blocks | 54 | 0 | **−100%** |
| Arquivos com JSDoc | 0 | 11 (248 anotações) | — |
| Funções duplicadas entre arquivos | 30+ | ~15 | **−50%** |
| Lixo em disco (backups, debug, macOS) | ~82 MB | 0 | **−82 MB** |

---

### Módulos criados / extraídos

| Módulo | Linhas | Responsabilidade |
|--------|--------|------------------|
| `web/lib/job-state.mjs` | 734 | Inspeção de artefatos, checklist, ações de recovery |
| `web/lib/video-library.mjs` | 679 | CRUD de vídeos, metadados, export para `/root/postar/` |
| `web/lib/agendador.mjs` | 432 | Integração com agendador online |
| `web/lib/job-execution.mjs` | 390 | Spawn de processos, kill tree, montagem de comandos |
| `web/lib/utils.mjs` | 366 | Helpers HTTP, sanitização, formatação |
| `web/lib/presets.mjs` | 270 | Estilos visuais e perfis de saída |
| `web/lib/job-queue.mjs` | 191 | Fila dual-lane (preview + heavy), persistência |
| `web/lib/tiktok-helper.mjs` | 168 | Helper de publicação TikTok |
| `web/lib/routes.mjs` | 76 | Tabela de roteamento HTTP |
| `shared/utils.mjs` | 89 | `normalizeText`, `sleep`, `slugify`, `parseEnvFile`, `fileExists`, `loadJsonIfExists` |

---

### Arquivos limpos / removidos

| Categoria | Itens | Espaço |
|-----------|-------|--------|
| MP4 exports antigos na raiz | 6 arquivos | ~83 MB |
| `.env.bak`, `video-engine/.env.bak` | 2 arquivos | 2.7 KB |
| `scripts/generate-flux2-assets.mjs.bak` | 1 arquivo | 137 KB |
| `output.txt`, `report.txt`, `1`, `video-preview.html` | 4 arquivos | 58 KB |
| Metadados macOS (`._*`, `.DS_Store`) | 784+ arquivos | ~126 KB |
| `__pycache__/` | 2 diretórios | — |

---

### Outras melhorias

- 54 empty catches substituídos por logging ou justificativa documentada
- JSDoc adicionado a 11 arquivos (web/lib, shared, config) — 248 anotações `@param`/`@returns`/`@typedef`
- `shared/utils.mjs` elimina duplicação de 6+ funções que existiam em 4–10 cópias

---

### Próximos passos recomendados

| # | Item | Prioridade |
|---|------|------------|
| 1 | Resolver vulnerabilidades de segurança (secrets 0777, `/api/file` sem allowlist, root user) | Crítica |
| 2 | Continuar extração de `server.mjs` (SSE, static files, middleware) — meta: < 2 000 linhas | Alta |
| 3 | Substituir `jobs.json` (5 MB) por SQLite | Alta |
| 4 | Converter filesystem sync → async nos hot paths | Alta |
| 5 | Dividir `generate-flux2-assets.mjs` (3 800 linhas) em módulos | Média |
| 6 | Dividir `app.js` (3 001 linhas) em componentes frontend | Média |
| 7 | Cache de artefatos com TTL para `sanitizeJob()` | Média |
| 8 | Paralelizar geração de cenas (2–3 concurrent) | Média |
| 9 | Converter para npm workspaces | Baixa |
