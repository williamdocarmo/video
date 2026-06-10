# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first system that turns a title or source text into a finished short-form video: storyboard → AI-generated images → synthetic narration → karaoke captions → final Remotion render. Everything is driven from a web UI (`http://127.0.0.1:3210`, public at `https://video.vamostestar.online/`). User-facing strings, docs, and storyboards are largely **Portuguese (pt-BR)** — match that when editing user-visible text.

`README.md` is the authoritative deep reference (full route tables, env var lists, QA check list, visual presets, TTS providers). Read it when you need specifics; this file is the orientation map.

## Layout

The repo is three cooperating Node ESM subprojects (all `"type": "module"`), plus shared config:

- **`web/`** — HTTP server, job queue, and frontend (`web/public/`). The control plane.
- **`scripts/`** — orchestration: `foiumaideia.mjs` is the top-level orchestrator; `generate-google-assets.mjs` does remote image generation. `scripts/lib/` holds the scene-spec compiler and failure taxonomy.
- **`video-engine/`** — the core pipeline (`scripts/make-plan1-video.mjs`), the TTS/LLM/timing libraries (`scripts/lib/`), and the Remotion compositions (`src/`, React/TSX). Has its **own `package.json`** and dependencies.
- **`config/`** — `output-profiles.mjs` (vertical-short / horizontal-5m / horizontal-10m) and `visual-style-presets.mjs` (10 presets, ~17 prompt fields each).
- **`shared/utils.mjs`** — cross-cutting helpers (normalizeText, slugify, extractJson, sleep).

## Process / data flow

The flow is **process-spawned, not in-process**. Understanding this is key to navigating the code:

```
UI → POST /api/generate → web/lib/job-queue.mjs (dual-lane: preview + heavy)
   → web/lib/job-execution.mjs spawns `node scripts/foiumaideia.mjs ...`
   → foiumaideia.mjs spawns:
       make-plan1-video.mjs --preview-only   (storyboard + QA, for approval)
       generate-google-assets.mjs            (Gemini plan → image model → Vision audit → ffmpeg → scene-XX.mp4)
       make-plan1-video.mjs                  (storyboard → graphic plan → TTS → timeline → Remotion render → validate-run QA)
```

Config crosses process boundaries via **environment variables** (`TTS_PROVIDER`, `IMAGE_MODEL`, `GENERATION_MODE`, `VIDEO_LANGUAGE`, `ELEVENLABS_VOICE_ID`, etc.) set by `job-execution.mjs` when spawning. When tracing how a UI option reaches the engine, follow the env var, not a function call.

State is file-based: jobs/videos persist to `.web-ui/` (`jobs.json`, `videos.json`); engine artifacts live under `video-engine/runs/{slug}/`, `video-engine/public/runs/{slug}/`, `video-engine/assets/envato/{slug}/`, and `video-engine/out/{slug}.mp4`. Final exports go to `/root/postar/{channel}/`.

## Runtime roles

Three entrypoints share `.web-ui/jobs.json` as a snapshot (no distributed queue):

| Role | Command | Notes |
|------|---------|-------|
| `all` | `npm run web` (`node web/server.mjs`) | API + worker in one process (default / production) |
| `api` | `npm run web:api` | HTTP UI/API only |
| `worker` | `npm run web:worker` | queue execution, no HTTP port |

Auth: HTTP Basic is applied globally before route dispatch. If `VIDEO_STUDIO_PASSWORD` is unset, a password is generated and persisted to `.web-ui/runtime-auth.json`.

## Common commands

```bash
# Run the studio (most common)
npm run web

# Full video from CLI (bypasses UI)
node scripts/foiumaideia.mjs --title "Meu título"
node scripts/foiumaideia.mjs --title "Meu título" --provider elevenlabs

# Re-render voice / reuse audio / validate an existing run
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --provider elevenlabs
node video-engine/scripts/rerender-voice.mjs --slug MEU-SLUG --reuse-existing-audio
node video-engine/scripts/validate-run.mjs   --slug MEU-SLUG

# Visual assets only (remote image generation via Google APIs)
node scripts/generate-google-assets.mjs --slug MEU-SLUG

# Remotion: interactive studio for composition work (run inside video-engine/)
cd video-engine && npm run studio

# Restart production service
systemctl restart codex-video-ui.service
```

## Tests

Tests are standalone Node scripts using `node:assert/strict` — no test framework, no runner config. Run a single test by executing the file directly:

```bash
node scripts/test-scene-spec.mjs
node scripts/test-scene-failure-taxonomy.mjs
node scripts/test-generate-google-rules.mjs
node scripts/test-storyboard-fallback.mjs
# or via npm: npm run test:scene-spec, test:scene-failure-taxonomy, test:google-rules
```

There is no `npm test` / lint / typecheck setup; the `.tsx` Remotion files are run by Remotion's own bundler, not separately compiled.

## Things that bite

- **Image generation is remote-only** (Vertex Imagen / Gemini Flash/Pro Image via Google API). The only heavy *local* work is the Remotion (Chromium) render and ffmpeg. Default image model: `gemini-3.1-flash-image-preview`.
- **Model choice drives visual quality more than prompts.** Documented case (README changelog): `imagen-4.0-generate-001` ignores "solid background, no gradient" instructions repeated 3× and adds gray gradients anyway, while `gemini-2.5-flash-image` respects the same prompt. Don't assume a visual bug is a prompt bug.
- **GCP credentials** come from `video-engine/.env` (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`). Engine env lives in `video-engine/.env`, not the root.
- **Queue is single-slot per lane** (concurrency 1, FIFO). `preview` lane times out at 5min; `heavy` lane timeout varies by job type (generate 90min … validate 15min). Jobs marked `running` with no live process are auto-failed on recovery.
- **TTS producers all normalize to one `timedWords[]` format**, post-processed by `sanitizeTimedWordsForAudio` → `compressAudioSilences` → `anchorTimestampsToAudioSilences` → `analyzeSceneSpeechPacing`. QA only trusts sources `gcloud-speech-stt`, `azure-word-boundary`, `elevenlabs-alignment`.
- **In production, `REMOTION_CONCURRENCY=1` and `TMPDIR` is redirected** to `.tmp/system` (Remotion frames otherwise saturate `/tmp`). The systemd env overrides the `.env` defaults.
