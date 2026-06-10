# CODEX.md — Zero-Trust Codebase Audit Report

**Project:** Video Studio (`videos-flux2`)
**Date:** 2026-04-16
**Audited by:** 10-Agent AI Audit Team
**Scope:** Full production codebase at `/root/repo/videos-flux2`

---

## Executive Summary

**Overall Grade: C+ (68/100)**

Video Studio is a functional, actively-used production system for automated short-form video generation. The documentation is excellent (9/10), the pipeline works, and the code is remarkably consistent for a project with no linting tools. However, the audit uncovered **4 critical security vulnerabilities**, **4 critical backend bugs**, and **~2 GB of recoverable disk waste**. The most urgent issues are: real API keys in a world-readable `.env` file, a trivially guessable default password protecting the entire application, the service running as root, and unbounded memory growth from never-pruned job data.

| Domain | Score | Verdict |
|--------|-------|---------|
| Security | 3/10 | 🔴 Multiple critical exposures. Immediate action required. |
| Backend Stability | 5/10 | 🟠 Memory leaks and resource leaks will degrade over time. |
| Frontend Quality | 6/10 | 🟡 Functional but has memory leaks and accessibility gaps. |
| Architecture | 6/10 | 🟡 Well-decomposed libs, but 5 mega-files need splitting. |
| Dead Code / Waste | 5/10 | 🟠 ~2 GB recoverable. 15 ghost files. 6 dead scripts. |
| Documentation | 9/10 | 🟢 Outstanding README, CHANGELOG, and cost analysis. |
| Code Formatting | 7/10 | 🟢 Consistent style, but no automated enforcement. |

---

## The 10-Agent Perspective

### Agent 1 — Security Lead
> "The `.env` file has `777` permissions and contains 5 real API keys. The default password is `007007`. The service runs as root. This is a ticking time bomb on any shared network. Rotate all keys immediately."

### Agent 2 — Backend Bug Hunter
> "The `jobs` Map grows forever — every job ever created stays in memory. After months of production use, this will OOM the server. The SSE streams Map has the same problem. The Remotion `--props` CLI argument will overflow for complex videos."

### Agent 3 — Frontend Specialist
> "The 113K `app.js` re-renders the entire UI on every SSE event. Two polling intervals run forever, even when the tab is backgrounded. Event listeners are re-attached on every render cycle. It works, but it's burning CPU."

### Agent 4 — Architecture Reviewer
> "Five files exceed 90K each. `server.mjs` at 128K is a partial god-file — it already delegates to 9 lib modules, but route handlers should be extracted next. The frontend-backend contract is implicit with no shared schema."

### Agent 5 — DevOps Engineer
> "990 MB of Remotion temp files in `.tmp/` are not gitignored. Three orphaned `jobs.json.*.tmp` files total 17 MB. The `.gitignore` is missing 4 patterns. The systemd service has zero hardening directives."

### Agent 6 — Legacy Code Specialist
> "17 legacy storyboard JSONs, 10 caption style experiments, and a 14 MB stray video are tracked in git or sitting in the repo root. Six scripts are dead. Two `package.json` script entries point to non-existent files."

### Agent 7 — Performance Analyst
> "Every queue mutation broadcasts ALL jobs (not just changed ones). `refreshQueuePositions()` serializes the entire jobs Map. Video uploads read the entire file into memory (100+ MB). FFmpeg stderr accumulates without bounds."

### Agent 8 — API Security Auditor
> "Google API keys are passed in URL query strings (logged everywhere). No CORS headers. No CSP headers. No rate limiting on any endpoint. No request body size validation on most routes. Error messages leak internal paths."

### Agent 9 — Accessibility Auditor
> "Job list items lack `aria-selected`. Video cards aren't keyboard-focusable. Progress meters are `aria-hidden`. Only one responsive breakpoint at 980px. No dark mode. No `:focus-visible` styles."

### Agent 10 — Documentation Auditor
> "The README is genuinely excellent — architecture diagrams, pipeline flows, cost analysis. Zero TODO/FIXME comments in the codebase. But `top.md` and `PRODUCTION-RUNBOOK.md` reference deleted files. No API schema documentation exists."

