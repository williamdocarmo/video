import "dotenv/config";
import {spawnSync} from "node:child_process";
import {access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {resolveOutputProfileConfig} from "../../config/output-profiles.mjs";
import {normalizeText, slugify, uniqueStrings, sleep as wait, runLoggedCommand as runLoggedCommandBase} from "../../../shared/utils.mjs";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";
import {analyzeSceneSpeechPacing, buildTimeline} from "./lib/timings.mjs";
import {sanitizeTimedWordsForAudio} from "./lib/alignment-utils.mjs";
import {
  callJsonProvider,
  evaluateStoryboardQa,
  generateStoryboard,
  getGeminiUsageSummary,
  pickSceneOverlay,
  repairStoryboard,
  resetGeminiUsageSummary,
  resolveLlmProvider
} from "./lib/llm-provider.mjs";
import {
  buildEstimatedTimedWords,
  extractTimedWordsFromAudio,
  getAudioDurationSeconds,
  normalizePortugueseForTts,
  synthesizeVoiceover
} from "./lib/tts.mjs";
import {mergeUsedAssetsRegistry, readUsedAssetsRegistry, writeUsedAssetsRegistry} from "./lib/used-assets.mjs";
import {runStreamingCommand} from "./lib/clean-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const LOCAL_STOCK_VIDEO_AUDIT_SCRIPT = path.join(projectRoot, "scripts", "local-stock-video-audit.py");
const MIN_SCENES = Math.max(1, Number.parseInt(process.env.MIN_SCENE_COUNT || "10", 10) || 10);
const MAX_SCENES = Math.max(MIN_SCENES, Number.parseInt(process.env.MAX_SCENE_COUNT || "18", 10) || 18);
const REMOTION_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.REMOTION_TIMEOUT_MS || "1800000", 10) || 1800000
);
const REMOTION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.REMOTION_CONCURRENCY || "2", 10) || 2
);
const REMOTION_VIDEO_BITRATE = String(process.env.REMOTION_VIDEO_BITRATE || "1400k");
const REMOTION_AUDIO_BITRATE = String(process.env.REMOTION_AUDIO_BITRATE || "96k");
const REMOTION_X264_PRESET = String(process.env.REMOTION_X264_PRESET || "veryfast");
const REMOTION_SCALE = String(process.env.REMOTION_SCALE || "1");
const REQUIRE_ENVATO_ALL_SCENES =
  String(process.env.REQUIRE_ENVATO_ALL_SCENES || "true").trim().toLowerCase() === "true";
const ALLOW_TEXT_ONLY_FALLBACK =
  String(process.env.ALLOW_TEXT_ONLY_FALLBACK || "false").trim().toLowerCase() === "true";
const REQUIRE_PREMIUM_TTS =
  String(process.env.REQUIRE_PREMIUM_TTS || "true").trim().toLowerCase() === "true";
const LLM_STAGE_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.LLM_STAGE_MAX_ATTEMPTS || "3", 10) || 3
);
const STORYBOARD_PREVIEW_QA_REPAIR_MAX_ATTEMPTS = Math.max(
  0,
  Number.parseInt(process.env.STORYBOARD_PREVIEW_QA_REPAIR_MAX_ATTEMPTS || "3", 10) || 3
);
const DEFAULT_ENVATO_MUSIC_DIR = String(
  process.env.DEFAULT_ENVATO_MUSIC_DIR ||
    path.join(process.env.HOME || "/root", "Documents", "scripts", "envato", "music")
).trim();
const MIN_BACKGROUND_MUSIC_BYTES = Math.max(
  262144,
  Number.parseInt(process.env.MIN_BACKGROUND_MUSIC_BYTES || "262144", 10) || 262144
);
const BACKGROUND_MUSIC_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);

const buildProfileContext = (profileValue) => {
  const profile = resolveOutputProfileConfig(profileValue);

  return {
    profile,
    outputWidth: Number(process.env.OUTPUT_WIDTH || profile.width || 1080),
    outputHeight: Number(process.env.OUTPUT_HEIGHT || profile.height || 1920),
    compositionId: String(process.env.RENDER_COMPOSITION_ID || profile.compositionId || "CodexShort"),
    targetSeconds: Number(process.env.TARGET_DURATION_SECONDS || profile.defaultTargetSeconds || 100)
  };
};

const listBackgroundMusicCandidates = async (musicDir) => {
  if (!musicDir || !existsSync(musicDir)) {
    return [];
  }

  const entries = await readdir(musicDir, {withFileTypes: true});
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.startsWith("track-")) {
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();

    if (!BACKGROUND_MUSIC_EXTENSIONS.has(extension)) {
      continue;
    }

    const absolutePath = path.join(musicDir, entry.name);

    try {
      const fileStats = await stat(absolutePath);

      if (fileStats.size < MIN_BACKGROUND_MUSIC_BYTES) {
        continue;
      }

      candidates.push({
        absolutePath,
        fileName: entry.name,
        size: fileStats.size
      });
    } catch {
      // Ignore unreadable files and keep scanning the remaining tracks.
    }
  }

  return candidates.sort((left, right) => left.fileName.localeCompare(right.fileName));
};

const chooseRandomBackgroundMusic = async () => {
  const candidates = await listBackgroundMusicCandidates(DEFAULT_ENVATO_MUSIC_DIR);

  if (!candidates.length) {
    return null;
  }

  return candidates[Math.floor(Math.random() * candidates.length)] || null;
};

const materializeBackgroundMusic = async ({slug, audioDir, sourcePath}) => {
  if (!sourcePath || !existsSync(sourcePath)) {
    return null;
  }

  const extension = path.extname(sourcePath).toLowerCase() || ".mp3";
  const targetFileName = `background-music${extension}`;
  const targetPath = path.join(audioDir, targetFileName);
  await copyFile(sourcePath, targetPath);

  return {
    sourcePath,
    targetPath,
    publicPath: path.posix.join("runs", slug, "audio", targetFileName)
  };
};

const graphicSceneSchema = z.object({
  title: z.string().min(2).max(48),
  overlay: z.string().min(2).max(52),
  sceneType: z.enum(["stock", "text-only"]),
  visualGoal: z.string().min(8).max(320),
  candidateQueries: z.array(z.string().min(3).max(140)).min(2).max(4)
});

const graphicPlanBaseSchema = z.object({
  styleNotes: z.string().min(8).max(480),
  scenes: z.array(graphicSceneSchema).min(1).max(MAX_SCENES)
});

const createGraphicPlanSchema = (sceneCount) =>
  graphicPlanBaseSchema.extend({
    scenes: z.array(graphicSceneSchema).length(sceneCount)
  });

const graphicPlanOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    styleNotes: {type: "string"},
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {type: "string"},
          overlay: {type: "string"},
          sceneType: {
            type: "string",
            enum: ["stock", "text-only"]
          },
          visualGoal: {type: "string"},
          candidateQueries: {
            type: "array",
            items: {type: "string"}
          }
        },
        required: ["title", "overlay", "sceneType", "visualGoal", "candidateQueries"]
      }
    }
  },
  required: ["styleNotes", "scenes"]
};

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--title") {
      parsed.title = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--slug") {
      parsed.slug = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--no-render") {
      parsed.noRender = true;
      continue;
    }

    if (item === "--preview-only") {
      parsed.previewOnly = true;
      continue;
    }

    if (item === "--storyboard-file") {
      parsed.storyboardFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--source-text-file") {
      parsed.sourceTextFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--target-seconds") {
      parsed.targetSeconds = Number(argv[index + 1]);
      index += 1;
    }

    if (item === "--output-profile") {
      parsed.outputProfile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--continue-run") {
      parsed.continueRun = true;
      continue;
    }
  }

  return parsed;
};

const TRUSTED_TIMED_WORD_SOURCES = new Set(["gcloud-speech-stt", "azure-word-boundary", "elevenlabs-alignment"]);

const normalizeTimedWordsSource = (source) => String(source || "").trim().toLowerCase();

const isTrustedTimedWordsSource = (source) => {
  const normalized = normalizeTimedWordsSource(source);
  return (
    TRUSTED_TIMED_WORD_SOURCES.has(normalized) ||
    [...TRUSTED_TIMED_WORD_SOURCES].some((base) => normalized === `${base}-rebuilt-from-audio`)
  );
};

const toRebuiltTimedWordsSource = (source) => {
  const normalized = normalizeTimedWordsSource(source);
  return TRUSTED_TIMED_WORD_SOURCES.has(normalized)
    ? `${normalized}-rebuilt-from-audio`
    : "estimated-rebuilt-from-audio";
};

const timedWordsLookPlausible = (timedWords) => {
  if (!Array.isArray(timedWords) || timedWords.length === 0) {
    return false;
  }

  let previousStart = -Infinity;
  let previousEnd = -Infinity;

  for (const word of timedWords) {
    const startSeconds = Number(word?.startSeconds);
    const endSeconds = Number(word?.endSeconds);

    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      return false;
    }

    if (startSeconds < 0 || endSeconds <= startSeconds) {
      return false;
    }

    if (startSeconds + 0.01 < previousStart || endSeconds + 0.01 < previousEnd) {
      return false;
    }

    previousStart = startSeconds;
    previousEnd = endSeconds;
  }

  return true;
};

const deriveTitleFromText = (input) => {
  const text = String(input || "").trim();

  if (!text) {
    return "";
  }

  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || text;

  return line
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
};

const PORTUGUESE_QUERY_HINTS = [
  "abertura",
  "saude",
  "tecnologia",
  "programacao",
  "inteligencia",
  "artificial",
  "futuro",
  "produtividade",
  "seguranca",
  "educacao",
  "medicina",
  "empresa",
  "empresas",
  "trabalho",
  "pessoas",
  "vida",
  "cidade",
  "cidades"
];

