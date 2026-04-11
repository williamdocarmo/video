# Production Runbook

## Scope

This document covers the production system behind `video.vamostestar.online`, not the local `pipeline.py` flow in this repo.

## Deployment Model

Validated production facts:

- host: `192.168.1.70`
- deployed repo: `/root/repo/videos-flux2`
- service: `codex-video-ui.service`
- public site: `https://video.vamostestar.online`
- access: Basic Auth in front of the site

Important operational point:

- the effective runtime is a `systemd` service on the host
- this should not be assumed to be a normal active Coolify-managed app resource path

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

- `GET /api/config`
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

## Channel Policy

Current working expectations from production presets:

### `foiumaideia`

- language: `pt-BR`
- strongest short-form hook style
- good default choices: assertive voices, `shortform_native`, strong visual contrast

### `quiet2min`

- language: `en-US`
- calm/wellness direction
- PT publication here is a mistake and should be treated as regression

### `ate2min`

- language: `pt-BR`
- short calm reflective content

## Voice And Style Findings

Validated production options included:

- voices: `Iapetus`, `Charon`, `Kore`, `Puck`, `Sulafat`
- image styles include `ink`, `editorial_clean`, `realistic_film`, `editorial_line_green`, `punk`, and others

Practical guidance learned:

- `Puck` is strong for TikTok retention when the script needs faster energy
- `Kore` is stronger when the hook needs firmness or authority
- `ink` needs tighter prompt control, otherwise style drift becomes obvious quickly

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

Remote MVP mitigation already applied in `scripts/generate-flux2-assets.mjs`:

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

## Current Documentation Risks

The biggest documentation failure mode was mixing:

- local experimental repo state
- production host state
- future architecture plans

This runbook exists to keep those three separate.
