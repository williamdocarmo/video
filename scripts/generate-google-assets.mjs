#!/usr/bin/env node
/**
 * generate-google-assets.mjs
 *
 * Asset generation using Google Vertex AI / Gemini APIs.
 *
 * For each scene in a storyboard:
 *   1. Call Gemini to build a structured visual plan with 1..N shots
 *   2. Generate one Google Vertex image per planned shot
 *   3. Create a static video clip per image (no zoom/pan)
 *   4. Concatenate clips into scene-XX.mp4
 *
 * Output: assets/envato/{slug}/scene-XX.mp4
 */

import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {existsSync, readFileSync, writeFileSync, unlinkSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {resolveVisualStylePreset} from "../config/visual-style-presets.mjs";
import {normalizeText, sleep, uniqueStrings, extractJsonObject} from "../shared/utils.mjs";
import {callVertexMultimodalText, generateVertexImage} from "../video-engine/scripts/lib/gcp-media.mjs";
import {resolveGcpConfig} from "../video-engine/scripts/lib/gcp-config.mjs";
import {createGeminiUsageSummary, recordGeminiUsage} from "../video-engine/scripts/lib/gemini-usage.mjs";
import {analyzeFailureText} from "./lib/scene-failure-taxonomy.mjs";
import {compileSceneSpecFromStoryboardScene, lintSceneSpec} from "./lib/scene-spec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const LOCAL_VISUAL_AUDIT_SCRIPT = path.join(projectRoot, "scripts", "local-flux2-visual-audit.py");
const MIN_VALID_VIDEO_BYTES = 1024;

const loadSimpleEnvFile = (targetPath) => {
  if (!existsSync(targetPath)) {
    return;
  }

  const raw = readFileSync(targetPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};

loadSimpleEnvFile(path.join(projectRoot, "video-engine", ".env"));
loadSimpleEnvFile(path.join(projectRoot, ".env"));

const resolvePathFromProjectRoot = (value, fallback = "") => {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return "";
  }
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
};

const OUTPUT_WIDTH = Math.max(1, Number(process.env.OUTPUT_WIDTH || 1080));
const OUTPUT_HEIGHT = Math.max(1, Number(process.env.OUTPUT_HEIGHT || 1920));
const OUTPUT_LAYOUT = OUTPUT_WIDTH > OUTPUT_HEIGHT ? "horizontal" : "vertical";
const DEFAULT_FLUX2_CANVAS =
  OUTPUT_LAYOUT === "horizontal"
    ? {width: 1920, height: 1080}
    : {width: 1080, height: 1920};

const resolveFlux2Canvas = () => {
  const configuredWidth = Number(process.env.FLUX2_WIDTH || 0);
  const configuredHeight = Number(process.env.FLUX2_HEIGHT || 0);
  const hasConfiguredCanvas = configuredWidth > 0 && configuredHeight > 0;
  const configuredLayout = configuredWidth > configuredHeight ? "horizontal" : "vertical";
  const isConfiguredCanvasLargeEnough =
    configuredWidth >= DEFAULT_FLUX2_CANVAS.width &&
    configuredHeight >= DEFAULT_FLUX2_CANVAS.height;

  if (hasConfiguredCanvas && configuredLayout === OUTPUT_LAYOUT && isConfiguredCanvasLargeEnough) {
    return {
      width: configuredWidth,
      height: configuredHeight,
      source: "env"
    };
  }

  return {
    ...DEFAULT_FLUX2_CANVAS,
    source: hasConfiguredCanvas ? "layout-default-upgrade" : "layout-default"
  };
};

const FLUX2_CANVAS = resolveFlux2Canvas();
const LAYOUT_CAMERA = OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9 medium-wide illustration" : "vertical 9:16 medium-wide illustration";
const LAYOUT_COMPOSITION = OUTPUT_LAYOUT === "horizontal"
  ? "wide landscape composition, full character and all required objects fully visible, generous safe margins, no cropped head or limbs, no extreme close-up"
  : "vertical portrait composition, full character and all required objects fully visible, comfortable margins, no cropped head or limbs, no extreme close-up";
const LAYOUT_PLANNER_GUIDANCE = OUTPUT_LAYOUT === "horizontal"
  ? "All shots must be composed for a horizontal 16:9 frame. Default to medium-wide or wide framing. Keep the full character head and body inside the frame with safe margins. Avoid zoomed-in portraits, cropped heads, cropped limbs, and extreme close-ups unless a full object close-up is explicitly required."
  : "All shots must be composed for a vertical 9:16 frame. Keep the full character head and body inside the frame with safe margins. Avoid cropped heads, cropped limbs, and extreme close-ups unless a full object close-up is explicitly required.";
const LAYOUT_PROMPT_DIRECTIVES = OUTPUT_LAYOUT === "horizontal"
  ? [
      "horizontal landscape framing",
      "wide composition with full character visible",
      "keep head, hands, and feet inside frame",
      "generous safe margins around the character",
      "avoid zoomed-in portrait crop"
    ]
  : [
      "vertical portrait framing",
      "full character visible with comfortable margins",
      "keep head, hands, and feet inside frame",
      "avoid zoomed-in portrait crop"
    ];
const LAYOUT_OBJECT_CLOSEUP_DIRECTIVES = OUTPUT_LAYOUT === "horizontal"
  ? [
      "horizontal landscape close-up framing",
      "object-led composition with the key hardware or prop dominating the frame",
      "allow a tight crop around the main object detail",
      "avoid full-body character framing unless the shot explicitly requires it"
    ]
  : [
      "vertical portrait close-up framing",
      "object-led composition with the key hardware or prop dominating the frame",
      "allow a tight crop around the main object detail",
      "avoid full-body character framing unless the shot explicitly requires it"
    ];

// --- Config ---
const FLUX2_MODEL = process.env.FLUX2_MODEL || "AITRADER/FLUX2-klein-9B-mlx-4bit";
const FLUX2_BASE_MODEL = process.env.FLUX2_BASE_MODEL || "flux2-klein-9b";
const FLUX2_WIDTH = FLUX2_CANVAS.width;
const FLUX2_HEIGHT = FLUX2_CANVAS.height;
const FLUX2_STEPS = Number(process.env.FLUX2_STEPS || 4);
const FLUX2_GUIDANCE = Number(process.env.FLUX2_GUIDANCE || 1.0);
const FLUX2_CACHE_LIMIT_GB = Number(process.env.FLUX2_CACHE_LIMIT_GB || 8.0);
const FLUX2_MIN_SHOTS_PER_SCENE = Math.max(1, Number(process.env.FLUX2_MIN_SHOTS_PER_SCENE || 1));
const FLUX2_MAX_SHOTS_PER_SCENE = Math.max(
  FLUX2_MIN_SHOTS_PER_SCENE,
  Number(process.env.FLUX2_MAX_SHOTS_PER_SCENE || 8)
);
const FLUX2_ALLOW_FALLBACK = String(process.env.FLUX2_ALLOW_FALLBACK || "false").trim().toLowerCase() === "true";
const FLUX2_SUPPORTS_NEGATIVE_PROMPT = !String(FLUX2_BASE_MODEL || "")
  .trim()
  .toLowerCase()
  .startsWith("flux2");
const FLUX2_RENDER_RETRY_COUNT = Math.max(1, Number(process.env.FLUX2_RENDER_RETRY_COUNT || 3));
const CLIP_FPS = 30;
const CLIP_W = OUTPUT_WIDTH;
const CLIP_H = OUTPUT_HEIGHT;
const WORDS_PER_SECOND = 2.5;
const LLM_RETRY_DELAYS_MS = [1_000, 3_000, 7_000];
const LLM_PLANNER_MAX_TOKENS = [900, 1200, 1500];
const FLUX2_LOCAL_AUDIT_MIN_BYTES = Math.max(8_192, Number(process.env.FLUX2_LOCAL_AUDIT_MIN_BYTES || 24_576));
const FLUX2_LOCAL_VISUAL_AUDIT_STRICT = String(process.env.FLUX2_LOCAL_VISUAL_AUDIT_STRICT || "false").trim().toLowerCase() === "true";
const geminiUsageSummary = createGeminiUsageSummary();
const GCP_CONFIG = resolveGcpConfig(process.env);

// --- SDXL Refinement + Upscale Config ---
const SDXL_ENABLED = String(process.env.SDXL_ENABLED || "false").trim().toLowerCase() === "true";
const SDXL_MODEL = process.env.SDXL_MODEL || "stabilityai/stable-diffusion-xl-refiner-1.0";
const SDXL_DENOISE = Number(process.env.SDXL_DENOISE || 0.3);
const SDXL_STEPS = Number(process.env.SDXL_STEPS || 25);
const SDXL_GUIDANCE_SCALE = Number(process.env.SDXL_GUIDANCE_SCALE || 7.5);
const SDXL_MAX_DIMENSION = Number(process.env.SDXL_MAX_DIMENSION || 1024);
const SDXL_PROMPT_WORD_LIMIT = Math.max(16, Number(process.env.SDXL_PROMPT_WORD_LIMIT || 36));
const UPSCALE_ENABLED = String(process.env.UPSCALE_ENABLED || "false").trim().toLowerCase() === "true";
const UPSCALE_FACTOR = Math.max(1, Number(process.env.UPSCALE_FACTOR || 2));
const SDXL_REFINE_SCRIPT = path.join(projectRoot, "scripts", "sdxl-refine-and-upscale.py");
const ESRGAN_VENV_PYTHON = (() => {
  const venvPython = path.join(projectRoot, ".venv-esrgan", "bin", "python3");
  return existsSync(venvPython) ? venvPython : "python3";
})();

const DEFAULT_NEGATIVE_TERMS = [
  "text",
  "letters",
  "words",
  "numbers",
  "captions",
  "subtitles",
  "watermark",
  "logo",
  "signature",
  "brand mark",
  "photorealistic",
  "photograph",
  "3d render",
  "realistic skin",
  "detailed face",
  "realistic eyes",
  "extreme close-up",
  "cropped head",
  "cropped limbs",
  "gradient background",
  "dark background",
  "complex shadows",
  "depth of field",
  "bokeh",
  "lens flare",
  "neon glow",
  "high saturation",
  "extra arms",
  "extra hands",
  "extra legs",
  "extra feet",
  "extra fingers",
  "duplicate limbs",
  "duplicate hands",
  "duplicate arms",
  "mutated hands",
  "mutated anatomy",
  "deformed anatomy",
  "fused limbs",
  "floating limbs",
  "two heads",
  "multiple heads"
];
const FLUX2_NEGATIVE_PROMPT = String(process.env.FLUX2_NEGATIVE_PROMPT || "").trim();

// --- Args ---
const parseArgs = (argv) => {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--storyboard-file") { parsed.storyboardFile = argv[++i]; continue; }
    if (a === "--slug") { parsed.slug = argv[++i]; continue; }
    if (a === "--style") { parsed.style = argv[++i]; continue; }
    if (a === "--style-preset") { parsed.stylePreset = argv[++i]; continue; }
    if (a === "--dry-run") { parsed.dryRun = true; continue; }
    if (a === "--images-only") { parsed.imagesOnly = true; continue; }
    if (a === "--allow-fallback") { parsed.allowFallback = true; continue; }
    if (a === "--max-images") { parsed.maxImages = Number(argv[++i]); continue; }
    if (a === "--seed-base") { parsed.seedBase = Number(argv[++i]); continue; }
    if (a === "--force") { parsed.force = true; continue; }
    if (a === "--scene-number") { parsed.sceneNumber = Number(argv[++i]); continue; }
    if (a === "--provider") { parsed.provider = argv[++i]; continue; }
  }
  return parsed;
};