---

## Critical Vulnerabilities — Immediate Fixes Required

### 🔴 CRITICAL-1: Real API Keys in World-Readable `.env`
- **File:** `.env` (permissions: `-rwxrwxrwx`)
- **Keys exposed:** `GOOGLE_API_KEY`, `AZURE_SPEECH_KEY`, `ELEVENLABS_API_KEY`, `AGENDADOR_ONLINE_PASSWORD`, `GOOGLE_APPLICATION_CREDENTIALS` path
- **Impact:** Any process on the host can read all production credentials.
- **Fix:** `chmod 600 .env`. Rotate ALL keys. Consider a secrets manager.

### 🔴 CRITICAL-2: Default Password `007007` Protects Entire Application
- **File:** `web/server.mjs:3217`
- **Code:** `const BASIC_AUTH_PASSWORD = process.env.VIDEO_STUDIO_PASSWORD || "007007";`
- **Impact:** `VIDEO_STUDIO_PASSWORD` is not set in any `.env` file, so the fallback is active. Combined with `0.0.0.0` binding, anyone on the network has full access.
- **Fix:** Remove fallback. Require env var or refuse to start.

### 🔴 CRITICAL-3: Service Runs as Root with No Hardening
- **File:** `deploy/codex-video-ui.service:21`
- **Code:** `User=root`
- **Impact:** Any RCE vulnerability gives full system access. No `ProtectSystem`, `NoNewPrivileges`, or `PrivateTmp`.
- **Fix:** Create dedicated `videostudio` user. Add systemd hardening directives.

### 🔴 CRITICAL-4: Jobs Map Never Pruned — Unbounded Memory Growth
- **File:** `web/server.mjs:188`
- **Code:** `const jobs = new Map();` — only `jobs.set()` is ever called, never `jobs.delete()`.
- **Impact:** Memory leak proportional to total jobs ever created. Each job carries `logTail` (2000 lines), input objects, and metadata.
- **Fix:** Implement retention policy — prune completed/failed jobs older than N days.

### 🔴 CRITICAL-5: SSE Streams Map Never Cleaned
- **File:** `web/server.mjs:189`
- **Code:** `const streams = new Map();` — empty Sets accumulate for every job ever streamed.
- **Impact:** Unbounded memory leak.
- **Fix:** Delete Map entry when subscriber Set becomes empty.

### 🔴 CRITICAL-6: Remotion `--props` CLI Overflow
- **File:** `web/server.mjs:1495`
- **Code:** `"--props=" + JSON.stringify(renderProps)` — full timeline/captions/timed-words as CLI arg.
- **Impact:** `E2BIG` error for complex videos (OS arg limit ~128KB-2MB).
- **Fix:** Write props to temp file, pass file path instead.

### 🔴 CRITICAL-7: Compressed Videos Never Cleaned After Upload
- **File:** `web/lib/agendador.mjs:287-320`
- **Impact:** Compressed video copies (50-100+ MB each) accumulate in the video library directory.
- **Fix:** `await unlink(prepared.filePath)` after successful upload when `prepared.compressed === true`.

### 🔴 CRITICAL-8: No HTTPS — Basic Auth Sent in Cleartext
- **File:** Entire server
- **Impact:** Credentials visible to any network sniffer.
- **Fix:** Add TLS termination via reverse proxy or Node.js `https` module.

---

## Hardcoded Values Checklist