const normalizeQueryCandidate = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const sanitizeEnglishStockQuery = (value) =>
  normalizeQueryCandidate(value)
    .replace(/\b(vertical|portrait)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isLikelyEnglishStockQuery = (value) => {
  const normalized = sanitizeEnglishStockQuery(value);

  if (!normalized || normalized.split(" ").filter(Boolean).length < 2) {
    return false;
  }

  return /^[a-z0-9 -]+$/.test(normalized) && !PORTUGUESE_QUERY_HINTS.some((term) => normalized.includes(term));
};

const buildQueryVariants = (query) => {
  const base = normalizeText(query);
  const cleaned = base
    .replace(/\b(4k|hd|uhd|slow motion|cinematic)\b/gi, "")
    .replace(/\b(vertical|portrait)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = normalizeQueryCandidate(cleaned);
  const contextualFallbacks = [];
  const wordCount = normalized.split(" ").filter(Boolean).length;

  const baseVariants =
    wordCount <= 8
      ? [`${base} vertical`, `${cleaned} vertical`, cleaned, `${cleaned} portrait`]
      : [];

  if (/\b(face unlock|face recognition|facial recognition|desbloqueio facial|desbloqueio por rosto|rosto)\b/.test(normalized)) {
    contextualFallbacks.push(
      "person unlocking smartphone close up at home",
      "woman holding smartphone at home close up",
      "person using smartphone at home close up",
      "woman using smartphone close up",
      "person looking at smartphone close up",
      "close up holding smartphone"
    );
  }

  if (/\b(smartphone|phone|celular)\b/.test(normalized) && /\b(morning|bed|bedroom|waking up|manha|cama|quarto)\b/.test(normalized)) {
    contextualFallbacks.push(
      "woman using smartphone at home in morning",
      "person checking smartphone at home near window",
      "person using smartphone on sofa at home"
    );
  }

  if (/\b(streaming|smart tv|television|tv|serie|series|filme|filmes)\b/.test(normalized)) {
    contextualFallbacks.push(
      "people watching smart tv on couch",
      "couple watching tv at home living room",
      "woman watching tv on sofa"
    );
  }

  if (/\b(shopping|ecommerce|product|products|online store|purchase|loja online|oferta|ofertas|modelo|modelos|compra|compras|tenis)\b/.test(normalized)) {
    contextualFallbacks.push(
      "woman shopping online on laptop at home",
      "person browsing ecommerce website on laptop",
      "online shopping at home laptop close up"
    );
  }

  if (/\b(chatbot|support chat|customer support|customer service chat|chat|atendimento|suporte)\b/.test(normalized)) {
    contextualFallbacks.push(
      "person using laptop chat support at home",
      "woman chatting on laptop at desk",
      "customer support chat on laptop close up"
    );
  }

  if (/\b(photo|portrait mode|taking photo|smartphone camera|camera do celular|foto|retrato|selfie)\b/.test(normalized)) {
    contextualFallbacks.push(
      "woman taking photo with smartphone outdoors",
      "smartphone camera taking portrait photo",
      "person using phone camera outdoors"
    );
  }

  if (/\b(feed|social media|scrolling|short video|short videos|reels|tiktok|rede social|videos|posts)\b/.test(normalized)) {
    contextualFallbacks.push(
      "young woman scrolling social media on smartphone at home",
      "person watching short videos on phone close up",
      "smartphone social media scrolling close up"
    );
  }

  if (/\b(mapa|rota|transito|trafego|motorista|congestionamento)\b/.test(normalized)) {
    contextualFallbacks.push(
      "driver using smartphone gps navigation in traffic",
      "car dashboard phone navigation traffic route close up",
      "driver checking map app in city traffic"
    );
  }

  if (/\b(musica|playlist|faixa|faixas|ouvir|fones|headphones|onibus)\b/.test(normalized)) {
    contextualFallbacks.push(
      "person listening to music on smartphone with headphones",
      "music streaming app recommended songs on phone close up",
      "woman using smartphone music app headphones close up"
    );
  }

  if (/\b(teclado|digita|digitando|corrige|palavra|palavras|frase)\b/.test(normalized)) {
    contextualFallbacks.push(
      "close up typing on smartphone predictive text keyboard messaging app",
      "smartphone keyboard word suggestions texting close up",
      "person texting on phone close up keyboard"
    );
  }

  if (/\b(email|e mail|caixa de entrada|inbox|spam|promocoes|mensagens importantes)\b/.test(normalized)) {
    contextualFallbacks.push(
      "office worker reading organized email inbox on laptop at desk",
      "person checking email inbox on laptop close up",
      "email inbox on laptop office close up"
    );
  }

  if (/\b(banco|fraude|fraud|compra fora do padrao|compras fora do padrao)\b/.test(normalized)) {
    contextualFallbacks.push(
      "mobile banking fraud alert notification on smartphone",
      "person checking banking alert on phone close up",
      "smartphone bank security alert close up"
    );
  }

  if (/\b(carro por aplicativo|rideshare|uber|motorista disponivel|pedir um carro)\b/.test(normalized)) {
    contextualFallbacks.push(
      "woman ordering rideshare on smartphone city sidewalk",
      "rideshare app on phone pickup map screen",
      "person requesting car ride on smartphone"
    );
  }

  if (/\b(delivery|entrega de comida|entregador|entregadores|pedido|pedidos)\b/.test(normalized)) {
    contextualFallbacks.push(
      "delivery courier on scooter checking phone navigation",
      "food delivery rider using smartphone on street",
      "delivery driver checking app before pickup"
    );
  }

  if (/\b(dirigir|faixa|frenagem|sensor|alerta de faixa)\b/.test(normalized)) {
    contextualFallbacks.push(
      "driver assistance dashboard car lane alert",
      "person driving car with dashboard safety alert",
      "car dashboard warning while driving close up"
    );
  }

  if (/\b(voice assistant|smart speaker|smart home|smart lights)\b/.test(normalized)) {
    contextualFallbacks.push(
      "smart home voice assistant with lights switching on",
      "person using smart speaker at home living room",
      "woman controlling smart lights with smartphone"
    );
  }

  return uniqueStrings(
    [
      ...baseVariants,
      ...contextualFallbacks
    ].filter((value) => value && value.length >= 3)
  ).slice(0, 6);
};

const baseHeaders = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://localhost/codex-videos",
  "X-Title": "codex-videos-plan1"
});

const callOpenRouter = async ({apiKey, model, temperature, messages}) => {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: baseHeaders(apiKey),
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`OpenRouter falhou com status ${response.status}.`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  return Array.isArray(content)
    ? content
        .map((item) => item?.text ?? "")
        .join("\n")
        .trim()
    : String(content ?? "").trim();
};

const buildGraphicMessages = ({title, storyboard}) => {
  const targetSceneCount = Array.isArray(storyboard?.scenes) ? storyboard.scenes.length : MIN_SCENES;
  const requestedShape = JSON.stringify({
    styleNotes: "string",
    scenes: [
      {
        title: "string",
        overlay: "string",
        sceneType: "stock",
        visualGoal: "string",
        candidateQueries: ["string", "string", "string"]
      }
    ]
  });

  return [
    {
      role: "system",
      content:
        "You are the graphic agent for a short-form vertical video pipeline. Return valid JSON only. No markdown. If the video language is pt-BR, keep overlays in Brazilian Portuguese. Candidate queries must be in English and should work on stock-footage sites. Prefer concrete human scenes and phone usage over abstract concepts. Never ask for sci-fi CGI, impossible future labs, Mars rovers, abstract holograms, or shots that are unlikely to exist in normal stock footage."
    },
    {
      role: "user",
      content: [
        `Title: ${title}`,
        `Task: keep the same scene order and return exactly ${targetSceneCount} scenes.`,
        "For each scene, produce an asset plan with:",
        "- a short overlay in pt-BR",
        "- a visualGoal describing exactly what should be visible",
        REQUIRE_ENVATO_ALL_SCENES
          ? "- sceneType: always use stock"
          : "- sceneType: use stock by default; use text-only only if stock footage is very unlikely",
        "- 3 candidateQueries ordered from most specific to broader fallback",
        "Rules:",
        "1. Candidate queries must match the narration exactly.",
        "2. Candidate queries must be practical stock search terms in English.",
        "3. Candidate queries must use ASCII English only, with plain Latin letters, numbers, spaces, and hyphens.",
        "4. Never mix Portuguese, Chinese, emojis, or any non-Latin characters inside candidate queries.",
        "5. Every visualGoal must be a complete concrete shot description, never a fragment.",
        "6. If narration mentions paper, menu, sign, packaging, label, or translation, describe blank or unreadable layouts instead of readable text.",
        "7. Prefer portrait-friendly, concrete, human scenes that can realistically be found in stock footage for this exact topic.",
        "8. Avoid generic futuristic or abstract visuals.",
        "9. If a scene is conceptually hard, translate it into a present-day human proof point of the same idea.",
        "10. Prefer people using devices, engineers in factories, doctors with scans, solar panels, wind turbines, warehouses, offices, homes, transport and city footage.",
        "11. Overlays should be short and clear, 2 to 4 words when possible.",
        "11b. Every overlay must summarize the exact scene subject. Never use generic recycled labels like 'No trabalho', 'Na saúde', 'Rotina', 'Pessoas' or 'Novo normal' unless the narration is literally about that exact thing.",
        REQUIRE_ENVATO_ALL_SCENES
          ? "12. Never use text-only. Every scene must be solvable with stock video."
          : "12. Use text-only only as a last resort.",
        "13. styleNotes must be a concrete production note with at least 12 characters. Never leave styleNotes empty, generic, or one word only.",
        `14. The scenes array must contain exactly ${targetSceneCount} items. Do not omit or merge scenes.`,
        "Return this JSON shape:",
        requestedShape,
        "Storyboard JSON:",
        JSON.stringify(storyboard)
      ].join("\n")
    }
  ];
};

const fallbackGraphicPlan = (storyboard) => ({
  styleNotes: "Usar cenas humanas concretas, planos verticais e acoes claras com celular.",
  scenes: storyboard.scenes.map((scene) => ({
    title: scene.title,
    overlay: scene.overlay,
    sceneType: "stock",
    visualGoal: scene.narration,
    candidateQueries: buildQueryVariants(scene.searchQuery)
  }))
});

const canReuseGraphicPlan = (storyboard) => {
  return storyboard.scenes.every(
    (scene) =>
      Array.isArray(scene.candidateQueries) &&
      scene.candidateQueries.length >= 2 &&
      typeof scene.visualGoal === "string" &&
      scene.visualGoal.trim().length >= 8
  );
};

const requirePrimaryProviderSuccess = (provider) => provider === "gemini" || provider === "vertex";

const isRetryableLlmStageError = (error) => {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "timeout",
    "timed out",
    "aborted",
    "econnreset",
    "socket hang up",
    "network",
    "fetch failed",
    "connection",
    "temporarily unavailable",
    "rate limit",
    "429",
    "503",
    "502",
    "504"
  ].some((term) => message.includes(term));
};