const cliArgs = parseArgs(process.argv.slice(2));
const IMAGE_PROVIDER = "google-cloud";
const ENABLE_PLANNER_FALLBACK = true;
const GOOGLE_CLOUD_PROJECT = String(process.env.GOOGLE_CLOUD_PROJECT || "gen-lang-client-0114845839").trim();
const GOOGLE_CLOUD_LOCATION = String(process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
const GOOGLE_IMAGE_MODEL = String(process.env.GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image").trim();
const GOOGLE_IMAGE_MODEL_FALLBACKS = String(
  process.env.GOOGLE_IMAGE_MODEL_FALLBACKS || ""
).trim();
const GOOGLE_IMAGE_MIN_INTERVAL_MS = Math.max(
  0,
  Number(process.env.GOOGLE_IMAGE_MIN_INTERVAL_MS || 35_000)
);
const GOOGLE_IMAGE_REQUEST_PAUSE_MS = Math.max(0, Number(process.env.GOOGLE_IMAGE_REQUEST_PAUSE_MS || 2500));
const GOOGLE_IMAGE_RETRY_DELAYS_MS = String(process.env.GOOGLE_IMAGE_RETRY_DELAYS_MS || "2500,6000,12000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0);
const ACTIVE_STYLE_PRESET = resolveVisualStylePreset(
  cliArgs.stylePreset || process.env.IMAGE_STYLE_PRESET || process.env.FLUX2_STYLE_PRESET || "claude"
);
const STYLE_IS_INK = ACTIVE_STYLE_PRESET.id === "ink";
const USE_DIRECT_SCENE_PLANNER = String(
  process.env.USE_DIRECT_SCENE_PLANNER || (STYLE_IS_INK ? "false" : "true")
).trim().toLowerCase() === "true";
const CHARACTER = process.env.IMAGE_CHARACTER_PROMPT || process.env.FLUX2_CHARACTER_PROMPT || ACTIVE_STYLE_PRESET.characterPrompt;
// Legacy DEFAULT_FLUX2_STYLE leaked the old Claude-style prompt into unrelated presets.
// Style presets are now the source of truth unless a per-run --style override is passed.
const DEFAULT_STYLE = ACTIVE_STYLE_PRESET.stylePrompt;
const DEFAULT_STYLE_LOCK_PROMPT =
  process.env.IMAGE_STYLE_LOCK_PROMPT || process.env.FLUX2_STYLE_LOCK_PROMPT || ACTIVE_STYLE_PRESET.styleLockPrompt;
const DEFAULT_COMPOSITION_RULES =
  process.env.IMAGE_COMPOSITION_RULES || process.env.FLUX2_COMPOSITION_RULES || ACTIVE_STYLE_PRESET.compositionRules;
const DEFAULT_BACKGROUND_DIRECTIVES = ACTIVE_STYLE_PRESET.backgroundDirectives;
const DEFAULT_LIGHTING =
  process.env.IMAGE_DEFAULT_LIGHTING || process.env.FLUX2_DEFAULT_LIGHTING || ACTIVE_STYLE_PRESET.defaultLighting || "clean contextual lighting";
const STYLE_PLANNER_GUIDANCE =
  ACTIVE_STYLE_PRESET.plannerGuidance || "All shots must stay compatible with the selected visual style and remain easy to read on mobile.";
const STYLE_HUMAN_GUIDANCE =
  ACTIVE_STYLE_PRESET.humanGuidance || "If a shot includes a person, describe a stylized simplified person with readable posture and minimal facial detail.";
const STYLE_ANATOMY_GUIDANCE =
  ACTIVE_STYLE_PRESET.anatomyGuidance || "If a shot includes a person, keep anatomy clean and avoid extra limbs, duplicate hands, merged limbs, or multiple heads.";
const STYLE_SCALE_GUIDANCE =
  ACTIVE_STYLE_PRESET.scaleGuidance || "If a shot includes a person, keep the subject large enough to read clearly in frame.";
const STYLE_ATTEMPT_DIRECTIVES = Array.isArray(ACTIVE_STYLE_PRESET.attemptDirectives)
  ? ACTIVE_STYLE_PRESET.attemptDirectives
  : [];
const STYLE_REFINE_PROMPT_LEAD =
  ACTIVE_STYLE_PRESET.refinePromptLead || "clean stylized illustration";
const STYLE_REFINE_PROMPT_FINISH =
  ACTIVE_STYLE_PRESET.refinePromptFinish || "clean readable composition, no text";
const STYLE_AUDIT_DESCRIPTION =
  ACTIVE_STYLE_PRESET.auditStyleDescription || "stylized illustration";
const EXPECT_STICKMAN_AUDIT = ACTIVE_STYLE_PRESET.expectStickman === true;
const STYLE_NEGATIVE_PROMPT_REMOVALS = Array.isArray(ACTIVE_STYLE_PRESET.negativePromptRemovals)
  ? ACTIVE_STYLE_PRESET.negativePromptRemovals.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
  : [];

const pickStableRunDirective = ({pool, salt = ""}) => {
  if (!Array.isArray(pool) || pool.length === 0) {
    return null;
  }

  const digest = createHash("sha1")
    .update(`${cliArgs.slug || "default"}::${ACTIVE_STYLE_PRESET.id}::${salt}`)
    .digest("hex");
  const index = Number.parseInt(digest.slice(0, 8), 16) % pool.length;
  return pool[index] || pool[0] || null;
};

// --- Helpers ---
const GOOGLE_IMAGE_RATE_LIMIT_DIR = path.join(projectRoot, ".cache");
const GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR = path.join(GOOGLE_IMAGE_RATE_LIMIT_DIR, "google-image-rate-limit.lock");
const GOOGLE_IMAGE_RATE_LIMIT_FILE = path.join(GOOGLE_IMAGE_RATE_LIMIT_DIR, "google-image-rate-limit.json");
const GOOGLE_IMAGE_RATE_LIMIT_LOCK_MAX_AGE_MS = 60000;

const withGoogleImageRateLimit = async () => {
  if (GOOGLE_IMAGE_MIN_INTERVAL_MS <= 0) {
    return;
  }

  await mkdir(GOOGLE_IMAGE_RATE_LIMIT_DIR, {recursive: true});

  for (;;) {
    try {
      await mkdir(GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR);
      break;
    } catch (error) {
      if (error && error.code === "EEXIST") {
        try {
          const lockStat = await stat(GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR);
          const lockAgeMs = Date.now() - lockStat.mtimeMs;
          if (lockAgeMs > GOOGLE_IMAGE_RATE_LIMIT_LOCK_MAX_AGE_MS) {
            process.stdout.write(`[vertex-image] removing stale rate-limit lock (age: ${Math.round(lockAgeMs / 1000)}s)\n`);
            await rm(GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR, {recursive: true, force: true});
            continue;
          }
        } catch {}
        await sleep(250);
        continue;
      }
      throw error;
    }
  }

  let waitMs = 0;

  try {
    let nextAvailableAt = 0;
    try {
      const raw = await readFile(GOOGLE_IMAGE_RATE_LIMIT_FILE, "utf8");
      const parsed = JSON.parse(raw);
      nextAvailableAt = Number(parsed.nextAvailableAt || 0);
    } catch {}

    const now = Date.now();
    const reservedAt = Math.max(now, nextAvailableAt);
    waitMs = Math.max(0, reservedAt - now);

    await writeFile(
      GOOGLE_IMAGE_RATE_LIMIT_FILE,
      JSON.stringify(
        {
          nextAvailableAt: reservedAt + GOOGLE_IMAGE_MIN_INTERVAL_MS
        },
        null,
        2
      ),
      "utf8"
    );
  } finally {
    await rm(GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR, {recursive: true, force: true});
  }

  if (waitMs > 0) {
    process.stdout.write(`[vertex-image] waiting ${waitMs}ms to respect rate limit\n`);
    await sleep(waitMs);
  }
};

const requireBinary = (name) => {
  const result = spawnSync("which", [name], {encoding: "utf8"});
  if (result.status !== 0) throw new Error(`Binary not found: ${name}`);
  return result.stdout.trim();
};

const generateGoogleCloudImage = async ({prompt, outputPath}) => {
  const models = [GOOGLE_IMAGE_MODEL, ...GOOGLE_IMAGE_MODEL_FALLBACKS.split(",").map((value) => value.trim()).filter(Boolean)]
    .filter(Boolean);
  let lastError = null;

  for (let attempt = 0; attempt <= GOOGLE_IMAGE_RETRY_DELAYS_MS.length; attempt++) {
    for (const [index, model] of [...new Set(models)].entries()) {
      try {
        await withGoogleImageRateLimit();
        const {payload, bytes} = await generateVertexImage({
          model,
          prompt,
          aspectRatio: OUTPUT_LAYOUT === "horizontal" ? "16:9" : "9:16",
          numberOfImages: 1
        });
        recordGeminiUsage(geminiUsageSummary, {
          model: payload?.modelVersion || model,
          usageMetadata: payload?.usageMetadata,
          context: "vertex-image-generation"
        });

        await writeFile(outputPath, bytes);
        process.stdout.write(`[vertex-image] ok via ${model}\n`);

        if (GOOGLE_IMAGE_REQUEST_PAUSE_MS > 0) {
          await sleep(GOOGLE_IMAGE_REQUEST_PAUSE_MS);
        }
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const message = lastError.message || "";
        const retryable =
          /\b429\b/.test(message) ||
          /\b503\b/.test(message) ||
          /\b500\b/.test(message) ||
          /timed? out/i.test(message) ||
          /rate/i.test(message) ||
          /temporar/i.test(message) ||
          /inline image data/i.test(message);

        process.stderr.write(`[vertex-image] ${model} attempt=${attempt + 1} failed: ${message}\n`);

        if (!retryable && index === models.length - 1) {
          break;
        }

        if (index < models.length - 1) {
          await sleep(1500);
          continue;
        }

        if (attempt < GOOGLE_IMAGE_RETRY_DELAYS_MS.length) {
          const delay = GOOGLE_IMAGE_RETRY_DELAYS_MS[attempt];
          process.stderr.write(`[vertex-image] waiting ${delay}ms before retry cycle\n`);
          await sleep(delay);
        }
      }
    }
  }

  throw lastError ?? new Error("Vertex image generation falhou sem detalhes");
};

const loadSecretIntoEnv = (key) => {
  if (String(process.env[key] || "").trim()) {
    return;
  }

  const service = String(process.env.KEYCHAIN_SERVICE || process.env.VIDEOS_ENVATO_KEYCHAIN_SERVICE || "video-engine").trim();
  const result = spawnSync("security", ["find-generic-password", "-a", key, "-s", service, "-w"], {
    encoding: "utf8",
    stdio: "pipe"
  });

  if (result.status === 0 && String(result.stdout || "").trim()) {
    process.env[key] = String(result.stdout).trim();
  }
};

const normalizeForMatch = (value) =>
  normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const truncateText = (value, maxLength) => {
  const normalized = normalizeText(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const countWords = (text) =>
  normalizeText(text)
    .split(/\s+/)
    .filter(Boolean).length;

const truncateWords = (value, maxWords) => {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return normalized;
  }
  return `${words.slice(0, maxWords).join(" ").trim()}...`;
};

const detectImageFormat = (bytes) => {
  if (!bytes || bytes.length < 12) {
    return null;
  }

  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;

  if (isPng) {
    return "png";
  }

  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (isJpeg) {
    return "jpeg";
  }

  const riff = bytes.toString("ascii", 0, 4) === "RIFF";
  const webp = bytes.toString("ascii", 8, 12) === "WEBP";
  if (riff && webp) {
    return "webp";
  }

  return null;
};

const collectGeneratedImageVariants = async (expectedPath) => {
  const dir = path.dirname(expectedPath);
  const {name, ext} = path.parse(expectedPath);
  const entries = await readdir(dir).catch(() => []); /* expected: dir may not exist yet */
  const matches = entries.filter((entry) =>
    (entry === `${name}${ext}` || entry.startsWith(`${name}_`)) &&
    entry.endsWith(ext)
  );

  const enriched = await Promise.all(matches.map(async (entry) => {
    const fullPath = path.join(dir, entry);
    try {
      const details = await stat(fullPath);
      return {path: fullPath, mtimeMs: details.mtimeMs};
    } catch {
      return null;
    }
  }));

  return enriched
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const buildReuseMetadata = ({scenePlans}) => ({
  stylePreset: ACTIVE_STYLE_PRESET.id,
  outputLayout: OUTPUT_LAYOUT,
  outputWidth: CLIP_W,
  outputHeight: CLIP_H,
  fluxWidth: FLUX2_WIDTH,
  fluxHeight: FLUX2_HEIGHT,
  storyboardFingerprint: createHash("sha1")
    .update(JSON.stringify(scenePlans.map((scenePlan) => ({
      scene: scenePlan.scene,
      title: scenePlan.title,
      narration: scenePlan.narration,
      planner: scenePlan.planner,
      shots: scenePlan.shots
    }))))
    .digest("hex")
});

const readReuseMetadata = async (assetDir) => {
  try {
    return JSON.parse(await readFile(path.join(assetDir, "flux2-meta.json"), "utf8"));
  } catch {
    return null;
  }
};

const removeGeneratedImageVariants = async (expectedPath) => {
  const variants = await collectGeneratedImageVariants(expectedPath);
  await Promise.all(variants.map((variant) => rm(variant.path, {force: true})));
};

const resolveGeneratedImagePath = async ({expectedPath}) => {
  const variants = await collectGeneratedImageVariants(expectedPath);
  const latest = variants[0]?.path;

  if (!latest) {
    throw new Error(`Google Vertex nao produziu a imagem esperada para ${path.basename(expectedPath)}`);
  }

  return latest;
};

const listSegmentImageCandidates = async ({imagesDir, sceneNum, segNum}) => {
  const prefix = `scene-${sceneNum}-seg-${segNum}`;
  const entries = await readdir(imagesDir).catch(() => []); /* expected: images dir may not exist yet */

  const enriched = await Promise.all(entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".png"))
    .map(async (entry) => {
      const fullPath = path.join(imagesDir, entry);
      try {
        const details = await stat(fullPath);
        return {path: fullPath, mtimeMs: details.mtimeMs};
      } catch {
        return null;
      }
    }));

  return enriched
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
};

const isConnectorOnlyText = (text) => {
  const normalized = normalizeText(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[!?.,;:]+/g, "")
    .trim();

  return [
    "e sabe o que mais",
    "mas olha so",
    "ao mesmo tempo",
    "agora",
    "so que",
    "e e aqui que",
    "e nao para por ai",
    "o mais interessante e que"
  ].includes(normalized);
};

const isInternalLabel = (scene, value) => {
  const candidate = normalizeForMatch(value);

  if (!candidate) {
    return false;
  }

  return [scene?.title, scene?.overlay].some((label) => candidate === normalizeForMatch(label));
};

const filterRenderablePhrases = (scene, values) =>
  uniqueStrings(values).filter((value) => !isInternalLabel(scene, value));

const normalizeStringArray = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueStrings(
    value
      .map((item) => truncateText(item, 180))
      .filter(Boolean)
  );
};

const sanitizeShotText = (value) => {
  let text = normalizeText(value);

  if (!text) {
    return text;
  }

  const replacements = [
    [/\beye contact\b/gi, "direct human connection"],
    [/\bface-to-face\b/gi, "direct human connection"],
    [/\beyes reflecting smartphone screen\b/gi, "character illuminated by smartphone glow"],
    [/\beye reflection\b/gi, "smartphone glow on character"],
    [/\breflected in (?:their|the) pupils\b/gi, "casting blue glow across the character"],
    [/\bstickman eyes\b/gi, "character"],
    [/\bstickman face\b/gi, "character"],
    [/\beyes\b/gi, "back of the head"],
    [/\beye\b/gi, "back of the head"],
    [/\bpupils?\b/gi, "back of the head"],
    [/\bface\b/gi, "back of the head, seen from behind"],
    [/\bsecure encrypted map on a tablet\b/gi, "slate device showing an abstract tactical map panel"],
    [/\bencrypted map on a tablet\b/gi, "slate device showing an abstract tactical map panel"],
    [/\bsecure map on a tablet\b/gi, "slate device showing an abstract tactical map panel"],
    [/\bmap application\b/gi, "abstract navigation panel"],
    [/\bmap app\b/gi, "abstract navigation panel"],
    [/\bdigital map on (?:a |the )?(smartphone|phone|tablet|screen)\b/gi, "abstract route panel on a generic device"],
    [/\bmap on (?:a |the )?(smartphone|phone|tablet|screen)\b/gi, "abstract route panel on a generic device"],
    [/\bsecure encrypted map\b/gi, "abstract tactical map panel"],
    [/\bencrypted map\b/gi, "abstract tactical map panel"],
    [/\bsecure map\b/gi, "abstract tactical map panel"],
    [/\bsmartphone screen\b/gi, "generic smartphone with a blank glowing screen"],
    [/\bphone screen\b/gi, "generic smartphone with a blank glowing screen"],
    [/\btablet screen\b/gi, "generic tablet with a blank glowing screen"],
    [/\btablet\b/gi, "generic tablet with a blank glowing screen"],
    [/\bcomputer monitor\b/gi, "monitor with abstract unlabeled blocks only"],
    [/\bdigital screen\b/gi, "abstract glowing display with no UI chrome"],
    [/\bdisplay screen\b/gi, "abstract glowing display with no UI chrome"],
    [/\byoung person\b/gi, "young character"],
    [/\bperson\b/gi, "character"],
    [/\bbusinessman\b/gi, "business character"],
    [/\bexecutive\b/gi, "executive character"],
    [/\bsoftware engineers\b/gi, "engineer characters"],
    [/\bengineers\b/gi, "engineer characters"],
    [/\bteam of software engineers\b/gi, "engineer team"],
    [/\babstract text lines\b/gi, "one or two large soft blank panels"],
    [/\btext lines\b/gi, "one or two large soft blank panels"],
    [/\bblank content blocks\b/gi, "one or two large soft blank panels"],
    [/\bblank rectangular content blocks\b/gi, "one or two large soft blank panels"],
    [/\bfinancial chart\b/gi, "unlabeled line chart"],
    [/\bfinancial charts\b/gi, "unlabeled line charts"],
    [/\bnews on a tablet\b/gi, "abstract unlabeled chart on a tablet"],
    [/\bfinancial news\b/gi, "abstract unlabeled dashboard"],
    [/\bbrowser\b/gi, "abstract panel"],
    [/\btoolbar icons\b/gi, "simple abstract dots"],
    [/\binterface\b/gi, "soft abstract glow panel"],
    [/\bscreen interface\b/gi, "soft abstract screen glow"],
    [/\brestaurant menu\b/gi, "paper menu card with blank horizontal blocks"],
    [/\bpaper menu\b/gi, "paper menu card with blank horizontal blocks"],
    [/\bmenu card\b/gi, "paper menu card with blank horizontal blocks"],
    [/\bmenu\b/gi, "menu card with blank horizontal blocks"],
    [/\bdocument\b/gi, "document sheet with blank layout blocks"],
    [/\bpaper\b/gi, "paper sheet"],
    [/\bsign\b/gi, "sign panel with blank blocks"],
    [/\bsubtitle\b/gi, "empty caption bar"],
    [/\bsubtitles\b/gi, "empty caption bars"],
    [/\btranslation\b/gi, "translated overlay bars"],
    [/\btranslated text\b/gi, "translated overlay bars"],
    [/\btext original\b/gi, "printed layout made of blank bars"],
    [/\bno signal\b/gi, "crossed-out signal bars"],
    [/\bsignal lost\b/gi, "crossed-out signal bars"],
    [/\blost signal\b/gi, "crossed-out signal bars"],
    [/\bgps unavailable\b/gi, "crossed-out navigation pin"],
    [/\bnavigation unavailable\b/gi, "crossed-out navigation pin"],
    [/\bdisplays? a ['"]crossed-out signal bars['"] or ['"]crossed-out navigation pin['"] icon\b/gi, "shows a symbolic outage cue on the screen"],
    [/\bdisplays? a ['"]crossed-out signal bars['"] icon\b/gi, "shows crossed-out signal bars on the screen"],
    [/\bdisplays? a ['"]crossed-out navigation pin['"] icon\b/gi, "shows a crossed-out navigation pin on the screen"],
    [/\bdisplays? a ['"]([^'"]+)['"] icon\b/gi, "shows a simple symbolic status cue on the screen"],
    [/'crossed-out signal bars'/gi, "crossed-out signal bars"],
    [/"crossed-out signal bars"/gi, "crossed-out signal bars"],
    [/'crossed-out navigation pin'/gi, "crossed-out navigation pin"],
    [/"crossed-out navigation pin"/gi, "crossed-out navigation pin"],
    [/\bthought bubble containing a question mark\b/gi, "puzzled body language"],
    [/\bthought bubble with a question mark\b/gi, "puzzled body language"],
    [/\bquestion marks?\b/gi, "puzzled body language"],
    [/\bfocused expression\b/gi, "forward-leaning posture"],
    [/\bstressed expression\b/gi, "tense posture"],
    [/\bworried expression\b/gi, "tense posture"],
    [/\blooking stressed\b/gi, "holding a tense posture"],
    [/\bworried expression\b/gi, "tense posture"],
    [/\bfocused intensity\b/gi, "intent body posture"],
    [/\bintense posture\b/gi, "tense forward posture"]
  ];

  if (STYLE_IS_INK) {
    replacements.push(
      [/\bdimly lit secure military command center\b/gi, "simplified military operations room"],
      [/\bmilitary command center\b/gi, "simplified military operations room"],
      [/\bsatellite dishes visible in the background\b/gi, "abstract satellite dish silhouettes in the background"],
      [/\bsatellite dishes\b/gi, "abstract satellite dish silhouettes"],
      [/\btactical map on a screen\b/gi, "abstract tactical map panel"],
      [/\btactical map\b/gi, "abstract tactical map panel"],
      [/\bnavigation app\b/gi, "abstract navigation panel"],
      [/\bprominent gps map on screen\b/gi, "abstract route line on a blank glowing screen"],
      [/\bgps map on screen\b/gi, "abstract route line on a blank glowing screen"],
      [/\bgps route\b/gi, "abstract route line"],
      [/\bclear, easy-to-follow gps route\b/gi, "simple abstract route line"],
      [/\bclear easy-to-follow gps route\b/gi, "simple abstract route line"],
      [/\bthought bubble containing a question mark\b/gi, "puzzled body language"],
      [/\bthought bubble with a question mark\b/gi, "puzzled body language"],
      [/\bquestion mark\b/gi, "puzzled gesture"],
      [/\bserious and focused\b/gi, "tense forward posture"],
      [/\bmodern and sleek\b/gi, "clean futuristic backdrop"]
    );
  }

  for (const [pattern, replacement] of replacements) {
    text = text.replace(pattern, replacement);
  }

  return normalizeText(
    text
      .replace(/\bstickman stickman\b/gi, "character")
      .replace(/\bstickman\b/gi, "character")
      .replace(/\babstract abstract\b/gi, "abstract")
  );
};

const sanitizeShotTextForSceneSpec = (value, sceneSpec = null) => {
  const source = normalizeText(value);
  let text = sanitizeShotText(source);

  if (!text || !sceneSpec) {
    return text;
  }

  const sourceLower = normalizeForMatch(source);
  const viewpoint = sceneSpec?.camera?.viewpoint || "front";
  const faceVisibility = sceneSpec?.pose?.faceVisibility || "partial";

  if (
    viewpoint !== "back" &&
    faceVisibility !== "hidden" &&
    /\bface\b|\bexpression\b|\beyes?\b|\bmouth\b|\bsmile\b/.test(sourceLower)
  ) {
    text = text
      .replace(/\bback of the head, seen from behind\b/gi, "face")
      .replace(/\bback of the head\b/gi, "face");
  }

  return normalizeText(text);
};

const buildSceneSpecMustShow = (scene, sceneSpec = null) => {
  if (!sceneSpec) {
    return [];
  }

  const mustShow = [];

  if (sceneSpec?.subject?.kind === "person") {
    mustShow.push("character");
  }

  for (const region of Array.isArray(sceneSpec?.constraints?.focusRegions) ? sceneSpec.constraints.focusRegions : []) {
    if (region === "face" && sceneSpec?.pose?.faceVisibility !== "hidden") {
      mustShow.push("face");
    } else if (region === "hands" && sceneSpec?.pose?.handVisibility !== "none") {
      mustShow.push("hands");
    } else if (region === "torso") {
      mustShow.push("upper torso and chest");
    } else if (region === "silhouette") {
      mustShow.push("clear body silhouette");
    }
  }

  if (sceneSpec?.pose?.bodyPose === "breathing") {
    mustShow.push("slow breathing chest movement");
  }

  if (sceneSpec?.affect?.emotion === "calm") {
    mustShow.push("calm expression");
  }

  return filterRenderablePhrases(
    scene,
    uniqueStrings(mustShow.map((item) => sanitizeShotTextForSceneSpec(item, sceneSpec)))
  ).slice(0, 6);
};

const buildSceneSpecSupportingDetails = (sceneSpec = null) => {
  if (!sceneSpec) {
    return [];
  }

  const details = [];

  if (sceneSpec?.pose?.interaction === "none") {
    details.push("no extra props or gestures");
  }

  if (sceneSpec?.affect?.emotion === "calm") {
    details.push("relaxed shoulders and peaceful body language");
  }

  if (sceneSpec?.camera?.viewpoint === "back") {
    details.push("rear-facing viewpoint preserved");
  } else if (sceneSpec?.pose?.faceVisibility === "clear") {
    details.push("face remains visible and readable");
  }

  if (sceneSpec?.camera?.framing === "closeup" || sceneSpec?.camera?.framing === "extreme_closeup") {
    details.push("tight close-up framing with the focus region dominant");
  }

  return uniqueStrings(details).slice(0, 6);
};

const buildSceneAwareComposition = ({sceneSpec = null, fallback = ""}) => {
  const base = normalizeText(fallback || LAYOUT_COMPOSITION);

  if (!sceneSpec) {
    return base;
  }

  const framing = sceneSpec?.camera?.framing || "medium";
  const cropPriority = sceneSpec?.camera?.cropPriority || "environment";
  const viewpoint = sceneSpec?.camera?.viewpoint || "front";
  const subjectKind = sceneSpec?.subject?.kind || "scene";
  const allowedProps = Array.isArray(sceneSpec?.environment?.allowedProps) ? sceneSpec.environment.allowedProps : [];

  if (subjectKind === "person" && ["closeup", "extreme_closeup"].includes(framing)) {
    const focusTarget =
      cropPriority === "hands"
        ? "hands and upper torso"
        : cropPriority === "torso"
          ? "upper torso and chest"
          : "face and upper torso";

    return normalizeText(
      `${OUTPUT_LAYOUT === "horizontal" ? "horizontal landscape composition" : "vertical portrait composition"}, ${framing.replaceAll("_", " ")} focused on the ${focusTarget}, ${viewpoint === "back" ? "rear-view" : viewpoint === "profile" ? "profile" : "front-facing"} framing, no full body, keep the focal region dominant, no extra props, no cropped focus region`
    );
  }

  if (sceneSpec?.pose?.interaction === "none" && allowedProps.length === 0 && subjectKind === "person") {
    return normalizeText(`${base}, one clear subject only, minimal background props, no extra objects entering the frame`);
  }

  return base;
};

const buildSceneAwareCamera = ({sceneSpec = null, fallback = ""}) => {
  const base = normalizeText(fallback || LAYOUT_CAMERA);

  if (!sceneSpec) {
    return base;
  }

  const framing = sceneSpec?.camera?.framing || "medium";

  if (framing === "extreme_closeup") {
    return OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9 extreme close-up illustration" : "vertical 9:16 extreme close-up illustration";
  }

  if (framing === "closeup") {
    return OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9 close-up illustration" : "vertical 9:16 close-up illustration";
  }

  if (framing === "full_body") {
    return OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9 full-body illustration" : "vertical 9:16 full-body illustration";
  }

  return base;
};

const buildSceneAwareAction = ({sceneSpec = null, fallback = ""}) => {
  const base = normalizeText(fallback || "character interacting with the key objects");

  if (!sceneSpec) {
    return base;
  }

  if (sceneSpec?.pose?.interaction === "none") {
    if (sceneSpec?.pose?.bodyPose === "breathing") {
      return "character breathing slowly with relaxed shoulders and still posture";
    }

    if (sceneSpec?.pose?.bodyPose === "sleeping") {
      return "character resting still in a peaceful sleeping posture";
    }

    if (sceneSpec?.affect?.emotion === "calm") {
      return "character holding still with calm body language and no object interaction";
    }
  }

  return base;
};

const buildSceneSpecPromptDirectives = ({sceneSpec = null, sceneLint = null}) => {
  if (!sceneSpec) {
    return [];
  }

  const directives = [];

  if (sceneSpec?.pose?.interaction === "none") {
    directives.push("do not add extra props, devices, or extra hands performing actions unless explicitly required");
  }

  if (sceneSpec?.affect?.emotion === "calm") {
    directives.push("the body language must read calm, peaceful, and relaxed, never itchy, tense, stressed, or agitated");
  }

  if (sceneSpec?.camera?.viewpoint === "back") {
    directives.push("keep the subject seen from behind and never switch to a front-facing view");
  } else if (sceneSpec?.pose?.faceVisibility === "clear") {
    directives.push("keep the face visible and readable when the scene asks for facial expression");
  }

  if (sceneSpec?.camera?.framing === "closeup" || sceneSpec?.camera?.framing === "extreme_closeup") {
    directives.push("do not zoom out to full body when the scene requires a close-up");
  }

  if ((sceneSpec?.constraints?.focusRegions || []).includes("torso")) {
    directives.push("make the torso and breathing motion the primary visible focus");
  }

  if (sceneLint?.summary?.issueCount > 0) {
    directives.push("resolve the scene-spec constraints cleanly without introducing extra subjects or props");
  }

  return uniqueStrings(directives);
};

const realignShotWithSceneSpec = ({scene, shot, sceneSpec = null}) => {
  if (!sceneSpec || !shot) {
    return shot;
  }

  const specMustShow = buildSceneSpecMustShow(scene, sceneSpec);
  const specSupporting = buildSceneSpecSupportingDetails(sceneSpec);

  shot.coverageText = truncateText(
    sanitizeShotTextForSceneSpec(sceneSpec.visualGoal || sceneSpec.searchQuery || sceneSpec.narration || shot.coverageText, sceneSpec),
    220
  );
  shot.mustShow = uniqueStrings([
    ...specMustShow,
    ...filterRenderablePhrases(scene, (Array.isArray(shot.mustShow) ? shot.mustShow : []).map((item) => sanitizeShotTextForSceneSpec(item, sceneSpec)))
  ]).slice(0, 8);
  shot.supportingDetails = uniqueStrings([
    ...specSupporting,
    ...filterRenderablePhrases(scene, (Array.isArray(shot.supportingDetails) ? shot.supportingDetails : []).map((item) => sanitizeShotTextForSceneSpec(item, sceneSpec)))
  ]).slice(0, 8);
  shot.setting = truncateText(
    sanitizeShotTextForSceneSpec(sceneSpec.visualGoal || sceneSpec.searchQuery || shot.setting || "clean contextual setting", sceneSpec),
    220
  );
  shot.composition = truncateText(buildSceneAwareComposition({sceneSpec, fallback: shot.composition}), 220);
  shot.camera = truncateText(buildSceneAwareCamera({sceneSpec, fallback: shot.camera}), 120);
  shot.action = truncateText(buildSceneAwareAction({sceneSpec, fallback: shot.action}), 180);

  return shot;
};

const shotLikelyShowsCharacterHead = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bcharacter\b|\bperson\b|\bbusinessman\b|\bexecutive\b|\bengineer\b|\bman\b|\bwoman\b|\bhuman\b|\bdriver\b/.test(haystack);
};

const shotHasHumanTouchpoint = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bcharacter\b|\bperson\b|\bbusinessman\b|\bexecutive\b|\bengineer\b|\bman\b|\bwoman\b|\bhuman\b|\bdriver\b|\bhand\b|\bhands\b|\bfinger\b|\bfingertip\b/.test(haystack);
};

const shotNeedsBlankDeviceScreen = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  const hasDevice =
    /\bsmartphone\b|\bphone\b|\btablet\b|\blaptop\b|\bscreen\b|\bmonitor\b|\bdisplay\b|\bdashboard\b|\binterface\b|\bscanner\b|\bchat bubble\b/.test(haystack);

  return hasDevice && !shotAllowsAbstractScreenContent(shot);
};

const shotNeedsStatusUiSignal = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  const hasStatusIntent =
    /\bno signal\b|\bsem sinal\b|\blost signal\b|\bsignal lost\b|\bgps unavailable\b|\bgps indisponivel\b|\boffline\b|\bsem internet\b|\bwithout internet\b|\bnetwork unavailable\b|\bno service\b|\bsem servico\b|\bfora de cobertura\b|\bsem cobertura\b|\broute unavailable\b|\brota indisponivel\b|\bgps off\b|\bsearching for gps\b|\bsem gps\b|\bcrossed out signal\b|\bcrossed out navigation\b|\bbroken route\b|\bdisconnected navigation\b/.test(haystack);
  const hasDeviceContext =
    /\bgps\b|\bmap\b|\bnavigation\b|\bnavegacao\b|\bdashboard\b|\bcar\b|\bvehicle\b|\bphone\b|\bsmartphone\b|\btablet\b|\blaptop\b|\bscreen\b|\bmonitor\b|\bdisplay\b|\bdevice\b|\bsystem\b|\binterface\b|\bnetwork\b|\bsignal\b|\bsatellite\b/.test(haystack);

  return hasStatusIntent && hasDeviceContext;
};

const shotAllowsAbstractScreenContent = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  const hasDeviceContext =
    /\bsmartphone\b|\bphone\b|\btablet\b|\blaptop\b|\bscreen\b|\bmonitor\b|\bdisplay\b|\bdashboard\b|\binterface\b|\bpanel\b/.test(haystack);
  const hasAbstractContentIntent =
    /\bmap application\b|\bmap app\b|\bmap panel\b|\bdigital map\b|\bnetwork map\b|\btactical map\b|\bencrypted map\b|\bsecure map\b|\bnavigation\b|\broute\b|\bdirections\b|\bchart\b|\bgraph\b|\bdashboard\b|\bradar\b|\bdiagram\b|\bwaveform\b|\bunlabeled chart\b/.test(haystack);

  return hasDeviceContext && hasAbstractContentIntent && !shotNeedsStatusUiSignal(shot);
};

const describeAllowedAbstractScreenContent = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  if (/\btactical map\b|\bencrypted map\b|\bsecure map\b|\bnetwork map\b|\bradar\b/.test(haystack)) {
    return "one abstract tactical map panel";
  }

  if (/\bnavigation\b|\broute\b|\bdirections\b|\bgps\b|\bmap application\b|\bmap app\b|\bdigital map\b/.test(haystack)) {
    return "one abstract route or navigation panel";
  }

  if (/\bchart\b|\bgraph\b|\bdashboard\b|\bwaveform\b|\bdiagram\b|\bunlabeled chart\b/.test(haystack)) {
    return "one abstract chart or dashboard panel";
  }

  return "one large abstract unlabeled panel";
};

const buildGeminiVisionAuditGuardrails = ({shot}) => {
  const guardrails = [];

  if (shotAllowsAbstractScreenContent(shot)) {
    guardrails.push(
      `- If a device screen is visible, ${describeAllowedAbstractScreenContent(shot)} is explicitly allowed when it stays abstract and unreadable.`,
      "- Do not reject just because a phone, tablet, dashboard, or monitor shows an abstract map, route, chart, radar, or tactical panel with no readable words or realistic UI chrome."
    );
  } else if (shotNeedsBlankDeviceScreen(shot)) {
    guardrails.push(
      "- If a device screen is visible, a blank glow or very soft abstract panel is intentional and acceptable when no richer screen content is required."
    );
  }

  if (shotNeedsStatusUiSignal(shot)) {
    guardrails.push(
      "- For no-signal or gps-unavailable scenes, one symbolic outage cue on the screen is allowed, such as crossed-out signal bars, a crossed-out navigation pin, or a broken route line.",
      "- Still reject readable outage words or realistic interface copy; the outage should be conveyed by simple symbolic shapes only."
    );
  }

  return guardrails;
};

const OCR_STATUS_ALLOWED_TOKENS = new Set([
  "off",
  "offline",
  "no",
  "sem",
  "signal",
  "sinal",
  "gps",
  "lost",
  "searching",
  "route",
  "rerouting",
  "unavailable",
  "indisponivel",
  "service",
  "servico",
  "nosignal",
  "noservice",
  "nogps"
]);

const OCR_STATUS_STRONG_TOKENS = new Set([
  "off",
  "offline",
  "signal",
  "sinal",
  "gps",
  "lost",
  "unavailable",
  "indisponivel",
  "nosignal",
  "noservice",
  "nogps"
]);

const OCR_ALWAYS_BLOCKED_TOKENS = new Set([
  "watermark",
  "logo",
  "caption",
  "subtitle",
  "subscribe",
  "follow",
  "like",
  "share",
  "official",
  "copyright",
  "youtube",
  "instagram",
  "facebook",
  "tiktok",
  "login",
  "verify",
  "update",
  "allow",
  "denied",
  "error",
  "warning",
  "http",
  "www",
  "com",
  "brand"
]);

const normalizeOcrToken = (value) =>
  normalizeForMatch(value)
    .replace(/[^a-z0-9]/g, "")
    .trim();

const parseOcrTokensFromReason = (reason) => {
  const match = /ocr detectou texto provavel:\s*(.+)$/i.exec(String(reason || ""));
  if (!match?.[1]) {
    return [];
  }

  return match[1]
    .split(",")
    .map((token) => normalizeOcrToken(token))
    .filter(Boolean);
};

const shouldAllowStatusOcrReason = ({shot, visualAudit, reason}) => {
  if (!/ocr detectou texto provavel/i.test(String(reason || ""))) {
    return {allowed: false, tokens: []};
  }

  if (!shotNeedsStatusUiSignal(shot)) {
    return {allowed: false, tokens: []};
  }

  const rawTokenCandidates = Array.isArray(visualAudit?.ocr_tokens)
    ? visualAudit.ocr_tokens.map((token) => token?.text)
    : [];
  const parsedFromReason = parseOcrTokensFromReason(reason);
  const normalizedTokens = uniqueStrings([
    ...rawTokenCandidates.map((token) => normalizeOcrToken(token)),
    ...parsedFromReason
  ]).filter(Boolean);

  if (normalizedTokens.length === 0 || normalizedTokens.length > 3) {
    return {allowed: false, tokens: normalizedTokens};
  }

  const hasBlockedToken = normalizedTokens.some((token) =>
    OCR_ALWAYS_BLOCKED_TOKENS.has(token) || /\d{2,}/.test(token)
  );
  if (hasBlockedToken) {
    return {allowed: false, tokens: normalizedTokens};
  }

  if (normalizedTokens.some((token) => token.length > 14 || !OCR_STATUS_ALLOWED_TOKENS.has(token))) {
    return {allowed: false, tokens: normalizedTokens};
  }

  const hasStrongToken = normalizedTokens.some((token) => OCR_STATUS_STRONG_TOKENS.has(token));
  const hasNoSignalPair =
    (normalizedTokens.includes("no") && (normalizedTokens.includes("signal") || normalizedTokens.includes("service") || normalizedTokens.includes("gps"))) ||
    (normalizedTokens.includes("sem") && (normalizedTokens.includes("sinal") || normalizedTokens.includes("servico") || normalizedTokens.includes("gps")));

  if (!hasStrongToken && !hasNoSignalPair) {
    return {allowed: false, tokens: normalizedTokens};
  }

  return {
    allowed: true,
    tokens: normalizedTokens
  };
};

const shotAllowsHeadAccessories = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bsmart glasses\b|\bglasses\b|\beyewear\b|\bgoggles\b|\bvr headset\b|\bheadset\b|\bhelmet\b/.test(haystack);
};

const shotNeedsObjectLedCloseup = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  const explicitCloseupIntent = /\bclose up\b|\bclose-up\b|\bextreme close-up\b|\bmacro\b|\bdetail shot\b|\bhero close-up\b/.test(haystack);
  const hardwareDamageIntent = /\bcharging port\b|\bport\b|\bconnector\b|\bglass\b|\bpeeling\b|\bpeel(?:ing)?\b|\bprotective layer\b|\bfilm edge\b|\bsmudge\b|\bsmudges\b|\bresidue\b|\bscratch(?:es)?\b|\bcorrosion\b|\bdiscoloration\b|\boleophobic\b/.test(haystack);
  const genericScreenIntent = /\bscreen\b|\bdisplay\b/.test(haystack);
  const humanContext = shotHasHumanTouchpoint(shot);

  if (explicitCloseupIntent || hardwareDamageIntent) {
    return true;
  }

  if (genericScreenIntent && !humanContext) {
    return true;
  }

  return false;
};