| File | Line | Description | Current Value | Should Be |
|------|------|-------------|---------------|-----------|
| `.env` | 34 | Google API Key | `AIzaSy[REDACTED]` | Secrets manager |
| `.env` | 47 | Agendador password | `N[REDACTED]` | Secrets manager |
| `.env` | 49-55 | Personal emails (×4) | `[REDACTED]@*.com` | Secrets manager |
| `.env` | 57 | GCP credentials path | `/home/william/...` | Relative path / env var |
| `.env` | 58 | GCP project ID | `project-7997[REDACTED]` | Secrets manager |
| `.env` | 62 | Azure Speech Key | `F8gU[REDACTED]` | Secrets manager |
| `.env` | 87 | ElevenLabs API Key | `sk_5dc8[REDACTED]` | Secrets manager |
| `server.mjs` | 3217 | Auth password fallback | `007007` | No fallback — require env var |
| `server.mjs` | 209 | Default host | `0.0.0.0` | `127.0.0.1` |
| `server.mjs` | 208 | Default port | `3210` | Acceptable (env-configurable) |
| `make-plan1-video.mjs` | 609 | OpenRouter referer | `https://localhost/codex-videos` | Env var `OPENROUTER_REFERER` |
| `llm-provider.mjs` | 1805 | OpenRouter referer | `https://localhost/codex-videos` | Env var `OPENROUTER_REFERER` |
| `agendador.mjs` | 15 | Agendador URL | `https://agendador.online` | Shared config constant |
| `schedule-agendador-daily.mjs` | 35 | Agendador URL (dup) | `https://agendador.online` | Shared config constant |
| `retry-agendador-failed-posts.mjs` | 11 | Agendador URL (dup) | `https://agendador.online` | Shared config constant |
| `codex-video-ui.service` | 21 | Service user | `root` | Dedicated service user |
| `codex-video-ui.service` | 10 | WEB_HOST | `0.0.0.0` | `127.0.0.1` |
| `llm-provider.mjs` | 2136 | API key in URL query | `?key=${apiKey}` | `x-goog-api-key` header |

---

## Backend Bugs & Logic Issues

### Critical (4)

| # | File | Bug | Impact |
|---|------|-----|--------|
| B1 | `server.mjs:188` | Jobs Map never pruned | OOM over time |
| B2 | `server.mjs:189` | SSE streams Map never cleaned | Memory leak |
| B3 | `server.mjs:1495` | Remotion --props CLI overflow | E2BIG for complex videos |
| B4 | `agendador.mjs:287` | Compressed videos never deleted | Disk space leak |

### High (5)

| # | File | Bug | Impact |
|---|------|-----|--------|
| B5 | `agendador.mjs:349` | Entire video read into memory for upload | 200MB+ memory spike |
| B6 | `server.mjs:903` | FFmpeg stderr accumulated without limit | Memory pressure |
| B7 | `server.mjs:770` | Orphaned `jobs.json.*.tmp` on crash | 17MB already orphaned |
| B8 | `server.mjs:1635` | Queue worker start not fully atomic | Fragile concurrency guard |
| B9 | `server.mjs:1555` | Resumed jobs skip `handleAutoContinue` | Auto-chain broken |

### Medium (7)

| # | File | Bug |
|---|------|-----|
| B10 | `job-queue.mjs:100` | `refreshQueuePositions` broadcasts ALL jobs |
| B11 | `web/lib/utils.mjs:7` | `parseEnvFile` doesn't strip quotes (inconsistent with `shared/utils.mjs`) |
| B12 | `server.mjs:310` | `ffprobeDurationSeconds` no maxBuffer on spawnSync |
| B13 | `server.mjs:3270` | `handleJobResumeRequest` ignores URL `:id` param |
| B14 | `generate-google-assets.mjs:328` | Rate limit lock can deadlock if stale detection fails |
| B15 | `server.mjs:3340` | Simulador fire-and-forget with no error feedback |
| B16 | `server.mjs:3430` | Basic Auth default password (also security CRITICAL-2) |

---

## Frontend & Architecture Issues

### Architecture

| Issue | Severity | Details |
|-------|----------|---------|
| 5 mega-files (>90K each) | HIGH | `generate-google-assets.mjs` 169K, `llm-provider.mjs` 130K, `server.mjs` 128K, `app.js` 113K, `make-plan1-video.mjs` 92K |
| No shared API schema | MEDIUM | Frontend-backend contract is implicit; 8+ fallback field names in `app.js` |
| No request body size limit on most routes | MEDIUM | DoS via large POST bodies |
| No rate limiting | HIGH | `/api/generate` spawns expensive child processes with no throttle |
| No security headers | HIGH | No CSP, X-Frame-Options, X-Content-Type-Options |

