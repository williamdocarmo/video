# ElevenLabs TTS Integration — Architecture Audit & Implementation

---

## Phase 1: Architecture Audit & File Discovery

### a) Web UI and API Entry Points

| File | Role |
|------|------|
| `web/public/index.html` | Frontend HTML — form `#generateForm` with voice `<select name="voice">` at line 139 |
| `web/public/app.js` | Frontend JS — `buildGeneratePayload()` (line 2580), form submit handler (line 2674), voice population via `getVoicesForLanguage()` (line 873) |
| `web/server.mjs` | Backend HTTP server — `handleGenerateRequest()` (line 1870), route `POST /api/generate` (line 3260), config endpoint `/api/config` |
| `web/lib/presets.mjs` | Voice/model option definitions — `voiceOptions[]` (line 56), `DEFAULT_VOICE` (line 51) |

### b) Backend Queue and Lane Orchestration

| File | Role |
|------|------|
| `web/lib/job-queue.mjs` | Two-lane queue (`preview` / `heavy`), 1 concurrent per lane |
| `web/lib/job-execution.mjs` | Spawns child processes — `createGenerateJobCommand()` (line 116), `createRerenderJobCommand()` (line 162), `createAudioPrepJobCommand()` (line 196). Passes `AZURE_TTS_VOICE` and `GOOGLE_TTS_VOICE` env vars to children |
| `web/server.mjs` | `enqueueAndStart()` dispatches jobs to the correct lane |

### c) Core Video Pipeline

| File | Role |
|------|------|
| `scripts/foiumaideia.mjs` | Top-level orchestrator — preview → assets → pipeline → export. Passes `--voice` flag and env vars to `make-plan1-video.mjs` |
| `video-engine/scripts/make-plan1-video.mjs` | Core pipeline — storyboard → TTS → timeline → Remotion render → QA. Calls `synthesizeVoiceover()` at ~line 780 with full `elevenlabs`, `google`, `azure` config objects |

### d) TTS Module

| File | Role |
|------|------|
| `video-engine/scripts/lib/tts.mjs` | Central TTS engine. Contains `synthesizeVoiceover()` (line 2332), `synthesizeWithElevenLabs()` (line ~210), `synthesizeWithCloudTtsGemini()`, `synthesizeWithCloudTtsChirp3()`, `synthesizeWithAzureSpeech()`, `extractTimedWordsFromAudio()` |

### e) Manual Rerender CLI Script

| File | Role |
|------|------|
| `video-engine/scripts/rerender-voice.mjs` | Re-renders with new voice. Calls `synthesizeVoiceover()` with `provider: selectedProvider` from `TTS_PROVIDER` env var |

### f) Supporting Files

| File | Role |
|------|------|
| `video-engine/scripts/lib/gcp-config.mjs` | GCP auth, project config, access tokens |
| `video-engine/scripts/lib/secrets.mjs` | Keychain-based secret loading — already includes `ELEVENLABS_API_KEY` in `secretKeys[]` |
| `video-engine/scripts/lib/alignment-utils.mjs` | `sanitizeTimedWordsForAudio()` — normalizes timedWords to audio duration |
| `video-engine/.env.example` | Already has `ELEVENLABS_*` vars and `TTS_PROVIDER=google` |

### Current GCP TTS Flow

```
synthesizeVoiceover({ provider, text, sceneSpans, google, azure, elevenlabs })
  │
  ├─ provider matches "google-gemini-tts" / "gemini-tts" / "gemini"
  │   └─ synthesizeWithCloudTtsGemini() → Cloud TTS API → MP3
  │       └─ extractTimedWordsFromAudio() → Google Cloud STT → timedWords
  │           └─ fallback: buildEstimatedTimedWords()
  │
  └─ provider matches "gcloud" / "google" / "auto" (default)
      └─ synthesizeWithCloudTtsChirp3() → Cloud TTS Chirp3 API → MP3
          └─ extractTimedWordsFromAudio() → Google Cloud STT → timedWords
```