const shotNeedsFullHumanFigure = (shot) => shotLikelyShowsCharacterHead(shot) && !shotNeedsObjectLedCloseup(shot);

const filterConflictingCloseupDirectives = (directives = []) =>
  directives.filter((directive) => !/\bfull body\b|\bfull-body\b|\bfull character\b|\bfull stick figure\b|\bentire stick figure\b|\bfull character visible\b|\bkeep enough body in frame\b|\bkeep the body readable\b|\bcharacter head\b|\blarge round head\b|\bone readable stick figure\b|\bone readable human figure\b/i.test(String(directive || "")));

const buildHumanSubjectPrompt = (shot) => {
  if (shotNeedsFullHumanFigure(shot)) {
    return CHARACTER;
  }

  if (shotNeedsObjectLedCloseup(shot) && shotHasHumanTouchpoint(shot)) {
    return "if human interaction is needed, show only one clean hand or one fingertip interacting with the main object detail, with no extra limbs and no partial second person";
  }

  return null;
};

const shotNeedsPortFocus = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bcharging port\b|\bport\b|\bconnector\b|\busb port\b/.test(haystack);
};

const shotNeedsPeelingLayer = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bpeeling\b|\bpeel(?:ing)?\b|\bprotective layer\b|\bfilm edge\b|\boleophobic\b/.test(haystack);
};

const shotNeedsSurfaceDamageFocus = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\bsmudge\b|\bsmudges\b|\bresidue\b|\bscratch(?:es)?\b|\bcorrosion\b|\bdiscoloration\b/.test(haystack);
};

const shotIncludesPaperLikeObject = (shot) => {
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));

  return /\breceipt\b|\bbill\b|\binvoice\b|\bticket\b|\bdocument\b|\bpaper\b|\bnote\b|\bcalendar\b|\bmap\b|\bmenu\b|\bpackaging\b|\blabel\b|\bprinted page\b|\bcheckout\b/.test(haystack);
};

const buildAttemptDirectives = ({shot, attempt = 0, failureSummary = ""}) => {
  const directives = [];
  const objectLedCloseup = shotNeedsObjectLedCloseup(shot);
  const layoutDirectives = objectLedCloseup ? LAYOUT_OBJECT_CLOSEUP_DIRECTIVES : LAYOUT_PROMPT_DIRECTIVES;
  const styleAttemptDirectives = objectLedCloseup
    ? filterConflictingCloseupDirectives(STYLE_ATTEMPT_DIRECTIVES)
    : STYLE_ATTEMPT_DIRECTIVES;

  directives.push(...styleAttemptDirectives, ...layoutDirectives);

  if (shotNeedsFullHumanFigure(shot)) {
    if (EXPECT_STICKMAN_AUDIT) {
      directives.push(
        "character head is a simple circle with minimal features: two dots for eyes and a small curve for mouth, no hair detail, no ears, no nose, no eyebrows",
        "keep enough body in frame that the stick figure reads as a full character with clear posture, not just a tiny head and one stick line",
        "show exactly one stick figure — do not add a second figure, crowd, or silhouette in the background"
      );
    } else {
      directives.push(
        "show exactly one person with exactly two arms and two hands — do not add a second person, crowd, background silhouette, or extra limbs",
        "keep the full character visible in frame with clear posture and readable body language"
      );
    }
  }

  if (shotNeedsBlankDeviceScreen(shot)) {
    if (shotNeedsStatusUiSignal(shot)) {
      directives.push(
        "any smartphone, tablet, dashboard, or navigation display must be a generic unbranded slab with a blank glow and at most one simple symbolic outage cue such as crossed-out signal bars, a crossed-out navigation pin, or a broken route line",
        "show signal loss or missing navigation through symbolic shapes only, never with readable words such as OFF, GPS, SIGNAL, ERROR, LOST, or UNAVAILABLE",
        "do not add browser chrome, top bars, app shells, labels, tiny UI rows, or realistic interface copy"
      );
    } else {
      directives.push(
        "any smartphone, tablet, laptop, monitor, dashboard, scanner, or digital display must be a generic unbranded slab with a plain blank glow or only one to two large soft abstract panels, with no notch, no camera hole, no top cutout, no speaker slit, no status bar, no icons, no rows of small blocks, and no browser chrome"
      );
    }
  } else if (shotAllowsAbstractScreenContent(shot)) {
    directives.push(
      `if a device screen is visible, it may show ${describeAllowedAbstractScreenContent(shot)} only`,
      "keep screen content abstract and unreadable: no words, no labels, no browser chrome, no status bar, no small icons, and no realistic UI copy"
    );
  }

  if (shotIncludesPaperLikeObject(shot)) {
    directives.push(
      "any paper, map, document, receipt, menu, note, or printed material must show only abstract visual patterns: colored blobs, soft lines, faded shapes, or watercolor-like marks — never readable words, street names, numbers, prices, labels, or legible print",
      "for maps, use abstract cartographic shapes: colored regions, wavy route lines, and terrain-like blobs with no text labels"
    );
  }

  if (shotNeedsObjectLedCloseup(shot)) {
    directives.push(
      "use an object-led extreme close-up or macro composition where the key hardware detail fills most of the frame",
      "do not use a full-body person, hero portrait, or wide environmental shot; if a hand is required, show only the hand or fingertip interacting with the device detail"
    );
  }

  if (shotNeedsPortFocus(shot)) {
    directives.push(
      "make the charging port or connector the unmistakable focal point near the center of frame",
      "show the residue directly at the port opening, not on the screen"
    );
  }

  if (shotNeedsPeelingLayer(shot)) {
    directives.push(
      "show a transparent lifted film edge or protective layer clearly separating from the glass",
      "make the peeled edge obvious and readable at mobile size"
    );
  }

  if (shotNeedsSurfaceDamageFocus(shot)) {
    directives.push(
      "make the visible damage unmistakable through clear smudges, residue, scratches, corrosion marks, or discoloration on the hardware surface"
    );
  }

  if (attempt > 0) {
    directives.push("simplify the composition further than the previous failed render and remove every non-essential detail");

    if (/tracos faciais|facial|face|head|eye|pupil/i.test(failureSummary)) {
      directives.push("keep character faces simple, avoid photorealistic detail");
    }

    if (/window controls|browser|chrome|top bar|status bar|ui/i.test(failureSummary)) {
      directives.push("screens must be plain blank light shapes without framed interface chrome, tabs, control dots, top bars, or app shells");
    }

    if (/ocr|text|letters|numbers|glyph|label|caption|subtitle/i.test(failureSummary)) {
      if (shotNeedsStatusUiSignal(shot)) {
        directives.push(
          "for status scenes, prefer symbolic UI-state cues like disconnected bars, crossed-signal icon, broken route line, or muted network indicator",
          "do not spell the outage with words, abbreviations, labels, or button text"
        );
      } else {
        directives.push("remove every letter, number, label, glyph, caption, and text-like mark from the entire image");
      }
    }

    if (shotIncludesPaperLikeObject(shot) && /ocr|text|letters|numbers|glyph|label|caption|subtitle|receipt|invoice|ticket|document/i.test(failureSummary)) {
      directives.push(
        "if paper or a receipt is required, keep it tiny, angled, partially folded, motion-softened, or partly occluded so it reads as a paper object without inviting readable print",
        "use abstract cash-register receipt texture with faint broken bars or soft micro marks only, never clean words, prices, totals, dates, or store names"
      );
    }

    if (/not a close-up|wider shot|full body shot|full-body shot|person holding a smartphone|not the focal point/i.test(failureSummary)) {
      directives.push("crop much tighter to the required device detail so the hardware itself dominates the frame");
    }

    if (/charging port|residue is on the screen, not the charging port|not specifically the charging port/i.test(failureSummary)) {
      directives.push("reframe as a hardware macro shot centered on the charging port with the residue touching the port opening");
    }

    if (/peeling|protective layer|film edge|layer visibly peeling/i.test(failureSummary)) {
      directives.push("show the transparent layer physically lifting away from the glass with a clearly visible separated edge");
    }

    if (/not blank or glowing|not glowing/i.test(failureSummary)) {
      if (shotAllowsAbstractScreenContent(shot)) {
        directives.push(
          `the screen may show ${describeAllowedAbstractScreenContent(shot)}, but it must stay abstract and unreadable`,
          "remove labels, words, icons, browser chrome, and any realistic UI text"
        );
      } else {
        directives.push("make the screen a plain blank glow with no content, no icons, and no text");
      }
    }

    if (/extra arms|extra hands|extra legs|duplicate limbs|duplicate hands|mutated anatomy|anatomy/i.test(failureSummary)) {
      directives.push("fix anatomy strictly: one head, two arms, two hands, two legs only, with clean separated limbs and no duplicated extremities");
    }
  }

  return uniqueStrings(directives);
};

