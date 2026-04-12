# Video Generation Cost Analysis

Pricing snapshot date: 2026-04-09.

Scope: this report models the Google-generated path in this repo: topic/script -> Gemini planning -> Google TTS/STT -> Vertex AI image generation -> ffmpeg scene clips -> Remotion render -> QA. The repo also supports stock-video paths (Envato/Pexels), but those replace GCP image cost with third-party licensing cost and are not the main focus here.

I excluded free tiers and committed-use discounts. All numbers are on-demand, pay-as-you-go estimates.

## 1. Executive Summary

The realistic marginal cost of a typical generated short video in this codebase is about **$0.40 per video** at current Google Cloud list prices.

For the current Google-generated path, the **largest cost is image generation**, not TTS and not storage. In the medium scenario, image generation is about **$0.24**, and image-stage planning/vision QA adds another **$0.06**. Together, visuals are roughly **75% of total cost**.

If you reuse existing images and only re-voice/re-render, the same video drops to roughly **$0.10-$0.15**. That is the closest practical "image-to-video" equivalent supported by this repo, because the codebase does not call a dedicated image-to-video model.

## 2. Cost Breakdown (Per Video)

Typical medium scenario used for the headline number:

- Empirical repo averages from existing runs and manifests:
- Video/audio length: about **79 seconds**
- Scenes: about **12.6**
- Planned images: about **10.1**
- Narration size: about **1,106 characters / 186 words**
- End-to-end wall-clock runtime: about **9.2 minutes**
- Observed retry-artifact floor: about **21.8% extra image attempts**
- Compute assumption: ephemeral worker priced like **Cloud Run Jobs at 4 vCPU / 8 GiB**
- STT assumption: conservative **Google Speech-to-Text v1-style pricing**, modeled at about **$0.024/min**

Per-video medium estimate:

| Component | Medium estimate | Notes |
|---|---:|---|
| Audio: Gemini TTS | $0.020 | `gemini-2.5-flash-tts`, mostly output-audio-token cost |
| Audio: Google STT alignment | $0.032 | Used to recover word timings for captions |
| Images: Imagen 4 Fast generation | $0.244 | 10 final images with 1.22x retry overhead |
| Image-stage LLM/QA | $0.058 | Scene shot planner + Gemini vision audit |
| Compute | $0.020 | Non-render job CPU/memory time |
| Rendering | $0.029 | Remotion + ffmpeg QA work |
| Storage | $0.0003 | Negligible at these file sizes |
| Network | $0.0013 | Small if final MP4 is downloaded externally |
| **Total** | **$0.405** | Typical current run |

Important: in this repo, **STT for word-level timing is often more expensive than TTS input processing**, and sometimes close to TTS total cost. That is unusual but real here.

## 3. Cost by Scenario

### Low Quality

Assumptions:

- 45 seconds
- 8 scenes
- 8 final images
- 650 narration characters
- light retry overhead

Estimated cost:

| Component | Low |
|---|---:|
| Audio: TTS | $0.011 |
| Audio: STT | $0.018 |
| Images: generation | $0.176 |
| Image-stage LLM/QA | $0.037 |
| Compute | $0.008 |
| Rendering | $0.012 |
| Storage | $0.0001 |
| Network | $0.001 |
| **Total** | **$0.263** |

### Medium Quality

Assumptions:

- 80 seconds
- 12-13 scenes
- 10 final images
- 1,100 narration characters
- retry overhead close to current repo average

Estimated cost:

| Component | Medium |
|---|---:|
| Audio: TTS | $0.020 |
| Audio: STT | $0.032 |
| Images: generation | $0.244 |
| Image-stage LLM/QA | $0.058 |
| Compute | $0.020 |
| Rendering | $0.029 |
| Storage | $0.0003 |
| Network | $0.0013 |
| **Total** | **$0.405** |

### High Quality

Assumptions:

- 140 seconds
- about 20 scenes
- 20 final images
- 2,000 narration characters
- higher retry rate and more render time

Estimated cost:

| Component | High |
|---|---:|
| Audio: TTS | $0.035 |
| Audio: STT | $0.056 |
| Images: generation | $0.540 |
| Image-stage LLM/QA | $0.115 |
| Compute | $0.046 |
| Rendering | $0.070 |
| Storage | $0.0008 |
| Network | $0.002 |
| **Total** | **$0.865** |

## 4. Pipeline Analysis

Step-by-step cost contribution in the current Google-generated path:

1. Script/storyboard generation
   Cost: about **$0.017-$0.020** per video in observed preview runs.
   Notes: Gemini 2.5 Flash is cheap here; this is not the main spend.

2. Voice generation
   Cost: about **$0.011-$0.035** depending on runtime.
   Notes: Gemini TTS is cheaper than Chirp 3 HD for this workload.