### ElevenLabs Integration Strategy

**Key finding:** `synthesizeWithElevenLabs()` already exists in `tts.mjs` (line ~210) and is fully functional. It:
1. Calls `POST /v1/text-to-speech/{voiceId}/with-timestamps` — the `with-timestamps` endpoint returns character-level alignment data
2. Uses `buildTimedWordsFromAlignment()` to convert ElevenLabs' character-level alignment into the same `timedWords[]` format used by the rest of the pipeline
3. Handles chunking, concatenation, and temp file cleanup

**What's missing:** The `synthesizeVoiceover()` router function (line 2332) currently rejects any provider that isn't `gcloud`/`google`/`auto`/`gemini-tts`. It throws:
```
Provider de voz nao suportado para a pipeline GCP: elevenlabs
```

The integration requires:
1. **TTS router** — Add `elevenlabs` to the accepted providers in `synthesizeVoiceover()`
2. **Frontend** — Add an audio provider selector so users can choose ElevenLabs and pick a voice ID
3. **Backend** — Pass the provider choice and ElevenLabs voice ID through the job pipeline
4. **CLI** — Accept `--provider` flag in `rerender-voice.mjs`

---

## Phase 2: Implementation Plan & Code

### 2.1 Environment & Config

No new dependencies needed. The ElevenLabs integration uses the native `fetch` API (Node 18+) which is already used throughout the codebase.

**`.env` additions** (add to root `.env` alongside existing vars):

```bash
# ElevenLabs TTS (optional — only needed when TTS_PROVIDER=elevenlabs)
ELEVENLABS_API_KEY=your-key-here
ELEVENLABS_VOICE_ID=TX3LPaxmHKxFdv7VOQHJ
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_LANGUAGE_CODE=pt
ELEVENLABS_STABILITY=0.32
ELEVENLABS_SIMILARITY_BOOST=0.8
ELEVENLABS_STYLE=0.24
ELEVENLABS_USE_SPEAKER_BOOST=true
ELEVENLABS_SPEED=1
```

These are already documented in `video-engine/.env.example`.

---

### 2.2 TTS Engine — Route to ElevenLabs

**File:** `video-engine/scripts/lib/tts.mjs`

The `synthesizeVoiceover()` function must accept `"elevenlabs"` as a provider and delegate to the existing `synthesizeWithElevenLabs()`.

**Current code (line 2332):**

```javascript
export const synthesizeVoiceover = async ({
  text,
  sceneSpans = [],
  voice,
  rate,
  aiffPath,
  mp3Path,
  provider = "gcloud",
  elevenlabs,
  google,
  azure
}) => {
  const normalizedProvider = String(provider || "gcloud").trim().toLowerCase();
  if (!["gcloud", "google-cloud", "google", "auto", "google-gemini-tts", "gemini-tts", "gemini"].includes(normalizedProvider)) {
    throw new Error(`Provider de voz nao suportado para a pipeline GCP: ${normalizedProvider}`);
  }
```

**Replace with:**