const classifyRepairCategories = ({shot, failureSummary = ""}) => {
  const summary = normalizeForMatch(failureSummary);
  const haystack = normalizeForMatch([
    shot?.coverageText,
    ...(Array.isArray(shot?.mustShow) ? shot.mustShow : []),
    ...(Array.isArray(shot?.supportingDetails) ? shot.supportingDetails : []),
    shot?.setting,
    shot?.composition,
    shot?.action
  ].join(" "));
  const categories = new Set();

  if (/ocr|readable text|letters|numbers|glyph|label|caption|subtitle|text on/i.test(failureSummary)) {
    categories.add("text_on_object");
  }
  if (shotNeedsStatusUiSignal(shot)) {
    categories.add("status_ui_signal");
  }
  if (/receipt|bill|invoice|ticket|checkout/i.test(summary)) {
    categories.add("receipt_like_object");
  }
  if (/wrong subject|wrong subject matter|does not match|modern laptop|depicts a modern laptop/i.test(summary)) {
    categories.add("wrong_subject");
  }
  if (/extra arms|extra hands|extra legs|duplicate limbs|duplicate hands|mutated anatomy|anatomy/i.test(summary)) {
    categories.add("anatomy_error");
  }
  if (/tiny|distant|barely visible|too small/i.test(summary)) {
    categories.add("tiny_subject");
  }
  if (/not a close-up|wider shot|full body shot|full-body shot|person holding a smartphone|not the focal point/i.test(summary)) {
    categories.add("missed_closeup");
  }
  if (/charging port|residue is on the screen, not the charging port|not specifically the charging port/i.test(summary)) {
    categories.add("missed_port_focus");
  }
  if (/peeling|protective layer|film edge|layer visibly peeling/i.test(summary)) {
    categories.add("missed_peeling_layer");
  }
  if (/corrosion|discoloration|smudges|smudge|scratches|residue/i.test(summary)) {
    categories.add("missed_surface_damage");
  }
  if (/not blank or glowing|not glowing/i.test(summary) && !shotAllowsAbstractScreenContent(shot)) {
    categories.add("missed_blank_glow");
  }

  if (/\bwatch\b|\bsmartwatch\b|\bpocket watch\b|\bclock\b/.test(haystack)) categories.add("watch_like_object");
  if (/\bpaper\b|\bdocument\b|\bnote\b|\bcalendar\b|\bmap\b/.test(haystack)) categories.add("paper_like_object");
  if (/\breceipt\b|\bbill\b|\binvoice\b|\bticket\b|\bcheckout\b/.test(haystack)) categories.add("receipt_like_object");
  if (/\btypewriter\b|maquina de escrever|máquina de escrever/.test(haystack)) categories.add("typewriter_object");
  if (/\bsmartphone\b|\bphone\b|\btablet\b|\blaptop\b|\bscreen\b|\bmonitor\b|\bdisplay\b|\binterface\b/.test(haystack)) categories.add("screen_like_object");

  return [...categories];
};

const buildPositiveRepairDirectives = ({shot, failureSummary = ""}) => {
  const categories = classifyRepairCategories({shot, failureSummary});
  const directives = [];

  if (categories.includes("watch_like_object") && categories.includes("text_on_object")) {
    directives.push(
      "show the watch as a clean accessory with an abstract unreadable face made of simple shapes only",
      "if a smartwatch is present, represent it as a blank dark glass surface or a minimal abstract glow with no visible time, numerals, ticks, digits, or interface detail",
      "if a pocket watch is present, keep the face angled away or partially occluded so it reads clearly as a watch object without readable markings"
    );
  }

  if (categories.includes("paper_like_object") && categories.includes("text_on_object")) {
    directives.push(
      "show paper, notes, maps, or calendars as blank graphic surfaces with lines and blocks only, never readable words or numbers",
      "prefer side angle, folded paper, or partial crop so the object reads clearly without inviting legible text"
    );
  }

  if (categories.includes("receipt_like_object") && categories.includes("text_on_object")) {
    directives.push(
      "if a receipt or checkout paper is required, treat it as a small supporting prop, not a hero close-up",
      "render the receipt with soft broken bars, faint line texture, or abstract pseudo-print only, never readable store names, totals, prices, dates, or button-like labels",
      "prefer angled, folded, partially hidden, or motion-soft receipt paper so the scene reads immediately without legible text"
    );
  }

  if (categories.includes("screen_like_object") && categories.includes("text_on_object")) {
    if (categories.includes("status_ui_signal")) {
      directives.push(
        "show the screen as a blank glowing panel with one bold symbolic outage cue only, such as crossed-out signal bars, a crossed-out navigation pin, or a broken route line",
        "make the device readable by silhouette and symbolic state only, never by visible words or interface copy"
      );
    } else if (shotAllowsAbstractScreenContent(shot)) {
      directives.push(
        `the screen may contain ${describeAllowedAbstractScreenContent(shot)}, but only as large abstract unreadable shapes`,
        "remove all readable labels, glyphs, icons, legends, and realistic interface copy from the display"
      );
    } else {
      directives.push(
        "show screens as abstract glowing panels with one or two large soft shapes only",
        "make the device readable by silhouette and framing, not by visible UI content"
      );
    }
  }

  if (categories.includes("status_ui_signal") && categories.includes("text_on_object")) {
    directives.push(
      "for no-signal or gps-unavailable states, prioritize symbolic status indicators over readable words",
      "do not use tiny status text, abbreviations, menu labels, button labels, or alert copy to express the outage"
    );
  }

  if (categories.includes("typewriter_object")) {
    directives.push(
      "make the vintage mechanical typewriter the unmistakable hero object in frame",
      "show metal keys, carriage, platen, and blank paper so the scene reads immediately as a typewriter and not as a laptop"
    );
  }

  if (categories.includes("wrong_subject")) {
    directives.push(
      `make the main subject unmistakable and dominant: ${shot?.mustShow?.join(", ") || shot?.coverageText || "the requested subject"}`,
      "remove competing modern substitute objects that could steal the interpretation"
    );
  }

  if (categories.includes("anatomy_error")) {
    directives.push(
      "use a simpler safer pose with both hands either clearly separated or one hand partially hidden behind the main object",
      "keep the body readable through silhouette, not through complex overlapping limbs"
    );
  }

  if (categories.includes("tiny_subject")) {
    directives.push(
      "make the main subject larger and more dominant in frame",
      "reduce background noise so the subject reads instantly on mobile"
    );
  }

  if (categories.includes("missed_closeup")) {
    directives.push(
      "switch to a tighter macro crop where the required object fills most of the frame",
      "remove non-essential background and avoid showing a full person"
    );
  }

  if (categories.includes("missed_port_focus")) {
    directives.push(
      "make the charging port the hero detail and place the residue directly at the port opening",
      "if a finger is present, let it point at the port itself, not the screen"
    );
  }

  if (categories.includes("missed_peeling_layer")) {
    directives.push(
      "show a transparent lifted layer edge physically separated from the glass so the peeling action is unmistakable",
      "make the exposed glass beneath the lifted layer visibly dirtier or more smudged"
    );
  }

  if (categories.includes("missed_surface_damage")) {
    directives.push(
      "make the surface damage obvious with visible residue, smudges, scratches, corrosion marks, or discoloration on the device surface"
    );
  }

  if (categories.includes("missed_blank_glow")) {
    directives.push(
      "use a clean blank glowing screen with no readable UI and no realistic app content"
    );
  }

  return uniqueStrings(directives);
};

const buildRetryDirectiveLabel = ({shot, failureSummary = ""}) => {
  const categories = classifyRepairCategories({shot, failureSummary});
  const labels = [];

  if (categories.includes("anatomy_error")) labels.push("anatomy");
  if (categories.includes("text_on_object") && categories.includes("receipt_like_object")) labels.push("receipt-text");
  else if (categories.includes("text_on_object") && categories.includes("paper_like_object")) labels.push("paper-text");
  else if (categories.includes("text_on_object")) labels.push("anti-text");
  if (categories.includes("screen_like_object")) labels.push("anti-UI");
  if (categories.includes("missed_closeup")) labels.push("closeup");
  if (categories.includes("missed_port_focus")) labels.push("port-focus");
  if (categories.includes("missed_peeling_layer")) labels.push("peeling-layer");
  if (categories.includes("missed_surface_damage")) labels.push("surface-damage");
  if (categories.includes("missed_blank_glow")) labels.push("blank-screen");

  return labels.length > 0 ? labels.join("/") : "scene-fidelity";
};

const SHOT_VARIATION_ROTATION = [
  "prefer a medium-wide full-body composition with readable environment context",
  "prefer a three-quarter or over-the-shoulder angle if the main device remains clearly visible",
  "prefer a top-down or desk-diagonal composition when objects on a surface are central to the idea",
  "prefer an object-led composition with the key device or prop larger in frame and the character supporting the action",
  "prefer a wider environmental shot with the character smaller in frame when the setting matters",
  "prefer a side-profile composition with a strong readable silhouette"
];

const STICKMAN_VARIATION_ROTATION = [
  "prefer a medium-wide full-body composition with the entire stick figure clearly visible and the key object still readable",
  "prefer a three-quarter full-body angle with the device visible but keep the head small enough to avoid a close-up look",
  "prefer a wider environmental shot with the full stick figure, readable posture, and key object visible at the same time",
  "prefer a side-profile full-body composition with a strong readable silhouette and safe margins around the head and limbs"
];

const FULL_HUMAN_VARIATION_ROTATION = [
  "prefer a medium-wide full-body composition with readable environment context",
  "prefer a three-quarter angle with the main device still clearly visible",
  "prefer a side-profile composition with a strong readable silhouette"
];

const FULL_HUMAN_STICKMAN_VARIATION_ROTATION = [
  "prefer a medium-wide full-body composition with the entire stick figure clearly visible and the key object still readable",
  "prefer a three-quarter full-body angle with the device visible but keep the head small enough to avoid a close-up look",
  "prefer a side-profile full-body composition with a strong readable silhouette and safe margins around the head and limbs"
];

const RUN_VISUAL_CONTRACT = {
  closeupDirective: OUTPUT_LAYOUT === "horizontal"
    ? "keep all object-led close-ups in the same horizontal premium macro language across the whole run, with centered hardware detail, restrained props, and consistent contrast"
    : "keep all object-led close-ups in the same vertical premium macro language across the whole run, with centered hardware detail, restrained props, and consistent contrast",
  backgroundDirective: EXPECT_STICKMAN_AUDIT
    ? "keep the same background density, line weight, and silhouette clarity across all scenes in this run"
    : "keep the same camera family, subject scale, and background density across all scenes in this run"
};

const normalizePromptDirectives = ({directives = [], shot, limit = 10}) => {
  const results = [];
  const seenFamilies = new Set();
  const objectLedCloseup = shotNeedsObjectLedCloseup(shot);
  const fullHumanFigure = shotNeedsFullHumanFigure(shot);

  const classifyFamily = (directive) => {
    const normalized = normalizeForMatch(directive);

    if (/\bmacro\b|\bclose up\b|\bcloseup\b|\bextreme close up\b|\bextreme closeup\b|\bobject led\b|\bhardware detail\b/.test(normalized)) {
      return "scale-closeup";
    }

    if (/\bfull body\b|\bfullbody\b|\bwide environmental\b|\bwider environmental\b|\bmedium wide\b|\bfull character\b/.test(normalized)) {
      return "scale-full";
    }

    if (/\bthree quarter\b|\bover the shoulder\b|\bside profile\b|\btop down\b|\bdesk diagonal\b/.test(normalized)) {
      return "angle";
    }

    if (/\bkeep all object led closeups\b|\bkeep all object led close ups\b|\bkeep the same camera family\b|\bkeep the same background density\b/.test(normalized)) {
      return "run-consistency";
    }

    return null;
  };

  for (const directive of uniqueStrings(directives)) {
    const value = normalizeText(directive);
    if (!value) {
      continue;
    }

    const normalized = normalizeForMatch(value);

    if (
      objectLedCloseup &&
      /\bfull body\b|\bfullbody\b|\bwide environmental\b|\bwider environmental\b|\bfull character\b|\bfull stick figure\b/.test(normalized)
    ) {
      continue;
    }

    if (
      fullHumanFigure &&
      /\bmacro\b|\bextreme close up\b|\bextreme closeup\b|\bobject led\b|\bhardware detail fills most of the frame\b|\bcrop to the hand\b/.test(normalized)
    ) {
      continue;
    }

    const family = classifyFamily(value);
    if (family && seenFamilies.has(family)) {
      continue;
    }

    results.push(value);
    if (family) {
      seenFamilies.add(family);
    }

    if (results.length >= limit) {
      break;
    }
  }

  return results;
};

const buildVariationDirectives = ({shot}) => {
  if (shotNeedsObjectLedCloseup(shot)) {
    return [
      RUN_VISUAL_CONTRACT.closeupDirective,
      "if a hand is present, crop to the hand and the hardware detail only",
      "avoid full-body, portrait, or wide environmental framing for this shot"
    ];
  }

  const fullHumanPool = EXPECT_STICKMAN_AUDIT
    ? FULL_HUMAN_STICKMAN_VARIATION_ROTATION
    : FULL_HUMAN_VARIATION_ROTATION;
  const generalPool = EXPECT_STICKMAN_AUDIT ? STICKMAN_VARIATION_ROTATION : SHOT_VARIATION_ROTATION;
  const humanDirective = pickStableRunDirective({
    pool: shotNeedsFullHumanFigure(shot) ? fullHumanPool : generalPool,
    salt: shotNeedsFullHumanFigure(shot) ? "full-human-camera" : "general-camera"
  });

  return [
    humanDirective,
    RUN_VISUAL_CONTRACT.backgroundDirective,
    EXPECT_STICKMAN_AUDIT
      ? "keep the entire stick figure visible, avoid oversized head close-ups, and keep enough body in frame for clear posture"
      : "keep character scale and object hierarchy consistent across nearby scenes"
  ].filter(Boolean);
};

const buildSemanticFallbackShot = (scene, segmentText) => {
  const source = normalizeForMatch(`${segmentText} ${scene.narration || ""}`);
  const mustShow = [];
  const supportingDetails = [];
  let setting = normalizeText(scene.visualGoal || scene.searchQuery || "clean contextual setting");
  let action = "character interacting with the required objects";

  const addMustShow = (...items) => mustShow.push(...items.filter(Boolean));
  const addSupporting = (...items) => supportingDetails.push(...items.filter(Boolean));

  if (/\btypewriter\b/.test(source) || /maquina de escrever/.test(source) || /máquina de escrever/.test(source)) {
    addMustShow("vintage mechanical typewriter", "hands typing on a typewriter keyboard");
    addSupporting("paper sheet in the platen without readable text", "writer desk with books and coffee");
    setting = "writer desk scene centered on a vintage mechanical typewriter";
    action = "hands typing intently on a vintage mechanical typewriter";
  }

  if (
    !(/\btypewriter\b/.test(source) || /maquina de escrever/.test(source) || /máquina de escrever/.test(source)) &&
    (
      /\bdigitar\b/.test(source) ||
      /\bdigitando\b/.test(source) ||
      /\btyping\b/.test(source) ||
      /\bteclado\b/.test(source) ||
      /\bkeyboard\b/.test(source) ||
      /\blaptop\b/.test(source) ||
      /\bcomputer\b/.test(source)
    )
  ) {
    addMustShow("hands typing on a laptop keyboard");
    addSupporting("focused late-night computer workspace", "close-up desk scene with glowing laptop");
    setting = "late-night desk workspace with laptop and abstract interface glow";
    action = "character typing intensely on a laptop keyboard";
  }

  if (/\bssd\b/.test(source) || /\busb drive\b/.test(source) || /\bpendrive\b/.test(source)) {
    addMustShow("plain unbranded portable storage device", "small travel bag");
    addSupporting("blank device with no letters or labels", "device being placed into the bag");
    setting = "simple travel preparation scene with minimal props";
    action = "character placing a small storage device into a travel bag";
  }

  if (/\bconvers/.test(source) || /\bchat\b/.test(source)) {
    addMustShow("two chat bubbles without readable text");
    addSupporting("conversation replacing isolated typing", "abstract messaging flow without words");
    setting = "clean digital conversation scene with floating chat bubbles";
    action = "character engaging with an abstract chat interface";
  }

  if (/quartel general|headquarters|comando|military|soldier|camouflage|tactical map|satellite dish|command center/.test(source)) {
    addMustShow("soldier in camouflage silhouette", "abstract tactical map panel");
    if (STYLE_IS_INK) {
      addSupporting("simplified military operations room", "abstract satellite dish silhouettes");
      setting = "editorial military operations vignette with an abstract tactical map panel and simplified command-room cues";
      action = "soldier studying an abstract tactical display in a secure operations setting";
    } else {
      addMustShow("military-style digital command center", "strategy table", "large world map screen without readable text");
      addSupporting("officers coordinating around a tactical display", "high-alert operations room");
      setting = "high-tech command center with strategy table and wall-sized network map";
      action = "command team analyzing a digital battlefield";
    }
  }

  if (/\bgps\b|\bnavigation\b|\broute\b|\bdirections\b|\bnavigator\b/.test(source)) {
    addMustShow("generic smartphone or dashboard navigation device");
    if (STYLE_IS_INK) {
      addSupporting("blank glowing navigation panel with one abstract route line", "device readable by silhouette, not UI text");
    } else {
      addSupporting("clean abstract route display with no readable text");
    }
  }

  if (/\bno signal\b|\bgps unavailable\b|\bnavigation unavailable\b|\bsignal lost\b|\blost signal\b/.test(source)) {
    addMustShow("generic smartphone with a crossed-out signal symbol");
    addSupporting(
      "blank glowing map with a broken route line",
      "lost body language with empty surroundings",
      "device readable by symbolic outage cue, not by UI text"
    );
    setting = "street or roadside scene where the character feels lost without navigation guidance";
    action = "character checking a phone with a disconnected navigation symbol";
  }

  if (/\bcharging port\b|\bport\b|\bconnector\b|\busb port\b/.test(source)) {
    addMustShow(
      "smartphone charging port close-up",
      "tiny toothpaste residue at the charging port"
    );
    if (/\bpointing\b|\bhand pointing\b|\bfinger\b/.test(source)) {
      addMustShow("finger pointing directly at the charging port");
    }
    addSupporting("blank unbranded phone body with no readable screen text");
    setting = "technical macro hardware shot with premium studio lighting";
    action = "finger pointing at the charging port residue";
  }

  if (/\bpeeling\b|\bpeel(?:ing)?\b|\bprotective layer\b|\bfilm edge\b|\boleophobic\b/.test(source)) {
    addMustShow(
      "smartphone screen close-up",
      "transparent film edge lifting from the glass"
    );
    if (/\bsmudge\b|\bsmudges\b|\bdirty\b|\bsujeira\b/.test(source)) {
      addMustShow("smudges on the exposed screen");
    }
    if (/\bwiping\b|\bwipe\b|\bcloth\b|\bcleaning\b/.test(source)) {
      addMustShow("cloth wiping the screen");
    }
    addSupporting("the peeled layer clearly separated from the glass surface");
    setting = "macro smartphone screen shot with technical rim lighting";
    action = "cloth dragging across the screen while the transparent layer lifts away";
  }

  if (/\bcorrosion\b|\bdiscoloration\b|\bscratch(?:es)?\b|\bsmudge\b|\bsmudges\b|\bresidue\b/.test(source)) {
    addMustShow("smartphone screen close-up");
    if (/\bcorrosion\b|\bdiscoloration\b/.test(source)) {
      addMustShow("chemical corrosion marks on the glass", "screen discoloration after chemical damage");
    }
    if (/\bscratch(?:es)?\b/.test(source)) {
      addMustShow("visible scratch damage on the glass");
    }
    if (/\bsmudge\b|\bsmudges\b|\bresidue\b/.test(source)) {
      addMustShow("visible residue or smudges on the screen");
    }
    addSupporting("blank glowing screen with no readable interface");
    setting = "macro product damage shot with premium studio lighting";
    action = "camera lingering on the damaged device surface";
  }

  if (/monopolio|monopolio dos buscadores|buscador|search engine|search/.test(source)) {
    addMustShow("dominant search empire under pressure", "cracked magnifying glass symbol");
    addSupporting("multiple abstract search panels without words", "digital market dominance collapsing");
    setting = "internet control room with abstract search systems";
    action = "systems shaking as search dominance breaks";
  }

  if (/resposta imediata|software engineers|engenheiros|modelos gigantescos|texto, som e imagem|texto som e imagem|multimodal/.test(source)) {
    addMustShow("software engineers in front of multiple large monitors", "abstract code blocks on screens");
    addSupporting("audio waveform icon", "image thumbnail icon", "multimodal AI lab setup");
    setting = "AI research lab with several large monitors and multimodal visual cues";
    action = "engineers coordinating around multimodal AI systems";
  }

  if (mustShow.length === 0) {
    const visualGoalAnchor = normalizeText(scene.visualGoal);
    const searchQueryAnchor = normalizeText(scene.searchQuery);
    const candidateAnchor = normalizeText(Array.isArray(scene.candidateQueries) ? scene.candidateQueries[0] : "");
    const combinedGoal = normalizeForMatch(`${visualGoalAnchor} ${scene.narration || ""}`);
    const combinedSearch = normalizeForMatch(searchQueryAnchor);
    const searchTokens = new Set(combinedSearch.split(/\s+/).filter((token) => token.length >= 4));
    const overlappingTokenCount = Array.from(searchTokens).filter((token) => combinedGoal.includes(token)).length;
    const searchLooksAbstract =
      /\bstarry\b|\bgalaxy\b|\bcosmic\b|\bdeep space\b|\breflection in the water\b|\bethereal\b|\babstract\b|\bsurreal\b/.test(combinedSearch) &&
      !/\bstarry\b|\bgalaxy\b|\bcosmic\b|\bdeep space\b/.test(combinedGoal);

    if (visualGoalAnchor && (searchLooksAbstract || overlappingTokenCount < 2)) {
      addMustShow(visualGoalAnchor);
    } else {
      addMustShow(searchQueryAnchor || candidateAnchor || visualGoalAnchor);
    }
  }

  if (supportingDetails.length === 0) {
    addSupporting(normalizeText(scene.visualGoal));
  }

  return {
    mustShow: uniqueStrings(filterRenderablePhrases(scene, mustShow)).slice(0, 6),
    supportingDetails: uniqueStrings(filterRenderablePhrases(scene, supportingDetails)).slice(0, 6),
    setting: truncateText(setting, 220),
    action: truncateText(action, 180)
  };
};