const runLlmStageWithRetries = async ({stageLabel, task}) => {
  let lastError = null;

  for (let attempt = 1; attempt <= LLM_STAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= LLM_STAGE_MAX_ATTEMPTS || !isRetryableLlmStageError(lastError)) {
        throw lastError;
      }

      const backoffMs = 1500 * attempt;
      process.stdout.write(
        `[${stageLabel}] tentativa ${attempt}/${LLM_STAGE_MAX_ATTEMPTS} falhou (${lastError.message}). retry em ${Math.round(backoffMs / 1000)}s...\n`
      );
      await wait(backoffMs);
    }
  }

  throw lastError || new Error(`${stageLabel} falhou sem detalhes.`);
};

const generateGraphicPlanStrict = async ({title, storyboard, llmProvider, apiKey, model, cwd}) => {
  let lastError = null;
  const expectedSceneCount = Array.isArray(storyboard?.scenes) ? storyboard.scenes.length : MIN_SCENES;
  const graphicPlanSchema = createGraphicPlanSchema(expectedSceneCount);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retryInstruction =
      attempt === 0
        ? null
        : `Previous response was invalid. Fix the JSON, keep styleNotes as a concrete sentence with at least 12 characters, and return exactly ${expectedSceneCount} scenes in the same order as the storyboard. Validation error: ${lastError?.message || "unknown"}`;

    try {
      const graphicResponse = await callJsonProvider({
        provider: llmProvider,
        apiKey,
        model,
        messages: retryInstruction
          ? [
              ...buildGraphicMessages({title, storyboard}),
              {
                role: "user",
                content: retryInstruction
              }
            ]
          : buildGraphicMessages({title, storyboard}),
        schema: graphicPlanOutputSchema,
        cwd,
        usageContext: attempt === 0 ? "graphic-plan" : "graphic-plan-repair"
      });

      return graphicPlanSchema.parse(graphicResponse);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
};

const alignGraphicPlan = (storyboard, graphicPlan) => {
  return {
    styleNotes: normalizeText(graphicPlan?.styleNotes) || fallbackGraphicPlan(storyboard).styleNotes,
    scenes: storyboard.scenes.map((scene, index) => {
      const draft = graphicPlan?.scenes?.[index];
      const fallback = fallbackGraphicPlan(storyboard).scenes[index];
      const visualGoal = normalizeText(draft?.visualGoal) || fallback.visualGoal;
      const heuristicQueries = buildQueryVariants(visualGoal);
      const candidateQueries = uniqueStrings(
        [
          ...(Array.isArray(draft?.candidateQueries)
            ? draft.candidateQueries
                .map((value) => sanitizeEnglishStockQuery(value))
                .filter((value) => isLikelyEnglishStockQuery(value))
            : []),
          ...heuristicQueries,
          ...fallback.candidateQueries
        ]
      ).slice(0, 6);

      return {
        ...scene,
        overlay: pickSceneOverlay({
          overlay: draft?.overlay,
          title: scene.title,
          narration: scene.narration,
          fallbackOverlay: fallback.overlay
        }),
        sceneType: REQUIRE_ENVATO_ALL_SCENES ? "stock" : draft?.sceneType === "text-only" ? "text-only" : "stock",
        visualGoal,
        candidateQueries: candidateQueries.length > 0 ? candidateQueries : fallback.candidateQueries
      };
    })
  };
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "pipe",
    env: {...process.env, ...(options.env ?? {})}
  });

  if (result.status !== 0) {
    throw new Error(`${command} falhou: ${result.stderr || result.stdout || "sem detalhes"}`);
  }

  return result.stdout?.trim() ?? "";
};

const runLoggedCommand = async (command, args, options = {}) => {
  if (options.compactProgress) {
    const result = await runStreamingCommand(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: {...process.env, ...(options.env ?? {})},
      compactProgress: true
    });
    if (result.status !== 0) {
      throw new Error(`${command} falhou: ${result.stderr || result.stdout || "sem detalhes"}`);
    }
    return;
  }
  const result = await runLoggedCommandBase(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env
  });
  if (result.code !== 0) {
    throw new Error(`${command} falhou: ${result.stderr || result.stdout || "sem detalhes"}`);
  }
};

const isRemotionNetworkFetchError = (error) => {
  const message = String(error instanceof Error ? error.message : error || "");
  return (
    message.includes("ERR_NETWORK_CHANGED") ||
    (message.includes("Failed to fetch http://localhost:3000/proxy") && message.includes("/public/runs/")) ||
    (message.includes("Browser failed to load http://localhost:3000/proxy") && message.includes("/public/runs/"))
  );
};

const buildRemotionRenderArgs = ({compositionId, outPath, renderProps, concurrency, scale, videoBitrate, audioBitrate, x264Preset}) => [
  "remotion",
  "render",
  "src/index.ts",
  compositionId,
  outPath,
  `--props=${JSON.stringify(renderProps)}`,
  `--timeout=${REMOTION_TIMEOUT_MS}`,
  `--concurrency=${concurrency}`,
  `--scale=${scale}`,
  `--video-bitrate=${videoBitrate}`,
  `--audio-bitrate=${audioBitrate}`,
  `--x264-preset=${x264Preset}`
];

const renderWithRemotion = async ({compositionId, outPath, renderProps}) => {
  const attempts = [
    {
      label: "padrao",
      concurrency: REMOTION_CONCURRENCY,
      scale: REMOTION_SCALE,
      videoBitrate: REMOTION_VIDEO_BITRATE,
      audioBitrate: REMOTION_AUDIO_BITRATE,
      x264Preset: REMOTION_X264_PRESET
    }
  ];

  if (REMOTION_CONCURRENCY > 1) {
    attempts.push({
      label: "fallback",
      concurrency: 1,
      scale: REMOTION_SCALE,
      videoBitrate: REMOTION_VIDEO_BITRATE,
      audioBitrate: REMOTION_AUDIO_BITRATE,
      x264Preset: REMOTION_X264_PRESET
    });
  }

  let lastError = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];

    if (index > 0) {
      process.stdout.write(
        `[editor] Remotion retry ${index + 1}/${attempts.length} com concurrency=${attempt.concurrency} apos falha de fetch local.\n`
      );
    }

    try {
      await runLoggedCommand(
        "npx",
        buildRemotionRenderArgs({
          compositionId,
          outPath,
          renderProps,
          concurrency: attempt.concurrency,
          scale: attempt.scale,
          videoBitrate: attempt.videoBitrate,
          audioBitrate: attempt.audioBitrate,
          x264Preset: attempt.x264Preset
        }),
        {
          compactProgress: true,
          env: {
            CI: "1",
            NO_COLOR: "1",
            FORCE_COLOR: "0"
          }
        }
      );
      return;
    } catch (error) {
      lastError = error;

      if (!isRemotionNetworkFetchError(error) || index === attempts.length - 1) {
        throw error;
      }

      process.stdout.write(
        "[editor] Remotion perdeu um asset local durante o fetch. Vou reduzir a concorrencia e tentar de novo.\n"
      );
    }
  }

  if (lastError) {
    throw lastError;
  }
};

const fileExists = async (targetPath) => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const findOverrideAsset = async ({slug, sceneNumber}) => {
  const overridesDir = path.join(projectRoot, "assets", "envato", slug);

  if (!(await fileExists(overridesDir))) {
    return null;
  }

  const prefix = `scene-${String(sceneNumber).padStart(2, "0")}`;
  const entries = await readdir(overridesDir);
  const match = entries.find((entry) => entry.startsWith(prefix));

  return match ? path.join(overridesDir, match) : null;
};

const resolveFlux2IllustrationPath = async ({slug, sceneNumber, publicRunDir}) => {
  const imagesDir = path.join(projectRoot, "assets", "envato", slug, "_flux2_images");

  if (!(await fileExists(imagesDir))) {
    return null;
  }

  const prefix = `scene-${String(sceneNumber).padStart(2, "0")}-seg-`;
  const matches = (await readdir(imagesDir))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".png"))
    .sort();

  // Only promote single-shot scenes to still-image rendering.
  // Multi-segment scenes keep using the stitched MP4 so scene coverage is preserved.
  if (matches.length !== 1) {
    return null;
  }

  const sourcePath = path.join(imagesDir, matches[0]);
  const publicImagesDir = path.join(publicRunDir, "images");
  const outputName = `scene-${String(sceneNumber).padStart(2, "0")}.png`;
  const outputPath = path.join(publicImagesDir, outputName);

  await mkdir(publicImagesDir, {recursive: true});
  await copyFile(sourcePath, outputPath);

  return path.posix.join("runs", slug, "images", outputName);
};

const probePrimaryVideoStream = (sourcePath) => {
  const output = runCommand("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt,width,height,color_space,color_transfer,color_primaries",
    "-of",
    "json",
    sourcePath
  ]);

  const parsed = JSON.parse(output || "{}");
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;

  return {
    codecName: String(stream?.codec_name || "").trim().toLowerCase(),
    pixelFormat: String(stream?.pix_fmt || "").trim().toLowerCase(),
    width: Number(stream?.width || 0),
    height: Number(stream?.height || 0),
    colorSpace: String(stream?.color_space || "").trim().toLowerCase(),
    colorTransfer: String(stream?.color_transfer || "").trim().toLowerCase(),
    colorPrimaries: String(stream?.color_primaries || "").trim().toLowerCase()
  };
};

const materializeOverrideAsset = async ({sourcePath, outputPath, width, height}) => {
  const streamInfo = probePrimaryVideoStream(sourcePath);
  const baseFilter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=30`;
  const safeCpuPrefix = [
    "-y",
    "-fflags",
    "+genpts",
    "-analyzeduration",
    "200M",
    "-probesize",
    "200M",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map_metadata",
    "-1",
    "-an",
    "-sn",
    "-dn",
    "-ignore_unknown"
  ];
  const attempts = [
    [
      ...safeCpuPrefix,
      "-vf",
      `${baseFilter},format=yuv420p`,
      "-vsync",
      "cfr",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      "12",
      outputPath
    ],
    [
      ...safeCpuPrefix,
      "-vf",
      `colorspace=iall=bt709:all=bt709:fast=1,${baseFilter},format=yuv420p`,
      "-vsync",
      "cfr",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      "12",
      outputPath
    ],
    [
      ...safeCpuPrefix,
      "-vf",
      `${baseFilter},format=nv12`,
      "-vsync",
      "cfr",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      "12",
      outputPath
    ],
    [
      ...safeCpuPrefix,
      "-vf",
      `zscale=matrixin=bt709:matrix=bt709:transferin=bt709:transfer=bt709:primariesin=bt709:primaries=bt709,${baseFilter},format=yuv420p`,
      "-vsync",
      "cfr",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      "12",
      outputPath
    ]
  ];
  const isProres42210Bit = streamInfo.codecName === "prores" || streamInfo.pixelFormat === "yuv422p10le";

  if (!isProres42210Bit) {
    attempts.push([
      "-y",
      "-i",
      sourcePath,
      "-map",
      "0:v:0",
      "-map_metadata",
      "-1",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`,
      "-r",
      "30",
      "-c:v",
      "h264_videotoolbox",
      "-b:v",
      "6M",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-t",
      "12",
      outputPath
    ]);
  }
  const errors = [];

  for (const args of attempts) {
    try {
      runCommand("ffmpeg", args);
      return;
    } catch (error) {
      errors.push(error.message);
    }
  }

  throw new Error(errors.join("\n\n"));
};