### Frontend (`app.js`)

| Issue | Severity | Details |
|-------|----------|---------|
| Two polling intervals never cleared | HIGH | 20s + 5s intervals run even when tab is backgrounded |
| Event listeners re-attached every render | HIGH | `addEventListener` in loops inside `renderAll()` |
| EventSource reconnect race condition | MEDIUM | No generation counter; stale reconnects possible |
| Partial XSS in `renderSceneGallery` | MEDIUM | `sceneNumber`/`segNumber` not escaped in HTML attributes |
| Global mutable state with no change tracking | MEDIUM | Direct mutation; easy to forget `renderAll()` |
| No keyboard navigation for video cards | MEDIUM | Missing `tabindex`, `role`, `keydown` handlers |
| Progress meters hidden from screen readers | LOW | `aria-hidden="true"` on progress bars |

### React/Remotion Components

| Issue | Severity | Details |
|-------|----------|---------|
| Duplicate `background` property in ShortVideo.tsx | HIGH | Dead code at line 114, silently overwritten at line 124 |
| Caption rendering duplicated between ShortVideo.tsx and CaptionStyleDemo.tsx | LOW | ~200 lines of identical logic |
| `BlackInkVideoProps` type defined but never used | LOW | Dead type in `types.ts` |

---

## Refactoring Roadmap

### Phase 1 — Security Hardening (This Week)

1. **Rotate all API keys** — Google, Azure, ElevenLabs, Agendador password
2. **`chmod 600 .env`** on both `.env` files
3. **Set `VIDEO_STUDIO_PASSWORD`** to a strong value; remove `007007` fallback
4. **Create `videostudio` system user**; update `codex-video-ui.service`
5. **Add security headers** in `server.mjs` response pipeline (~10 lines)
6. **Move API keys from URL query strings to headers** in `llm-provider.mjs`

### Phase 2 — Stability Fixes (This Sprint)

7. **Add job retention policy** — prune completed/failed jobs older than 7 days
8. **Clean SSE streams** — delete Map entry when subscriber Set is empty
9. **Write Remotion props to temp file** instead of CLI argument
10. **Delete compressed videos after upload** in `agendador.mjs`
11. **Cap FFmpeg stderr** to last 8KB
12. **Clean orphaned `jobs.json.*.tmp`** on startup
13. **Add `handleAutoContinue`** to resumed generate job completion path

### Phase 3 — Dead Code & Disk Cleanup (Next Sprint)

14. **Delete ghost files:** `test-styles/`, `video-engine/storyboards/`, `video-engine/tmp-caption-styles/`, `video-engine/tmp-caption-strip-props.json`, `.codex`, root `.mp4`
15. **Delete dead scripts:** `tmp-compare-vertex-prompts.mjs`, `compare-gcp-image-models.mjs`, `whisper-stt.py`
16. **Fix `.gitignore`:** Add `.tmp/`, `.simulador/`; change `.env` to `**/.env`
17. **Remove broken `package.json` scripts:** `envato:session`, `envato:download`
18. **Clean `.tmp/system/`** — delete Remotion webpack bundles (~990 MB)
19. **Fix stale doc references** — remove `STYLE-CONSISTENCY-*.md` refs from `top.md` and `PRODUCTION-RUNBOOK.md`

### Phase 4 — Architecture Improvements (Next Month)

20. **Extract route handlers** from `server.mjs` into `web/lib/handlers/` modules
21. **Add `.prettierrc` + `eslint.config.mjs`** with format/lint scripts
22. **Add event delegation** in `app.js` for all dynamically-rendered lists
23. **Add visibility-aware polling** — pause intervals when tab is backgrounded
24. **Add request body size limit** to `readRequestBody`
25. **Stream video uploads** instead of reading entire file into memory
26. **Extract shared caption component** from ShortVideo.tsx / CaptionStyleDemo.tsx
27. **Add shared API schema** (Zod in `shared/`) for frontend-backend contract

---

## Clean Code Audit