const splitNarration = (narration) => {
  if (!narration) return [{text: "cena abstrata", words: 2}];
  const parts = narration.split(/(?<=[.;!?])\s+/).filter((segment) => segment.trim().length > 3);
  if (parts.length === 0) {
    const trimmed = narration.trim();
    return [{text: trimmed, words: countWords(trimmed)}];
  }
  return parts.map((segment) => ({
    text: segment.trim(),
    words: countWords(segment)
  }));
};

const splitVisualClauses = (narration) => {
  const cleaned = normalizeText(narration);

  if (!cleaned) {
    return [];
  }

  return cleaned
    .split(
      /(?<=[.;!?])\s+|:\s+|;\s+|,\s+(?=(?:mas|porque|enquanto|agora|ao mesmo tempo|s[óo] que|na prática|e é aqui que|e nao para por ai|e não para por aí|o mais interessante é que|e sabe o que mais|meanwhile|now|but|in practice|and this is where|and in the middle of all this|but look|and it does not stop there|the most interesting part is that|and you know what else|the problem is that|and the wildest part is that|but wait|there is more|on the other hand)\b)/i
    )
    .map((segment) => normalizeText(segment))
    .filter((segment) => segment.length > 8 && !isConnectorOnlyText(segment));
};

const estimateShotTarget = (scene) => {
  const sentenceCount = splitNarration(scene.narration).length;
  const clauseCount = splitVisualClauses(scene.narration).length;
  const anchorDensity = Math.ceil(countWords(`${scene.visualGoal || ""} ${scene.searchQuery || ""}`) / 10);

  return Math.max(
    FLUX2_MIN_SHOTS_PER_SCENE,
    Math.min(FLUX2_MAX_SHOTS_PER_SCENE, Math.max(sentenceCount, clauseCount, anchorDensity, 1))
  );
};

const estimateDuration = (words) => {
  const seconds = Math.ceil(words / WORDS_PER_SECOND) + 1;
  return Math.max(3, Math.min(20, seconds));
};

const withThinkingDisabled = (config = {}) => ({
  ...config,
  thinkingConfig: {
    thinkingBudget: 0
  }
});

const requestLlmText = async ({prompt, systemInstruction, maxTokens = 900}) => {
  const model = String(process.env.GEMINI_PLANNER_MODEL || GCP_CONFIG.storyModel || "gemini-2.5-flash").trim();
  let lastError = null;

  for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const {payload, text} = await callVertexMultimodalText({
        model,
        textParts: [prompt],
        systemInstruction,
        generationConfig: withThinkingDisabled({
          temperature: 0,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json"
        })
      });
      recordGeminiUsage(geminiUsageSummary, {
        model: payload?.modelVersion || model,
        usageMetadata: payload?.usageMetadata,
        context: "flux2-shot-planner"
      });
      return normalizeText(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === LLM_RETRY_DELAYS_MS.length) {
        throw lastError;
      }
    }

    await sleep(LLM_RETRY_DELAYS_MS[attempt]);
  }

  throw lastError ?? new Error("Gemini falhou sem detalhes.");
};

const SCENE_PLANNER_SYSTEM_INSTRUCTION = [
  "You are a senior visual planner for FLUX image generation.",
  "Return valid JSON only. No markdown. No comments.",
  "Use English for all values except exact brand or product names when needed.",
  `Goal: create clear visual shot plans that FLUX can render consistently for a ${OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9" : "vertical 9:16"} short-form video.`,
  "Critical semantic rule: every explicit concrete object, device, place, interface, or action mentioned in the narration or visual goal must appear in at least one shot.mustShow.",
  "If the narration mentions a tree, one mustShow item must literally be 'tree'.",
  "Never replace a concrete object with a metaphor or a generic substitute.",
  "For named AI models or brands, represent them as competing systems or devices without logos or readable brand text.",
  STYLE_PLANNER_GUIDANCE,
  STYLE_HUMAN_GUIDANCE,
  STYLE_ANATOMY_GUIDANCE,
  STYLE_SCALE_GUIDANCE,
  "Describe characters by their role and posture. Keep facial detail minimal and express emotion primarily through body language and posture.",
  LAYOUT_PLANNER_GUIDANCE,
  "Across scenes, vary framing and staging. Use a mix of medium-wide, wide, side-profile, over-the-shoulder, top-down desk view, and object-led compositions when they fit the narration.",
  "Do not default to the same straight-on medium shot of a character at a desk in consecutive scenes.",
  "Prefer different environments and props across scenes whenever the narration changes: phone, laptop, payment terminal, router, card, inbox, desk, room, street, office, home, server rack, lock, alert screen, or hands-only detail if relevant.",
  "If a screen or interface is needed, describe it as abstract and unreadable using one or two large soft blank panels, a single abstract map/chart/tactical panel when the scene truly requires it, or empty speech bubbles only.",
  "If a scene implies no signal, GPS unavailable, or broken navigation, represent that only with symbolic cues such as crossed-out signal bars, a crossed-out navigation pin, or a broken route line. Never use readable status words.",
  "Interface layouts must avoid top bars, browser tabs, control dots, title bars, or operating-system chrome.",
  "Phones, tablets, laptops, dashboards, and monitors must be generic unbranded rectangles with a plain blank glow or one or two large unlabeled abstract panels only. No notch, no camera hole, no top cutout, no speaker slit, no icons, and no status bar.",
  "If a document, paper menu, street sign, packaging, label, or printed page is needed, describe it with blank bars, empty blocks, or abstract overlays only. Never request readable print.",
  "Never request fake text lines, browser chrome, window controls, menus, toolbars, headlines, labels, or glyph-like marks inside interfaces.",
  "Each shot must be drawable as a single static explanatory illustration.",
  "Rules:",
  "- keep shot order aligned to narration order",
  "- keep each mustShow list visually concrete and short",
  "- use as many shots as needed to preserve semantic fidelity up to the allowed limit",
  "- split crowded beats into separate shots instead of compressing multiple devices, actions, or settings into one frame",
  "- prefer separate shots when a scene mixes human posture with a device or interface close-up",
  "- vary framing and setting across consecutive shots instead of repeating the same desk medium shot",
  "- do not invent objects unrelated to the narration or the visual goal",
  "- use character or person wording for people",
  "- use unlabeled chart wording for graphs whenever possible",
  "- use blank content blocks instead of text lines inside interfaces",
  "- do not request text overlays, subtitles, labels, logos, or watermarks"
].filter(Boolean).join("\n");

const buildScenePlannerPrompt = (scene) => {
  const searchAnchors = uniqueStrings([
    scene.searchQuery,
    ...(Array.isArray(scene.candidateQueries) ? scene.candidateQueries : [])
  ].map((value) => sanitizeShotText(value))).slice(0, 6);
  const targetCount = estimateShotTarget(scene);

  return [
    `Create ${FLUX2_MIN_SHOTS_PER_SCENE} to ${FLUX2_MAX_SHOTS_PER_SCENE} shots for this scene.`,
    `Return exactly ${targetCount} ordered shots for this scene unless the scene is truly impossible to split further.`,
    "Prefer more shots whenever the narration contains multiple concrete visual beats, objects, settings, or actions.",
    "JSON schema:",
    JSON.stringify(
      {
        shots: [
          {
            coverageText: "short English description of the exact narration beat this shot covers",
            mustShow: ["required visible object or object phrase"],
            supportingDetails: ["secondary visible detail"],
            setting: "clear environment",
            composition: "how the shot should be arranged so required objects are visible",
            camera: LAYOUT_CAMERA,
            action: "what the character or scene is doing",
            lighting: "simple clean lighting",
            avoid: ["text", "watermark", "logo", "caption", "subtitle", "numbers", "letters"]
          }
        ]
      },
      null,
      2
    ),
    `Return exactly ${targetCount} ordered shots for this scene.`,
    "",
    `Scene title: ${normalizeText(scene.title)}`,
    `Narration: ${normalizeText(scene.narration)}`,
    `Search query anchor: ${sanitizeShotText(scene.searchQuery)}`,
    `Visual goal anchor: ${sanitizeShotText(scene.visualGoal)}`,
    `Overlay theme only, never render as text: ${normalizeText(scene.overlay)}`,
    `Candidate query anchors: ${searchAnchors.join(" | ") || "none"}`
  ].join("\n");
};

const buildFallbackVisualPlan = (scene) => {
  const targetCount = estimateShotTarget(scene);
  const clauseSegments = splitVisualClauses(scene.narration);
  const fallbackSegments = clauseSegments.length > 0
    ? clauseSegments.map((segment) => ({text: segment, words: countWords(segment)}))
    : splitNarration(scene.narration).filter((segment) => !isConnectorOnlyText(segment.text));
  const segments = fallbackSegments.slice(0, Math.max(1, targetCount));

  return segments.map((segment) => {
    const semantic = buildSemanticFallbackShot(scene, segment.text);

    return {
      coverageText: normalizeText(segment.text) || normalizeText(scene.narration),
      mustShow: semantic.mustShow,
      supportingDetails: semantic.supportingDetails,
      setting: semantic.setting,
      composition: LAYOUT_COMPOSITION,
      camera: LAYOUT_CAMERA,
      action: semantic.action,
      lighting: DEFAULT_LIGHTING,
      avoid: DEFAULT_NEGATIVE_TERMS
    };
  });
};

const buildDirectScenePlan = (scene) => {
  const semantic = buildSemanticFallbackShot(scene, scene.visualGoal || scene.searchQuery || scene.narration);

  return [
    {
      coverageText: normalizeText(scene.visualGoal || scene.searchQuery || scene.narration),
      mustShow: semantic.mustShow,
      supportingDetails: semantic.supportingDetails,
      setting: semantic.setting,
      composition: LAYOUT_COMPOSITION,
      camera: LAYOUT_CAMERA,
      action: semantic.action,
      lighting: DEFAULT_LIGHTING,
      avoid: DEFAULT_NEGATIVE_TERMS
    }
  ];
};

const normalizeShot = (scene, rawShot, {sceneSpec = null} = {}) => {
  const specMustShow = buildSceneSpecMustShow(scene, sceneSpec);
  const mustShow = uniqueStrings([
    ...specMustShow,
    ...filterRenderablePhrases(scene, normalizeStringArray(rawShot?.mustShow).map((item) => sanitizeShotTextForSceneSpec(item, sceneSpec)))
  ]).slice(0, 8);
  const supportingDetails = uniqueStrings([
    ...buildSceneSpecSupportingDetails(sceneSpec),
    ...filterRenderablePhrases(scene, normalizeStringArray(rawShot?.supportingDetails).map((item) => sanitizeShotTextForSceneSpec(item, sceneSpec)))
  ]).slice(0, 8);
  const avoid = uniqueStrings([
    ...DEFAULT_NEGATIVE_TERMS,
    ...normalizeStringArray(rawShot?.avoid)
  ]);
  const coverageText = truncateText(sanitizeShotTextForSceneSpec(rawShot?.coverageText || scene.narration, sceneSpec), 220);
  const setting = truncateText(sanitizeShotTextForSceneSpec(rawShot?.setting || scene.visualGoal || scene.searchQuery || "clean contextual setting", sceneSpec), 220);
  const composition = truncateText(
    buildSceneAwareComposition({
      sceneSpec,
      fallback: sanitizeShotTextForSceneSpec(rawShot?.composition || LAYOUT_COMPOSITION, sceneSpec)
    }),
    220
  );
  const camera = truncateText(buildSceneAwareCamera({sceneSpec, fallback: sanitizeShotTextForSceneSpec(rawShot?.camera || LAYOUT_CAMERA, sceneSpec)}), 120);
  const action = truncateText(buildSceneAwareAction({sceneSpec, fallback: sanitizeShotTextForSceneSpec(rawShot?.action || "character interacting with the key objects", sceneSpec)}), 180);
  const lighting = truncateText(sanitizeShotTextForSceneSpec(rawShot?.lighting || DEFAULT_LIGHTING, sceneSpec), 180);

  if (mustShow.length === 0) {
    throw new Error("Shot sem mustShow.");
  }

  return {
    coverageText,
    mustShow,
    supportingDetails,
    setting,
    composition,
    camera,
    action,
    lighting,
    avoid
  };
};

const mergePlannerShotsWithFallback = (plannedShots, fallbackShots) => {
  return fallbackShots.map((fallbackShot, index) => plannedShots[index] ?? fallbackShot);
};

const buildSdxlRefinePrompt = ({scene, shot}) => {
  const parts = [
    STYLE_REFINE_PROMPT_LEAD,
    shot.coverageText,
    `show ${shot.mustShow.join(", ")}`,
    shot.supportingDetails.length > 0 ? `details ${shot.supportingDetails.slice(0, 1).join(", ")}` : null,
    `setting ${shot.setting}`,
    `action ${shot.action}`,
    STYLE_REFINE_PROMPT_FINISH
  ].filter(Boolean);

  return truncateWords(parts.join(". "), SDXL_PROMPT_WORD_LIMIT);
};

