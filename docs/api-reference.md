# API Reference

## Scope

This document formalizes the HTTP API currently implemented by `web/server.mjs`.

- Runtime scope: current Node.js runtime and its `all` / `api` / `worker` roles
- UI scope: routes used by `web/public/app.js`
- Source of truth: application code, not this document
- Versioning: the API is currently unversioned

## Base URLs

- Local: `http://127.0.0.1:3210`
- Production: `https://video.vamostestar.online`

## Transport and conventions

- Request body format: JSON for all documented `POST` routes
- Success responses: JSON except `GET /api/jobs/:id/stream`, `GET /api/file`, `GET /api/simulador/video/:id`, and `GET /tiktok-helper`
- Error format: `{ "error": "message" }`
- Common business-conflict status: `409 Conflict`
- Body size limit: `1_500_000` bytes
- API auth: the Node runtime currently enforces HTTP Basic Auth globally before route dispatch
- Auth source:
  - preferred: `VIDEO_STUDIO_PASSWORD`
  - fallback: generated local password persisted in `.web-ui/runtime-auth.json`
- Documentation endpoints are also exposed by the runtime:
  - `GET /api/openapi.yaml`
  - `GET /api/docs/api-reference`
  - `GET /api/docs/operations-reference`

## Common resource shapes

### Job

Sanitized job objects returned by `/api/generate`, `/api/jobs`, `/api/jobs/:id`, and recovery endpoints expose the same top-level structure.

Important fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Internal job id |
| `type` | `string` | Observed values: `generate`, `rerender`, `scene-regenerate`, `audio-prep`, `render-only`, `validate-only` |
| `title` | `string` | Display title |
| `slug` | `string` | Run slug |
| `status` | `string` | Observed values: `queued`, `running`, `completed`, `failed` |
| `queueLane` | `string|null` | `preview` or `heavy` |
| `queuePosition` | `number|null` | Only meaningful while queued |
| `input` | `object` | Effective inputs used for the job |
| `outputPath` | `string|null` | Absolute file path when present |
| `outputUrl` | `string|null` | File URL via `/api/file` when present |
| `storyboardPath` | `string|null` | Effective storyboard path if resolvable |
| `storyboardUrl` | `string|null` | File URL via `/api/file` when present |
| `logTail` | `string[]` | Recent log lines only, not a full durable log |
| `error` | `string|null` | Final error summary for failed jobs |
| `state` | `object` | Derived state classification |
| `stage` | `object` | Derived stage classification |
| `rca` | `object` | Derived root-cause summary |
| `recommendedAction` | `object` | UI-oriented next-step hint |
| `stepChecklist` | `object[]` | Derived step status summary |

Notes:

- `input.sourceTextFile` is redacted to `"[internal]"` in API responses.
- `storyboardPath` may point to a preview storyboard fallback if that is the effective source.
- `logTail` is intentionally truncated state, not a full audit trail.

### Video

Video records returned by `/api/videos` and video mutation routes share a common shape.

Important fields:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Derived from slug and file name |
| `slug` | `string` | Video slug |
| `path` | `string` | Absolute export path |
| `url` | `string` | File URL via `/api/file` |
| `title` | `string` | Stored title or inferred fallback |
| `publishTitle` | `string` | Short publish title used for YouTube/publish flows |
| `caption` | `string` | Stored caption or inferred fallback |
| `socialCaption` | `string` | Short caption used for cross-post outside YouTube and for the helper |
| `hashtags` | `string[]` | Stored or parsed from `post.txt` |
| `channel` | `string` | Export channel |
| `scheduleAt` | `string` | Scheduling timestamp string, if any |
| `platforms` | `string[]` | Publish targets such as `FB`, `IG`, `YT` |
| `isDraft` | `boolean` | Draft intent for publish flow |
| `thumbnailUrl` | `string|null` | Stored or derived thumbnail URL |
| `publishedAt` | `string|null` | Publish completion time |
| `publishedPostId` | `string|null` | External post id if publish succeeded |
| `lastPublishStatus` | `string|null` | Last known publish outcome persisted locally |
| `jobId` | `string|null` | Latest linked job id |
| `jobType` | `string|null` | Latest linked job type |
| `creationParams` | `object|null` | Effective creation parameters from the linked job |
| `state` | `object` | Derived publish state |
| `stage` | `object` | Derived publish stage |
| `caseSummary` | `object` | Aggregated summary used by the UI |