const runLocalStockVideoAudit = ({videoPath}) => {
  if (String(process.env.ENABLE_LOCAL_STOCK_VIDEO_AUDIT || "true").trim().toLowerCase() === "false") {
    return {skipped: true, passed: true, reason: "disabled"};
  }

  const result = spawnSync("python3", [LOCAL_STOCK_VIDEO_AUDIT_SCRIPT, "--video", videoPath], {
    encoding: "utf8",
    stdio: "pipe"
  });

  const output = String(result.stdout || "").trim();
  const err = String(result.stderr || "").trim();

  if (result.status !== 0 && !output) {
    throw new Error(err || "auditoria local de stock falhou sem saida");
  }

  let parsed;
  try {
    parsed = JSON.parse(output || err);
  } catch {
    throw new Error(`auditoria local de stock devolveu JSON invalido: ${output || err}`);
  }

  if (typeof parsed?.passed !== "boolean") {
    throw new Error("auditoria local de stock nao devolveu campo passed");
  }

  return parsed;
};

const summarizeVisualAuditReasons = (audit) =>
  Array.isArray(audit?.reasons) && audit.reasons.length > 0
    ? audit.reasons.slice(0, 2).join("; ")
    : "auditoria visual local reprovou o clip";

const logAgent = (agent, message) => {
  process.stdout.write(`[${agent}] ${message}\n`);
};

const roundMetric = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

const summarizeStoryboardScene = (scene, index) => ({
  index: index + 1,
  title: normalizeText(scene?.title),
  overlay: normalizeText(scene?.overlay),
  narration: normalizeText(scene?.narration),
  searchQuery: normalizeText(scene?.searchQuery),
  sceneType: String(scene?.sceneType || "").trim() || null,
  candidateQueries: Array.isArray(scene?.candidateQueries)
    ? scene.candidateQueries.map((query) => normalizeText(query)).filter(Boolean)
    : []
});

const summarizeStoryboard = (storyboard) => {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];

  return {
    videoTitle: normalizeText(storyboard?.videoTitle),
    hook: normalizeText(storyboard?.hook),
    postCaption: normalizeText(storyboard?.postCaption),
    cta: normalizeText(storyboard?.cta),
    sceneCount: scenes.length,
    wordCount: scenes
      .map((scene) => scene?.narration || "")
      .join(" ")
      .split(/\s+/)
      .filter(Boolean).length,
    scenes: scenes.map((scene, index) => summarizeStoryboardScene(scene, index))
  };
};

const summarizeStoryboardQa = (storyboardQa) => ({
  passed: Boolean(storyboardQa?.passed),
  profile: String(storyboardQa?.profile || "").trim() || null,
  issues: Array.isArray(storyboardQa?.issues) ? storyboardQa.issues : [],
  warnings: Array.isArray(storyboardQa?.warnings) ? storyboardQa.warnings : [],
  issueObjects: Array.isArray(storyboardQa?.issueObjects) ? storyboardQa.issueObjects : [],
  warningObjects: Array.isArray(storyboardQa?.warningObjects) ? storyboardQa.warningObjects : [],
  issueCount: Array.isArray(storyboardQa?.issues) ? storyboardQa.issues.length : 0,
  warningCount: Array.isArray(storyboardQa?.warnings) ? storyboardQa.warnings.length : 0,
  metrics: storyboardQa?.metrics ?? null
});

const buildStoryboardPreviewMetadata = ({
  title,
  language,
  desiredDurationSeconds,
  initialStoryboard,
  finalStoryboard,
  initialQa,
  finalQa,
  repairHistory
}) => ({
  schemaVersion: 1,
  title,
  language,
  desiredDurationSeconds,
  initialStoryboard: summarizeStoryboard(initialStoryboard),
  finalStoryboard: summarizeStoryboard(finalStoryboard),
  initialQa: summarizeStoryboardQa(initialQa),
  finalQa: summarizeStoryboardQa(finalQa),
  repair: {
    maxAttempts: STORYBOARD_PREVIEW_QA_REPAIR_MAX_ATTEMPTS,
    attemptCount: Array.isArray(repairHistory) ? repairHistory.length : 0,
    repaired: Array.isArray(repairHistory) && repairHistory.length > 0,
    attempts: Array.isArray(repairHistory) ? repairHistory : []
  }
});

const buildQaSummary = (validation, qaPass, outPath) => ({
  passed: qaPass,
  outputPath: outPath,
  checks: validation.checks,
  metrics: validation.metrics
});

const applyValidationSummary = (report, validation, qaPass, outPath) => {
  report.status = qaPass ? "completed" : "failed";
  report.finalVideo = outPath;
  report.sceneCount = Number(validation.checks?.sceneCount || 0);
  report.durationSec = roundMetric(validation.metrics?.videoSeconds);
  report.audioDurationSec = roundMetric(validation.metrics?.audioSeconds);
  report.qa = buildQaSummary(validation, qaPass, outPath);
};

const printQaSummary = (validation, qaPass, outPath) => {
  process.stdout.write(
    `[qa] resumo: status=${qaPass ? "ok" : "fail"} scenes=${validation.checks.sceneCount} ` +
    `audio=${roundMetric(validation.metrics.audioSeconds, 2)}s ` +
    `video=${roundMetric(validation.metrics.videoSeconds, 2)}s ` +
    `envatoOnly=${validation.checks.envatoOnly} ` +
    `linkedNarration=${validation.checks.linkedNarration} ` +
    `sync=${validation.checks.audioVideoSyncOk} ` +
    `output=${outPath}\n`
  );
};

const extractQaFrames = async ({slug, outPath, seconds}) => {
  const qaDir = path.join(projectRoot, "runs", slug, "qa");
  await mkdir(qaDir, {recursive: true});
  const framePaths = [];

  for (let index = 0; index < seconds.length; index += 1) {
    const outputPath = path.join(qaDir, `frame-${String(index + 1).padStart(2, "0")}.png`);
    runCommand("ffmpeg", ["-y", "-ss", String(seconds[index]), "-i", outPath, "-frames:v", "1", outputPath]);
    framePaths.push(outputPath);
  }

  return framePaths;
};

const THUMBNAIL_WIDTH = 1080;
const THUMBNAIL_HEIGHT = 1920;
const THUMBNAIL_FONT_CANDIDATES = [
  "DejaVu Sans:style=Bold",
  "DejaVu Sans",
  "Liberation Sans:style=Bold",
  "Arial:style=Bold"
];
const DEFAULT_THUMBNAIL_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

const escapeFfmpegFilterPath = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

const resolveThumbnailFontFile = () => {
  for (const candidate of THUMBNAIL_FONT_CANDIDATES) {
    const result = spawnSync("fc-match", ["-f", "%{file}\n", candidate], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe"
    });

    if (result.status !== 0) {
      continue;
    }

    const fontFile = String(result.stdout || "")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (fontFile) {
      return fontFile;
    }
  }

  return DEFAULT_THUMBNAIL_FONT;
};