3. Word-timing extraction
   Cost: about **$0.018-$0.056**.
   Notes: this repo calls Google Speech-to-Text after TTS to build karaoke timing. That is a meaningful cost line, not a rounding error.

4. Visual shot planning + semantic audit
   Cost: about **$0.037 low / $0.058 medium / $0.115 high**.
   Notes: per-scene planner calls plus Gemini vision checks after image generation.

5. Image generation
   Cost: about **$0.176 low / $0.244 medium / $0.540 high** with Imagen 4 Fast.
   Notes: this is the dominant cost driver. Retry overhead materially matters.

6. Scene clip assembly
   Cost: low direct API cost, but part of compute bill.
   Notes: each image becomes a static MP4 clip through ffmpeg, then clips are concatenated into `scene-XX.mp4`.

7. Remotion render + QA
   Cost: about **$0.02-$0.12** total compute depending on duration and runtime.
   Notes: the repo renders 1080x1920 at 30 fps, x264 `veryfast`, with three extracted QA frames and a full media decode validation pass.

## 5. Scaling Projection

Using current medium-case variable cost of **$0.405/video**:

| Volume | Low case | Medium case | High case |
|---|---:|---:|---:|
| 100 videos/month | $26 | $40 | $87 |
| 1,000 videos/month | $263 | $405 | $865 |
| 10,000 videos/month | $2,634 | $4,047 | $8,651 |

Notes:

- These are **variable generation costs**.
- If you keep an always-on render VM, add that fixed monthly infrastructure bill on top.
- If you run the UI and jobs on Cloud Run / Cloud Run Jobs, the fixed idle cost is much lower.

## 6. Inefficiencies Found

1. Image requests are intentionally serialized with a very slow rate cap.
   The code sets `GOOGLE_IMAGE_MIN_INTERVAL_MS` to **35,000 ms** and also adds `GOOGLE_IMAGE_REQUEST_PAUSE_MS` of **2,500 ms**. For 10 images, this can burn roughly **6 minutes of wall time** before counting model latency. That does not increase Vertex AI API spend, but it does increase paid compute time if the worker runs on Cloud Run Jobs or a dedicated VM.

2. The CLI image-model default is inconsistent with the web-app default.
   The web app defaults to **Imagen 4 Fast**, but `scripts/generate-google-assets.mjs` still defaults to **`gemini-2.5-flash-image`** if `GOOGLE_IMAGE_MODEL` is not set. Manual or ad hoc CLI runs can therefore cost nearly **2x more per image** than UI-triggered runs.

3. Retry artifacts are not cleaned aggressively.
   The current workspace contains **70 leftover `__attempt-*` PNG files** across generated asset directories. That is direct evidence of retry waste and unnecessary retained storage.

4. Duration overshoot is frequent enough to affect cost.
   Across existing orchestration reports, the average output is about **1.07x target duration**, median is about **1.11x**, and p90 is about **1.53x**. Overshoot directly increases TTS, STT, render time, file size, and egress.

5. Re-render defaults are inconsistent with the main render path.
   `rerender-voice.mjs` defaults to **9M video bitrate**, while the main path and `.env.example` use **1400k**. If the environment does not override this, recovery or rerender jobs can produce much larger files and slower renders than normal generation.

6. STT is an expensive dependency for caption timing.
   The pipeline pays for TTS and then pays again for STT just to recover precise word boundaries. In this workload, that extra pass is non-trivial.

7. TTS chunk pacing adds idle time on longer videos.
   The example env uses `GOOGLE_TTS_CHUNK_MAX_CHARACTERS=1800` and `GOOGLE_TTS_INTER_REQUEST_MS=10000`. On longer scripts, extra pauses add wall-clock time and therefore compute cost.

## 7. Optimization Suggestions

1. Standardize **Imagen 4 Fast** as the only default everywhere.
   Estimated savings: **20%-25% total** versus accidental Gemini Flash Image use on medium jobs.

2. Replace the fixed 35-second image interval with adaptive throttling.
   Estimated savings: **5%-10% total cost** in serverless compute, plus a major throughput gain.
   Operational gain: much lower queue time.

3. Skip STT for low-cost profiles, or use a provider/path with native word boundaries.
   Estimated savings: **8%-13% total**.
   Best use: short videos where frame-perfect karaoke is not essential.

4. Enforce stricter duration control before TTS/render.
   Estimated savings: **5%-20% total**, depending on how often outputs currently overshoot target length.

5. Use selective model escalation.
   Default: Imagen 4 Fast.
   Escalate only failed scenes to Imagen 4 or Ultra.
   Estimated savings versus always using Imagen 4 or Ultra: **25%-50% on image spend**.