### Config

`GET /api/config` returns the UI bootstrap payload:

- `defaults`
- `defaultVoicesByLanguage`
- `voices`
- `channels`
- `channelPresets`
- `outputProfiles`
- `imageModels`
- `generationModes`
- `imageStyles`
- `tones`
- `durations`
- `durationsByProfile`
- `agendador`

This is configuration data for the current runtime, not a stable public contract.

## Configuration and discovery

### `GET /api/health`

Returns a lightweight operational snapshot for health checks.

Response:

```json
{
  "ok": true,
  "service": "video-studio",
  "now": "2026-04-22T12:00:00.000Z",
  "uptimeSeconds": 1234,
  "queue": {
    "previewQueueLength": 0,
    "heavyQueueLength": 2,
    "queueLength": 2,
    "activeJobId": "job_123",
    "activePreviewJobId": null,
    "activeHeavyJobId": "job_123"
  },
  "jobs": {
    "total": 42,
    "running": 1,
    "queued": 2,
    "failed": 8
  },
  "retention": {
    "days": 14,
    "count": 500
  },
  "auth": {
    "source": "env"
  }
}
```

Behavior:

- This is a process-level health snapshot, not an end-to-end dependency check.

### `GET /api/openapi.yaml`

Returns the current OpenAPI YAML served by the runtime.

Behavior:

- Useful for tooling, code generation, and schema diffing against the live server.

### `GET /api/docs/:name`

Returns runtime markdown documentation files.

Allowed names:

- `api-reference`
- `operations-reference`

### `GET /api/config`

Returns the UI configuration payload used to populate dropdowns and defaults.

Key response sections:

- `defaults.channel`, `defaults.language`, `defaults.outputProfile`, `defaults.imageModel`, `defaults.generationMode`
- `voices[]`
- `channels[]`
- `outputProfiles[]`
- `imageModels[]`
- `generationModes[]`
- `imageStyles[]`
- `tones[]`
- `agendador.profiles[]`

Known limitation:

- This payload is runtime-derived and may change when presets change, without API versioning.

### `GET /api/elevenlabs-voices`

Returns ElevenLabs voices from the configured account, with a 5-minute in-memory cache.

Response:

```json
{
  "voices": [
    {
      "value": "voice_id",
      "label": "Voice name",
      "category": "premade",
      "languages": ["en", "pt"]
    }
  ]
}
```

Known limitation:

- If `ELEVENLABS_API_KEY` is absent or the upstream request fails, the route still returns `200` with `{"voices":[]}`.

## Generation and preview approval

### `POST /api/generate`

Creates a new generation job.

Essential request payload:

```json
{
  "title": "Video title",
  "sourceText": "Optional long-form source text",
  "language": "pt-BR",
  "outputProfile": "vertical-short",
  "targetSeconds": 60,
  "generationMode": "balanced",
  "imageModel": "imagen-4.0-generate-001",
  "imageStyle": "ink",
  "channel": "foiumaideia",
  "tone": "shortform_native",
  "voice": "Kore",
  "audioProvider": "gcp",
  "customVoice": "",
  "customStylePrompt": "",
  "force": true,
  "noMusic": true,
  "previewOnly": true,
  "generateForBothChannels": false,
  "storyboard": {
    "videoTitle": "Optional external storyboard title",
    "scenes": []
  }
}
```

Behavior:

- Requires either:
  - a valid external `storyboard.scenes[]`, or
  - a valid `title` and/or `sourceText` combination accepted by server-side validation
