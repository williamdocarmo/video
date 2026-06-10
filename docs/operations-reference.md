# Operations Reference

## Scope

This document formalizes the current operational model of the app without proposing runtime changes. It describes how the existing server behaves today, where state lives, and which gaps operators should already account for.

## Runtime model

- Main runtime: `web/server.mjs`
- Split entrypoints: `web/api-server.mjs`, `web/worker-engine.mjs`
- Runtime style: `all`, `api`, or `worker`
- Queue model: two in-process lanes backed by a shared `.web-ui/jobs.json` snapshot
- Worker model: jobs execute through child processes started by the Node runtime
- Primary UI client: `web/public/app.js`
- Access protection: HTTP Basic Auth is enforced by the Node runtime before route dispatch
- Auth source priority:
  - `VIDEO_STUDIO_PASSWORD` when defined
  - otherwise `.web-ui/runtime-auth.json`, generated locally on first boot
- Supported runtime roles:
  - `all`
  - `api`
  - `worker`

Observed queue lanes:

| Lane | Current intent | Practical effect |
| --- | --- | --- |
| `preview` | Storyboard-only preview jobs | Lightweight lane, separate from heavy work |
| `heavy` | Full generate, rerender, render-only, validate-only, recovery follow-ups | Effective throughput bottleneck |

Operational implication:

- A process restart clears in-memory queue state, active SSE subscribers, and transient log streaming state.
- In split mode, API and worker still rely on the same snapshot file for coordination; this is operational decoupling, not distributed queueing.

## Important paths

| Path | Purpose |
| --- | --- |
| `web/server.mjs` | HTTP API, queue orchestration, file serving |
| `web/lib/job-queue.mjs` | Queue lane bookkeeping |
| `web/lib/job-state.mjs` | Derived state, recovery checks, summaries |
| `web/lib/video-library.mjs` | Video listing and metadata persistence |
| `.web-ui/jobs.json` | Persisted job snapshot |
| `.web-ui/videos.json` | Persisted aggregated video metadata map |
| `.web-ui/inputs/` | Stored source text and externally submitted storyboards |
| `.web-ui/tiktok-drafts/` | Stored TikTok helper drafts |
| `video-engine/runs/<slug>/` | Storyboard, voiceover, render props, QA reports |
| `video-engine/assets/envato/<slug>/` | Scene clips, image attempts, scene manifests |
| `video-engine/out/` | Final local MP4 outputs |
| `/root/postar/<channel>/` | Exported publish-ready MP4 files by channel |

## Job lifecycle

High-level lifecycle:

1. HTTP route creates an internal job object.
2. The job is assigned to `preview` or `heavy`.
3. The job is inserted into the in-memory queue.
4. A persisted snapshot is scheduled to disk.
5. The active lane worker starts a child process for the job.
6. Job progress updates feed:
   - job state in memory
   - persisted snapshots
   - `logTail`
   - live SSE updates
7. Completion or failure releases the lane and allows the next queued job to proceed.

Observed top-level statuses:

- `queued`
- `running`
- `completed`
- `failed`

Observed job families:

- `generate`
- `rerender`
- `scene-regenerate`
- recovery-generated follow-up jobs
- render/audio/validate helper jobs built from existing artifacts

## Persistence model

### What is persisted

- Job snapshots
- Video metadata sidecars
- TikTok drafts
- Input source files
- Run artifacts and export artifacts

### What is not durable in the same way

- Live SSE subscriptions
- Full process stdout/stderr history as a centralized log store
- Queue execution state beyond the current process snapshot and derived recovery behavior

### Practical consequence

- Recovery after restart depends on the consistency between:
  - `.web-ui/jobs.json`
  - current child-process reality
  - files already present under `video-engine/runs/` and `video-engine/assets/`

## API-to-operations mapping

### Create and approve flow

1. `POST /api/generate`
   - may return one job or a dual-channel pair
2. Monitor `GET /api/jobs` or `GET /api/jobs/:id/stream`
3. If preview mode was used, inspect storyboard via `storyboardUrl`
4. Approve with `POST /api/approve-preview`
5. Monitor heavy-lane progress

### Recovery flow

Available operator actions exposed by the current API:

- `POST /api/jobs/:id/resume`
- `POST /api/jobs/:id/retry-from-storyboard`
- `POST /api/jobs/:id/regenerate-missing-scene`
- `POST /api/jobs/:id/approve-scene-attempt`
- `POST /api/jobs/:id/generate-audio`
- `POST /api/jobs/:id/render-only`
- `POST /api/jobs/:id/validate`
- `POST /api/jobs/:id/force-fail`

Operational meaning:

- `resume` is strict and only works when the expected artifacts already exist and are fresh.
- `retry-from-storyboard` recreates a generate flow from a stored storyboard.
- `regenerate-missing-scene` targets a missing scene or an explicitly requested one.
- `approve-scene-attempt` is the manual bypass when generated attempts exist but automated acceptance failed.
- `force-fail` is the queue release valve for stuck queued/running jobs.

### Dual-channel mirror flow

Current supported dual mode:

- source channel: `@ate2min`
- mirror channel: `@quiet2min`
- input requirement: storyboard in `pt-BR`

Behavior:

1. API stores the Portuguese storyboard
2. Runtime translates only viewer-facing text to English
3. API enqueues the Portuguese primary job
4. API enqueues the English dependent job with `reuseAssetsFromSlug`
5. The mirror job must wait for the source job to complete before it can render

## File serving model

The server exposes a path-based file endpoint through `GET /api/file`.

Current protections:

- requested paths are resolved to absolute paths
- requests must stay within allowed roots
- protected names are blocked, including `.env`, `.key`, `secrets.mjs`, `secrets.json`, `gcp-ate.json`, and `jobs.json`

Operational consequence:

- This is safe enough for internal operation when the allowlist is correct, but it is still not the same thing as an opaque artifact API with stable IDs.

## Video library and publication

### Library sources

The `/api/videos` payload is assembled from:

- exported MP4 files under channel export directories
- linked jobs found by slug/path
- persisted sidecar metadata
- run storyboard files and post text where available

### Publication flow

Current publish flow:

1. Resolve target video by slug or path
2. Resolve metadata and platform list
3. Resolve copy fields:
   - `title` for the library
   - `publishTitle` for YouTube/publish-facing title
   - `socialCaption` for Instagram/TikTok/helper
4. Check `agendador` credentials/profile
5. Upload MP4
6. Try to upload thumbnail
7. Create upstream post or draft
8. Persist resulting publish metadata locally

Operational caveats:

- Local metadata can drift from remote reality if remote edits/deletions happen outside this app.
- `POST /api/videos/:slug/reset-publish` only clears local metadata. It does not undo anything upstream.
- `IG`/TikTok-safe copy is capped to `2200` characters; operators should not assume the long-form YouTube description is safe for those platforms.

## Observability model

### What operators have today

- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/stream`
- `logTail` on job objects
- derived `state`, `stage`, `rca`, `recommendedAction`, and `stepChecklist`

### What operators do not have as a first-class runtime feature

- durable centralized structured logs
- metrics endpoint
- tracing
- externally managed queue visibility

Practical consequence:

- `heartbeatAt` is a stronger signal than stale checklist text when assessing whether a job is still alive.

## Known limits and gaps

### Process model

- The runtime can operate as `all`, `api`, or `worker`.
- Even in split mode, the app remains single-node from an execution-state perspective because queue coordination still depends on in-memory state plus `.web-ui/jobs.json`.
- Horizontal scaling is not supported by the current design.

### Disk dependence

- Recovery and library operations depend on local files staying in place.
- Missing, stale, or manually edited artifacts directly affect what recovery endpoints can do.

### Log durability

- `logTail` is not a complete execution log.
- SSE is transient and tied to the active process.
- The UI can lag behind real progress on disk during long asset-generation runs; operator checks should prefer artifact freshness and live process state over stale checklist text.

### Contract drift

- The API is unversioned.
- Derived fields such as `caseSummary`, `rca`, and `recommendedAction` are useful operationally but are not stable external contracts.

### Simulator isolation

- Simulator jobs use their own persistence flow and background execution model.
- The simulator responds immediately and completes work asynchronously, so `POST /api/simulador/generate` should be treated as accepted-for-processing rather than fully completed.

## Safe operator assumptions

- Prefer job `id` as the authoritative API identifier.
- Prefer `slug` as the authoritative run/video identifier.
- Treat `storyboardUrl` and `outputUrl` as convenience links into current local artifacts, not immutable public URLs.
- Expect `409` on recovery routes when prerequisites are not satisfied.
- Use `force-fail` sparingly, only to unblock a stuck queued/running lane.
