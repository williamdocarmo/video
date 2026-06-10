# Production Runbook

## Scope

This document covers the production system behind `video.vamostestar.online`, not the local `pipeline.py` flow in this repo.

## Deployment Model

Validated production facts:

- host: `192.168.1.70`
- deployed repo: `/root/repo/videos-flux2`
- observed active service: `codex-video-ui.service`
- public site: `https://video.vamostestar.online`
- access: Basic Auth is enforced by the Node runtime; production may also sit behind site-level protection

Important operational point:

- the effective runtime is a `systemd` service on the host
- this should not be assumed to be a normal active Coolify-managed app resource path
- the repo now also supports split units:
  - `codex-video-api.service`
  - `codex-video-worker.service`

## Key Paths On Host

- app repo: `/root/repo/videos-flux2`
- video engine: `/root/repo/videos-flux2/video-engine`
- web server: `/root/repo/videos-flux2/web/server.mjs`
- output publish dir: `/root/postar`
- run artifacts: `/root/repo/videos-flux2/video-engine/runs/<slug>`
- generated assets: `/root/repo/videos-flux2/video-engine/assets/envato/<slug>`

## Service Operations

Useful commands:

```bash
sudo systemctl status codex-video-ui.service
sudo systemctl restart codex-video-ui.service
sudo journalctl -u codex-video-ui.service -f
```

Do not assume a restart is needed after every change. Many script-only fixes are picked up by new jobs without restarting the web service.

If/when the split runtime is enabled, use:

```bash
sudo systemctl status codex-video-api.service
sudo systemctl status codex-video-worker.service
sudo systemctl restart codex-video-api.service
sudo systemctl restart codex-video-worker.service
sudo journalctl -u codex-video-api.service -f
sudo journalctl -u codex-video-worker.service -f
```

## Site API Workflow

Observed workflow:

1. `POST /api/generate`
   - can run with `previewOnly: true`
2. inspect job via `GET /api/jobs`
3. fetch storyboard via `storyboardUrl` and `/api/file?...`
4. edit and submit via `POST /api/approve-preview`
5. heavy render enters queue
6. monitor completion in `GET /api/jobs`

Useful endpoints already validated:

- `GET /api/health`
- `GET /api/config`
- `GET /api/openapi.yaml`
- `POST /api/generate`
- `POST /api/approve-preview`
- `GET /api/jobs`
- `GET /api/file`
- `POST /api/jobs/:id/force-fail`

## Queue Model

There are at least two practical lanes:

- `preview`
- `heavy`

Heavy jobs are the real bottleneck. The queue is affected by:

- serial render pressure
- Imagen rate limits
- long-running audio/timestamp/render stages

Important caution:

- `heartbeatAt` is more trustworthy than stale checklist text when deciding whether a job is alive
- `stepChecklist` and some `updatedAt` fields can lag behind real stage progress
- in split `api` + `worker`, the practical source of truth shared between the two processes remains `.web-ui/jobs.json`

## Channel Policy

Current working expectations from production presets:

### `foiumaideia`

- language: `pt-BR`
- strongest short-form hook style
- good default choices: assertive voices, `shortform_native`, strong visual contrast

### `quiet2min`

- language: `en-US`
- same editorial spine as `ate2min`, but in English
- direction: short reflective truths that tiram da acomodação sem humilhar e terminam com autoestima restaurada
- PT publication here is a mistake and should be treated as regression

### `ate2min`

- language: `pt-BR`
- same editorial spine as `quiet2min`, but in Brazilian Portuguese
- direction: verdade curta, firme e humana, com aterrissagem acolhedora no final

### Dual-channel mode (`@ate2min` + `@quiet2min`)

- The site can now create both channels from a single storyboard in `pt-BR`
- The runtime writes the Portuguese storyboard, translates only viewer-facing text to English, and enqueues a second job for `@quiet2min`
- The English job reuses the Portuguese visual assets via `reuseAssetsFromSlug`
- Operational implication: if the Portuguese job fails, the English mirror job must stay queued/blocked instead of generating a visually divergent second run

## Voice And Style Findings

Validated production options included:

- voices: `Iapetus`, `Charon`, `Kore`, `Puck`, `Sulafat`
- image styles include `ink`, `editorial_clean`, `realistic_film`, `editorial_line_green`, `punk`, and others

Practical guidance learned:

- `Puck` is strong for TikTok retention when the script needs faster energy
- `Kore` is stronger when the hook needs firmness or authority
- `ink` needs tighter prompt control, otherwise style drift becomes obvious quickly
- TikTok cover should be treated as `1080x1920` with safe margins, not as a full-bleed poster
- final thumbnail uses clean AI-generated image only (text overlay was removed)
- keep the focal subject centered so the cover survives TikTok grid/player crops

## Output Policy Fixes Already Applied

A real production mismatch existed:

- intended profile: `1080x1920`
- actual output at one point: `810x1440`

Cause:

- `REMOTION_SCALE=0.75`

Applied fix on host:

- `/root/repo/videos-flux2/video-engine/.env`
- `/root/repo/videos-flux2/web/server.mjs`
- `/root/repo/videos-flux2/video-engine/scripts/rerender-voice.mjs`

Current policy:

- use scale `1`
- validate final resolution with `ffprobe`

Example validation:

```bash
ffprobe -v error \
  -show_entries stream=width,height:format=duration,size \
  -of json /root/postar/<channel>/<video>.mp4
```

## Visual Consistency Findings

Root cause summary:

- style was prompt-only, not contract-based
- scene prompts accumulated contradictory framing rules
- retries fixed semantics but could worsen run cohesion
- QA emphasized scene validity more than run-level identity

Remote MVP mitigation already applied in `scripts/generate-google-assets.mjs`:

- stable run-level visual direction
- directive normalization
- reduced contradictory framing mix
- reduced leak of object-led rules into full-human scenes

Validated result:

- touchscreen test scene for `@foiumaideia` in `ink` style passed local audit and Gemini Vision after the patch

What still remains open:

- hard `visual-contract.json`
- measurable consistency score
- consistency QA gate
- selective repair loop based on score

## Storyboard Editing Findings

Editing the storyboard before heavy render materially improves quality.

The most common fixes were:

- replace generic `styleNotes` with explicit style language
- remove prompts that invite UI text
- remove concept drift like broken-screen imagery when the topic is adoption friction
- compress or sharpen weak hooks before heavy render

Rule:

- do not approve preview blindly when style-sensitive content is involved

## Publishing Findings

The site flow is enough for create/preview/render/publish-adjacent work, but not for every recovery action.

Learned operational caveats:

- wrong-language posts may need direct `agendador` API correction
- delete/unpublish was handled manually outside the normal site flow
- local metadata may need to be corrected after remote deletion so the UI state matches reality

Do not store raw secrets in repo docs.

If credentials are needed:

- read them from the remote environment
- do not commit them here

## Recommended Safe Workflow

1. Confirm channel, language, voice, image style, and target seconds.
2. Start with `previewOnly: true`.
3. Review storyboard for:
   - hook strength
   - language correctness
   - style consistency
   - UI/text risk
   - topic drift
4. Approve edited storyboard only after those checks.
5. Monitor heavy queue and confirm the job is genuinely progressing.
6. Validate final MP4:
   - duration
   - resolution
   - channel/language correctness
   - style coherence
7. Only then publish or replace files.

## Gemini 3.x Image Models

As of 2026-04-22, the default image model is `gemini-3.1-flash-image-preview`.

### Endpoint
All Gemini image models (3.1 Flash Image, 3 Pro Image, 2.5 Flash Image) use the `generativelanguage.googleapis.com` endpoint. This is a remote API call — no local GPU or image generation.

### Available models in UI dropdown
- `gemini-3.1-flash-image-preview` (default)
- `gemini-3-pro-image-preview`
- `gemini-2.5-flash-image`
- `imagen-4.0-fast-generate-001`
- `imagen-4.0-generate-001`
- `imagen-4.0-ultra-generate-001`
- `image-pipeline` (multi-model pipeline)