```javascript
export const synthesizeVoiceover = async ({
  text,
  sceneSpans = [],
  voice,
  rate,
  aiffPath,
  mp3Path,
  provider = "gcloud",
  elevenlabs,
  google,
  azure
}) => {
  const normalizedProvider = String(provider || "gcloud").trim().toLowerCase();

  if (normalizedProvider === "elevenlabs") {
    const apiKey = String(elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("ElevenLabs requer ELEVENLABS_API_KEY.");
    }

    const voiceId = String(elevenlabs?.voiceId || process.env.ELEVENLABS_VOICE_ID || "").trim();
    if (!voiceId) {
      throw new Error("ElevenLabs requer ELEVENLABS_VOICE_ID.");
    }

    const result = await synthesizeWithElevenLabs({
      text,
      mp3Path,
      apiKey,
      voiceId,
      modelId: String(elevenlabs?.modelId || process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2").trim(),
      languageCode: String(elevenlabs?.languageCode || process.env.ELEVENLABS_LANGUAGE_CODE || "pt").trim(),
      voiceSettings: elevenlabs?.voiceSettings || {
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.22),
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.9),
        style: Number(process.env.ELEVENLABS_STYLE || 0.3),
        use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",
        speed: Number(process.env.ELEVENLABS_SPEED || 1.05)
      }
    });

    const maxSilence = Number.parseFloat(process.env.TTS_MAX_SILENCE_SECONDS || "0.4");
    if (maxSilence > 0) {
      compressAudioSilences(mp3Path, maxSilence);
    }

    let timedWords = result.timedWords || [];
    const audioDurationSeconds = getAudioDurationSeconds(mp3Path);

    if (timedWords.length === 0) {
      const extracted = await extractTimedWordsFromAudio({
        mp3Path,
        apiKey: process.env.GOOGLE_API_KEY || "",
        text,
        languageCode: google?.languageCode || process.env.VIDEO_LANGUAGE || "pt-BR",
        sceneSpans,
        allowEstimated: ALLOW_ESTIMATED_TIMED_WORDS
      });
      timedWords = extracted.timedWords;
      result.timedWordsSource = extracted.timedWordsSource;
    } else {
      const normalized = sanitizeTimedWordsForAudio({timedWords, audioDurationSeconds});
      timedWords = normalized.timedWords;
    }

    return {
      provider: "elevenlabs",
      timedWords,
      timedWordsSource: result.timedWordsSource || "elevenlabs-alignment",
      voiceName: voiceId
    };
  }

  if (!["gcloud", "google-cloud", "google", "auto", "google-gemini-tts", "gemini-tts", "gemini"].includes(normalizedProvider)) {
    throw new Error(`Provider de voz nao suportado para a pipeline GCP: ${normalizedProvider}`);
  }
```

**Explanation of timedWords strategy:**

ElevenLabs' `/with-timestamps` endpoint returns character-level alignment data (`character_start_times_seconds`, `character_end_times_seconds`). The existing `buildTimedWordsFromAlignment()` function (already in `tts.mjs`) converts this into the same `timedWords[]` format that Remotion's karaoke captions expect. This gives us native word-level timestamps without needing Google Cloud STT as an intermediary.

If the ElevenLabs alignment data is empty (rare edge case), we fall back to `extractTimedWordsFromAudio()` which uses Google Cloud STT, exactly like the GCP providers do.

---

### 2.3 Frontend UI — Audio Provider Dropdown

#### 2.3.1 HTML

**File:** `web/public/index.html`

Add an audio provider selector before the voice dropdown. Insert after line 137 (before the `<label class="field">` for Voz):

```html
                  <label class="field">
                    <span>Provedor de áudio</span>
                    <select name="audioProvider" id="generateAudioProvider">
                      <option value="gcp" selected>Google Cloud TTS</option>
                      <option value="elevenlabs">ElevenLabs</option>
                    </select>
                  </label>
```

#### 2.3.2 JavaScript

**File:** `web/public/app.js`

**a) Register the element.** Find the `elements` object (near line 83 where `voiceHint` is defined) and add:

```javascript
  audioProvider: document.querySelector("#generateAudioProvider"),
```

**b) Add provider-change handler.** After the voice-related helpers (~line 880), add:

```javascript
const ELEVENLABS_VOICES = [
  {value: "TX3LPaxmHKxFdv7VOQHJ", label: "Liam • Narração pt-BR", languages: ["pt-BR", "en-US"]},
  {value: "pFZP5JQG7iQjIQuC4Bku", label: "Lily • Feminina en-US", languages: ["en-US", "pt-BR"]},
  {value: "nPczCjzI2devNBz1zQrb", label: "Brian • Masculina en-US", languages: ["en-US", "pt-BR"]}
];

const syncVoiceOptionsForProvider = () => {
  const provider = elements.audioProvider?.value || "gcp";
  const language = elements.generateForm?.language?.value || "pt-BR";
  const voiceSelect = elements.generateForm?.voice;
  if (!voiceSelect) return;

  voiceSelect.innerHTML = "";

  if (provider === "elevenlabs") {
    for (const v of ELEVENLABS_VOICES) {
      const opt = document.createElement("option");
      opt.value = v.value;
      opt.textContent = v.label;
      voiceSelect.appendChild(opt);
    }
    if (elements.voiceHint) elements.voiceHint.textContent = "Voice ID do ElevenLabs";
  } else {
    const voices = getVoicesForLanguage(language);
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.value;
      opt.textContent = v.label;
      voiceSelect.appendChild(opt);
    }
    voiceSelect.value = getPreferredVoiceForLanguage(language);
    if (elements.voiceHint) elements.voiceHint.textContent = "";
  }
};

elements.audioProvider?.addEventListener("change", syncVoiceOptionsForProvider);
```

**c) Include `audioProvider` in the payload.** In `buildGeneratePayload()` (line 2580), add to the returned object:

```javascript
    audioProvider: String(data.get("audioProvider") || "gcp"),
```

---

### 2.4 Backend API & Queue

#### 2.4.1 Server — Accept `audioProvider`

**File:** `web/server.mjs`

In `handleGenerateRequest()` (line 1870), after the `voice` resolution (~line 1900), add:

```javascript
  const audioProvider = body.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp";
```

Then include it in the `job.input` object:

```javascript
      audioProvider,
```

#### 2.4.2 Job Execution — Pass Provider to Child Processes

**File:** `web/lib/job-execution.mjs`

**a) `createGenerateJobCommand()` (line 116):** Add to the `env` object:

```javascript
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
```

**b) `createRerenderJobCommand()` (line 162):** Add to the `env` object:

```javascript
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
```

**c) `createAudioPrepJobCommand()` (line 196):** Add to the `env` object:

```javascript
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
```

---

### 2.5 CLI Rerender Tool — Accept `--provider` Flag

**File:** `video-engine/scripts/rerender-voice.mjs`

**a) Add `--provider` to `parseArgs()` (line ~30):**

```javascript
    if (argv[i] === "--provider") { parsed.provider = argv[++i]; continue; }
```

**b) Use it in `main()`.** Replace the line:

```javascript
  const selectedProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
```

with:

```javascript
  const selectedProvider = String(args.provider || process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
```

**c) Load the ElevenLabs secret.** In the `loadSecretsIntoEnv` call at the top of `main()`, add `"ELEVENLABS_API_KEY"`:

```javascript
  loadSecretsIntoEnv(["GOOGLE_API_KEY", "AZURE_SPEECH_KEY", "ELEVENLABS_API_KEY"]);
```

**d) Pass ElevenLabs config to `synthesizeVoiceover()`.** The existing call already passes an `elevenlabs: {}` object. Update it to:

```javascript
      elevenlabs: {
        apiKey: process.env.ELEVENLABS_API_KEY || "",
        voiceId: process.env.ELEVENLABS_VOICE_ID || "TX3LPaxmHKxFdv7VOQHJ",
        modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        languageCode: process.env.ELEVENLABS_LANGUAGE_CODE || "pt",
        voiceSettings: {
          stability: Number(process.env.ELEVENLABS_STABILITY || 0.22),
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.9),
          style: Number(process.env.ELEVENLABS_STYLE || 0.3),
          use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",
          speed: Number(process.env.ELEVENLABS_SPEED || 1.05)
        }
      },
```

---

### 2.6 Foiumaideia Orchestrator — Pass `--provider` Flag

**File:** `scripts/foiumaideia.mjs`

**a) Add `--provider` to `parseArgs()`.** In the arg parsing loop (~line 130), add:

```javascript
    if (item === "--provider") {
      parsed.provider = argv[index + 1];
      index += 1;
      continue;
    }
```