- When `storyboard.scenes[]` is present, the server stores it to an internal file and forces `previewOnly: false`
- When `generateForBothChannels: true`, the request must include a storyboard in `pt-BR`; the server creates a Portuguese `@ate2min` job plus an English `@quiet2min` mirror job that reuses the same visual assets
- Supported `language` values are currently `pt-BR` and `en-US`
- Supported `audioProvider` values are normalized to `gcp` or `elevenlabs`

Success response:

```json
{
  "job": {
    "id": "job_123",
    "type": "generate",
    "status": "queued",
    "queueLane": "preview"
  },
  "jobs": [],
  "dualChannelMode": null
}
```

Observed validation failures:

- `400` if title/source input is insufficient
- `400` if the selected voice is invalid
- `400` if the payload exceeds the server body limit

Notes:

- In the normal single-job path, `job` is the created job and `jobs[]` may be omitted or empty.
- In dual-channel mode, `job` is the primary Portuguese job, `jobs[]` contains both created jobs, and `dualChannelMode` identifies the mirrored flow.

### `POST /api/approve-preview`

Approves a completed preview job and enqueues the full generation flow.

Request:

```json
{
  "jobId": "preview_job_id",
  "storyboard": {
    "videoTitle": "Edited title",
    "hook": "Edited hook",
    "postCaption": "Edited caption",
    "styleNotes": "Edited notes",
    "cta": "Edited CTA",
    "scenes": [
      {
        "title": "Scene title",
        "narration": "Narration",
        "overlay": "Overlay text",
        "searchQuery": "Search terms",
        "visualGoal": "Visual goal"
      }
    ]
  }
}
```

Behavior:

- `jobId` must identify a completed preview `generate` job
- Edited storyboard must preserve the same number of scenes as the preview storyboard
- The approved storyboard is written back to the preview storyboard file before the full job is queued

Success response:

```json
{
  "job": {
    "id": "full_job_id",
    "type": "generate",
    "status": "queued",
    "input": {
      "previewOnly": false,
      "approvedFromJobId": "preview_job_id"
    }
  }
}
```

Observed conflict cases:

- `404` if the preview job does not exist
- `400` if the job is not a preview
- `400` if the preview is not completed or has no storyboard
- `400` if the edited storyboard is structurally invalid
- `400` if preview validation fails for duration/content constraints

### `POST /api/rerender-voice`

Creates a voice-only rerender job for an existing run slug.

Request:

```json
{
  "slug": "2026-04-22-example-video",
  "language": "pt-BR",
  "tone": "natural_clean",
  "voice": "Kore",
  "customVoice": "",
  "audioProvider": "gcp",
  "outputProfile": "vertical-short",
  "customStylePrompt": "",
  "scriptGuidance": ""
}
```

Behavior:

- Requires `slug`
- Reuses the existing run storyboard and render props from disk

Success response:

```json
{
  "job": {
    "id": "rerender_job_id",
    "type": "rerender",
    "status": "queued"
  }
}
```

## Jobs and recovery

### `GET /api/jobs`

Lists jobs with pagination and queue metadata.

Query parameters:

- `limit`: default `50`, min `1`, max `500`
- `offset`: default `0`

Response shape:

```json
{
  "jobs": [],
  "total": 42,
  "limit": 50,
  "offset": 0,
  "cases": [],
  "summary": {
    "total": 42,
    "queued": 3,
    "running": 1,
    "completed": 30,
    "failed": 8
  },
  "activeJobId": "job_123",
  "activePreviewJobId": null,
  "activeHeavyJobId": "job_123",
  "previewQueueLength": 0,
  "heavyQueueLength": 2,
  "queueLength": 2
}
```

### `GET /api/jobs/:id`

Returns a single sanitized job object.

### `GET /api/jobs/:id/stream`

Server-Sent Events stream for live job updates.

Behavior:

- Response content type is `text/event-stream`
- The server emits `update` events containing a sanitized job payload
- Keepalive comments are sent every 25 seconds

Known limitation:

- Stream state is in-memory only. A process restart drops subscribers and the transient log flow.

### `GET /api/jobs/:id/scenes`

Returns best-available generated PNG assets for each scene segment.

Response:

```json
{
  "scenes": [
    {
      "sceneNumber": 1,
      "segNumber": 1,
      "url": "/api/file?path=%2Fabs%2Fpath%2Fscene-01-seg-01.png"
    }
  ]
}
```

Behavior:

- Final approved PNGs win over attempt PNGs
- If only attempt files exist, the highest attempt number wins

### `GET /api/jobs/:id/scene-review`

Returns failed scene segments that still have rejected attempts available for manual review.

Response:

```json
{
  "reviewItems": [
    {
      "sceneNumber": 1,
      "segNumber": 2,
      "title": "Scene title",
      "error": "Failure summary",
      "coverageText": "Narrative coverage",
      "action": "Suggested repair action",
      "prompt": "Prompt used",
      "recommendedAttempt": 3,
      "attempts": [
        {
          "attempt": 3,
          "file": "scene-01-seg-02__attempt-3.png",
          "absolutePath": "/abs/path/file.png",
          "url": "/api/file?path=%2Fabs%2Fpath%2Ffile.png",
          "sizeBytes": 12345,
          "updatedAt": "2026-04-22T12:00:00.000Z"
        }
      ]
    }
  ]
}
```

### `POST /api/jobs/:id/retry-from-storyboard`

Retries a failed generation job from an existing storyboard.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

Behavior:

- Route id and body `jobId` must match if both are provided
- Only available when the source job is retryable from storyboard

### `POST /api/jobs/:id/regenerate-missing-scene`

