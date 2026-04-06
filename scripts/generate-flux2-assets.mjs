#!/usr/bin/env node
/**
 * generate-flux2-assets.mjs
 *
 * Legacy filename kept for compatibility.
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
import {callVertexMultimodalText, generateVertexImage} from "../video-engine/scripts/lib/gcp-media.mjs";
import {resolveGcpConfig} from "../video-engine/scripts/lib/gcp-config.mjs";
import {createGeminiUsageSummary, recordGeminiUsage} from "../video-engine/scripts/lib/gemini-usage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const LOCAL_VISUAL_AUDIT_SCRIPT = path.join(projectRoot, "scripts", "local-flux2-visual-audit.py");

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
  ? "wide landscape composition, full stick figure and all required objects fully visible, generous safe margins, no cropped head or limbs, no extreme close-up"
  : "vertical portrait composition, full stick figure and all required objects fully visible, comfortable margins, no cropped head or limbs, no extreme close-up";
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

// --- Helpers ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GOOGLE_IMAGE_RATE_LIMIT_DIR = path.join(projectRoot, ".cache");
const GOOGLE_IMAGE_RATE_LIMIT_LOCK_DIR = path.join(GOOGLE_IMAGE_RATE_LIMIT_DIR, "google-image-rate-limit.lock");
const GOOGLE_IMAGE_RATE_LIMIT_FILE = path.join(GOOGLE_IMAGE_RATE_LIMIT_DIR, "google-image-rate-limit.json");

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

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

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
  const entries = await readdir(dir).catch(() => []);
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
  const entries = await readdir(imagesDir).catch(() => []);

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

const uniqueStrings = (values) => {
  const seen = new Set();

  return values.filter((value) => {
    const normalized = normalizeText(value).toLowerCase();

    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
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

  return /\bsmartphone\b|\bphone\b|\btablet\b|\blaptop\b|\bscreen\b|\bmonitor\b|\bdisplay\b|\bdashboard\b|\binterface\b|\bscanner\b|\bchat bubble\b/.test(haystack);
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
    directives.push(
      "character head is a simple circle with minimal features: two dots for eyes and a small curve for mouth, no hair detail, no ears, no nose, no eyebrows",
      "keep enough body in frame that the stick figure reads as a full character with clear posture, not just a tiny head and one stick line"
    );
  }

  if (shotNeedsBlankDeviceScreen(shot)) {
    directives.push(
      "any smartphone, tablet, laptop, monitor, dashboard, scanner, or digital display must be a generic unbranded slab with a plain blank glow or only one to two large soft abstract panels, with no notch, no camera hole, no top cutout, no speaker slit, no status bar, no icons, no rows of small blocks, and no browser chrome"
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
      directives.push("remove every letter, number, label, glyph, caption, and text-like mark from the entire image");
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
      directives.push("make the screen a plain blank glow with no content, no icons, and no text");
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
  if (/not blank or glowing|not glowing/i.test(summary)) {
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
    directives.push(
      "show screens as abstract glowing panels with one or two large soft shapes only",
      "make the device readable by silhouette and framing, not by visible UI content"
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

const buildVariationDirectives = ({sceneIndex = 0, segmentIndex = 0, shot}) => {
  if (shotNeedsObjectLedCloseup(shot)) {
    return [
      "prefer an extreme close-up or macro object-led composition where the key device detail fills most of the frame",
      "if a hand is present, crop to the hand and the hardware detail only",
      "avoid full-body, portrait, or wide environmental framing for this shot"
    ];
  }

  const variationPool = EXPECT_STICKMAN_AUDIT ? STICKMAN_VARIATION_ROTATION : SHOT_VARIATION_ROTATION;
  const directive = variationPool[(sceneIndex + segmentIndex) % variationPool.length];
  return [
    directive,
    EXPECT_STICKMAN_AUDIT
      ? "keep the entire stick figure visible, avoid oversized head close-ups, and keep enough body in frame for clear posture"
      : null,
    "avoid repeating the same straight-on medium shot used in nearby scenes unless the narration truly requires it"
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

const extractJsonObject = (input) => {
  const text = String(input ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Nao encontrei JSON valido no planeador visual.");
  }

  return text.slice(start, end + 1);
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

const requestLlmText = async ({prompt, maxTokens = 900}) => {
  const model = String(process.env.GEMINI_PLANNER_MODEL || GCP_CONFIG.storyModel || "gemini-2.5-flash").trim();
  let lastError = null;

  for (let attempt = 0; attempt <= LLM_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const {payload, text} = await callVertexMultimodalText({
        model,
        textParts: [prompt],
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

const buildScenePlannerPrompt = (scene) => {
  const searchAnchors = uniqueStrings([
    scene.searchQuery,
    ...(Array.isArray(scene.candidateQueries) ? scene.candidateQueries : [])
  ]).slice(0, 6);
  const targetCount = estimateShotTarget(scene);

  return [
    "You are a senior visual planner for FLUX image generation.",
    "Return valid JSON only. No markdown. No comments.",
    "Use English for all values except exact brand or product names when needed.",
    "Goal: create clear visual shot plans that FLUX can render consistently for a vertical 9:16 short-form video.",
    `Create ${FLUX2_MIN_SHOTS_PER_SCENE} to ${FLUX2_MAX_SHOTS_PER_SCENE} shots for this scene.`,
    `Return exactly ${targetCount} ordered shots for this scene unless the scene is truly impossible to split further.`,
    "Prefer more shots whenever the narration contains multiple concrete visual beats, objects, settings, or actions.",
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
    "If a screen or interface is needed, describe it as abstract and unreadable using one or two large soft blank panels, simple unlabeled charts, or empty speech bubbles only.",
    "Interface layouts must avoid top bars, browser tabs, control dots, title bars, or operating-system chrome.",
    "Phones, tablets, laptops, dashboards, and monitors must be generic unbranded rectangles with a plain blank glow or one or two large unlabeled abstract panels only. No notch, no camera hole, no top cutout, no speaker slit, no icons, and no status bar.",
    "If a document, paper menu, street sign, packaging, label, or printed page is needed, describe it with blank bars, empty blocks, or abstract overlays only. Never request readable print.",
    "Never request fake text lines, browser chrome, window controls, menus, toolbars, headlines, labels, or glyph-like marks inside interfaces.",
    "Each shot must be drawable as a single static explanatory illustration.",
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
    "Rules:",
    "- keep shot order aligned to narration order",
    `- return exactly ${targetCount} ordered shots for this scene`,
    "- keep each mustShow list visually concrete and short",
    "- use as many shots as needed to preserve semantic fidelity up to the allowed limit",
    "- split crowded beats into separate shots instead of compressing multiple devices, actions, or settings into one frame",
    "- prefer separate shots when a scene mixes human posture with a device or interface close-up",
    "- vary framing and setting across consecutive shots instead of repeating the same desk medium shot",
    "- do not invent objects unrelated to the narration or the visual goal",
    "- use character or person wording for people",
    "- use unlabeled chart wording for graphs whenever possible",
    "- use blank content blocks instead of text lines inside interfaces",
    "- do not request text overlays, subtitles, labels, logos, or watermarks",
    "",
    `Scene title: ${normalizeText(scene.title)}`,
    `Narration: ${normalizeText(scene.narration)}`,
    `Search query anchor: ${normalizeText(scene.searchQuery)}`,
    `Visual goal anchor: ${normalizeText(scene.visualGoal)}`,
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

const normalizeShot = (scene, rawShot) => {
  const mustShow = filterRenderablePhrases(scene, normalizeStringArray(rawShot?.mustShow).map((item) => sanitizeShotText(item))).slice(0, 8);
  const supportingDetails = filterRenderablePhrases(scene, normalizeStringArray(rawShot?.supportingDetails).map((item) => sanitizeShotText(item))).slice(0, 8);
  const avoid = uniqueStrings([
    ...DEFAULT_NEGATIVE_TERMS,
    ...normalizeStringArray(rawShot?.avoid)
  ]);
  const coverageText = truncateText(sanitizeShotText(rawShot?.coverageText || scene.narration), 220);
  const setting = truncateText(sanitizeShotText(rawShot?.setting || scene.visualGoal || scene.searchQuery || "clean contextual setting"), 220);
  const composition = truncateText(
    sanitizeShotText(rawShot?.composition || LAYOUT_COMPOSITION),
    220
  );
  const camera = truncateText(sanitizeShotText(rawShot?.camera || LAYOUT_CAMERA), 120);
  const action = truncateText(sanitizeShotText(rawShot?.action || "character interacting with the key objects"), 180);
  const lighting = truncateText(sanitizeShotText(rawShot?.lighting || DEFAULT_LIGHTING), 180);

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

const planSceneShots = async (scene, {allowFallback = ENABLE_PLANNER_FALLBACK} = {}) => {
  if (USE_DIRECT_SCENE_PLANNER) {
    return {
      planner: "direct-scene",
      shots: buildDirectScenePlan(scene).map((shot) => normalizeShot(scene, shot))
    };
  }

  const fallbackShots = buildFallbackVisualPlan(scene).map((shot) => normalizeShot(scene, shot));
  const targetCount = fallbackShots.length;

  let lastError = null;
  let sawUnderSegmentation = false;
  let bestPartialShots = null;

  for (const maxTokens of LLM_PLANNER_MAX_TOKENS) {
    try {
      const raw = await requestLlmText({
        prompt: buildScenePlannerPrompt(scene),
        maxTokens
      });
      const parsed = JSON.parse(extractJsonObject(raw));
      const shots = Array.isArray(parsed?.shots) ? parsed.shots.slice(0, targetCount) : [];

      if (shots.length === 0) {
        throw new Error("Planeador devolveu zero shots.");
      }

      const normalizedShots = shots.map((shot) => normalizeShot(scene, shot));

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

const buildImagePrompt = ({scene, shot, style, sceneIndex = 0, segmentIndex = 0, extraDirectives = []}) => {
  const humanSubjectPrompt = buildHumanSubjectPrompt(shot);
  const attemptDirectives = uniqueStrings([
    ...buildAttemptDirectives({shot, attempt: 0}),
    ...buildVariationDirectives({sceneIndex, segmentIndex, shot}),
    ...extraDirectives
  ]);
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

  return {
    totals: {
      sceneCount: scenePlans.length,
      imageCount: manifest.length,
      plannerFailureCount: plannerFailures.length,
      underSegmentedSceneCount: underSegmentedScenes.length,
      promptValidationFailureCount: promptValidationFailures.length,
      localAuditFailureCount: localAuditFailures.length,
      localAuditSkippedCount
    },
    plannerFailures,
    underSegmentedScenes,
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
      provider: "flux2-local",
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
      const visualReasons = visualAudit.reasons.map((reason) => `auditoria visual local: ${reason}`);
      const hardVisualReasons = FLUX2_LOCAL_VISUAL_AUDIT_STRICT
        ? visualReasons
        : visualReasons.filter((reason) => /ocr detectou texto provavel/i.test(reason));
      const advisoryVisualWarnings = FLUX2_LOCAL_VISUAL_AUDIT_STRICT
        ? []
        : visualReasons.filter((reason) => !/ocr detectou texto provavel/i.test(reason));

      reasons.push(...hardVisualReasons);
      warnings.push(...advisoryVisualWarnings);
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
      narration: scene.narration || ""
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

const auditWithGeminiVision = async ({imagePath, visualGoal, narration}) => {
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
    "- Any readable word, button label, UI copy, alert text, document text, or on-screen text such as Update, Login, Verify, Allow, Access Denied, or email copy",
    "",
    "Do NOT reject for:",
    `- ${STYLE_AUDIT_DESCRIPTION} instead of realistic people or realistic scenes (this IS the intended style)`,
    "- Simplified, abstract, or minimalist representations of any kind",
    "- Flat colors, lack of shading, cartoon-like appearance, or line art style",
    "- Characters drawn as stick figures when the goal mentions 'woman', 'man', 'person' etc.",
    "- Minor detail differences or missing secondary elements",
    "- Tiny illegible pseudo-text or broken printer-like marks on a receipt, ticket, invoice, or paper slip when that paper object is only a supporting prop and the text cannot be semantically read",
    ...(STYLE_IS_INK
      ? [
          "- A clean paper background or simplified editorial backdrop instead of a literal room, street, office, or command center, as long as the core subject and action match",
          "- Simplified environmental cues replacing a literal realistic setting when the intended style is editorial ink"
        ]
      : []),
    "",
    "If only one stick figure is visible, it must not have more than two hands or more than two arms. Occluded limbs are acceptable, extra limbs are not.",
    "When the scene narration or visual goal clearly involves a person, reject images where the character is barely visible, too tiny to read, or looks like just a stick line instead of a clear stick figure.",
    "Reject any image that contains readable text on a phone, laptop, tablet, sign, button, or interface, even if the subject matter otherwise matches.",
    "For receipts, tickets, invoices, or paper slips: only reject if the text is clearly readable or semantically meaningful, such as a store name, price, total, date, sentence, or obvious label. Do not reject for one short nonsense token or tiny illegible pseudo-print on a supporting paper prop.",
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
  if (clips.length === 1) {
    execFileSync("cp", [clips[0], outputPath]);
    return;
  }
  const listPath = path.join(tempDir, "concat.txt");
  await writeFile(listPath, clips.map((clipPath) => `file '${clipPath}'`).join("\n"));
  execFileSync("ffmpeg", [
    "-y", "-f", "concat", "-safe", "0", "-i", listPath,
    "-c", "copy", "-movflags", "+faststart", outputPath
  ], {stdio: "inherit"});
};

const clearSceneArtifacts = async ({assetDir, imagesDir, sceneNum}) => {
  const targets = [
    path.join(assetDir, `scene-${sceneNum}.mp4`)
  ];

  for (const target of targets) {
    await rm(target, {force: true}).catch(() => {});
  }

  const entries = await readdir(imagesDir).catch(() => []);
  const prefix = `scene-${sceneNum}-`;
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => rm(path.join(imagesDir, entry), {force: true}).catch(() => {}))
  );
};

// --- Main ---
const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.storyboardFile || !args.slug) {
    throw new Error("Usa: node scripts/generate-flux2-assets.mjs --storyboard-file <path> --slug <slug>");
  }

  const envatoRoot = resolvePathFromProjectRoot(process.env.VIDEOS_ENVATO_ROOT, path.join(projectRoot, "video-engine"));
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
  const incompleteScenes = [];

  const targetSceneIndexes = requestedSceneNumber ? [requestedSceneNumber - 1] : scenes.map((_, index) => index);

  for (const i of targetSceneIndexes) {
    const scene = scenes[i];
    const sceneNum = String(i + 1).padStart(2, "0");
    const plan = await planSceneShots(scene, {allowFallback});

    scenePlans.push({
      scene: sceneNum,
      title: scene.title,
      narration: scene.narration,
      planner: plan.planner,
      plannerError: plan.plannerError ?? null,
      shotCount: plan.shots.length,
      shots: plan.shots,
      suggestedShots: plan.suggestedShots ?? null
    });
    plannedSceneEntries.push({
      index: i,
      scene,
      sceneNum,
      plan
    });

    process.stdout.write(`[vertex-assets] scene ${sceneNum}: ${plan.shots.length} planned image(s) via ${plan.planner}\n`);
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
    process.stdout.write(
      "[vertex-assets] storyboard/style/layout changed; regenerating assets from scratch\n"
    );
    await rm(assetDir, {recursive: true, force: true});
    await mkdir(imagesDir, {recursive: true});
  }

  const totalSegmentCount = Math.min(plannedSceneEntries.reduce((sum, entry) => sum + entry.plan.shotCount, 0), maxImages);
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
    let sceneFailed = plannedShots.length === 0;

    for (let j = 0; j < plannedShots.length; j++) {
      if (totalImages >= totalSegmentCount) {
        break;
      }

      const shot = plannedShots[j];
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
        segmentIndex: j
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
      const segVideoExists = !args.imagesOnly && existsSync(segVideoPath);
      const segImageExists = existsSync(segImagePath);
      if (canReuseExistingAssets && segImageExists && (args.imagesOnly || segVideoExists)) {
        process.stdout.write(`[vertex-assets]   SKIP: reusing existing ${path.basename(segImagePath)}` +
          (segVideoExists ? ` + ${path.basename(segVideoPath)}` : "") + "\n");
        if (segVideoExists) segmentClips.push(segVideoPath);
        manifest.push({
          scene: sceneNum, segment: j + 1, title: scene.title,
          planner: entry.plan?.planner ?? "unknown",
          narration: scene.narration, coverageText: shot.coverageText,
          mustShow: shot.mustShow, prompt, negativePrompt, validation,
          duration: segDuration, seed: globalSeed + j,
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
          }

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
              narration: scene.narration || ""
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
            if (attempt === FLUX2_RENDER_RETRY_COUNT - 1) {
              throw lastError;
            }
            process.stderr.write(`[vertex-assets]   attempt ${attempt + 1} failed: ${lastError.message}\n`);
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

        if (!args.imagesOnly) {
          imageToStaticClip({imagePath: finalImagePath, videoPath: segVideoPath, duration: segDuration});
          segmentClips.push(segVideoPath);
        }

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
          duration: segDuration,
          seed: finalSeed,
          status: args.imagesOnly ? "generated-image-only" : "generated"
        });
      } catch (err) {
        sceneFailed = true;
        process.stderr.write(`[vertex-assets] scene ${sceneNum} seg ${segNum} failed: ${err.message}\n`);
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
          localAudit: {
            provider: "flux2-local",
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
    const expectedClips = sdxlDeferred ? 0 : plannedShots.length;

    if (!args.dryRun && !args.imagesOnly && sceneFailed) {
      if (segmentClips.length === 0) {
        incompleteScenes.push(sceneNum);
        process.stderr.write(`[vertex-assets] scene ${sceneNum}: incomplete visual coverage, skipping final scene clip\n`);
        continue;
      }
      process.stderr.write(`[vertex-assets] scene ${sceneNum}: partial coverage (${segmentClips.length}/${plannedShots.length} shots ok), using available clips\n`);
    }

    // When SDXL is enabled, clip creation is deferred to after batch refinement
    if (!sdxlDeferred && !args.dryRun && !args.imagesOnly && segmentClips.length > 0) {
      if (canReuseExistingAssets && existsSync(videoPath)) {
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

      if (incompleteScenes.includes(sceneNum)) continue;
      if (canReuseExistingAssets && existsSync(videoPath)) {
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
  process.stdout.write(`[vertex-assets] done: ${totalImages} images generated\n`);

  if (!args.dryRun && !args.imagesOnly && incompleteScenes.length > 0) {
    throw new Error(`Geracao de imagens ficou incompleta nas cenas: ${incompleteScenes.join(", ")}`);
  }
};

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