6. Clean intermediates aggressively.
   Keep only:
   - final MP4
   - final audio
   - minimal QA frames
   Delete:
   - retry PNGs
   - intermediate scene segment MP4s
   - stale temp dirs
   Estimated savings: small on direct dollars, high on disk hygiene and retry reliability.

7. Unify rerender bitrate with the main render path.
   Estimated savings on rerender-only jobs: **50%+** on render time, output size, and network.

8. Cache storyboard, scene plans, and successful images by normalized prompt hash.
   Estimated savings on retries, regenerated jobs, and topic variants: **20%-70%** depending on repetition.

## 8. Alternative Architectures

### Strategy Cost Comparison

For the same medium workload, the image strategy changes the total cost more than anything else:

| Strategy | What changes | Estimated medium cost |
|---|---|---:|
| Current UI default | `Imagen 4 Fast` for new images | **~$0.40/video** |
| Manual CLI fallback risk | `gemini-2.5-flash-image` instead of Imagen Fast | **~$0.63/video** |
| Higher-quality text-to-video | `Imagen 4` for all generated images | **~$0.65/video** |
| Highest-quality text-to-video | `Imagen 4 Ultra` for all generated images | **~$0.89/video** |
| Image-to-video equivalent in this repo | reuse existing images/clips and only re-voice/re-render | **~$0.10-$0.15/video** |

This repo does not call a dedicated video-generation model. In practice, its "text-to-video" path is really **text -> planned still images -> static scene clips -> Remotion render**. Its cheapest "image-to-video" equivalent is **reuse or supply images, then skip image generation entirely**.

### Cheapest Practical Path

Use:

- Gemini 2.5 Flash for text planning
- Gemini TTS as primary voice
- Imagen 4 Fast for all default images
- Cloud Run Jobs for per-video compute
- GCS lifecycle deletion for intermediates after 1 day

Trade-off:

- best cost/throughput balance
- not best possible anatomy quality on hard scenes

This is also the path that matches the current web UI default, because [`web/lib/presets.mjs`] sets `DEFAULT_IMAGE_MODEL` to `imagen-4.0-fast-generate-001`.

### Higher-Quality Selective Escalation

Use Imagen 4 Fast first, then rerun only failed scenes with Imagen 4 or Imagen 4 Ultra.

Trade-off:

- quality improves where needed
- average cost remains close to Fast baseline

### Image-to-Video / Reuse-Assets Path

In this repo, the closest supported equivalent is:

- reuse storyboard
- reuse previously generated images or scene clips
- regenerate only voice/timings/render

Estimated medium cost:

- about **$0.10-$0.15/video**

Trade-off:

- dramatically cheaper
- less visual novelty per run

### Stock-Heavy Architecture

Use Envato/Pexels for most scenes and keep GCP only for script + audio + render.

Trade-off:

- lower GCP image spend
- introduces stock licensing/search/download costs
- less control over exact scene semantics

## 9. Final Recommendations

If the goal is the best cost/performance strategy at scale, the practical recommendation is:

1. Keep **Imagen 4 Fast** as the universal default.
2. Fix the image-model default mismatch between UI and CLI immediately.
3. Reduce the hard-coded image pacing delays; they are burning compute time.
4. Treat **STT as optional**, not mandatory, for lower-cost tiers.
5. Keep renders on **ephemeral jobs**, not an always-on render VM, unless you have sustained high utilization.
6. Use **selective scene escalation** instead of upgrading the whole video to a more expensive image model.

If you do only those changes, a realistic medium-case cost can move from about **$0.40/video** toward roughly **$0.28-$0.33/video**, while throughput improves substantially.

## Sources

Official pricing:

- Vertex AI pricing: https://cloud.google.com/vertex-ai/generative-ai/pricing
- Google Cloud Text-to-Speech pricing: https://cloud.google.com/text-to-speech/pricing
- Google Cloud Speech-to-Text pricing: https://cloud.google.com/speech-to-text/pricing
- Cloud Run pricing: https://cloud.google.com/run
- Cloud Storage pricing: https://cloud.google.com/storage/pricing
- Network pricing: https://cloud.google.com/vpc/network-pricing

Repo evidence used for modeling:

- `README.md`
- `web/lib/presets.mjs`
- `web/server.mjs`
- `video-engine/.env.example`
- `video-engine/scripts/lib/tts.mjs`
- `video-engine/scripts/lib/gcp-media.mjs`
- `video-engine/scripts/make-plan1-video.mjs`
- `video-engine/scripts/rerender-voice.mjs`
- `scripts/generate-google-assets.mjs`
- `video-engine/runs/*/orchestration-report.json`
- `video-engine/runs/*/voiceover.json`
- `video-engine/runs/*/render-props.json`
- `video-engine/assets/envato/*/google-assets-manifest.json`
- `video-engine/assets/envato/*/gemini-usage.json`