**b) Set `TTS_PROVIDER` in `runtimeEnv`.** After the `args.voice` block (~line 416), add:

```javascript
  if (args.provider) {
    runtimeEnv.TTS_PROVIDER = args.provider;
  }
```

---

## Phase 3: Validation & Testing

### 3.1 Verify ElevenLabs API Key

```bash
cd /root/repo/videos-flux2

# Check that the key is set
grep ELEVENLABS_API_KEY .env
```

### 3.2 End-to-End CLI Test (bypasses UI)

```bash
# Test with ElevenLabs via the rerender tool on an existing slug
node video-engine/scripts/rerender-voice.mjs \
  --slug YOUR_EXISTING_SLUG \
  --provider elevenlabs \
  --voice TX3LPaxmHKxFdv7VOQHJ
```

Replace `YOUR_EXISTING_SLUG` with any slug that already has scene clips and a storyboard in `video-engine/runs/`.

### 3.3 Full Pipeline Test via CLI

```bash
# Generate a new video using ElevenLabs from scratch
TTS_PROVIDER=elevenlabs \
ELEVENLABS_VOICE_ID=TX3LPaxmHKxFdv7VOQHJ \
node scripts/foiumaideia.mjs --title "Teste ElevenLabs integração"
```

### 3.4 UI Test

1. Restart the service: `systemctl restart codex-video-ui.service`
2. Open `https://video.vamostestar.online/`
3. In the creation form, select "ElevenLabs" from the "Provedor de áudio" dropdown
4. Verify the voice dropdown switches to ElevenLabs voice IDs
5. Submit a generation and monitor the pipeline log for `provider: "elevenlabs"` in the voiceover step

### 3.5 Validate timedWords Quality

After a successful ElevenLabs run, inspect the voiceover metadata:

```bash
cat video-engine/runs/YOUR_SLUG/voiceover.json | python3 -m json.tool | head -20
```

Confirm:
- `provider` is `"elevenlabs"`
- `timedWordsSource` is `"elevenlabs-alignment"`
- `timedWords` array is populated with `startSeconds`, `endSeconds`, `startChar`, `endChar` per word

### 3.6 Validate Karaoke Captions

```bash
cat video-engine/runs/YOUR_SLUG/render-props.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
captions = data.get('captions', [])
print(f'Captions: {len(captions)}')
for c in captions[:3]:
    words = c.get('words', [])
    print(f'  [{c[\"startFrame\"]}-{c[\"endFrame\"]}] {len(words)} words: {\" \".join(w[\"text\"] for w in words[:5])}...')
"
```

### 3.7 Run Existing QA

```bash
node video-engine/scripts/validate-run.mjs --slug YOUR_SLUG
```

---

## Summary of Changes by File

| File | Change |
|------|--------|
| `video-engine/scripts/lib/tts.mjs` | Add `elevenlabs` branch to `synthesizeVoiceover()` router |
| `web/public/index.html` | Add `<select name="audioProvider">` dropdown |
| `web/public/app.js` | Add `ELEVENLABS_VOICES[]`, `syncVoiceOptionsForProvider()`, include `audioProvider` in payload |
| `web/server.mjs` | Parse `audioProvider` from request body, store in `job.input` |
| `web/lib/job-execution.mjs` | Pass `TTS_PROVIDER` and `ELEVENLABS_VOICE_ID` env vars in 3 command builders |
| `video-engine/scripts/rerender-voice.mjs` | Add `--provider` flag, load ElevenLabs secret, pass config to `synthesizeVoiceover()` |
| `scripts/foiumaideia.mjs` | Add `--provider` flag, set `TTS_PROVIDER` in runtime env |

**Zero new npm dependencies.** The ElevenLabs REST API is called via native `fetch`. The `synthesizeWithElevenLabs()` function and `buildTimedWordsFromAlignment()` already exist and are battle-tested in the codebase.