const wrapThumbnailText = (value, {maxCharsPerLine = 20, maxLines = 4} = {}) => {
  const words = normalizeText(value)
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (words.length === 0) {
    return "";
  }

  const lines = [];
  let currentLine = "";

  const pushCurrentLine = () => {
    if (currentLine) {
      lines.push(currentLine);
      currentLine = "";
    }
  };

  for (const word of words) {
    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (candidate.length <= maxCharsPerLine || !currentLine) {
      currentLine = candidate;
      continue;
    }

    pushCurrentLine();

    if (lines.length >= maxLines) {
      break;
    }

    currentLine = word;

    if (currentLine.length > maxCharsPerLine) {
      const chunks = currentLine.match(new RegExp(`.{1,${Math.max(8, maxCharsPerLine)}}`, "g")) || [currentLine];
      currentLine = chunks.shift() || "";
      lines.push(...chunks);
      currentLine = currentLine.slice(0, maxCharsPerLine).trim();
    }
  }

  pushCurrentLine();

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/…?$/, "").slice(0, Math.max(1, maxCharsPerLine - 1)).trimEnd()}…`;
  }

  return lines.join("\n").trim();
};

const createThumbnailPoster = async ({
  slug,
  runDir,
  publicRunDir,
  sourceFramePath,
  title,
  hook,
  channelHandle = "@foiumaideia"
}) => {
  const thumbnailDir = path.join(runDir, ".thumbnail-work");
  const runThumbnailPath = path.join(runDir, "thumbnail.png");
  const publicThumbnailPath = path.join(publicRunDir, "thumbnail.png");
  const metadataPath = path.join(runDir, "thumbnail.json");
  const publicMetadataPath = path.join(publicRunDir, "thumbnail.json");
  const headlineFile = path.join(thumbnailDir, "headline.txt");
  const sublineFile = path.join(thumbnailDir, "subline.txt");
  const badgeFile = path.join(thumbnailDir, "badge.txt");
  const fontFile = resolveThumbnailFontFile();
  const headline = wrapThumbnailText(hook || title, {maxCharsPerLine: 18, maxLines: 4}).toUpperCase();
  const subline = wrapThumbnailText(title || "", {maxCharsPerLine: 22, maxLines: 2});
  const badge = wrapThumbnailText(channelHandle || "@foiumaideia", {maxCharsPerLine: 16, maxLines: 1}).toUpperCase();

  await mkdir(thumbnailDir, {recursive: true});
  await mkdir(publicRunDir, {recursive: true});
  await writeFile(headlineFile, headline || "");
  await writeFile(sublineFile, subline || "");
  await writeFile(badgeFile, badge || "");

  if (!sourceFramePath || !existsSync(sourceFramePath)) {
    throw new Error(`Nao consegui localizar o frame-base da thumbnail para ${slug}.`);
  }

  const filter = [
    `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`,
    "format=yuv420p",
    "drawbox=x=0:y=0:w=iw:h=220:color=black@0.42:t=fill",
    "drawbox=x=0:y=ih-540:w=iw:h=540:color=black@0.52:t=fill",
    "drawbox=x=0:y=0:w=24:h=ih:color=0x22c55e@0.95:t=fill",
    `drawtext=fontfile='${escapeFfmpegFilterPath(fontFile)}':textfile='${escapeFfmpegFilterPath(badgeFile)}':expansion=none:fontcolor=0x22c55e:fontsize=34:line_spacing=0:x=56:y=56:shadowcolor=black@0.85:shadowx=3:shadowy=3:fix_bounds=1`,
    `drawtext=fontfile='${escapeFfmpegFilterPath(fontFile)}':textfile='${escapeFfmpegFilterPath(headlineFile)}':expansion=none:fontcolor=white:fontsize=78:line_spacing=10:x=56:y=128:shadowcolor=black@0.92:shadowx=4:shadowy=4:fix_bounds=1`,
    `drawtext=fontfile='${escapeFfmpegFilterPath(fontFile)}':textfile='${escapeFfmpegFilterPath(sublineFile)}':expansion=none:fontcolor=white:fontsize=44:line_spacing=8:x=56:y=h-430:shadowcolor=black@0.92:shadowx=3:shadowy=3:fix_bounds=1`
  ].join(",");

  try {
    runCommand("ffmpeg", [
      "-y",
      "-i",
      sourceFramePath,
      "-vf",
      filter,
      "-frames:v",
      "1",
      runThumbnailPath
    ]);
  } catch (error) {
    await copyFile(sourceFramePath, runThumbnailPath);
    process.stderr.write(
      `Aviso: thumbnail com overlay falhou (${error.message}); usando frame simples como fallback.\n`
    );
  }

  await copyFile(runThumbnailPath, publicThumbnailPath);
  const metadata = {
    slug,
    createdAt: new Date().toISOString(),
    sourceFramePath: path.relative(projectRoot, sourceFramePath),
    thumbnailPath: path.relative(projectRoot, runThumbnailPath),
    publicThumbnailPath: path.relative(projectRoot, publicThumbnailPath),
    title,
    hook,
    badge
  };

  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  await writeFile(publicMetadataPath, JSON.stringify(metadata, null, 2));
  await rm(thumbnailDir, {recursive: true, force: true});

  return {
    ...metadata,
    thumbnailPath: runThumbnailPath,
    publicThumbnailPath
  };
};

const makeAgentReport = () => ({
  startedAt: new Date().toISOString(),
  status: "running",
  finalVideo: null,
  sceneCount: 0,
  durationSec: 0,
  audioDurationSec: 0,
  qa: null,
  thumbnail: null,
  llmUsage: null,
  agents: {
    sysadmin: {status: "pending", notes: []},
    dev: {status: "pending", notes: []},
    roteirista: {status: "pending", notes: []},
    grafico: {status: "pending", notes: []},
    editor: {status: "pending", notes: []},
    qa: {status: "pending", notes: []}
  }
});

const appendAgentNote = (report, agent, note) => {
  report.agents[agent].notes.push(note);
};

const readJsonIfExistsOrNull = async (targetPath) => {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const buildCombinedGeminiUsage = ({storyboardUsage, assetUsage}) => {
  const hasStoryboardUsage = Number(storyboardUsage?.requestCount || 0) > 0;
  const hasAssetUsage = Number(assetUsage?.requestCount || 0) > 0;

  if (!hasStoryboardUsage && !hasAssetUsage) {
    return null;
  }

  return {
    pricingSource: storyboardUsage?.pricingSource || assetUsage?.pricingSource || null,
    pricingSnapshotDate: storyboardUsage?.pricingSnapshotDate || assetUsage?.pricingSnapshotDate || null,
    storyboard: hasStoryboardUsage ? storyboardUsage : null,
    assetPipeline: hasAssetUsage ? assetUsage : null,
    estimatedTotalCostUsd: Number(
      (
        Number(storyboardUsage?.estimatedCostUsd || 0) +
        Number(assetUsage?.estimatedCostUsd || 0)
      ).toFixed(8)
    )
  };
};

const ensureVoiceEnding = (text) => {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    return "";
  }

  if (/[.!?…]$/.test(trimmed)) {
    return trimmed;
  }

  return `${trimmed}.`;
};

const buildVoiceText = (scenes) => {
  let text = "";
  const sceneSpans = [];

  scenes.forEach((scene, index) => {
    const narration = ensureVoiceEnding(normalizePortugueseForTts(scene.narration));

    if (!narration) {
      sceneSpans.push({
        sceneIndex: index,
        startChar: text.length,
        endChar: text.length - 1
      });
      return;
    }

    if (text.length > 0) {
      text += " ";
    }

    const startChar = text.length;
    text += narration;
    const endChar = text.length - 1;

    sceneSpans.push({
      sceneIndex: index,
      startChar,
      endChar
    });
  });

  return {
    text,
    sceneSpans
  };
};

const formatRushedSceneSummary = (scene) =>
  `cena ${scene.sceneIndex + 1} (${scene.timedWordCount} palavras em ${scene.durationSeconds}s, ${scene.wordsPerSecond} palavras/s)`;

const readJsonIfExists = async (targetPath) => {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
};

const getMtimeMsIfExists = async (targetPath) => {
  try {
    const details = await stat(targetPath);
    return Number(details.mtimeMs);
  } catch {
    return null;
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  loadSecretsIntoEnv(["OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_API_KEY", "AZURE_SPEECH_KEY", "ZAI_API_KEY"]);
  const sourceTextPath = args.sourceTextFile ? path.resolve(projectRoot, args.sourceTextFile) : "";
  const sourceText = sourceTextPath ? await readFile(sourceTextPath, "utf8") : "";

  if (!args.title && !sourceText) {
    throw new Error('Usa: npm run make:plan1 -- --title "o teu titulo aqui"');
  }

  const title = String(args.title || deriveTitleFromText(sourceText) || "").trim();

  if (!title) {
    throw new Error("Nao consegui derivar um titulo valido a partir da entrada fornecida.");
  }
  const llmProvider = resolveLlmProvider(process.env.LLM_PROVIDER || process.env.STORY_PROVIDER || "codex");
  const ttsProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
  const llmModel =
    llmProvider === "openrouter"
      ? process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001"
      : llmProvider === "vertex"
        ? process.env.STORY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash"
        : process.env.CODEX_MODEL || "";
  const profileContext = buildProfileContext(args.outputProfile || process.env.OUTPUT_PROFILE || "vertical-short");
  const requestedTargetSeconds = Number.isFinite(args.targetSeconds)
    ? args.targetSeconds
    : profileContext.targetSeconds;
  const targetSeconds =
    Number.isFinite(requestedTargetSeconds) && requestedTargetSeconds > 0
      ? requestedTargetSeconds
      : profileContext.profile.defaultTargetSeconds;
  const slug = args.slug || `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const runsDir = path.join(projectRoot, "runs", slug);
  const publicRunDir = path.join(projectRoot, "public", "runs", slug);
  const audioDir = path.join(publicRunDir, "audio");
  const videoDir = path.join(publicRunDir, "video");
  const outPath = path.join(projectRoot, "out", `${slug}.mp4`);
  const previousReportPath = path.join(runsDir, "agent-report.json");
  const previousReport = args.continueRun ? await readJsonIfExists(previousReportPath) : null;
  const previousAssetPlanPath = path.join(runsDir, "asset-plan.json");
  const previousAssetPlan = args.continueRun ? await readJsonIfExists(previousAssetPlanPath) : null;
  const report = makeAgentReport();
  resetGeminiUsageSummary();
  const usedAssetsRegistry = await readUsedAssetsRegistry();
  report.title = title;
  report.slug = slug;
  report.targetSeconds = targetSeconds;
  report.outputProfile = profileContext.profile.id;
  report.outputDimensions = {
    width: profileContext.outputWidth,
    height: profileContext.outputHeight,
    compositionId: profileContext.compositionId
  };

  await mkdir(runsDir, {recursive: true});
  await mkdir(audioDir, {recursive: true});
  await mkdir(videoDir, {recursive: true});

  logAgent("sysadmin", "a validar configuracao base do projeto");
  report.agents.sysadmin.status = "completed";
  appendAgentNote(report, "sysadmin", "Diretorios locais preparados.");

  logAgent("dev", `a preparar a execucao do Plano 1 para "${title}"`);
  report.agents.dev.status = "completed";
  report.agents.dev.config = {
    slug,
    targetSeconds,
    language: process.env.VIDEO_LANGUAGE || "pt-BR",
    provider: llmProvider,
    model: llmModel || "default",
    hasSourceText: Boolean(sourceText.trim()),
    scriptGuidance: process.env.VIDEO_SCRIPT_GUIDANCE || ""
  };
  appendAgentNote(report, "dev", "Diretorio de run, audio e video preparado.");

  logAgent("roteirista", "a gerar storyboard base e encadear as cenas");
  let storyboard;
  const videoLanguage = process.env.VIDEO_LANGUAGE || "pt-BR";

  if (args.storyboardFile) {
    const storyboardPath = path.resolve(projectRoot, args.storyboardFile);
    storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
    appendAgentNote(report, "roteirista", `Storyboard reaproveitado de ${storyboardPath}.`);
  } else {
    try {
      storyboard = await runLlmStageWithRetries({
        stageLabel: "roteirista",
        task: async () => generateStoryboard({
          title,
          language: videoLanguage,
          model: llmModel,
          apiKey: process.env.OPENROUTER_API_KEY || "",
          desiredDurationSeconds: targetSeconds,
          provider: llmProvider,
          cwd: projectRoot,
          sourceText,
          scriptGuidance: process.env.VIDEO_SCRIPT_GUIDANCE || "",
          imageStyleHint: process.env.IMAGE_STYLE_PRESET || ""
        })
      });
    } catch (error) {
      if (requirePrimaryProviderSuccess(llmProvider)) {
        throw new Error(`Gemini falhou ao gerar o storyboard: ${error.message}`);
      }

      throw error;
    }
  }

  let linkedStoryboard = {
    ...storyboard,
    scenes: storyboard.scenes
  };
  logAgent("roteirista", "a validar storyboard final antes das imagens");
  let storyboardQa = evaluateStoryboardQa({
    storyboard: linkedStoryboard,
    title,
    language: videoLanguage,
    desiredDurationSeconds: targetSeconds,
    scriptGuidance: process.env.VIDEO_SCRIPT_GUIDANCE || ""
  });
  const initialStoryboard = linkedStoryboard;
  const initialStoryboardQa = storyboardQa;
  const storyboardPreviewRepairHistory = [];

  for (
    let repairAttempt = 0;
    !storyboardQa.passed && repairAttempt < STORYBOARD_PREVIEW_QA_REPAIR_MAX_ATTEMPTS;
    repairAttempt += 1
  ) {
    const attemptLabel = `${repairAttempt + 1}/${STORYBOARD_PREVIEW_QA_REPAIR_MAX_ATTEMPTS}`;
    const beforeRepairStoryboard = linkedStoryboard;
    const beforeRepairQa = storyboardQa;
    process.stderr.write(
      `[roteirista] QA pre-visual falhou; a reescrever storyboard com base no feedback (${attemptLabel})\n`
    );
    appendAgentNote(
      report,
      "roteirista",
      `QA pre-visual falhou; repair automatico ${attemptLabel}: ${beforeRepairQa.issues.join(" | ")}`
    );

    linkedStoryboard = await runLlmStageWithRetries({
      stageLabel: "roteirista",
      task: async () =>
        repairStoryboard({
          title,
          language: videoLanguage,
          model: llmModel,
          apiKey: process.env.OPENROUTER_API_KEY || "",
          desiredDurationSeconds: targetSeconds,
          provider: llmProvider,
          cwd: projectRoot,
          storyboard: linkedStoryboard,
          sourceText,
          scriptGuidance: process.env.VIDEO_SCRIPT_GUIDANCE || "",
          issues: beforeRepairQa.issues,
          warnings: beforeRepairQa.warnings
        })
    });

    const repairedStoryboardQa = evaluateStoryboardQa({
      storyboard: linkedStoryboard,
      title,
      language: videoLanguage,
      desiredDurationSeconds: targetSeconds,
      scriptGuidance: process.env.VIDEO_SCRIPT_GUIDANCE || ""
    });
    storyboardPreviewRepairHistory.push({
      attempt: repairAttempt + 1,
      status: repairedStoryboardQa.passed ? "repaired" : "still_failing",
      requestedIssues: beforeRepairQa.issues,
      requestedWarnings: beforeRepairQa.warnings,
      before: {
        storyboard: summarizeStoryboard(beforeRepairStoryboard),
        qa: summarizeStoryboardQa(beforeRepairQa)
      },
      after: {
        storyboard: summarizeStoryboard(linkedStoryboard),
        qa: summarizeStoryboardQa(repairedStoryboardQa)
      }
    });
    storyboardQa = repairedStoryboardQa;
  }

  const storyboardPreviewMetadata = buildStoryboardPreviewMetadata({
    title,
    language: videoLanguage,
    desiredDurationSeconds: targetSeconds,
    initialStoryboard,
    finalStoryboard: linkedStoryboard,
    initialQa: initialStoryboardQa,
    finalQa: storyboardQa,
    repairHistory: storyboardPreviewRepairHistory
  });
  await writeFile(
    path.join(runsDir, "storyboard-qa.json"),
    JSON.stringify(
      {
        ...storyboardQa,
        previewMetadata: storyboardPreviewMetadata
      },
      null,
      2
    )
  );

  report.agents.roteirista.sceneCount = linkedStoryboard.scenes.length;
  report.agents.roteirista.wordCount = linkedStoryboard.scenes
    .map((scene) => scene.narration)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  report.agents.roteirista.storyboardQa = storyboardQa;
  report.agents.roteirista.storyboardPreviewMetadata = storyboardPreviewMetadata;
  appendAgentNote(
    report,
    "roteirista",
    `QA pre-visual: perfil=${storyboardQa.profile} score=${storyboardQa.metrics?.viralScore ?? "n/a"} palavras=${storyboardQa.metrics?.wordCount ?? 0}/${storyboardQa.metrics?.minWords ?? 0}-${storyboardQa.metrics?.maxWords ?? 0}.`
  );

  if (Array.isArray(storyboardQa.warnings) && storyboardQa.warnings.length > 0) {
    appendAgentNote(report, "roteirista", `QA pre-visual avisos: ${storyboardQa.warnings.join(" | ")}`);
  }

  if (!storyboardQa.passed) {
    report.agents.roteirista.status = "failed";
    appendAgentNote(report, "roteirista", `QA pre-visual reprovou o storyboard: ${storyboardQa.issues.join(" | ")}`);
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    throw new Error(`Storyboard reprovado pela QA pre-visual: ${storyboardQa.issues.join(" | ")}`);
  }

  report.agents.roteirista.status = "completed";
  appendAgentNote(report, "roteirista", "Storyboard validado e cenas conectadas para voz unica.");

  logAgent("grafico", "a criar o plano visual com queries alternativas para stock");
  let graphicPlan;

  if (args.storyboardFile && canReuseGraphicPlan(linkedStoryboard)) {
    graphicPlan = {
      styleNotes: normalizeText(linkedStoryboard.styleNotes) || fallbackGraphicPlan(linkedStoryboard).styleNotes,
      scenes: linkedStoryboard.scenes.map((scene) => ({
        title: scene.title,
        overlay: scene.overlay,
        sceneType: REQUIRE_ENVATO_ALL_SCENES ? "stock" : scene.sceneType === "text-only" ? "text-only" : "stock",
        visualGoal: scene.visualGoal,
        candidateQueries: scene.candidateQueries
      }))
    };
    appendAgentNote(report, "grafico", "Plano visual reaproveitado do storyboard existente.");
  } else if (["codex", "openrouter", "gemini", "zai", "vertex"].includes(llmProvider) || process.env.OPENROUTER_API_KEY) {
    try {
      graphicPlan = await runLlmStageWithRetries({
        stageLabel: "grafico",
        task: async () => generateGraphicPlanStrict({
          title,
          storyboard: linkedStoryboard,
          llmProvider,
          apiKey: process.env.OPENROUTER_API_KEY || "",
          model: llmModel,
          cwd: projectRoot
        })
      });
    } catch (error) {
      if (requirePrimaryProviderSuccess(llmProvider)) {
        throw new Error(`Gemini falhou ao gerar o plano visual: ${error.message}`);
      }

      throw error;
    }
  } else {
    graphicPlan = fallbackGraphicPlan(linkedStoryboard);
    appendAgentNote(report, "grafico", "Sem provider estruturado disponivel; queries graficas geradas por heuristica.");
  }

  const aligned = alignGraphicPlan(linkedStoryboard, graphicPlan);
  const enrichedStoryboard = {
    ...linkedStoryboard,
    styleNotes: aligned.styleNotes,
    scenes: aligned.scenes
  };

  report.agents.grafico.status = "completed";
  report.agents.grafico.styleNotes = enrichedStoryboard.styleNotes;
  report.agents.grafico.stockScenes = enrichedStoryboard.scenes.filter((scene) => scene.sceneType === "stock").length;
  report.agents.grafico.textOnlyScenes = enrichedStoryboard.scenes.filter((scene) => scene.sceneType === "text-only").length;
  appendAgentNote(report, "grafico", "Cada cena recebeu queries especificas do provider principal.");

  await writeFile(path.join(runsDir, "storyboard.json"), JSON.stringify(enrichedStoryboard, null, 2));
  const storyboardGeminiUsage = getGeminiUsageSummary();
  await writeFile(path.join(runsDir, "gemini-usage.json"), JSON.stringify(storyboardGeminiUsage, null, 2));
  const assetGeminiUsage = await readJsonIfExistsOrNull(path.join(projectRoot, "assets", "envato", slug, "gemini-usage.json"));
  report.llmUsage = buildCombinedGeminiUsage({
    storyboardUsage: storyboardGeminiUsage,
    assetUsage: assetGeminiUsage
  });

  if (args.previewOnly) {
    report.agents.editor.status = "skipped";
    report.agents.qa.status = "skipped";
    appendAgentNote(report, "editor", "Preview-only: audio, assets e render ignorados.");
    appendAgentNote(report, "qa", "Preview-only: validacao ignorada.");
    report.status = "preview";
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`Preview pronto: ${path.join(projectRoot, "runs", slug)}\n`);
    return;
  }

  logAgent("editor", "a gerar voz e a procurar clips por cena");
  const voicePlan = buildVoiceText(enrichedStoryboard.scenes);
  const aiffPath = path.join(audioDir, "voiceover.aiff");
  const mp3Path = path.join(audioDir, "voiceover.mp3");
  const voiceoverPath = path.join(runsDir, "voiceover.json");
  const existingVoiceover = args.continueRun ? await readJsonIfExists(voiceoverPath) : null;
  let voiceResult;

  if (
    args.continueRun &&
    existsSync(mp3Path) &&
    existingVoiceover &&
    String(existingVoiceover.text || "").trim() === voicePlan.text.trim()
  ) {
    const rebuiltTimedWordsResult = await extractTimedWordsFromAudio({
      mp3Path,
      text: voicePlan.text,
      languageCode: process.env.VIDEO_LANGUAGE || "pt-BR",
      sceneSpans: voicePlan.sceneSpans,
      allowEstimated: false
    });

    if (
      !isTrustedTimedWordsSource(rebuiltTimedWordsResult.timedWordsSource) ||
      !timedWordsLookPlausible(rebuiltTimedWordsResult.timedWords)
    ) {
      throw new Error(
        `Resume bloqueado: nao consegui reextrair timedWords reais do audio existente para a run ${slug}.`
      );
    }

    process.stderr.write(
      `Resume: voiceover.mp3 existente reutilizado e timedWords reextraidos via ${rebuiltTimedWordsResult.timedWordsSource}.\n`
    );
    appendAgentNote(report, "editor", `Resume: voiceover existente reutilizado e timedWords reextraidos via ${rebuiltTimedWordsResult.timedWordsSource}.`);

    voiceResult = {
      provider: existingVoiceover.provider || "reused-audio",
      usageMetadata: existingVoiceover.usageMetadata ?? null,
      modelVersion: existingVoiceover.modelVersion ?? null,
      voiceName: existingVoiceover.voiceName ?? null,
      timedWords: rebuiltTimedWordsResult.timedWords,
      timedWordsSource: rebuiltTimedWordsResult.timedWordsSource || "reextracted-audio"
    };
  } else {
    voiceResult = await synthesizeVoiceover({
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      voice: process.env.MACOS_VOICE || "Luciana",
      rate: process.env.TTS_RATE || 175,
      aiffPath,
      mp3Path,
      provider: ttsProvider,
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
      google: {
        model: process.env.GOOGLE_TTS_MODEL || "gemini-2.5-flash-preview-tts",
        voiceName: process.env.TTS_VOICE || process.env.GOOGLE_TTS_VOICE || "pt-BR-Chirp3-HD-Achernar",
        languageCode: process.env.VIDEO_LANGUAGE || "pt-BR",
        stylePrompt: process.env.GOOGLE_TTS_STYLE_PROMPT || "com voz masculina natural, segura e calorosa"
      },
      azure: {
        apiKey: process.env.AZURE_SPEECH_KEY || "",
        region: process.env.AZURE_SPEECH_REGION || "",
        endpoint: process.env.AZURE_SPEECH_ENDPOINT || "",
        voiceName: process.env.AZURE_TTS_VOICE || "pt-BR-AntonioNeural",
        languageCode: process.env.VIDEO_LANGUAGE || "pt-BR"
      }
    });
  }

  if (REQUIRE_PREMIUM_TTS && voiceResult.provider === "macos-say") {
    throw new Error("A run foi bloqueada porque o TTS caiu para macOS local em vez de provider premium.");
  }
  const audioDurationSeconds = getAudioDurationSeconds(mp3Path);
  let alignedTimedWords = Array.isArray(voiceResult.timedWords) ? voiceResult.timedWords : [];
  if (alignedTimedWords.length === 0) {
    if (args.continueRun) {
      throw new Error("Resume bloqueado: nao consegui extrair timedWords reais para a narração.");
    }

    alignedTimedWords = buildEstimatedTimedWords({
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      audioDurationSeconds,
      mp3Path
    });
  }
  const normalizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords: alignedTimedWords,
    audioDurationSeconds
  });
  alignedTimedWords = normalizedTimedWords.timedWords;
  if (
    normalizedTimedWords.metadata.scaled ||
    normalizedTimedWords.metadata.clampedCount > 0 ||
    normalizedTimedWords.metadata.droppedCount > 0
  ) {
    process.stderr.write(
      `Aviso: timedWords ajustados para caber no audio real ` +
      `(max ${normalizedTimedWords.metadata.originalMaxEndSeconds}s -> ${normalizedTimedWords.metadata.finalMaxEndSeconds}s).\n`
    );
  }
  let resolvedTimedWordsSource =
    voiceResult.timedWordsSource ?? (alignedTimedWords.length > 0 ? "estimated" : "none");
  let sceneSpeechPacing = analyzeSceneSpeechPacing({
    scenes: enrichedStoryboard.scenes,
    timedWords: alignedTimedWords,
    audioDurationSeconds,
    sceneSpans: voicePlan.sceneSpans
  });

  if (sceneSpeechPacing.rushedScenes.length > 0 && existsSync(mp3Path)) {
    const rebuiltTimedWords = buildEstimatedTimedWords({
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      audioDurationSeconds,
      mp3Path
    });
    const rebuiltSceneSpeechPacing = analyzeSceneSpeechPacing({
      scenes: enrichedStoryboard.scenes,
      timedWords: rebuiltTimedWords,
      audioDurationSeconds,
      sceneSpans: voicePlan.sceneSpans
    });
    const rebuiltImprovesPacing =
      rebuiltTimedWords.length > 0 &&
      (
        rebuiltSceneSpeechPacing.rushedScenes.length < sceneSpeechPacing.rushedScenes.length ||
        (
          rebuiltSceneSpeechPacing.rushedScenes.length === sceneSpeechPacing.rushedScenes.length &&
          (rebuiltSceneSpeechPacing.maxWordsPerSecond || Number.POSITIVE_INFINITY) <
            (sceneSpeechPacing.maxWordsPerSecond || Number.POSITIVE_INFINITY)
        )
      );

    if (rebuiltImprovesPacing) {
      alignedTimedWords = rebuiltTimedWords;
      sceneSpeechPacing = rebuiltSceneSpeechPacing;
      resolvedTimedWordsSource = toRebuiltTimedWordsSource(resolvedTimedWordsSource || voiceResult.timedWordsSource);
      process.stderr.write(
        `Aviso: timedWords existentes geraram pacing incoerente; reconstruindo alinhamento a partir do audio (${sceneSpeechPacing.rushedScenes.length} cenas apressadas restantes).\n`
      );
      appendAgentNote(
        report,
        "editor",
        "TimedWords reconstruidos a partir do audio para corrigir pacing incoerente."
      );
    }
  }

  const voiceoverPayload = {
    provider: voiceResult.provider,
    usageMetadata: voiceResult.usageMetadata ?? null,
    modelVersion: voiceResult.modelVersion ?? null,
    voiceName: voiceResult.voiceName ?? null,
    timedWordsSource: resolvedTimedWordsSource,
    text: voicePlan.text,
    sceneSpans: voicePlan.sceneSpans,
    timedWords: alignedTimedWords,
    sceneTimingAnalysis: sceneSpeechPacing
  };

  if (alignedTimedWords.length === 0) {
    report.agents.editor.status = "failed";
    report.agents.editor.voiceProvider = voiceResult.provider;
    report.agents.editor.audioDurationSeconds = audioDurationSeconds;
    appendAgentNote(report, "editor", "Run bloqueada: nao consegui extrair timedWords para a narração.");
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "voiceover.json"), JSON.stringify(voiceoverPayload, null, 2));
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    throw new Error(`Nao consegui extrair timestamps palavra-a-palavra para a run ${slug}.`);
  }

  if (sceneSpeechPacing.rushedScenes.length > 0) {
    report.agents.editor.status = "failed";
    report.agents.editor.voiceProvider = voiceResult.provider;
    report.agents.editor.audioDurationSeconds = audioDurationSeconds;
    appendAgentNote(
      report,
      "editor",
      `Run bloqueada: pacing incoerente detectado no TTS (${sceneSpeechPacing.rushedScenes
        .slice(0, 3)
        .map(formatRushedSceneSummary)
        .join("; ")}).`
    );
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "voiceover.json"), JSON.stringify(voiceoverPayload, null, 2));
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    throw new Error(
      `TTS gerou pacing incoerente na run ${slug}: ${sceneSpeechPacing.rushedScenes
        .slice(0, 3)
        .map(formatRushedSceneSummary)
        .join("; ")}.`
    );
  }

  const stockScenes = [];
  let visuallyRejectedClipCount = 0;
  for (let index = 0; index < enrichedStoryboard.scenes.length; index += 1) {
    const scene = enrichedStoryboard.scenes[index];
    const fileName = `scene-${String(index + 1).padStart(2, "0")}.mp4`;
    const outputPath = path.join(videoDir, fileName);
    let asset = null;
    let queryUsed = null;
    let failureReason = null;
    let visualAudit = null;
    let resolvedSceneType = scene.sceneType;
    let illustration = null;
    const overrideSource = await findOverrideAsset({
      slug,
      sceneNumber: index + 1
    });
    const existingClipMtime = args.continueRun ? await getMtimeMsIfExists(outputPath) : null;
    const overrideSourceMtime = overrideSource ? await getMtimeMsIfExists(overrideSource) : null;
    const previousAssetRecord =
      Array.isArray(previousAssetPlan) && previousAssetPlan[index] && typeof previousAssetPlan[index] === "object"
        ? previousAssetPlan[index]
        : null;
    const previousClipWasVerified =
      Boolean(previousAssetRecord?.clipPath) &&
      previousAssetRecord?.attribution?.source === "envato-local" &&
      (
        previousAssetRecord?.visualAudit?.passed === true ||
        String(previousAssetRecord?.queryUsed || "").trim().toLowerCase() !== "resume-existing"
      );
    const canReuseExistingClip =
      Number.isFinite(existingClipMtime) &&
      previousClipWasVerified &&
      (!Number.isFinite(overrideSourceMtime) || existingClipMtime >= overrideSourceMtime);

    if (args.continueRun && canReuseExistingClip) {
      visualAudit = runLocalStockVideoAudit({videoPath: outputPath});

      if (visualAudit.passed) {
        asset = {
          attribution: {
            source: "envato-local",
            path: outputPath
          }
        };
        queryUsed = "resume-existing";
      } else {
        visuallyRejectedClipCount += 1;
        failureReason = `Clip existente reprovado pela auditoria visual: ${summarizeVisualAuditReasons(visualAudit)}.`;
      }
    }

    if (!asset && overrideSource) {
      await materializeOverrideAsset({
        sourcePath: overrideSource,
        outputPath,
        width: profileContext.outputWidth,
        height: profileContext.outputHeight
      });
      visualAudit = runLocalStockVideoAudit({videoPath: outputPath});

      if (visualAudit.passed) {
        asset = {
          attribution: {
            source: "envato-local",
            path: overrideSource
          }
        };
        queryUsed = "envato-local";
      } else {
        visuallyRejectedClipCount += 1;
        failureReason = `Clip local reprovado pela auditoria visual: ${summarizeVisualAuditReasons(visualAudit)}.`;
        await rm(outputPath, {force: true});
      }
    }

    if (!asset && scene.sceneType === "stock") {
      failureReason = failureReason || "Nem Envato nem assets locais entregaram um clip utilizavel.";
      if (!REQUIRE_ENVATO_ALL_SCENES && ALLOW_TEXT_ONLY_FALLBACK) {
        resolvedSceneType = "text-only";
      }
    }

    if (asset?.attribution?.source === "envato-local") {
      illustration = await resolveFlux2IllustrationPath({
        slug,
        sceneNumber: index + 1,
        publicRunDir
      });
    }

    stockScenes.push({
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      title: scene.title,
      narration: scene.narration,
      overlay: scene.overlay,
      searchQuery: scene.searchQuery,
      visualGoal: scene.visualGoal,
      candidateQueries: scene.candidateQueries,
      sceneType: resolvedSceneType,
      illustration,
      clipPath: asset ? path.posix.join("runs", slug, "video", fileName) : null,
      attribution:
        asset?.attribution ??
        (resolvedSceneType === "text-only"
          ? {
              source: "text-only-fallback"
            }
          : null),
      visualAudit,
      queryUsed,
      failureReason
    });
  }

  const missingClipScenes = stockScenes.filter((scene) => !scene.clipPath);
  if (visuallyRejectedClipCount > 0) {
    appendAgentNote(
      report,
      "editor",
      `Auditoria visual local reprovou ${visuallyRejectedClipCount} clip(s) antes do render final.`
    );
  }
  await writeFile(path.join(runsDir, "asset-plan.json"), JSON.stringify(stockScenes, null, 2));

  if (missingClipScenes.length > 0 && (REQUIRE_ENVATO_ALL_SCENES || !ALLOW_TEXT_ONLY_FALLBACK)) {
    report.agents.editor.status = "failed";
    report.agents.editor.voiceProvider = voiceResult.provider;
    report.agents.editor.audioDurationSeconds = audioDurationSeconds;
    report.agents.editor.clipCoverage = Number(
      (stockScenes.filter((scene) => Boolean(scene.clipPath)).length / Math.max(1, stockScenes.length)).toFixed(2)
    );
    report.agents.editor.envatoSceneCount = stockScenes.filter((scene) => scene.attribution?.source === "envato-local").length;
    report.agents.editor.pexelsSceneCount = 0;
    report.agents.editor.textFallbackSceneCount = stockScenes.filter((scene) => scene.sceneType === "text-only").length;
    appendAgentNote(
      report,
      "editor",
      `Run bloqueada: ${missingClipScenes.length} cenas sem clip do Envato.`
    );
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    throw new Error(`Envato nao entregou clips para ${missingClipScenes.length} cenas da run ${slug}.`);
  }

  const timeline = buildTimeline({
    scenes: stockScenes,
    audioDurationSeconds,
    fps: 30,
    timedWords: alignedTimedWords,
    sceneSpans: voicePlan.sceneSpans
  });
  const backgroundMusicDisabled = String(process.env.DISABLE_BACKGROUND_MUSIC || "")
    .trim()
    .toLowerCase() === "true";
  const requestedMusicPath = String(process.env.DEFAULT_MUSIC_FILE || "").trim();
  let musicPath = null;

  if (!backgroundMusicDisabled) {
    let selectedMusicSource = requestedMusicPath || null;

    if (selectedMusicSource && !existsSync(selectedMusicSource)) {
      appendAgentNote(
        report,
        "editor",
        `Trilha explicita nao encontrada em ${selectedMusicSource}; a escolher uma track-* aleatoria.`
      );
      selectedMusicSource = null;
    }

    if (!selectedMusicSource) {
      const randomTrack = await chooseRandomBackgroundMusic();

      if (randomTrack) {
        selectedMusicSource = randomTrack.absolutePath;
        appendAgentNote(
          report,
          "editor",
          `Trilha aleatoria selecionada: ${randomTrack.fileName}.`
        );
      } else {
        appendAgentNote(
          report,
          "editor",
          `Nenhuma track-* valida encontrada em ${DEFAULT_ENVATO_MUSIC_DIR}; a seguir sem musica de fundo.`
        );
      }
    }

    if (selectedMusicSource) {
      const materializedMusic = await materializeBackgroundMusic({
        slug,
        audioDir,
        sourcePath: selectedMusicSource
      });

      if (materializedMusic?.publicPath) {
        musicPath = materializedMusic.publicPath;
      }
    }
  }

  const renderProps = {
    title: enrichedStoryboard.videoTitle,
    hook: enrichedStoryboard.hook,
    cta: enrichedStoryboard.cta,
    channelHandle: process.env.CHANNEL_HANDLE || "@teucanal",
    outputProfile: profileContext.profile.id,
    compositionId: profileContext.compositionId,
    videoWidth: profileContext.outputWidth,
    videoHeight: profileContext.outputHeight,
    durationInFrames: timeline.durationInFrames,
    narrationPath: path.posix.join("runs", slug, "audio", "voiceover.mp3"),
    musicPath: musicPath || null,
    scenes: timeline.scenes,
    captions: timeline.captions
  };

  await writeFile(
    path.join(runsDir, "voiceover.json"),
    JSON.stringify(voiceoverPayload, null, 2)
  );
  await writeUsedAssetsRegistry(
    mergeUsedAssetsRegistry(usedAssetsRegistry, {
      envatoItemUrls: [],
      pexelsVideoUrls: []
    })
  );
  await writeFile(path.join(runsDir, "render-props.json"), JSON.stringify(renderProps, null, 2));
  await writeFile(
    path.join(runsDir, "post.txt"),
    `${enrichedStoryboard.postCaption}\n\n${enrichedStoryboard.hashtags.join(" ")}\n`
  );

  report.agents.editor.status = "completed";
  report.agents.editor.voiceProvider = voiceResult.provider;
  report.agents.editor.audioDurationSeconds = audioDurationSeconds;
  report.agents.editor.clipCoverage = Number(
    (stockScenes.filter((scene) => Boolean(scene.clipPath)).length / Math.max(1, stockScenes.length)).toFixed(2)
  );
  report.agents.editor.envatoSceneCount = stockScenes.filter((scene) => scene.attribution?.source === "envato-local").length;
  report.agents.editor.pexelsSceneCount = 0;
  report.agents.editor.textFallbackSceneCount = stockScenes.filter((scene) => scene.sceneType === "text-only").length;
  appendAgentNote(report, "editor", `Clips encontrados para ${stockScenes.filter((scene) => Boolean(scene.clipPath)).length} de ${stockScenes.length} cenas.`);

  const renderDependencyMtimes = await Promise.all([
    getMtimeMsIfExists(path.join(runsDir, "render-props.json")),
    getMtimeMsIfExists(path.join(runsDir, "voiceover.json")),
    getMtimeMsIfExists(path.join(runsDir, "asset-plan.json")),
    getMtimeMsIfExists(path.join(runsDir, "storyboard.json"))
  ]);
  const latestRenderInputMtime = renderDependencyMtimes
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  const existingRenderMtime = await getMtimeMsIfExists(outPath);
  const shouldReuseRenderedVideo =
    args.continueRun &&
    previousReport?.status === "completed" &&
    Number.isFinite(existingRenderMtime) &&
    existingRenderMtime >= latestRenderInputMtime;

  if (!args.noRender && !shouldReuseRenderedVideo) {
    logAgent("editor", "a renderizar no Remotion");
    await mkdir(path.dirname(outPath), {recursive: true});
    await renderWithRemotion({
      compositionId: profileContext.compositionId,
      outPath,
      renderProps
    });
  }

  if (shouldReuseRenderedVideo) {
    appendAgentNote(report, "editor", "Resume: video final existente reutilizado para a QA.");
  }

  if (args.noRender) {
    report.agents.qa.status = "skipped";
    appendAgentNote(report, "qa", "Render e validacao foram ignorados por --no-render.");
    report.status = "skipped";
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));
    process.stdout.write(`Preview pronto: ${path.join(projectRoot, "runs", slug)}\n`);
    return;
  }

  logAgent("qa", "a validar o render, extrair frames e fechar o relatorio");
  const validation = JSON.parse(
    runCommand("node", [
      path.join(projectRoot, "scripts", "validate-run.mjs"),
      "--slug",
      slug,
      "--target-seconds",
      String(targetSeconds)
    ])
  );
  const qaFramePaths = await extractQaFrames({
    slug,
    outPath,
    seconds: [
      Math.max(0.5, validation.metrics.videoSeconds * 0.18).toFixed(2),
      Math.max(1.0, validation.metrics.videoSeconds * 0.5).toFixed(2),
      Math.max(1.5, validation.metrics.videoSeconds * 0.82).toFixed(2)
    ]
  });
  let thumbnailAsset = null;

  try {
    thumbnailAsset = await createThumbnailPoster({
      slug,
      runDir: runsDir,
      publicRunDir,
      sourceFramePath: qaFramePaths[0],
      title: enrichedStoryboard.videoTitle || title,
      hook: enrichedStoryboard.hook || title,
      channelHandle: process.env.CHANNEL_HANDLE || "@foiumaideia"
    });
    report.thumbnail = {
      ...thumbnailAsset,
      sourceFramePath: thumbnailAsset.sourceFramePath,
      thumbnailPath: path.relative(projectRoot, thumbnailAsset.thumbnailPath),
      publicThumbnailPath: path.relative(projectRoot, thumbnailAsset.publicThumbnailPath)
    };
    report.agents.qa.thumbnail = report.thumbnail;
    appendAgentNote(report, "qa", `Thumbnail criada em ${thumbnailAsset.publicThumbnailPath}.`);
  } catch (error) {
    appendAgentNote(report, "qa", `Thumbnail nao criada: ${error.message}`);
    process.stderr.write(`Aviso: thumbnail nao foi criada (${error.message}).\n`);
  }

  const clipCoverage = stockScenes.filter((scene) => Boolean(scene.clipPath)).length / Math.max(1, stockScenes.length);
  const qaPass =
    validation.checks.outputExists &&
    validation.checks.sceneCountOk &&
    validation.checks.captionsHaveCoverage &&
    validation.checks.captionTimelineMonotonic &&
    validation.checks.captionWordBoundsOk &&
    validation.checks.visualAuditOk &&
    validation.checks.karaokeReady &&
    validation.checks.wordTimedCaptions &&
    validation.checks.alignmentAvailable &&
    validation.checks.timedWordsSourceTrusted &&
    validation.checks.sceneTimelineMonotonic &&
    validation.checks.sceneStartWordSyncOk &&
    validation.checks.sceneSpeechPacingOk &&
    validation.checks.captionsBoundedToSingleScene &&
    validation.checks.transitionsOk &&
    validation.checks.linkedNarration &&
    validation.checks.audioVideoSyncOk &&
    validation.checks.sttAudioSyncOk &&
    validation.checks.sceneResolutionOk &&
    validation.checks.envatoOnly &&
    validation.checks.noTextFallback &&
    validation.checks.clipCoverageOk &&
    validation.checks.voiceProviderOk;

  report.agents.qa.status = qaPass ? "completed" : "failed";
  report.agents.qa.validation = validation;
  report.agents.qa.clipCoverage = Number(clipCoverage.toFixed(2));
  report.agents.qa.sampleFrames = qaFramePaths;
  appendAgentNote(report, "qa", qaPass ? "Validacao E2E passou." : "Validacao E2E falhou.");
  applyValidationSummary(report, validation, qaPass, outPath);
  report.completedAt = new Date().toISOString();

  await writeFile(path.join(runsDir, "agent-report.json"), JSON.stringify(report, null, 2));

  if (!qaPass) {
    throw new Error(`QA reprovou a run ${slug}. Vê runs/${slug}/agent-report.json`);
  }

  printQaSummary(validation, qaPass, outPath);
  process.stdout.write(`Video pronto: ${outPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`Erro: ${error.message}\n`);
  process.exit(1);
});
