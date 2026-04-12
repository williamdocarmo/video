# top.md — Current State And Documentation Map

> Repo: `/Users/guardian/Documents/repo/video`
> Last updated: 2026-04-11

## Scope

This directory is **not** the same thing as the production system behind `video.vamostestar.online`.

There are two different realities:

1. **Local repo**
   - main local script: `pipeline.py`
   - purpose: local end-to-end short video generation on macOS
   - stack: `edge-tts` + local Diffusers + ffmpeg

2. **Production system**
   - real deploy repo: `/root/repo/videos-flux2` on host `192.168.1.70`
   - UI/API: `video.vamostestar.online`
   - stack: Node web app + Google/Gemini/Imagen pipeline (all image generation is **remote API** — Vertex AI Imagen or Gemini 2.5 Flash Image) + Remotion render (local, Chromium) + ffmpeg (local, lightweight) + publish integrations
   - the heavy local work is **Remotion** (Chromium compositing) and **ffmpeg** — not image generation

Do not use this file as the source of truth for the production host internals. Use [PRODUCTION-RUNBOOK.md](/Users/guardian/Documents/repo/video/PRODUCTION-RUNBOOK.md) for that.

## Documentation Map

- [top.md](/Users/guardian/Documents/repo/video/top.md)
  Current state, repo/production split, and authoritative doc map.
- [PRODUCTION-RUNBOOK.md](/Users/guardian/Documents/repo/video/PRODUCTION-RUNBOOK.md)
  Remote host, service model, API workflow, channel policy, publishing caveats, fixes already applied.
- [STYLE-CONSISTENCY-PLAN.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-PLAN.md)
  Target architecture for hard visual consistency.
- [STYLE-CONSISTENCY-STORIES.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-STORIES.md)
  Execution order and acceptance criteria for style consistency work.

## Local Pipeline Reality Check

`pipeline.py` exists and is active in this repo.

Current local facts:

- default voice: `pt-BR-ThalitaMultilingualNeural`
- TTS prosody: `rate="+20%"`, `pitch="+50Hz"`
- karaoke timing: real `WordBoundary` events when available, proportional fallback otherwise
- TTS batching: `asyncio.gather()` with retry and concurrency limit
- audio path: source MP3 padded and re-encoded with `libmp3lame -q:a 2`
- image pipeline: `StableDiffusionPipeline`
- dtype policy: `float16` on `mps/cuda`, `float32` on `cpu`
- `--llm` exists and uses OpenAI-compatible chat completions
- `--skip-images` is guarded: it now requires the full expected image set
- concat fails early if there are zero valid rendered scenes

This means older notes claiming any of the following are now wrong:

- `pipeline.py` was deleted
- no SSML/prosody controls are used
- karaoke is only fake character timing
- CPU path always uses `float16`
- `AutoPipelineForText2Image` is still the active image loader
- `--skip-images` is safe just because some PNGs exist

## Production Reality Check

The production system is a separate repo and separate operational model.

Important facts already validated:

- host: `192.168.1.70`
- deployed repo: `/root/repo/videos-flux2`
- service entrypoint: `codex-video-ui.service`
- it is **not** currently managed as the primary active app through a normal Coolify app resource flow
- site access is behind Basic Auth
- heavy jobs are serialized by queue pressure and image-provider rate limits
- `previewOnly -> approve-preview -> heavy render` is the normal workflow
- final output policy matters operationally: `1080x1920` required explicit scale correction in production

## Channel Policy

Current production channel expectations:

- `foiumaideia`
  - language: `pt-BR`
  - tone: short-form native, strong hook, practical/curiosity framing
- `quiet2min`
  - language: `en-US`
  - calm/wellness voice and editorial direction
  - publishing PT by mistake is a real regression
- `ate2min`
  - language: `pt-BR`
  - short calm reflective content

## Visual Consistency Status

The production image pipeline (remote Vertex AI Imagen / Gemini 2.5 Flash Image via API) had a real style-drift problem:

- style was prompt decoration, not run contract
- retries could break style while fixing semantics
- prompts accumulated contradictory framing instructions
- QA checked scene validity better than run cohesion

An MVP mitigation was already applied remotely on 2026-04-11:

- stable run-level visual direction instead of per-scene camera rotation
- prompt directive normalization to reduce contradictory framing
- reduced leakage of macro/top-down style rules into full-human scenes

This was validated with a touchscreen test scene in `ink` style on production.

The full architecture target is still tracked in:

- [STYLE-CONSISTENCY-PLAN.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-PLAN.md)
- [STYLE-CONSISTENCY-STORIES.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-STORIES.md)

## Critical Production Fixes Already Applied

These are not proposals. They were already applied on the remote host:

- output scale fix
  - `REMOTION_SCALE=1`
  - previous `0.75` caused `810x1440` renders
- fallback scale fixes in server and rerender scripts
- published file replacement after rerender in native `1080x1920`
- manual correction flow for wrong-language `quiet2min` publication
- force-fail used on a duplicate heavy job to free queue

## What Is Still Missing

The following are still important and not yet fully productized in the repo here:

- full visual consistency scoring and hard QA gate
- proper run artifact for `visual-contract.json`
- production code sync back into this local repo
- cleaner operator documentation for publish/delete/unpublish flows
- canonical regression suite for style consistency

## Recommended Reading Order

1. Read [top.md](/Users/guardian/Documents/repo/video/top.md) to understand scope.
2. Read [PRODUCTION-RUNBOOK.md](/Users/guardian/Documents/repo/video/PRODUCTION-RUNBOOK.md) before touching the remote system.
3. Read [STYLE-CONSISTENCY-PLAN.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-PLAN.md) before changing prompt logic.
4. Read [STYLE-CONSISTENCY-STORIES.md](/Users/guardian/Documents/repo/video/STYLE-CONSISTENCY-STORIES.md) before scheduling implementation work.

## Bottom Line

The most important correction is simple:

- `pipeline.py` describes the **local** generator in this repo
- `videos-flux2` on `192.168.1.70` describes the **production** system

Treating them as one system caused documentation drift and bad assumptions. This file exists to stop that from happening again.