Creates a manual scene regeneration job.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id",
  "sceneNumber": 3,
  "autoContinueAfterSceneRepair": true
}
```

Behavior:

- Only available for failed jobs
- If `sceneNumber` is omitted, the server prefers the first missing scene it can detect

### `POST /api/jobs/:id/approve-scene-attempt`

Promotes a rejected attempt image to the approved scene output and optionally continues the pipeline.

Request:

```json
{
  "jobId": "optional_duplicate_of_path_id",
  "sceneNumber": 1,
  "segNumber": 2,
  "attempt": 3,
  "autoContinue": true
}
```

Success response:

```json
{
  "job": {
    "id": "approval_job_id",
    "type": "scene-regenerate",
    "status": "completed"
  },
  "followUpJob": {
    "id": "optional_follow_up_job_id"
  }
}
```

### `POST /api/jobs/:id/generate-audio`

Queues an audio-preparation job using existing storyboard and scene assets.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

### `POST /api/jobs/:id/render-only`

Queues a render-only job using existing prepared assets.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

### `POST /api/jobs/:id/validate`

Queues a validation-only job against an existing final MP4.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

### `POST /api/jobs/:id/force-fail`

Forces a queued or running job into the failed state and releases the queue lane.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

Behavior:

- If the job is running, the server tries to terminate the process tree first
- Returns the updated sanitized job

### `POST /api/jobs/:id/resume`

Creates a resumed `generate` job from a failed `generate` job after verifying artifacts.

Accepted body:

```json
{
  "jobId": "optional_duplicate_of_path_id"
}
```

Behavior:

- Only valid for failed non-preview `generate` jobs
- Requires on-disk storyboard, voiceover JSON, voiceover MP3, and all expected scene clips

Known limitation:

- Resume is intentionally conservative and fails with `409` when any expected artifact is missing or stale.

### `GET /api/runs`

Returns recent exports from disk.

Response:

```json
{
  "runs": [
    {
      "slug": "video-slug",
      "path": "/abs/path/video.mp4",
      "title": "Video title"
    }
  ]
}
```

Behavior:

- This is effectively a short recent-export view built from the same video record logic used by `/api/videos`.

## Videos and publishing

### `GET /api/videos`

Returns the export library plus failed unrecovered jobs and publish integration status.

Response shape:

```json
{
  "videos": [],
  "failedJobs": [],
  "cases": [],
  "summary": {
    "total": 10,
    "published": 3,
    "scheduled": 2,
    "drafts": 1,
    "failedJobs": 2,
    "retryableFailedJobs": 1,
    "readyCases": 7
  },
  "agendador": {
    "configured": true,
    "keychainBacked": true,
    "siteUrl": "https://agendador.online",
    "apiBase": "https://agendador.online/api",
    "profiles": []
  }
}
```

### `POST /api/videos/meta`

Updates per-video metadata.

Request:

```json
{
  "slug": "video-slug",
  "path": "/abs/path/video.mp4",
  "channel": "foiumaideia",
  "title": "Edited internal title",
  "publishTitle": "Short publish title",
  "caption": "Base long-form description",
  "socialCaption": "Short cross-post caption",
  "hashtags": ["#one", "#two"],
  "scheduleAt": "2026-04-22T15:00:00.000Z",
  "platforms": ["FB", "IG", "YT"],
  "isDraft": false
}
```

Behavior:

- Either `slug` or `path` is needed to resolve the target video
- `path` is validated against the server allowlist when used
- Platform values are normalized to uppercase and capped by server-side slicing
- `publishTitle` is capped at `100` characters server-side
- `caption` is capped at `5000` characters server-side
- `socialCaption` is capped at `2200` characters server-side

Success response:

```json
{
  "video": {
    "slug": "video-slug",
    "title": "Edited title"
  }
}
```

### `POST /api/videos/refazer`

Queues a fresh `generate` job from an existing video storyboard.

Request:

```json
{
  "slug": "video-slug",
  "path": "/abs/path/video.mp4",
  "channel": "foiumaideia",
  "language": "pt-BR",
  "outputProfile": "vertical-short",
  "targetSeconds": 60,
  "tone": "shortform_native",
  "voice": "Kore",
  "audioProvider": "gcp",
  "imageModel": "imagen-4.0-generate-001",
  "generationMode": "balanced",
  "customStylePrompt": ""
}
```

Behavior:

- Requires a resolvable storyboard on disk
- Reuses previous job settings where not explicitly overridden

### `POST /api/videos/delete`

Deletes a video export and its sidecar metadata.

Request:

```json
{
  "slug": "video-slug",
  "path": "/abs/path/video.mp4",
  "channel": "foiumaideia"
}
```

Success response:

```json
{
  "ok": true,
  "slug": "video-slug",
  "deletedPath": "/abs/path/video.mp4"
}
```

Important note:

- This is destructive. The API currently has no soft-delete or restore mechanism.

### `POST /api/videos/publish`

Publishes or schedules a video through the `agendador` integration.

Request:

```json
{
  "slug": "video-slug",
  "path": "/abs/path/video.mp4",
  "channel": "foiumaideia",
  "title": "Optional internal override",
  "publishTitle": "Optional short YouTube title",
  "caption": "Base long-form description",
  "socialCaption": "Short caption for cross-post outside YouTube",
  "hashtags": ["#one", "#two"],
  "scheduleAt": "2026-04-22T18:00:00.000Z",
  "platforms": ["FB", "IG", "YT"],
  "isDraft": false
}
```

Behavior:

- The server tries to send `title` upstream as a separate field using `publishTitle`
- For multi-platform publish, the caption body prefers `socialCaption`; for YouTube-only flows it can use the base long-form description
- Hashtags are appended with blank-line separation
- If `scheduleAt` resolves to the past, the server publishes immediately instead
- Missing or not-ready social accounts produce `409`
- The route persists publish metadata back into the video sidecar JSON
- If publishing to `IG` with a base description above `2200` and no `socialCaption`, the route rejects the request with `400`

Success response:

```json
{
  "ok": true,
  "post": {
    "id": "external_post_id"
  },
  "video": {
    "slug": "video-slug",
    "publishedPostId": "external_post_id"
  }
}
```

Known limitation:

- The current request body may contain UI-only fields such as `publishMode`; the backend ignores them.

### `POST /api/videos/tiktok-helper`

Creates a TikTok helper draft and returns a helper page URL.

Request:

```json
{
  "slug": "video-slug",
  "path": "/abs/path/video.mp4",
  "channel": "foiumaideia",
  "title": "Optional internal override",
  "publishTitle": "Optional short title for the helper page",
  "caption": "Optional base description override",
  "socialCaption": "Short caption used by the helper",
  "hashtags": ["#one", "#two"]
}
```

Behavior:

- The helper draft title prefers `publishTitle`
- The helper body uses `socialCaption`
- If `socialCaption` is empty and the base description exceeds `2200`, the route rejects the request with `400`

Success response:

```json
{
  "ok": true,
  "helperUrl": "/tiktok-helper?id=draft_id",
  "message": "Helper do TikTok aberto. O upload do MP4 no site do TikTok ainda precisa ser confirmado manualmente no browser."
}
```

### `POST /api/videos/:slug/reset-publish`

Clears publication status metadata for a video.

Request body:

```json
{}
```

Success response:

```json
{
  "ok": true
}
```

## Simulator

### `POST /api/simulador/generate`

Generates a simulator run from raw text input.

Request:

```json
{
  "title": "Simulado",
  "text": "Raw simulator source text"
}
```

Response:

```json
{
  "message": "20 questões → 2 vídeo(s)",
  "questionCount": 20,
  "batchCount": 2,
  "jobs": [
    {
      "id": "pending-0",
      "title": "Simulado (Parte 1/2)",
      "questionCount": 10,
      "status": "processing"
    }
  ]
}
```

Important note:

- The route responds before background processing finishes.

### `GET /api/simulador/jobs`

Returns the persisted simulator job list.

### `GET /api/simulador/video/:id`

Streams a generated simulator video file if it exists.

### `DELETE /api/simulador/jobs/:id`

Deletes a simulator job record and associated files.

## Files and helper pages

### `GET /api/file`

Serves a file by absolute path.

Query parameter:

- `path`: absolute path to the target file

Security behavior:

- Access is restricted to configured allowed roots
- The server blocks requests targeting protected names such as `.env`, `.key`, `secrets.mjs`, `secrets.json`, `gcp-ate.json`, and `jobs.json`
- Range requests are supported for streamable assets

Known limitation:

- This is still a path-based file serving endpoint, not an opaque artifact id API.

### `GET /tiktok-helper`

Returns the standalone HTML helper page for a previously created TikTok draft.

Query parameter:

- `id`: draft id returned by `/api/videos/tiktok-helper`

## Known limits and gaps

### Contract stability

- No route versioning exists today.
- Several responses include derived UI fields such as `caseSummary`, `rca`, and `recommendedAction`.
- The API does not publish a stable enum contract for every computed field.

### Runtime model

- Queue state is process-local.
- SSE subscriptions are process-local.
- Job log visibility is based on `logTail` plus in-memory streaming, not on a durable centralized log store.

### Storage model

- Jobs, video metadata, drafts, inputs, run artifacts, and exported videos are file-backed on local disk.
- Recovery endpoints assume those files are still present and fresh.

### Error handling

- The error envelope is consistent at the top level, but status-code semantics are still route-specific.
- Upstream integration failures are sometimes normalized into empty success payloads, notably on `GET /api/elevenlabs-voices`.

### Publish integration

- Publish and scheduling state is metadata-driven and can drift from remote system state if edits happen outside this app.
- The reset route only clears local metadata. It does not unpublish anything remotely.
- For consumers, `video.state`, `video.scheduleAt`, and `video.publishedAt` are more reliable than aggregate counters if exact publish state matters.