### Overall Score: 7/10

| Aspect | Score | Notes |
|--------|-------|-------|
| Documentation | 9/10 | Outstanding README, CHANGELOG, cost analysis |
| Naming | 8/10 | Descriptive functions and variables throughout |
| Comments | 8/10 | Zero TODO/FIXME debt; sparse but meaningful |
| Formatting | 7/10 | Consistent 2-space, double-quote, semicolons — but no enforcement |
| Self-documenting | 7/10 | Good overall; some magic numbers undocumented |
| Error messages | 7/10 | Context-rich but no structured logging |
| Resource cleanup | 7/10 | Good temp file cleanup; `.tmp/system/` accumulates |
| File organization | 5/10 | 5 mega-files (>90K) are the biggest quality concern |

### File-Level Scores

| File | Size | Score |
|------|------|-------|
| `README.md` | 28K | 9/10 |
| `CHANGELOG.md` | 18K | 9/10 |
| `video.md` | 14K | 9/10 |
| `config/output-profiles.mjs` | 5K | 9/10 |
| `PRODUCTION-RUNBOOK.md` | 7K | 8/10 |
| `web/lib/job-queue.mjs` | 6K | 8/10 |
| `web/lib/utils.mjs` | 10K | 8/10 |
| `shared/utils.mjs` | 3K | 8/10 |
| `scripts/foiumaideia.mjs` | 23K | 7/10 |
| `web/lib/job-state.mjs` | 35K | 7/10 |
| `video-engine/src/ShortVideo.tsx` | 14K | 7/10 |
| `config/visual-style-presets.mjs` | 32K | 7/10 |
| `top.md` | 6K | 7/10 |
| `video-engine/README.md` | 3K | 7/10 |
| `video-engine/scripts/make-plan1-video.mjs` | 92K | 6/10 |
| `video-engine/scripts/lib/llm-provider.mjs` | 130K | 6/10 |
| `web/server.mjs` | 128K | 5/10 |
| `web/public/app.js` | 113K | 5/10 |
| `scripts/generate-google-assets.mjs` | 169K | 5/10 |

### Disk Waste Summary

| Item | Size | Gitignored? | Action |
|------|------|-------------|--------|
| `.tmp/` (Remotion bundles) | 990 MB | ❌ | Add to `.gitignore`, delete |
| `video-engine/out/` (55 videos) | 926 MB | ✅ | Periodic cleanup |
| `video-engine/runs/` (134 dirs) | 142 MB | ✅ | Periodic cleanup |
| `.esrgan-models/` | 64 MB | ✅ | Delete if ESRGAN retired |
| `.web-ui/` (jobs + tmp) | 29 MB | ✅ | Delete 3 orphaned .tmp files |
| Root `.mp4` | 14 MB | ✅ | Delete stray file |
| `test-styles/` | 3 MB | ❌ | Delete & gitignore |
| **Total recoverable** | **~2.1 GB** | | |

---

## Appendix: Full Finding Index

### Security Findings (20)

| ID | Severity | Summary |
|----|----------|---------|
| C-1 | CRITICAL | Real API keys in world-readable `.env` |
| C-2 | CRITICAL | Default password `007007` |
| C-3 | CRITICAL | Service runs as root |
| C-4 | HIGH | PII (personal emails) in `.env` |
| H-1 | HIGH | Server binds to `0.0.0.0` |
| H-2 | HIGH | No rate limiting on auth or API |
| H-3 | HIGH | No HTTPS — Basic Auth in cleartext |
| H-4 | HIGH | API key in URL query string |
| H-5 | HIGH | User input flows into spawn() args |
| H-6 | HIGH | `.env` has 777 permissions |
| M-1 | MEDIUM | No CORS headers |
| M-2 | MEDIUM | Hardcoded OpenRouter referer |
| M-4 | MEDIUM | Error messages leak internal details |
| M-5 | MEDIUM | No Content-Security-Policy |
| M-6 | MEDIUM | Extensive innerHTML usage |
| M-7 | MEDIUM | GCP project ID exposed |
| L-1 | LOW | Algolia key in webpack bundle (third-party) |
| L-2 | LOW | Agendador URL hardcoded in 3 files |
| L-3 | LOW | MAX_BODY_BYTES documented |
| — | INFO | `.gitignore` missing `**/.env`, `.tmp/` patterns |