const planSceneShots = async (scene, {allowFallback = ENABLE_PLANNER_FALLBACK, sceneSpec = null} = {}) => {
  if (USE_DIRECT_SCENE_PLANNER) {
    return {
      planner: "direct-scene",
      shots: buildDirectScenePlan(scene).map((shot) => normalizeShot(scene, shot, {sceneSpec}))
    };
  }

  const fallbackShots = buildFallbackVisualPlan(scene).map((shot) => normalizeShot(scene, shot, {sceneSpec}));
  const targetCount = fallbackShots.length;

  let lastError = null;
  let sawUnderSegmentation = false;
  let bestPartialShots = null;

  for (const maxTokens of LLM_PLANNER_MAX_TOKENS) {
    try {
      const raw = await requestLlmText({
        prompt: buildScenePlannerPrompt(scene),
        systemInstruction: SCENE_PLANNER_SYSTEM_INSTRUCTION,
        maxTokens
      });
      const parsed = JSON.parse(extractJsonObject(raw));
      const shots = Array.isArray(parsed?.shots) ? parsed.shots.slice(0, targetCount) : [];

      if (shots.length === 0) {
        throw new Error("Planeador devolveu zero shots.");
      }

      const normalizedShots = shots.map((shot) => normalizeShot(scene, shot, {sceneSpec}));

      if (normalizedShots.length < targetCount) {
        sawUnderSegmentation = true;
        if (!bestPartialShots || normalizedShots.length > bestPartialShots.length) {
          bestPartialShots = normalizedShots;
        }
        lastError = new Error(`Gemini condensou demais a cena (${normalizedShots.length} < ${targetCount})`);
        continue;
      }

      return {
        planner: "gemini",
        shots: normalizedShots
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (sawUnderSegmentation && bestPartialShots?.length) {
    return {
      planner: "hybrid-expanded",
      plannerError: lastError instanceof Error ? lastError.message : String(lastError),
      plannerSupplementedShots: targetCount - bestPartialShots.length,
      shots: mergePlannerShotsWithFallback(bestPartialShots, fallbackShots)
    };
  }

  if (!allowFallback) {
    return {
      planner: "failed",
      plannerError: lastError instanceof Error ? lastError.message : String(lastError),
      shots: [],
      suggestedShots: fallbackShots
    };
  }

  return {
    planner: sawUnderSegmentation ? "fallback-expanded" : "fallback",
    plannerError: lastError instanceof Error ? lastError.message : String(lastError),
    shots: fallbackShots
  };
};

const buildNegativePrompt = (shot) => {
  return uniqueStrings([
    ...DEFAULT_NEGATIVE_TERMS,
    ...(FLUX2_NEGATIVE_PROMPT
      ? FLUX2_NEGATIVE_PROMPT.split(",").map((item) => item.trim())
      : []),
    ...(Array.isArray(shot?.avoid) ? shot.avoid : [])
  ])
    .filter((term) => !STYLE_NEGATIVE_PROMPT_REMOVALS.includes(String(term).trim().toLowerCase()))
    .join(", ");
};

const buildImagePrompt = ({scene, shot, style, sceneIndex = 0, segmentIndex = 0, sceneSpec = null, sceneLint = null, extraDirectives = []}) => {
  const humanSubjectPrompt = buildHumanSubjectPrompt(shot);
  const attemptDirectives = normalizePromptDirectives({
    shot,
    directives: [
      ...buildVariationDirectives({shot}),
      ...buildAttemptDirectives({shot, attempt: 0}),
      ...buildSceneSpecPromptDirectives({sceneSpec, sceneLint}),
      ...extraDirectives
    ]
  });
  const visualContractText = normalizeText([
    RUN_VISUAL_CONTRACT.backgroundDirective,
    shotNeedsObjectLedCloseup(shot) ? RUN_VISUAL_CONTRACT.closeupDirective : RUN_VISUAL_CONTRACT.humanDirective
  ].filter(Boolean).join("; "));
  const styleGuidance = truncateText(String(style || DEFAULT_STYLE).trim(), 320);
  const supportingDetailsText = shot.supportingDetails.length > 0
    ? `Add ${shot.supportingDetails.join(", ")} through visible body language, clear props, and readable action.`
    : "Use visible body language, clear props, and readable action to make the scene instantly understandable.";
  const backgroundGuidance = DEFAULT_BACKGROUND_DIRECTIVES.length > 0
    ? `Background direction: ${DEFAULT_BACKGROUND_DIRECTIVES.join("; ")}.`
    : null;
  const attemptGuidance = attemptDirectives.length > 0
    ? `Extra direction: ${attemptDirectives.join("; ")}.`
    : null;

  return [
    `Create a high-end ${styleGuidance} scene with one clear focal subject and clean anatomy.`,
    humanSubjectPrompt,
    `Show ${shot.coverageText} with ${shot.mustShow.join(", ")}.`,
    supportingDetailsText,
    `Set the scene in ${shot.setting}.`,
    `Frame it as ${shot.composition}, with ${shot.camera}.`,
    `The visible action is ${shot.action}.`,
    `Lighting should feel ${shot.lighting}.`,
    `Keep the subject fully readable in a ${OUTPUT_LAYOUT === "horizontal" ? "horizontal 16:9" : "vertical 9:16"} layout with subtle safe margins for captions and UI.`,
    `Maintain this visual identity: ${DEFAULT_STYLE_LOCK_PROMPT}.`,
    visualContractText ? `Run-level visual contract: ${visualContractText}.` : null,
    `Composition rules: ${DEFAULT_COMPOSITION_RULES}.`,
    backgroundGuidance,
    attemptGuidance,
    "Keep the image visually clean, mobile-readable, and compositionally strong.",
    "No text, no watermark, no logo, no interface chrome, no letter-like marks, no distorted anatomy, no extra fingers, no cropped head, and no cropped limbs."
  ].filter(Boolean).join(" ");
};

const validatePromptCoverage = ({shot, prompt, negativePrompt}) => {
  const promptText = String(prompt || "").toLowerCase();
  const negativeText = String(negativePrompt || "").toLowerCase();
  const missingObjects = shot.mustShow.filter((item) => !promptText.includes(String(item).toLowerCase()));
  const missingNegatives = ["text", "watermark", "logo"].filter((term) => !negativeText.includes(term));

  if (missingObjects.length > 0) {
    throw new Error(`Prompt sem cobertura explicita para: ${missingObjects.join(", ")}`);
  }

  if (missingNegatives.length > 0) {
    throw new Error(`Negative prompt incompleto: ${missingNegatives.join(", ")}`);
  }
};

const buildPlanReport = ({scenePlans, manifest}) => {
  const plannerFailures = scenePlans
    .filter((scenePlan) => scenePlan.planner !== "gemini")
    .map((scenePlan) => ({
      scene: scenePlan.scene,
      title: scenePlan.title,
      planner: scenePlan.planner,
      plannerError: scenePlan.plannerError ?? null,
      shotCount: scenePlan.shotCount,
      suggestedShotCount: Array.isArray(scenePlan.suggestedShots) ? scenePlan.suggestedShots.length : 0
    }));

  const underSegmentedScenes = scenePlans
    .map((scenePlan) => ({
      scene: scenePlan.scene,
      title: scenePlan.title,
      planner: scenePlan.planner,
      shotCount: scenePlan.shotCount,
      shotTargetCount: estimateShotTarget({narration: scenePlan.narration, visualGoal: "", searchQuery: ""}),
      narrationWordCount: countWords(scenePlan.narration)
    }))
    .filter((scene) => scene.shotCount < scene.shotTargetCount);

  const promptValidationFailures = manifest.filter((entry) => {
    const validation = entry.validation;
    if (!validation) {
      return false;
    }

    return validation.missingObjects.length > 0 || validation.missingNegatives.length > 0;
  });

  const localAuditFailures = manifest.filter((entry) => {
    const audit = entry.localAudit;
    return audit && audit.skipped !== true && audit.passed === false;
  });
  const localAuditSkippedCount = manifest.filter((entry) => entry.localAudit?.skipped === true).length;
  const sceneSpecWarnings = scenePlans
    .filter((scenePlan) => Number(scenePlan?.sceneLintSummary?.issueCount || 0) > 0 || String(scenePlan?.sceneRisk?.level || "") !== "low")
    .map((scenePlan) => ({
      scene: scenePlan.scene,
      title: scenePlan.title,
      riskLevel: scenePlan.sceneRisk?.level || "unknown",
      riskScore: scenePlan.sceneRisk?.score ?? null,
      issueCount: scenePlan.sceneLintSummary?.issueCount ?? 0,
      issues: Array.isArray(scenePlan.sceneLintIssues)
        ? scenePlan.sceneLintIssues.map((issue) => ({
            code: issue.code || "",
            severity: issue.severity || "",
            message: issue.message || ""
          }))
        : []
    }));
  const failureTaxonomyCounts = manifest.reduce((accumulator, entry) => {
    const category = String(entry?.failureTaxonomy?.primaryCategory || "").trim();
    if (!category) {
      return accumulator;
    }

    accumulator[category] = (accumulator[category] || 0) + 1;
    return accumulator;
  }, {});

  return {
    totals: {
      sceneCount: scenePlans.length,
      imageCount: manifest.length,
      plannerFailureCount: plannerFailures.length,
      underSegmentedSceneCount: underSegmentedScenes.length,
      promptValidationFailureCount: promptValidationFailures.length,
      localAuditFailureCount: localAuditFailures.length,
      localAuditSkippedCount,
      sceneSpecWarningCount: sceneSpecWarnings.length
    },
    plannerFailures,
    underSegmentedScenes,
    sceneSpecWarnings,
    failureTaxonomyCounts,
    promptValidationFailures: promptValidationFailures.map((entry) => ({
      scene: entry.scene,
      segment: entry.segment,
      title: entry.title,
      coverageText: entry.coverageText,
      missingObjects: entry.validation.missingObjects,
      missingNegatives: entry.validation.missingNegatives
    })),
    localAuditFailures: localAuditFailures.map((entry) => ({
      scene: entry.scene,
      segment: entry.segment,
      title: entry.title,
      coverageText: entry.coverageText,
      fileSizeBytes: entry.localAudit.fileSizeBytes,
      imageFormat: entry.localAudit.imageFormat,
      reasons: entry.localAudit.reasons,
      summary: entry.localAudit.summary
    }))
  };
};

const persistArtifacts = async ({assetDir, scenePlans, manifest, reuseMetadata, geminiUsage}) => {
  const planReport = buildPlanReport({scenePlans, manifest});
  await writeFile(path.join(assetDir, "visual-plan.json"), JSON.stringify(scenePlans, null, 2));
  await writeFile(path.join(assetDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(assetDir, "plan-report.json"), JSON.stringify(planReport, null, 2));
  await writeFile(path.join(assetDir, "flux2-visual-plan.json"), JSON.stringify(scenePlans, null, 2));
  await writeFile(path.join(assetDir, "flux2-manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(assetDir, "flux2-plan-report.json"), JSON.stringify(planReport, null, 2));
  await writeFile(path.join(assetDir, "gemini-usage.json"), JSON.stringify(geminiUsage, null, 2));
  if (reuseMetadata) {
    await writeFile(path.join(assetDir, "flux2-meta.json"), JSON.stringify(reuseMetadata, null, 2));
  }
  return planReport;
};

const runLocalVisualAudit = ({imagePath, shot}) => {
  const commandArgs = [LOCAL_VISUAL_AUDIT_SCRIPT, "--image", imagePath];

  if (EXPECT_STICKMAN_AUDIT && shotNeedsFullHumanFigure(shot)) {
    commandArgs.push("--expect-stickman");
  }

  if (shotAllowsHeadAccessories(shot)) {
    commandArgs.push("--allow-head-accessories");
  }

  const result = spawnSync("python3", commandArgs, {
    encoding: "utf8",
    stdio: "pipe"
  });

  const output = String(result.stdout || "").trim();
  const err = String(result.stderr || "").trim();

  if (result.status !== 0 && !output) {
    throw new Error(err || "auditoria visual local falhou sem saida");
  }

  let parsed;
  try {
    parsed = JSON.parse(output || err);
  } catch (error) {
    throw new Error(`auditoria visual local devolveu JSON invalido: ${output || err}`);
  }

  if (typeof parsed?.passed !== "boolean") {
    throw new Error("auditoria visual local nao devolveu campo passed");
  }

  return parsed;
};

const auditLocalFlux2Output = async ({imagePath, shot, validation, seed, dryRun = false}) => {
  if (dryRun) {
    return {
      provider: "google-imagen",
      mode: "prompt-and-render-guard",
      skipped: true,
      reason: "dry-run"
    };
  }

  const imageBytes = await readFile(imagePath);
  const fileSizeBytes = imageBytes.length;
  const imageFormat = detectImageFormat(imageBytes);
  const reasons = [];
  const warnings = [];
  let visualAudit = null;

  if (!imageFormat) {
    reasons.push("arquivo gerado nao tem assinatura valida de imagem");
  }

  if (fileSizeBytes < FLUX2_LOCAL_AUDIT_MIN_BYTES) {
    reasons.push(`arquivo muito pequeno (${fileSizeBytes} bytes)`);
  }

  if (validation.missingObjects.length > 0) {
    reasons.push(`prompt sem objetos obrigatorios: ${validation.missingObjects.join(", ")}`);
  }

  if (validation.missingNegatives.length > 0) {
    reasons.push(`negative prompt incompleto: ${validation.missingNegatives.join(", ")}`);
  }

  try {
    visualAudit = runLocalVisualAudit({imagePath, shot});
    if (visualAudit.passed === false && Array.isArray(visualAudit.reasons)) {
      for (const rawReason of visualAudit.reasons) {
        const prefixedReason = `auditoria visual local: ${rawReason}`;
        const isOcrReason = /ocr detectou texto provavel/i.test(rawReason);

        if (isOcrReason) {
          const ocrPolicy = shouldAllowStatusOcrReason({shot, visualAudit, reason: rawReason});
          if (ocrPolicy.allowed) {
            warnings.push(
              `${prefixedReason} (status-ui permitido: ${ocrPolicy.tokens.join(", ") || "token sem normalizacao"})`
            );
            continue;
          }

          if (shotIncludesPaperLikeObject(shot)) {
            warnings.push(`${prefixedReason} (paper-like object — downgraded to warning)`);
            continue;
          }

          /* Downgrade OCR to warning when no detected token is a known-dangerous word */
          const detectedOcrTokens = parseOcrTokensFromReason(rawReason);
          const hasBlockedOcrWord = detectedOcrTokens.some((token) => OCR_ALWAYS_BLOCKED_TOKENS.has(token));
          if (detectedOcrTokens.length > 0 && !hasBlockedOcrWord) {
            warnings.push(`${prefixedReason} (no blocked keyword found — downgraded to warning)`);
            continue;
          }

          reasons.push(prefixedReason);
          continue;
        }

        if (FLUX2_LOCAL_VISUAL_AUDIT_STRICT) {
          reasons.push(prefixedReason);
        } else {
          warnings.push(prefixedReason);
        }
      }
    }
  } catch (error) {
    reasons.push(`auditoria visual local falhou: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    provider: "flux2-local",
    mode: "prompt-and-render-guard",
    skipped: false,
    passed: reasons.length === 0,
    seed,
    imageFormat,
    fileSizeBytes,
    requiredObjects: shot.mustShow,
    visualAudit,
    warnings,
    reasons,
    summary: reasons.length === 0
      ? warnings.length > 0
        ? `Render local valido em ${imageFormat} com ${fileSizeBytes} bytes. Avisos: ${warnings.join("; ")}`
        : `Render local valido em ${imageFormat} com ${fileSizeBytes} bytes.`
      : reasons.join("; ")
  };
};

const recoverExistingSegmentImage = async ({
  imagesDir,
  segImagePath,
  scene,
  sceneNum,
  segNum,
  shot,
  validation,
  seed
}) => {
  const candidates = await listSegmentImageCandidates({imagesDir, sceneNum, segNum});

  for (const candidate of candidates) {
    const localAudit = await auditLocalFlux2Output({
      imagePath: candidate.path,
      shot,
      validation,
      seed
    });

    if (!localAudit.passed) {
      continue;
    }

    const visionAudit = await auditWithGeminiVision({
      imagePath: candidate.path,
      visualGoal: shot.coverageText || scene.visualGoal || scene.searchQuery || "",
      narration: scene.narration || "",
      shot
    });

    if (!visionAudit.skipped && !visionAudit.passed) {
      continue;
    }

    localAudit.visionAudit = visionAudit;

    if (candidate.path !== segImagePath) {
      await rm(segImagePath, {force: true});
      await copyFile(candidate.path, segImagePath);
    }

    return {
      imagePath: segImagePath,
      recoveredFrom: candidate.path,
      localAudit
    };
  }

  return null;
};

// --- Gemini Vision semantic audit ---
const GEMINI_VISION_AUDIT_ENABLED = String(process.env.GEMINI_VISION_AUDIT || "true").trim().toLowerCase() === "true";
const GEMINI_VISION_MODEL = String(process.env.GEMINI_VISION_MODEL || GCP_CONFIG.visionModel || "gemini-2.5-flash").trim();

const auditWithGeminiVision = async ({imagePath, visualGoal, narration, shot = null}) => {
  if (!GEMINI_VISION_AUDIT_ENABLED) {
    return {skipped: true, passed: true, reason: "gemini-vision-audit desativado"};
  }

  const imageBytes = await readFile(imagePath);
  const base64 = imageBytes.toString("base64");
  const mimeType = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";

  const prompt = [
    `You are a visual QA auditor for an automated video pipeline that uses a ${STYLE_AUDIT_DESCRIPTION}.`,
    `IMPORTANT: The intended art direction is ${STYLE_AUDIT_DESCRIPTION}. Treat that style as intentional, not as a defect.`,
    "",
    `Scene visual goal: "${visualGoal}"`,
    `Scene narration: "${narration}"`,
    "",
    "Evaluate whether this image's CONCEPT and SUBJECT MATTER match the visual goal. Ignore the art style completely.",
    "Check ONLY for:",
    "- Completely wrong subject matter (e.g. scene about cooking but image shows a car)",
    "- Image is blank, corrupted, or unrecognizable",
    "- Impossible anatomy such as extra hands, extra arms, extra legs, duplicate heads, fused limbs, or 3 to 4 hands on one body",
    "- The main person is so tiny, distant, or reduced to a stray line that it does not read as a clear focal subject when the scene needs a person",
    "- SKIP text checking entirely — text on screens, signs, or surfaces is handled by a separate OCR audit and is NOT your responsibility",
    "",
    "Do NOT reject for:",
    `- ${STYLE_AUDIT_DESCRIPTION} instead of realistic people or realistic scenes (this IS the intended style)`,
    "- Simplified, abstract, or minimalist representations of any kind",
    "- Flat colors, lack of shading, cartoon-like appearance, or line art style",
    "- Characters drawn as stick figures when the goal mentions 'woman', 'man', 'person' etc.",
    "- Minor detail differences or missing secondary elements",
    "- Any text, letters, numbers, or writing on any surface (text is checked separately by OCR, not by this audit)",
    ...buildGeminiVisionAuditGuardrails({shot}),
    ...(STYLE_IS_INK
      ? [
          "- A clean paper background or simplified editorial backdrop instead of a literal room, street, office, or command center, as long as the core subject and action match",
          "- Simplified environmental cues replacing a literal realistic setting when the intended style is editorial ink"
        ]
      : []),
    "",
    EXPECT_STICKMAN_AUDIT
      ? "If only one stick figure is visible, it must not have more than two hands or more than two arms. Occluded limbs are acceptable, extra limbs are not."
      : "If only one character is visible, it must not have more than two hands or more than two arms. Occluded limbs are acceptable, extra limbs are not.",
    EXPECT_STICKMAN_AUDIT
      ? "When the scene narration or visual goal clearly involves a person, reject images where the character is barely visible, too tiny to read, or looks like just a stick line instead of a clear stick figure."
      : "When the scene narration or visual goal clearly involves a person, reject images where the character is barely visible or too tiny to read as a clear focal subject.",
    "Do NOT reject for any text, letters, words, or writing anywhere in the image. Text auditing is handled separately by an OCR system. Your job is ONLY to check subject matter, anatomy, and composition.",
    "Ignore all text on receipts, tickets, maps, papers, signs, and screens — text is checked by a separate system.",
    "Reply ONLY with valid JSON: {\"pass\": true/false, \"reason\": \"brief explanation\"}"
  ].join("\n");

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const {payload, text} = await callVertexMultimodalText({
        model: GEMINI_VISION_MODEL,
        inlineDataParts: [{mimeType, data: base64}],
        textParts: [prompt],
        generationConfig: withThinkingDisabled({
          temperature: 0,
          responseMimeType: "application/json"
        })
      });
      recordGeminiUsage(geminiUsageSummary, {
        model: payload?.modelVersion || GEMINI_VISION_MODEL,
        usageMetadata: payload?.usageMetadata,
        context: "flux2-vision-audit"
      });
      const normalizedText = normalizeText(text);

      const jsonMatch = normalizedText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        process.stderr.write(`[gemini-vision] resposta sem JSON: ${normalizedText.slice(0, 200)}\n`);
        return {skipped: false, passed: true, reason: "resposta sem JSON, assumindo ok"};
      }

      const result = JSON.parse(jsonMatch[0]);
      return {
        skipped: false,
        passed: result.pass === true,
        reason: String(result.reason || "")
      };
    } catch (error) {
      if (attempt < 2) {
        await sleep(LLM_RETRY_DELAYS_MS[attempt] || 2000);
        continue;
      }
      process.stderr.write(`[gemini-vision] erro: ${error instanceof Error ? error.message : String(error)}\n`);
      return {skipped: true, passed: true, reason: "erro-excecao"};
    }
  }

  return {skipped: true, passed: true, reason: "tentativas esgotadas"};
};

// --- Vertex image generation ---
const generateImage = async ({prompt, outputPath}) => {
  process.stdout.write(`[vertex-image] generating: ${path.basename(outputPath)}\n`);
  await generateGoogleCloudImage({prompt, outputPath});
};

// --- SDXL refine + upscale (FLUX → SDXL → Upscale pipeline) ---
const refineAndUpscaleBatch = (jobs) => {
  if ((!SDXL_ENABLED && !UPSCALE_ENABLED) || jobs.length === 0) return [];

  process.stdout.write(`[sdxl-pipeline] batch refining ${jobs.length} images (model loads once)...\n`);

  const batchFile = path.join(jobs[0].input, "..", "_sdxl-batch.json");
  const batchJobs = jobs.map((job) => ({
    input: job.input,
    output: job.output,
    prompt: job.prompt || "",
    seed: job.seed,
  }));
  writeFileSync(batchFile, JSON.stringify(batchJobs));

  const args = [
    SDXL_REFINE_SCRIPT,
    "--batch", batchFile,
    "--denoise", String(SDXL_DENOISE),
    "--steps", String(SDXL_STEPS),
    "--sdxl-model", SDXL_MODEL,
    "--upscale-factor", String(UPSCALE_ENABLED ? UPSCALE_FACTOR : 1),
    "--guidance-scale", String(SDXL_GUIDANCE_SCALE),
    "--max-dimension", String(SDXL_MAX_DIMENSION),
  ];

  if (!SDXL_ENABLED) args.push("--skip-sdxl");
  if (!UPSCALE_ENABLED) args.push("--skip-upscale");

  try {
    const result = spawnSync(ESRGAN_VENV_PYTHON, args, {
      stdio: ["pipe", "pipe", "inherit"],
      timeout: 1800_000, // 30 min max for batch
    });

    // Cleanup batch file
    try { unlinkSync(batchFile); } catch { /* ignore */ }

    if (result.status !== 0) {
      process.stderr.write(`[sdxl-pipeline] WARN: batch process exited ${result.status}\n`);
      return jobs.map(() => ({skipped: false, passed: false, error: `exit code ${result.status}`}));
    }

    const stdout = (result.stdout || "").toString().trim();
    if (stdout) {
      try {
        const results = JSON.parse(stdout);
        process.stdout.write(`[sdxl-pipeline] batch done: ${results.length} images refined\n`);
        return results.map((info) => ({skipped: false, passed: !info.error, info}));
      } catch { /* ignore parse errors */ }
    }
    return jobs.map(() => ({skipped: false, passed: true}));
  } catch (error) {
    process.stderr.write(`[sdxl-pipeline] WARN: ${error.message}\n`);
    return jobs.map(() => ({skipped: false, passed: false, error: error.message}));
  }
};

// --- Static image → video clip (no zoom, no pan) ---
const imageToStaticClip = ({imagePath, videoPath, duration}) => {
  const filter = [
    `scale=${CLIP_W}:${CLIP_H}:force_original_aspect_ratio=decrease`,
    `pad=${CLIP_W}:${CLIP_H}:(ow-iw)/2:(oh-ih)/2:white`,
    `format=yuv420p`
  ].join(",");

  execFileSync("ffmpeg", [
    "-y", "-loop", "1", "-i", imagePath,
    "-vf", filter,
    "-t", String(duration),
    "-r", String(CLIP_FPS),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-an", videoPath
  ], {stdio: "inherit"});
};

// --- Concatenate multiple clips into one ---
const concatClips = async ({clips, outputPath, tempDir}) => {
  const parsedOutput = path.parse(outputPath);
  const tempOutputPath = path.join(
    parsedOutput.dir,
    `${parsedOutput.name}.tmp-${process.pid}-${Date.now()}${parsedOutput.ext || ".mp4"}`
  );

  if (clips.length === 1) {
    try {
      await copyFile(clips[0], tempOutputPath);
      await rename(tempOutputPath, outputPath);
    } catch (error) {
      await rm(tempOutputPath, {force: true}).catch(() => {}); /* best-effort cleanup on error */
      throw error;
    }

    return;
  }

  const listPath = path.join(tempDir, "concat.txt");
  await writeFile(listPath, clips.map((clipPath) => `file '${clipPath}'`).join("\n"));

  try {
    execFileSync("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-c", "copy", "-movflags", "+faststart", tempOutputPath
    ], {stdio: "inherit"});
    await rename(tempOutputPath, outputPath);
  } catch (error) {
    await rm(tempOutputPath, {force: true}).catch(() => {}); /* best-effort cleanup on error */
    throw error;
  }
};

const getVideoDurationSeconds = (targetPath) => {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetPath],
    {
      cwd: projectRoot,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    return 0;
  }

  const durationSeconds = Number.parseFloat(String(result.stdout || "").trim());
  return Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
};

const isUsableVideoClipPath = async (targetPath) => {
  try {
    const details = await stat(targetPath);
    if (!details.isFile() || details.size < MIN_VALID_VIDEO_BYTES) {
      return false;
    }
  } catch {
    return false;
  }

  return getVideoDurationSeconds(targetPath) > 0.05;
};

const clearSceneArtifacts = async ({assetDir, imagesDir, sceneNum}) => {
  const targets = [
    path.join(assetDir, `scene-${sceneNum}.mp4`)
  ];

  for (const target of targets) {
    await rm(target, {force: true}).catch(() => {}); /* best-effort: stale artifact may not exist */
  }

  const entries = await readdir(imagesDir).catch(() => []); /* expected: images dir may not exist yet */
  const prefix = `scene-${sceneNum}-`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(path.join(imagesDir, entry), {force: true}).catch(() => {})) /* best-effort cleanup */
  );
};

// --- Main ---
const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.storyboardFile || !args.slug) {
    throw new Error("Usa: node scripts/generate-google-assets.mjs --storyboard-file <path> --slug <slug>");
  }

  const envatoRoot = resolvePathFromProjectRoot(process.env.VIDEO_ENGINE_ROOT || process.env.VIDEOS_ENVATO_ROOT, path.join(projectRoot, "video-engine"));
  const storyboardPath = path.resolve(envatoRoot, args.storyboardFile);
  const storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
  const scenes = storyboard.scenes || [];
  process.stdout.write(
    `[vertex-assets] layout=${OUTPUT_LAYOUT} output=${CLIP_W}x${CLIP_H} canvas=${FLUX2_WIDTH}x${FLUX2_HEIGHT} source=${FLUX2_CANVAS.source}\n`
  );
  const maxImages = Number.isFinite(args.maxImages) && args.maxImages > 0
    ? Math.max(1, Math.floor(args.maxImages))
    : Number.POSITIVE_INFINITY;

  if (scenes.length === 0) throw new Error("Storyboard sem cenas.");

  const requestedSceneNumber = Number.isFinite(Number(args.sceneNumber)) ? Math.floor(Number(args.sceneNumber)) : 0;
  if (requestedSceneNumber && (requestedSceneNumber < 1 || requestedSceneNumber > scenes.length)) {
    throw new Error(`Cena invalida para regenerar: ${requestedSceneNumber}. Storyboard tem ${scenes.length} cenas.`);
  }

  const assetDir = path.join(envatoRoot, "assets", "envato", args.slug);
  const imagesDir = path.join(assetDir, "_flux2_images");

  // Reuse existing assets if available (avoid re-generating on retry)
  const forceRegenerate = args.force === true;
  if (forceRegenerate && !requestedSceneNumber) {
    await rm(assetDir, {recursive: true, force: true});
  }
  await mkdir(imagesDir, {recursive: true});
  if (requestedSceneNumber) {
    await clearSceneArtifacts({assetDir, imagesDir, sceneNum: String(requestedSceneNumber).padStart(2, "0")});
  }

  const seedBase = args.seedBase ?? 200;
  const allowFallback = args.allowFallback || ENABLE_PLANNER_FALLBACK;
  const manifest = [];
  const scenePlans = [];
  const plannedSceneEntries = [];
  let globalSeed = seedBase;
  let totalImages = 0;
  let totalSuccessfulSegments = 0;
  let totalGeneratedImages = 0;
  let totalFailedSegments = 0;
  const incompleteScenes = new Set();
  const incompleteSceneReasons = new Map();
  const appendSceneReason = (sceneNum, reason) => {
    const normalized = truncateText(String(reason || "").trim(), 320);
    if (!normalized) {
      return;
    }
    const current = incompleteSceneReasons.get(sceneNum) ?? [];
    if (!current.includes(normalized)) {
      current.push(normalized);
      incompleteSceneReasons.set(sceneNum, current);
    }
  };
  const markSceneIncomplete = ({sceneNum, clipsOk, clipsExpected, reasons = []}) => {
    incompleteScenes.add(sceneNum);
    const normalizedReasons = Array.isArray(reasons) ? reasons : [reasons];
    for (const reason of normalizedReasons) {
      appendSceneReason(sceneNum, reason);
    }
    if ((incompleteSceneReasons.get(sceneNum) || []).length === 0) {
      appendSceneReason(sceneNum, `coverage mismatch: ${clipsOk}/${clipsExpected} shots ok`);
    }
    const reasonSummary = (incompleteSceneReasons.get(sceneNum) || []).join(" | ");
    process.stderr.write(
      `[vertex-assets] scene ${sceneNum}: incomplete visual coverage (${clipsOk}/${clipsExpected} shots ok), skipping final scene clip\n`
    );
    if (reasonSummary) {
      process.stderr.write(`[vertex-assets] scene ${sceneNum}: incomplete reasons: ${reasonSummary}\n`);
    }
  };

  const targetSceneIndexes = requestedSceneNumber ? [requestedSceneNumber - 1] : scenes.map((_, index) => index);

  for (const i of targetSceneIndexes) {
    const scene = scenes[i];
    const sceneNum = String(i + 1).padStart(2, "0");
    const sceneSpec = compileSceneSpecFromStoryboardScene(scene, {sceneNumber: i + 1});
    const sceneLint = lintSceneSpec(sceneSpec);
    const plan = await planSceneShots(scene, {allowFallback, sceneSpec});

    scenePlans.push({
      scene: sceneNum,
      title: scene.title,
      narration: scene.narration,
      planner: plan.planner,
      plannerError: plan.plannerError ?? null,
      shotCount: plan.shots.length,
      shots: plan.shots,
      suggestedShots: plan.suggestedShots ?? null,
      sceneSpec,
      sceneRisk: sceneLint.risk,
      sceneLintSummary: sceneLint.summary,
      sceneLintIssues: sceneLint.issues,
      sceneRepairStrategy: sceneLint.repairStrategy
    });
    plannedSceneEntries.push({
      index: i,
      scene,
      sceneNum,
      plan,
      sceneSpec,
      sceneLint
    });

    process.stdout.write(`[vertex-assets] scene ${sceneNum}: ${plan.shots.length} planned image(s) via ${plan.planner}\n`);
    if ((sceneLint.summary?.issueCount || 0) > 0 || sceneLint.risk?.level !== "low") {
      process.stdout.write(
        `[vertex-assets] scene ${sceneNum}: scene-spec risk=${sceneLint.risk?.level || "unknown"} issues=${sceneLint.summary?.issueCount || 0}\n`
      );
    }
  }

  const plannerFailures = scenePlans.filter((scenePlan) => scenePlan.planner === "failed");

  if (plannerFailures.length > 0 && !allowFallback) {
    await persistArtifacts({
      assetDir,
      scenePlans,
      manifest,
      reuseMetadata: buildReuseMetadata({scenePlans}),
      geminiUsage: geminiUsageSummary
    });
    throw new Error(`Planner falhou sem fallback nas cenas: ${plannerFailures.map((scenePlan) => scenePlan.scene).join(", ")}`);
  }

  const currentReuseMetadata = buildReuseMetadata({scenePlans});
  const existingReuseMetadata = forceRegenerate ? null : await readReuseMetadata(assetDir);
  const canReuseExistingAssets =
    !forceRegenerate &&
    existingReuseMetadata &&
    JSON.stringify(existingReuseMetadata) === JSON.stringify(currentReuseMetadata);

  if (!forceRegenerate && existingReuseMetadata && !canReuseExistingAssets) {
    if (requestedSceneNumber) {
      process.stdout.write(
        `[vertex-assets] storyboard/style/layout changed; preserving existing scenes during targeted repair of scene ${requestedSceneNumber}\n`
      );
    } else {
      process.stdout.write(
        "[vertex-assets] storyboard/style/layout changed; regenerating assets from scratch\n"
      );
      await rm(assetDir, {recursive: true, force: true});
      await mkdir(imagesDir, {recursive: true});
    }
  }

  await writeFile(path.join(assetDir, "flux2-meta.json"), JSON.stringify(currentReuseMetadata, null, 2));

  const totalPlannedShotCount = plannedSceneEntries.reduce(
    (sum, entry) => sum + (Array.isArray(entry.plan?.shots) ? entry.plan.shots.length : 0),
    0
  );
  const totalSegmentCount = Math.min(totalPlannedShotCount, maxImages);
  process.stdout.write(
    `[vertex-assets] ${plannedSceneEntries.length} scene(s)` +
    (requestedSceneNumber ? ` (target scene ${requestedSceneNumber})` : "") +
    ` → ${totalSegmentCount} images to generate\n`
  );

  const pendingSdxlJobs = [];

  for (const entry of plannedSceneEntries) {
    if (totalImages >= totalSegmentCount) {
      break;
    }

    const i = entry.index;
    const scene = entry.scene;
    const sceneNum = entry.sceneNum;
    const videoPath = path.join(assetDir, `scene-${sceneNum}.mp4`);
    const plannedShots = entry.plan?.shots ?? [];
    const segmentClips = [];
    const completedSegmentIndexes = new Set();
    const sceneFailureReasons = [];
    let sceneNeedsReconcat = false;
    let sceneFailed = plannedShots.length === 0;
    if (plannedShots.length === 0) {
      sceneFailureReasons.push("planner retornou zero shots para a cena");
    }

    for (let j = 0; j < plannedShots.length; j++) {
      if (totalImages >= totalSegmentCount) {
        break;
      }

      const shot = plannedShots[j];
      realignShotWithSceneSpec({scene, shot, sceneSpec: entry.sceneSpec});
      const segNum = String(j + 1).padStart(2, "0");
      const segImagePath = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}.png`);
      const segVideoPath = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}.mp4`);
      const coverageWords = countWords(shot.coverageText || scene.narration);
      const segDuration = estimateDuration(coverageWords);
      const negativePrompt = buildNegativePrompt(shot);
      const buildValidation = (prompt) => {
        try {
          validatePromptCoverage({shot, prompt, negativePrompt});
          return {missingObjects: [], missingNegatives: []};
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            missingObjects: shot.mustShow.filter((item) => !String(prompt).toLowerCase().includes(String(item).toLowerCase())),
            missingNegatives: ["text", "watermark", "logo"].filter((term) => !String(negativePrompt).toLowerCase().includes(term)),
            error: message
          };
        }
      };
      const prompt = buildImagePrompt({
        scene,
        shot,
        style: args.style || DEFAULT_STYLE,
        sceneIndex: i,
        segmentIndex: j,
        sceneSpec: entry.sceneSpec,
        sceneLint: entry.sceneLint
      });
      const validation = buildValidation(prompt);

      if (validation.missingObjects.length > 0 || validation.missingNegatives.length > 0) {
        throw new Error(`Prompt validation falhou para scene ${sceneNum} seg ${segNum}`);
      }

      totalImages++;
      process.stdout.write(`[vertex-assets] [${totalImages}/${totalSegmentCount}] scene ${sceneNum} seg ${segNum} (${segDuration}s)\n`);
      process.stdout.write(`[vertex-assets]   coverage: ${truncateText(shot.coverageText, 120)}\n`);
      process.stdout.write(`[vertex-assets]   must show: ${shot.mustShow.join(", ")}\n`);

      // Skip if image + clip already exist from a previous run
      const segVideoExists = !args.imagesOnly && await isUsableVideoClipPath(segVideoPath);
      const segImageExists = existsSync(segImagePath);
      if (canReuseExistingAssets && segImageExists && (args.imagesOnly || segVideoExists)) {
        process.stdout.write(`[vertex-assets]   SKIP: reusing existing ${path.basename(segImagePath)}` +
          (segVideoExists ? ` + ${path.basename(segVideoPath)}` : "") + "\n");
        if (segVideoExists) segmentClips.push(segVideoPath);
        completedSegmentIndexes.add(j);
        totalSuccessfulSegments++;
        manifest.push({
          scene: sceneNum, segment: j + 1, title: scene.title,
          planner: entry.plan?.planner ?? "unknown",
          narration: scene.narration, coverageText: shot.coverageText,
          mustShow: shot.mustShow, prompt, negativePrompt, validation,
          duration: segDuration, seed: globalSeed + j,
          sceneRisk: entry.sceneLint?.risk || null,
          status: "reused-existing"
        });
        continue;
      }

      if (canReuseExistingAssets && !args.dryRun && !segVideoExists) {
        const recovered = await recoverExistingSegmentImage({
          imagesDir,
          segImagePath,
          scene,
          sceneNum,
          segNum,
          shot,
          validation,
          seed: globalSeed + j
        });

        if (recovered) {
          process.stdout.write(
            `[vertex-assets]   RECOVER: using existing ${path.basename(recovered.recoveredFrom)}\n`
          );

          if (!args.imagesOnly) {
            imageToStaticClip({imagePath: recovered.imagePath, videoPath: segVideoPath, duration: segDuration});
            segmentClips.push(segVideoPath);
            sceneNeedsReconcat = true;
          }
          completedSegmentIndexes.add(j);
          totalSuccessfulSegments++;

          manifest.push({
            scene: sceneNum,
            segment: j + 1,
            title: scene.title,
            planner: entry.plan?.planner ?? "unknown",
            narration: scene.narration,
            coverageText: shot.coverageText,
            mustShow: shot.mustShow,
            supportingDetails: shot.supportingDetails,
            setting: shot.setting,
            composition: shot.composition,
            camera: shot.camera,
            action: shot.action,
            lighting: shot.lighting,
            prompt,
            negativePrompt,
            validation,
            localAudit: recovered.localAudit,
            duration: segDuration,
            seed: globalSeed + j,
            sceneRisk: entry.sceneLint?.risk || null,
            status: args.imagesOnly ? "recovered-image-only" : "recovered-existing"
          });
          continue;
        }
      }

      if (args.dryRun) {
        const localAudit = await auditLocalFlux2Output({
          imagePath: segImagePath,
          shot,
          validation,
          seed: globalSeed + j,
          dryRun: true
        });
        manifest.push({
          scene: sceneNum,
          segment: j + 1,
          title: scene.title,
          planner: entry.plan?.planner ?? "unknown",
          narration: scene.narration,
          coverageText: shot.coverageText,
          mustShow: shot.mustShow,
          supportingDetails: shot.supportingDetails,
          setting: shot.setting,
          composition: shot.composition,
          camera: shot.camera,
          action: shot.action,
          lighting: shot.lighting,
          prompt,
          negativePrompt,
          validation,
          localAudit,
          duration: segDuration,
          sceneRisk: entry.sceneLint?.risk || null,
          status: "dry-run"
        });
        continue;
      }

      try {
        let finalPrompt = prompt;
        let finalValidation = validation;
        let finalLocalAudit = null;
        let finalImagePath = segImagePath;
        let finalSeed = globalSeed + j;
        let lastError = null;

        for (let attempt = 0; attempt < FLUX2_RENDER_RETRY_COUNT; attempt += 1) {
          const seed = globalSeed + j + (attempt * 1000);
          const attemptOutputPath = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}__attempt-${attempt + 1}.png`);
          const attemptPrompt = attempt === 0
            ? prompt
            : buildImagePrompt({
                scene,
                shot,
              style: args.style || DEFAULT_STYLE,
              sceneIndex: i,
              segmentIndex: j,
              sceneSpec: entry.sceneSpec,
              sceneLint: entry.sceneLint,
              extraDirectives: buildAttemptDirectives({
                shot,
                attempt,
                  failureSummary: lastError?.message || ""
                }).concat(
                  buildPositiveRepairDirectives({
                    shot,
                    failureSummary: lastError?.message || ""
                  })
                )
              });
          const attemptValidation = attempt === 0 ? validation : buildValidation(attemptPrompt);

          if (attemptValidation.missingObjects.length > 0 || attemptValidation.missingNegatives.length > 0) {
            throw new Error(`Prompt validation falhou para scene ${sceneNum} seg ${segNum} na tentativa ${attempt + 1}`);
          }

          if (attempt > 0) {
            process.stdout.write(
              `[vertex-assets]   retry ${attempt + 1}/${FLUX2_RENDER_RETRY_COUNT} with stronger ${buildRetryDirectiveLabel({
                shot,
                failureSummary: lastError?.message || ""
              })} directives\n`
            );
          }

          try {
            await removeGeneratedImageVariants(attemptOutputPath);
            await generateImage({prompt: attemptPrompt, outputPath: attemptOutputPath});
            const producedImagePath = await resolveGeneratedImagePath({expectedPath: attemptOutputPath});
            const localAudit = await auditLocalFlux2Output({
              imagePath: producedImagePath,
              shot,
              validation: attemptValidation,
              seed
            });

            if (localAudit.skipped !== true) {
              process.stdout.write(
                `[vertex-assets]   local audit: format=${localAudit.imageFormat || "unknown"} bytes=${localAudit.fileSizeBytes || 0} passed=${localAudit.passed}\n`
              );
            }

            if (localAudit.skipped !== true && !localAudit.passed) {
              throw new Error(`Local audit failed: ${localAudit.summary || "render invalido"}`);
            }

            // Gemini Vision semantic audit
            const visionAudit = await auditWithGeminiVision({
              imagePath: producedImagePath,
              visualGoal: shot.coverageText || scene.visualGoal || scene.searchQuery || "",
              narration: scene.narration || "",
              shot
            });

            if (!visionAudit.skipped) {
              process.stdout.write(
                `[gemini-vision]   passed=${visionAudit.passed} reason="${visionAudit.reason}"\n`
              );
            }

            if (!visionAudit.skipped && !visionAudit.passed) {
              throw new Error(`Gemini Vision audit failed: ${visionAudit.reason || "imagem nao corresponde a cena"}`);
            }

            finalPrompt = attemptPrompt;
            finalValidation = attemptValidation;
            finalLocalAudit = localAudit;
            finalLocalAudit.visionAudit = visionAudit;
            finalImagePath = producedImagePath;
            finalSeed = seed;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const failureAnalysis = analyzeFailureText(lastError.message);
            if (attempt === FLUX2_RENDER_RETRY_COUNT - 1) {
              /* ── Fallback: rewrite visual goal when all attempts failed due to readable text on screen ── */
              const isScreenTextFailure =
                failureAnalysis.primaryCategory === "screen_content_mismatch" ||
                (
                  failureAnalysis.primaryCategory === "text_overlay" &&
                  /\b(screen|smartphone|phone|tablet|computer|monitor|display|device)\b/i.test(lastError.message)
                );
              if (isScreenTextFailure && !shot._screenFallbackApplied) {
                shot._screenFallbackApplied = true;
                const stripScreenContent = (text) => text
                  .replace(/\b(screen|display|monitor)\s+(showing|displaying|with)\s+[^,.]*/gi, "blank glowing $1")
                  .replace(/\b(scrolling through|browsing)\s+[^,.]*\s+on\s+(?:a\s+)?(phone|smartphone|tablet|screen)\b/gi, "looking at a $2 with a blank dark screen")
                  .replace(/\b(phone|smartphone|tablet|laptop|computer)\s+(screen\s+)?(showing|displaying|with)\s+[^,.]*/gi, "$1 with a blank dark screen")
                  .replace(/\bon\s+(?:a\s+)?(computer|laptop|phone|smartphone|tablet|monitor)\s+screen\b/gi, "near a $1 with a blank dark screen")
                  .replace(/\s+/g, " ").trim();
                shot.coverageText = stripScreenContent(shot.coverageText || "");
                shot.mustShow = shot.mustShow.map((m) => stripScreenContent(m));
                shot.supportingDetails = shot.supportingDetails.map((d) => stripScreenContent(d));
                /* If the text still mentions a device without explicit blank screen, force it */
                const deviceRe = /\b(phone|smartphone|tablet|laptop|computer|monitor)\b/i;
                if (deviceRe.test(shot.coverageText) && !/blank.{0,10}screen/i.test(shot.coverageText)) {
                  shot.coverageText = shot.coverageText.replace(deviceRe, "$1 with a completely black turned-off screen");
                }
                process.stderr.write(`[vertex-assets]   screen-text fallback: rewriting visual goal and retrying\n`);
                /* Run 2 bonus attempts with the rewritten shot */
                for (let bonus = 0; bonus < 2; bonus += 1) {
                  const bonusSeed = globalSeed + j + ((FLUX2_RENDER_RETRY_COUNT + bonus) * 1000);
                  const bonusOutput = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}__attempt-${FLUX2_RENDER_RETRY_COUNT + bonus + 1}.png`);
                  const bonusPrompt = buildImagePrompt({
                    scene, shot,
                    style: args.style || DEFAULT_STYLE,
                    sceneIndex: i, segmentIndex: j,
                    sceneSpec: entry.sceneSpec,
                    sceneLint: entry.sceneLint,
                    extraDirectives: ["ABSOLUTELY NO TEXT of any kind on any surface or screen", "every screen and display must be a plain blank glowing surface with no content"]
                  });
                  process.stdout.write(`[vertex-assets]   screen-fallback retry ${bonus + 1}/2\n`);
                  try {
                    await removeGeneratedImageVariants(bonusOutput);
                    await generateImage({prompt: bonusPrompt, outputPath: bonusOutput});
                    const bonusImagePath = await resolveGeneratedImagePath({expectedPath: bonusOutput});
                    const bonusLocalAudit = await auditLocalFlux2Output({imagePath: bonusImagePath, shot, validation: buildValidation(bonusPrompt), seed: bonusSeed});
                    if (bonusLocalAudit.skipped !== true && !bonusLocalAudit.passed) {
                      throw new Error(`Local audit failed: ${bonusLocalAudit.summary || "render invalido"}`);
                    }
                    const bonusVision = await auditWithGeminiVision({imagePath: bonusImagePath, visualGoal: shot.coverageText || "", narration: scene.narration || "", shot});
                    if (!bonusVision.skipped) process.stdout.write(`[gemini-vision]   passed=${bonusVision.passed} reason="${bonusVision.reason}"\n`);
                    if (!bonusVision.skipped && !bonusVision.passed) throw new Error(`Gemini Vision audit failed: ${bonusVision.reason}`);
                    finalPrompt = bonusPrompt;
                    finalValidation = buildValidation(bonusPrompt);
                    finalLocalAudit = bonusLocalAudit;
                    finalLocalAudit.visionAudit = bonusVision;
                    finalImagePath = bonusImagePath;
                    finalSeed = bonusSeed;
                    lastError = null;
                    break;
                  } catch (bonusErr) {
                    lastError = bonusErr instanceof Error ? bonusErr : new Error(String(bonusErr));
                    process.stderr.write(`[vertex-assets]   screen-fallback attempt ${bonus + 1} failed: ${lastError.message}\n`);
                  }
                }
                if (!lastError) break;
              }

              /* ── Fallback: rewrite visual goal when all attempts failed due to readable text on paper/document ── */
              const isPaperTextFailure =
                lastError &&
                failureAnalysis.primaryCategory === "text_overlay" &&
                /\b(paper|document|map|note|receipt|menu|card|letter)\b/i.test(lastError.message);
              if (lastError && isPaperTextFailure && !shot._paperFallbackApplied && shotIncludesPaperLikeObject(shot)) {
                shot._paperFallbackApplied = true;
                const stripPaperText = (text) => text
                  .replace(/(paper map|map)/gi, "$1 with only abstract colored shapes and wavy lines, no text or labels")
                  .replace(/(document|paper|note|receipt|menu|calendar)/gi, "$1 with abstract visual texture only, no readable content")
                  .replace(/\s+/g, " ").trim();
                shot.coverageText = stripPaperText(shot.coverageText || "");
                shot.mustShow = shot.mustShow.map((m) => stripPaperText(m));
                shot.supportingDetails = shot.supportingDetails.map((d) => stripPaperText(d));
                process.stderr.write(`[vertex-assets]   paper-text fallback: rewriting visual goal and retrying
`);
                for (let bonus = 0; bonus < 2; bonus += 1) {
                  const bonusSeed = globalSeed + j + ((FLUX2_RENDER_RETRY_COUNT + 2 + bonus) * 1000);
                  const bonusOutput = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}__attempt-${FLUX2_RENDER_RETRY_COUNT + 2 + bonus + 1}.png`);
                  const bonusPrompt = buildImagePrompt({
                    scene, shot,
                    style: args.style || DEFAULT_STYLE,
                    sceneIndex: i, segmentIndex: j,
                    sceneSpec: entry.sceneSpec,
                    sceneLint: entry.sceneLint,
                    extraDirectives: ["ABSOLUTELY NO TEXT of any kind on any paper, map, document, or surface", "all paper and map surfaces must show only abstract shapes, colored blobs, and wavy lines with zero legible content"]
                  });
                  process.stdout.write(`[vertex-assets]   paper-fallback retry ${bonus + 1}/2
`);
                  try {
                    await removeGeneratedImageVariants(bonusOutput);
                    await generateImage({prompt: bonusPrompt, outputPath: bonusOutput});
                    const bonusImagePath = await resolveGeneratedImagePath({expectedPath: bonusOutput});
                    const bonusLocalAudit = await auditLocalFlux2Output({imagePath: bonusImagePath, shot, validation: buildValidation(bonusPrompt), seed: bonusSeed});
                    if (bonusLocalAudit.skipped !== true && !bonusLocalAudit.passed) {
                      throw new Error(`Local audit failed: ${bonusLocalAudit.summary || "render invalido"}`);
                    }
                    const bonusVision = await auditWithGeminiVision({imagePath: bonusImagePath, visualGoal: shot.coverageText || "", narration: scene.narration || "", shot});
                    if (!bonusVision.skipped) process.stdout.write(`[gemini-vision]   passed=${bonusVision.passed} reason="${bonusVision.reason}"
`);
                    if (!bonusVision.skipped && !bonusVision.passed) throw new Error(`Gemini Vision audit failed: ${bonusVision.reason}`);
                    finalPrompt = bonusPrompt;
                    finalValidation = buildValidation(bonusPrompt);
                    finalLocalAudit = bonusLocalAudit;
                    finalLocalAudit.visionAudit = bonusVision;
                    finalImagePath = bonusImagePath;
                    finalSeed = bonusSeed;
                    lastError = null;
                    break;
                  } catch (bonusErr) {
                    lastError = bonusErr instanceof Error ? bonusErr : new Error(String(bonusErr));
                    process.stderr.write(`[vertex-assets]   paper-fallback attempt ${bonus + 1} failed: ${lastError.message}
`);
                  }
                }
                if (!lastError) break;
              }

              const canApplySceneSpecRepair =
                lastError &&
                entry.sceneSpec &&
                !shot._sceneSpecRepairApplied &&
                ["viewpoint_mismatch", "framing_mismatch", "emotion_mismatch", "scene_semantics_mismatch", "face_defect"].includes(failureAnalysis.primaryCategory);
              if (canApplySceneSpecRepair) {
                shot._sceneSpecRepairApplied = true;
                realignShotWithSceneSpec({scene, shot, sceneSpec: entry.sceneSpec});
                process.stderr.write(
                  `[vertex-assets]   scene-spec repair: ${failureAnalysis.primaryCategory} -> ${failureAnalysis.repairStrategy.mode}\n`
                );

                for (let bonus = 0; bonus < 2; bonus += 1) {
                  const bonusSeed = globalSeed + j + ((FLUX2_RENDER_RETRY_COUNT + 4 + bonus) * 1000);
                  const bonusOutput = path.join(imagesDir, `scene-${sceneNum}-seg-${segNum}__attempt-${FLUX2_RENDER_RETRY_COUNT + 4 + bonus + 1}.png`);
                  const bonusPrompt = buildImagePrompt({
                    scene,
                    shot,
                    style: args.style || DEFAULT_STYLE,
                    sceneIndex: i,
                    segmentIndex: j,
                    sceneSpec: entry.sceneSpec,
                    sceneLint: entry.sceneLint,
                    extraDirectives: uniqueStrings([
                      ...buildSceneSpecPromptDirectives({sceneSpec: entry.sceneSpec, sceneLint: entry.sceneLint}),
                      ...(failureAnalysis.repairStrategy?.promptHints || []),
                      ...((failureAnalysis.repairStrategy?.suggestedPromptHints || []).slice(0, 4))
                    ])
                  });
                  process.stdout.write(`[vertex-assets]   scene-spec repair retry ${bonus + 1}/2\n`);

                  try {
                    await removeGeneratedImageVariants(bonusOutput);
                    await generateImage({prompt: bonusPrompt, outputPath: bonusOutput});
                    const bonusImagePath = await resolveGeneratedImagePath({expectedPath: bonusOutput});
                    const bonusLocalAudit = await auditLocalFlux2Output({imagePath: bonusImagePath, shot, validation: buildValidation(bonusPrompt), seed: bonusSeed});
                    if (bonusLocalAudit.skipped !== true && !bonusLocalAudit.passed) {
                      throw new Error(`Local audit failed: ${bonusLocalAudit.summary || "render invalido"}`);
                    }
                    const bonusVision = await auditWithGeminiVision({imagePath: bonusImagePath, visualGoal: shot.coverageText || "", narration: scene.narration || "", shot});
                    if (!bonusVision.skipped) process.stdout.write(`[gemini-vision]   passed=${bonusVision.passed} reason="${bonusVision.reason}"\n`);
                    if (!bonusVision.skipped && !bonusVision.passed) throw new Error(`Gemini Vision audit failed: ${bonusVision.reason}`);
                    finalPrompt = bonusPrompt;
                    finalValidation = buildValidation(bonusPrompt);
                    finalLocalAudit = bonusLocalAudit;
                    finalLocalAudit.visionAudit = bonusVision;
                    finalImagePath = bonusImagePath;
                    finalSeed = bonusSeed;
                    lastError = null;
                    break;
                  } catch (bonusErr) {
                    lastError = bonusErr instanceof Error ? bonusErr : new Error(String(bonusErr));
                    process.stderr.write(`[vertex-assets]   scene-spec repair attempt ${bonus + 1} failed: ${lastError.message}\n`);
                  }
                }

                if (!lastError) break;
              }
              throw lastError;
            }
            process.stderr.write(
              `[vertex-assets]   attempt ${attempt + 1} failed [${failureAnalysis.primaryCategory}/${failureAnalysis.repairStrategy.mode}]: ${lastError.message}\n`
            );
          }
        }

        if (!finalLocalAudit) {
          throw new Error("Render terminou sem auditoria final.");
        }

        if (finalImagePath !== segImagePath) {
          await rm(segImagePath, {force: true});
          await rename(finalImagePath, segImagePath);
          finalImagePath = segImagePath;
        }

        // Clean up all __attempt-N.png files except the winning one (now renamed to segImagePath)
        try {
          const attemptPattern = `scene-${sceneNum}-seg-${segNum}__attempt-`;
          const dirEntries = await readdir(imagesDir);
          const attemptFiles = dirEntries.filter((name) => name.startsWith(attemptPattern) && name.endsWith(".png"));
          await Promise.all(
            attemptFiles.map((name) => rm(path.join(imagesDir, name), {force: true}))
          );
        } catch {}

        if (!args.imagesOnly) {
          imageToStaticClip({imagePath: finalImagePath, videoPath: segVideoPath, duration: segDuration});
          segmentClips.push(segVideoPath);
          sceneNeedsReconcat = true;
        }
        completedSegmentIndexes.add(j);
        totalSuccessfulSegments++;
        totalGeneratedImages++;

        manifest.push({
          scene: sceneNum,
          segment: j + 1,
          title: scene.title,
          planner: entry.plan?.planner ?? "unknown",
          narration: scene.narration,
          coverageText: shot.coverageText,
          mustShow: shot.mustShow,
          supportingDetails: shot.supportingDetails,
          setting: shot.setting,
          composition: shot.composition,
          camera: shot.camera,
          action: shot.action,
          lighting: shot.lighting,
          prompt: finalPrompt,
          negativePrompt,
          validation: finalValidation,
          localAudit: finalLocalAudit,
          sceneRisk: entry.sceneLint?.risk || null,
          duration: segDuration,
          seed: finalSeed,
          status: args.imagesOnly ? "generated-image-only" : "generated"
        });
      } catch (err) {
        sceneFailed = true;
        totalFailedSegments++;
        process.stderr.write(`[vertex-assets] scene ${sceneNum} seg ${segNum} failed: ${err.message}\n`);
        sceneFailureReasons.push(`seg ${segNum} failed: ${truncateText(String(err?.message || "erro desconhecido"), 220)}`);
        const failureAnalysis = analyzeFailureText(err?.message || "");
        manifest.push({
          scene: sceneNum,
          segment: j + 1,
          title: scene.title,
          planner: entry.plan?.planner ?? "unknown",
          narration: scene.narration,
          coverageText: shot.coverageText,
          mustShow: shot.mustShow,
          prompt,
          negativePrompt,
          validation,
          failureTaxonomy: failureAnalysis,
          sceneRisk: entry.sceneLint?.risk || null,
          localAudit: {
            provider: "google-imagen",
            mode: "prompt-and-render-guard",
            skipped: false,
            passed: false,
            seed: globalSeed + j,
            imageFormat: null,
            fileSizeBytes: 0,
            requiredObjects: shot.mustShow,
            reasons: [err.message],
            summary: err.message
          },
          status: "failed",
          error: err.message
        });
      }
    }

    globalSeed += plannedShots.length;

    const sdxlDeferred = false;

    if (!args.dryRun && !args.imagesOnly && segmentClips.length > 0) {
      const verifiedSegmentClips = [];
      for (const clipPath of segmentClips) {
        if (await isUsableVideoClipPath(clipPath)) {
          verifiedSegmentClips.push(clipPath);
          continue;
        }
        sceneFailed = true;
        const clipName = path.basename(clipPath);
        sceneFailureReasons.push(`clip invalido ou ausente: ${clipName}`);
        process.stderr.write(`[vertex-assets] scene ${sceneNum}: invalid clip detected ${clipName}\n`);
      }
      segmentClips.length = 0;
      segmentClips.push(...verifiedSegmentClips);
    }

    const missingSegments = [];
    for (let j = 0; j < plannedShots.length; j += 1) {
      if (!completedSegmentIndexes.has(j)) {
        missingSegments.push(String(j + 1).padStart(2, "0"));
      }
    }
    if (missingSegments.length > 0) {
      sceneFailureReasons.push(`segmentos sem imagem valida: ${missingSegments.join(", ")}`);
    }

    if (
      !args.dryRun &&
      !args.imagesOnly &&
      (sceneFailed || plannedShots.length === 0 || segmentClips.length !== plannedShots.length)
    ) {
      await rm(videoPath, {force: true}).catch(() => {}); /* best-effort: remove incomplete scene video */
      markSceneIncomplete({
        sceneNum,
        clipsOk: segmentClips.length,
        clipsExpected: plannedShots.length,
        reasons: sceneFailureReasons
      });
      continue;
    }

    // When SDXL is enabled, clip creation is deferred to after batch refinement
    if (!sdxlDeferred && !args.dryRun && !args.imagesOnly && segmentClips.length > 0) {
      if (canReuseExistingAssets && !sceneNeedsReconcat && await isUsableVideoClipPath(videoPath)) {
        process.stdout.write(`[vertex-assets] scene ${sceneNum}: SKIP concat (reusing existing scene clip)\n`);
      } else {
        await concatClips({clips: segmentClips, outputPath: videoPath, tempDir: imagesDir});
        process.stdout.write(`[vertex-assets] scene ${sceneNum}: done (${segmentClips.length} clips)\n`);
      }
    }
  }

  // --- Batch SDXL Refine + Upscale (loads model once for all images) ---
  if (pendingSdxlJobs.length > 0) {
    const sdxlResults = refineAndUpscaleBatch(pendingSdxlJobs);

    for (let k = 0; k < pendingSdxlJobs.length; k++) {
      const job = pendingSdxlJobs[k];
      const result = sdxlResults[k] || {skipped: false, passed: false};

      if (result.passed && existsSync(job.output)) {
        execFileSync("mv", [job.output, job.input]);
        process.stdout.write(`[sdxl-pipeline] replaced ${path.basename(job.input)} with refined version\n`);
      }
    }

    // Now create video clips from (possibly refined) images and concat per scene
    process.stdout.write(`[sdxl-pipeline] creating video clips for ${scenes.length} scenes...\n`);
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNum = String(i + 1).padStart(2, "0");
      const videoPath = path.join(assetDir, `scene-${sceneNum}.mp4`);

      if (incompleteScenes.has(sceneNum)) continue;
      if (canReuseExistingAssets && await isUsableVideoClipPath(videoPath)) {
        process.stdout.write(`[vertex-assets] scene ${sceneNum}: SKIP concat (reusing existing scene clip)\n`);
        continue;
      }

      const sceneJobs = pendingSdxlJobs.filter((j) => j.input.includes(`scene-${sceneNum}-seg-`));
      const clips = [];

      for (const job of sceneJobs) {
        if (existsSync(job.input)) {
          imageToStaticClip({imagePath: job.input, videoPath: job.segVideoPath, duration: job.segDuration});
          clips.push(job.segVideoPath);
        }
      }

      if (clips.length !== sceneJobs.length) {
        await rm(videoPath, {force: true}).catch(() => {}); /* best-effort: remove incomplete scene video */
        markSceneIncomplete({
          sceneNum,
          clipsOk: clips.length,
          clipsExpected: sceneJobs.length,
          reasons: ["pipeline SDXL criou menos clips do que o esperado"]
        });
        continue;
      }

      if (clips.length > 0) {
        await concatClips({clips, outputPath: videoPath, tempDir: imagesDir});
        process.stdout.write(`[vertex-assets] scene ${sceneNum}: done (${clips.length} clips)\n`);
      }
    }
  }

  await persistArtifacts({
    assetDir,
    scenePlans,
    manifest,
    reuseMetadata: currentReuseMetadata,
    geminiUsage: geminiUsageSummary
  });
  process.stdout.write(
    `[vertex-assets] done: ${totalGeneratedImages} images generated (${totalSuccessfulSegments} usable segments, ${totalFailedSegments} failed, ${totalImages}/${totalSegmentCount} attempted)\n`
  );

  if (!args.dryRun && !args.imagesOnly && incompleteScenes.size > 0) {
    const orderedIncompleteScenes = Array.from(incompleteScenes).sort(
      (left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10)
    );
    const detailSummary = orderedIncompleteScenes
      .map((sceneNum) => {
        const reasons = incompleteSceneReasons.get(sceneNum) || [];
        return reasons.length > 0
          ? `${sceneNum} (${reasons.join(" | ")})`
          : sceneNum;
      })
      .join("; ");
    if (detailSummary) {
      process.stderr.write(`[vertex-assets] incomplete-scene-summary: ${detailSummary}\n`);
    }
    throw new Error(
      `Geracao de imagens ficou incompleta nas cenas: ${orderedIncompleteScenes.join(", ")}. Detalhes: ${detailSummary || "sem detalhes"}`
    );
  }
};

const isDirectRun = (() => {
  const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entryPath === fileURLToPath(import.meta.url);
})();

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

export {
  analyzeFailureText,
  buildGeminiVisionAuditGuardrails,
  buildSceneAwareAction,
  buildSceneAwareCamera,
  buildSceneAwareComposition,
  buildSceneSpecPromptDirectives,
  describeAllowedAbstractScreenContent,
  realignShotWithSceneSpec,
  sanitizeShotText,
  sanitizeShotTextForSceneSpec,
  shotAllowsAbstractScreenContent,
  shotNeedsBlankDeviceScreen,
  shotNeedsStatusUiSignal
};