### Model selection
The model is selected per job via the UI dropdown or `GOOGLE_IMAGE_MODEL` env var. The `generate-google-assets.mjs` script reads `GOOGLE_IMAGE_MODEL` (default: `gemini-2.5-flash-image` in the script, overridden by `presets.mjs` default `gemini-3.1-flash-image-preview` in the UI flow).

### Fallback for failed image attempts
If all attempts for a segment fail the Gemini Vision audit, the pipeline uses the best rejected attempt instead of killing the job. Log message: `"FALLBACK using rejected attempt (audit failed but usable)"`.

## TTS Model Migration (2.5 → 3.1)

The default TTS model changed from `gemini-2.5-flash-tts` to `gemini-3.1-flash-tts-preview`.

- Configured in `tts.mjs` as the default model parameter
- Env override: `GOOGLE_TTS_MODEL=gemini-3.1-flash-tts-preview`
- Fallback to Chirp3-HD on transient errors is unchanged
- No migration needed for existing runs — only affects new TTS synthesis calls

## Storyboard Upload Workflow

The UI now supports pasting or uploading a pre-made storyboard JSON instead of generating one via Gemini.

### How it works
1. In the "Criar" tab, paste JSON into the "Storyboard JSON" textarea or click "Carregar ficheiro .json"
2. Inline validation checks JSON syntax and verifies `scenes[]` exists with ≥1 scene
3. On submit, the storyboard is sent in the `POST /api/generate` payload as `storyboard` object
4. The pipeline skips storyboard generation and preview — goes directly to assets + render
5. If the external storyboard includes visual prompts per scene, the visual style preset is bypassed
6. QA `sceneCountOk` is relaxed for external storyboards (accepts ≥1 scene instead of profile minimum)

### Operational notes
- External storyboards bypass the Gemini storyboard QA and repair loop
- The `previewOnly` flag is forced to `false` when an external storyboard is provided
- Visual prompts in the storyboard take precedence over the selected visual style preset

## Job Timeout Behavior

Jobs no longer rely on a single `heavy=30min` ceiling. The queue now uses per-job budgets plus inactivity detection:

| Job family | Timeout |
|------------|---------|
| `preview` | 5 minutes |
| `generate` | 90 minutes |
| `render-only` | 60 minutes |
| `scene-regenerate` | 45 minutes |
| `audio-prep` | 20 minutes |
| `validate-only` | 15 minutes |

When a job exceeds its timeout or idles past its heartbeat budget:
1. The runtime records an explicit termination reason
2. The full child-process tree is terminated
3. The lane is released
4. The job is marked as `failed`

Common causes of timeout:
- Imagen/Gemini API rate limits causing long retry loops
- Remotion render hanging on asset fetch
- Network issues with GCP endpoints

Practical note:
- Stale UI stage text can lag behind real progress on disk. For long image runs, trust artifacts under `video-engine/assets/envato/<slug>/` and the worker process state over an old `updatedAt` field in the browser.

## Publish copy rules

Current publishing flow now distinguishes three pieces of copy:

- `title`: internal library title
- `publishTitle`: short publish title, primarily for YouTube
- `socialCaption`: short caption for cross-post outside YouTube and for the TikTok helper

Current operational limits:

| Field | Limit | Practical note |
|-------|-------|----------------|
| `publishTitle` | 100 chars | Aim for 55–70 on YouTube |
| `caption` | 5000 chars | Base long-form description |
| `socialCaption` | 2200 chars | Safe cap for cross-post outside YouTube |

Operational implication:
- If publishing outside `YT`, or opening the TikTok helper, and the base description exceeds `2200`, operators must fill `socialCaption` explicitly.

## .tmp Cleanup

On server startup, the server scans `.tmp/system/` and removes entries older than 24 hours.

- Prevents accumulation of Remotion temporary frames
- Uses `rm({recursive: true, force: true})` for each stale entry
- Logs count of cleaned entries if any were removed
- TMPDIR is set to `.tmp/system` via systemd environment (avoids saturating `/tmp`)

## Current Documentation Risks

The biggest documentation failure mode was mixing:

- local experimental repo state
- production host state
- future architecture plans

This runbook exists to keep those three separate.