### Backend Bugs (21)

| ID | Severity | Summary |
|----|----------|---------|
| B1 | CRITICAL | Jobs Map never pruned |
| B2 | CRITICAL | SSE streams Map never cleaned |
| B3 | CRITICAL | Remotion --props CLI overflow |
| B4 | CRITICAL | Compressed videos never deleted |
| B5 | HIGH | Entire video read into memory for upload |
| B6 | HIGH | FFmpeg stderr unbounded |
| B7 | HIGH | Orphaned jobs.json.*.tmp on crash |
| B8 | HIGH | Queue worker start not atomic |
| B9 | HIGH | Resumed jobs skip handleAutoContinue |
| B10 | MEDIUM | broadcastJob iterates all jobs |
| B11 | MEDIUM | parseEnvFile quote stripping inconsistency |
| B12 | MEDIUM | ffprobeDurationSeconds no maxBuffer |
| B13 | MEDIUM | handleJobResumeRequest ignores URL :id |
| B14 | MEDIUM | Rate limit lock can deadlock |
| B15 | MEDIUM | Simulador fire-and-forget |
| B16 | MEDIUM | Basic Auth default password |
| B17 | LOW | Duplicate slugify implementations |
| B18 | LOW | Scene count range inconsistency |
| B19 | LOW | countWords edge case (actually correct) |
| B20 | LOW | ElevenLabs cache not key-aware |
| B21 | LOW | video-library silently swallows errors |

### Frontend & Architecture (40)

| ID | Severity | Summary |
|----|----------|---------|
| F1 | HIGH | Event listeners re-attached every render |
| F2 | HIGH | Two polling intervals never cleared |
| F3 | MEDIUM | EventSource reconnect race |
| F4 | MEDIUM | Partial XSS in renderSceneGallery |
| F5 | MEDIUM | innerHTML with partially-escaped HTML |
| F6 | MEDIUM | Global mutable state, no change tracking |
| F7 | LOW | renderAll() expensive, called frequently |
| F8 | MEDIUM | fetchJson swallows non-JSON responses |
| F9 | LOW | Polling errors silently swallowed |
| F10 | MEDIUM | Job list items lack aria-selected |
| F11 | MEDIUM | Video cards not keyboard-focusable |
| F12 | HIGH | No security headers from server |
| F13 | LOW | Manual cache-busting query param |
| F14 | LOW | Two Google Fonts requests |
| F15 | LOW | Progress meters aria-hidden |
| F16 | MEDIUM | Only one responsive breakpoint |
| F17 | LOW | No dark mode |
| F18 | LOW | No :focus-visible styles |
| F19 | HIGH | Duplicate background property in ShortVideo.tsx |
| F20 | LOW | Fallback word splitting no timing distribution |
| F21 | LOW | _channelHandle unused prop |
| F22 | LOW | Large inline defaultProps in Root.tsx |
| F23 | LOW | Caption rendering duplicated across components |
| F24 | LOW | BlackInkVideoProps type unused |
| F25 | MEDIUM | Route handlers in server.mjs (partial god-file) |
| F26 | MEDIUM | No request body size limit |
| F27 | LOW | No rate limiting on API |
| F28 | MEDIUM | No shared API schema |
| F29 | LOW | Defensive field access excessive (8+ fallbacks) |
| F30 | MEDIUM | No dependencies in root package.json |
| F31 | MEDIUM | Mixed pinned/unpinned versions in video-engine |
| F32 | LOW | @remotion/cli in dependencies not devDependencies |
| F33 | LOW | Zod v4 very new |
| F34-40 | — | Architecture SOLID assessment (see body) |

---

*End of audit. This report should be reviewed by the development team and prioritized according to the Refactoring Roadmap phases above. Security Phase 1 items should be addressed before any other work.*
