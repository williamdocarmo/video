import http from "node:http";
import {spawn, spawnSync} from "node:child_process";
import {createReadStream, existsSync, readFileSync, readdirSync} from "node:fs";
import {copyFile, mkdir, readFile, readdir, stat, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  DEFAULT_OUTPUT_PROFILE,
  getDurationOptionsForProfile,
  listOutputProfileOptions,
  resolveOutputProfileConfig
} from "../config/output-profiles.mjs";
import {DEFAULT_VISUAL_STYLE_PRESET, VISUAL_STYLE_PRESETS} from "../config/visual-style-presets.mjs";
import {analyzeSceneSpeechPacing, buildTimeline} from "../video-engine/scripts/lib/timings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "web", "public");
const dataDir = path.join(projectRoot, ".web-ui");
const inputsDir = path.join(dataDir, "inputs");
const videoLibraryDir = path.join(dataDir, "videos");
const tiktokDraftsDir = path.join(dataDir, "tiktok-drafts");
const jobsFile = path.join(dataDir, "jobs.json");
const videosFile = path.join(dataDir, "videos.json");
const rootEnvPath = path.join(projectRoot, ".env");
const defaultVideoEngineRoot = path.join(projectRoot, "video-engine");
const defaultPostarRoot = path.resolve(projectRoot, "..", "..", "postar");
const DEFAULT_PORT = Number(process.env.WEB_PORT || 3210);
const DEFAULT_HOST = process.env.WEB_HOST || "127.0.0.1";
const RESUME_RENDER_FPS = 30;
const MAX_LOG_LINES = 500;
const MAX_BODY_BYTES = 1_500_000;
const DEFAULT_AGENDADOR_SITE_URL = "https://agendador.online";
let AGENDADOR_API_BASE = `${DEFAULT_AGENDADOR_SITE_URL}/api`;
const AGENDADOR_DEFAULT_PLATFORMS = ["FB", "IG", "YT"];
const AGENDADOR_MAX_UPLOAD_MB = 24;
const HAS_SECURITY_CLI = spawnSync("sh", ["-lc", "command -v security >/dev/null 2>&1"], {stdio: "ignore"}).status === 0;
const stylePreviewDir = path.join(publicDir, "style-previews");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8"
};

const normalizeAgendadorSiteUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return DEFAULT_AGENDADOR_SITE_URL;
  }

  return raw.endsWith("/api") ? raw.slice(0, -4) : raw;
};

const normalizeAgendadorApiBase = (value) => {
  const siteUrl = normalizeAgendadorSiteUrl(value);
  return siteUrl.endsWith("/api") ? siteUrl : `${siteUrl}/api`;
};

const FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE =
  "Write like a sharp Brazilian short-form creator reacting to a bad tech idea that gives people false confidence. The tone should feel human, sarcastic, slightly exaggerated, and very internet-native, like a smart friend warning you before you do something dumb. Use casual spoken Brazilian Portuguese when the video is in pt-BR. Prefer lines that sound like real reactions, such as 'isso da ruim', 'nao cai nessa', 'eu ja vi gente fazer isso', or 'essa ideia nao foi uma boa ideia', whenever they fit naturally. Start with a hard statement, warning, accusation, or shocking reveal. Build momentum through consequence, embarrassment, cost, and fail energy. Keep the script punchy, specific, and visually concrete. Keep each scene focused on one clear beat, but let the full script carry real progression instead of feeling like generic educational filler. Use ALL CAPS selectively for 2 to 5 of the hardest-hitting words across the hook and narration. Let the ending land as a memorable sting that makes the bad idea feel obviously stupid in hindsight. Do not add audio directions, editing directions, or narration outside the script itself.";

const tonePresets = {
  natural_clean: {
    label: "Natural limpo",
    description: "Explicativo direto, visual e humano, sem conectores artificiais.",
    scriptGuidance:
      "Keep the current practical explainer structure, but remove filler connector openings. Do not start scenes with phrases like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'. Keep it direct, human, visual, and native to short-form video. Do not include CTA in the narration or ending.",
    voiceStyles: {
      "pt-BR": "com narracao natural, clara, segura e direta",
      "en-US": "with a natural, clear, direct narration"
    }
  },
  shortform_native: {
    label: "Short-form nativo",
    description: "Hook rapido, payoff cedo e ritmo nativo de TikTok/Reels/Shorts.",
    scriptGuidance: FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE,
    voiceStyles: {
      "pt-BR": "com ritmo curto, visual e nativo de redes sociais",
      "en-US": "with a native short-form social rhythm"
    }
  },
  wellness_comfort: {
    label: "Wellness • Calmo reconfortante",
    description: "Acolhe, valida e alivia sem parecer coaching vazio.",
    scriptGuidance:
      "Write a wellness script in a calm, human and comforting tone. Start from a real emotional state, validate it gently, reduce pressure, and end with relief or acceptance. Use short, spoken lines, no CTA, no guru language, no hype, no artificial connectors.",
    voiceStyles: {
      "pt-BR": "com voz calma, acolhedora, serena e reconfortante",
      "en-US": "with a calm, gentle and comforting voice"
    }
  },
  wellness_end_of_day: {
    label: "Wellness • Soltar o peso do dia",
    description: "Fecho de dia, cansaco, descanso e permissao para desacelerar.",
    scriptGuidance:
      "Write a wellness script for the end of the day. Speak to tiredness, mental overload, and the need to release pressure. Make it feel like permission to stop, rest and soften. Avoid spiritual grandiosity, productivity language, CTA, and generic inspiration. End with rest.",
    voiceStyles: {
      "pt-BR": "com voz baixa, serena e acolhedora",
      "en-US": "with a soft, low and soothing voice"
    }
  }
};

const DEFAULT_VOICE = "Iapetus";
const DEFAULT_ENGLISH_VOICE = "Charon";
const DEFAULT_IMAGE_MODEL = "imagen-4.0-fast-generate-001";

const voiceOptions = [
  {
    label: "Iapetus • Clear / claro",
    value: "Iapetus",
    badge: "Melhor para pt-BR geral",
    description: "Voz Gemini-TTS do Google com timbre claro e limpo, boa para narracao geral.",
    languages: ["pt-BR", "en-US"]
  },
  {
    label: "Charon • Informative / informativo",
    value: "Charon",
    badge: "Melhor para en-US",
    description: "Voz Gemini-TTS do Google com tom mais informativo e seguro, boa para explicacao e ingles.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Kore • Firm / firme",
    value: "Kore",
    badge: "Melhor para tom firme",
    description: "Voz Gemini-TTS do Google com entrega firme e assertiva, boa para hooks e tom deciso.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Puck • Upbeat / energetico",
    value: "Puck",
    badge: "Melhor para shorts",
    description: "Voz Gemini-TTS do Google com energia mais alta e ritmo mais animado para shorts.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Sulafat • Warm / caloroso",
    value: "Sulafat",
    badge: "Melhor para tom acolhedor",
    description: "Voz Gemini-TTS do Google com timbre mais quente e acolhedor.",
    languages: ["pt-BR", "en-US"]
  }
];

const imageModelOptions = [
  {
    value: "imagen-4.0-fast-generate-001",
    label: "Imagen 4 Fast",
    provider: "Google",
    badge: "Novo padrão",
    description: "Mais barato do grupo Imagen e, nos teus testes, o melhor para pessoas e anatomia neste tipo de cena.",
    costLabel: "US$ 0,02 / imagem",
    costDetail: "Melhor opção para volume e produção diária."
  },
  {
    value: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "Google",
    badge: "Mais rápido",
    description: "Modelo atual do app. Bom para volume e iteração, mas menos confiável em anatomia humana complexa.",
    costLabel: "~US$ 0,039 / imagem",
    costDetail: "Referência para 1024x1024 no Vertex."
  },
  {
    value: "imagen-4.0-generate-001",
    label: "Imagen 4",
    provider: "Google",
    badge: "Mais consistente",
    description: "Melhor equilíbrio para produção. Mais estável para pessoas, mãos e composição do que o Flash Image.",
    costLabel: "US$ 0,04 / imagem",
    costDetail: "Melhor custo-benefício para renders finais."
  },
  {
    value: "imagen-4.0-ultra-generate-001",
    label: "Imagen 4 Ultra",
    provider: "Google",
    badge: "Maior qualidade",
    description: "Melhor opção do grupo para cenas críticas com pessoas, mãos e fidelidade visual.",
    costLabel: "US$ 0,06 / imagem",
    costDetail: "Use para cenas difíceis e quando anatomia importa mais."
  }
];

const imageStylePreviewFiles = {
  claude: "video-estilo-claude.jpeg",
  kiro: "video-estilo-kiro.jpeg",
  editorial_clean: "editorial-clean.jpeg",
  realistic_film: "realistic-film.jpeg",
  cartoon_3d: "cartoon-3d.jpeg",
  urban_sketching: "urban-sketching.jpeg",
  ink: "ink.jpeg",
  editorial_line_green: "editorial-line-green.jpeg",
  time_split_bold: "time-split-bold.jpeg",
  punk: "punk-poster.jpeg"
};

const imageStyleOptions = Object.values(VISUAL_STYLE_PRESETS).map((preset) => {
  const previewFile = imageStylePreviewFiles[preset.id] || `${preset.id}.jpeg`;
  const previewLinkPath = `/${previewFile}`;

  return {
    label: preset.label,
    value: preset.id,
    description: preset.description,
    previewFile,
    previewImagePath: path.join(stylePreviewDir, previewFile),
    previewLinkPath
  };
});
const channelOptions = [
  {
    label: "@foiumaideia",
    value: "foiumaideia",
    handle: "@foiumaideia",
    folder: "foiumaideia",
    description: "Curiosidade, explicação clara e impacto prático."
  },
  {
    label: "@quiet2min",
    value: "quiet2min",
    handle: "@quiet2min",
    folder: "quiet2min",
    description: "Reflexões calmas, autocuidado e clareza interior em poucos minutos."
  },
  {
    label: "@ate2min",
    value: "ate2min",
    handle: "@ate2min",
    folder: "ate2min",
    description: "Mensagens breves, tranquilas e inspiradoras para desacelerar."
  }
];

const channelPublishProfiles = {
  foiumaideia: {
    identifierKeys: [
      "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
      "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME",
      "FOIUMAIDEIA_USER",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"],
    publicUrlKeys: ["FOIUMAIDEIA_URL"]
  },
  quiet2min: {
    identifierKeys: [
      "AGENDADOR_ONLINE_QUIET2MIN_EMAIL",
      "AGENDADOR_ONLINE_QUIET2MIN_USERNAME",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"]
  },
  ate2min: {
    identifierKeys: [
      "AGENDADOR_ONLINE_ATE2MIN_EMAIL",
      "AGENDADOR_ONLINE_ATE2MIN_USERNAME",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"]
  }
};

const channelPresets = {
  foiumaideia: {
    tone: "shortform_native",
    voice: DEFAULT_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "editorial_line_green",
    outputProfile: "vertical-short",
    targetSeconds: 60,
    customStylePromptByLanguage: {
      "pt-BR": "com ritmo curto, visual e nativo de redes sociais, com voz firme, curiosa, ritmada e muito nativa de internet, sem soar teatral",
      "en-US": "with a native short-form social rhythm, a firm, curious, internet-native voice, and punchy delivery without sounding theatrical"
    },
    scriptGuidance: FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE
  },
  quiet2min: {
    language: "en-US",
    tone: "wellness_comfort",
    voice: DEFAULT_ENGLISH_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz calma, acolhedora, serena e ritmo suave",
      "en-US": "with a calm, soothing, warm voice and a gentle, reassuring pace"
    },
    scriptGuidance:
      "Write calm, reflective and soothing short scripts focused on personal growth, emotional clarity, inner peace and gentle self-help. The tone should feel peaceful, grounded, reassuring and visually concrete, like a quiet reset for the day."
  },
  ate2min: {
    language: "pt-BR",
    tone: "wellness_end_of_day",
    voice: DEFAULT_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz calorosa, tranquila, humana e inspiradora",
      "en-US": "with a warm, calm, human and inspiring voice"
    },
    scriptGuidance:
      "Write brief reflective stories with a calm, human and inspiring tone. Prioritize emotional clarity, practical wisdom, soft transitions and a memorable ending that fits within two minutes."
  }
};

const PREVIEW_QUEUE_LANE = "preview";
const HEAVY_QUEUE_LANE = "heavy";
const jobs = new Map();
const streams = new Map();
const jobProcesses = new Map();
const previewQueue = [];
const heavyQueue = [];
let activePreviewJobId = null;
let activeHeavyJobId = null;
let persistTimer = null;
const ARTIFACT_FRESHNESS_TOLERANCE_MS = 1500;

const parseEnvFile = async (envPath) => {
  if (!existsSync(envPath)) {
    return {};
  }

  const content = await readFile(envPath, "utf8");
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key) {
      result[key] = value;
    }
  }

  return result;
};

const resolvePathFrom = (baseDir, value, fallback = "") => {
  const raw = String(value || fallback || "").trim();

  if (!raw) {
    return "";
  }

  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

const slugify = (input) =>
  String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

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

const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const readJsonFile = async (targetPath) => {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
};

const writeJsonFile = async (targetPath, payload) => {
  await writeFile(targetPath, JSON.stringify(payload, null, 2));
};

const fileExists = async (targetPath) => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const createFileUrl = (targetPath) => {
  const absolutePath = path.resolve(String(targetPath || ""));
  return `/api/file?path=${encodeURIComponent(absolutePath)}`;
};

const readTextFile = async (targetPath) => {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return "";
  }
};

const safeUnlink = async (targetPath) => {
  try {
    await unlink(targetPath);
  } catch {}
};

const toVideoId = (filePath) => Buffer.from(String(filePath || ""), "utf8").toString("base64url");

const fromVideoId = (value) => {
  try {
    return Buffer.from(String(value || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
};

const getDatePrefixFromSlug = (slug) => {
  const match = String(slug || "").match(/^(\d{4}-\d{2}-\d{2})-/);
  return match?.[1] || new Date().toISOString().slice(0, 10);
};

const resolveLocalizedExportPath = async ({exportDir, slug, fallbackTitle, storyboardPath}) => {
  const storyboard = storyboardPath ? await readJsonFile(storyboardPath) : null;
  const localizedTitle = String(storyboard?.videoTitle || fallbackTitle || slug).trim();
  const localizedSlug = slugify(localizedTitle);
  const basename = localizedSlug ? `${getDatePrefixFromSlug(slug)}-${localizedSlug}` : slug;
  return path.join(exportDir, `${basename}.mp4`);
};

const roundSeconds = (value) => Math.round(Number(value || 0) * 1000) / 1000;

const countWords = (text) =>
  String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const getTargetWordRange = (targetSeconds = 100, language = "pt-BR") => {
  const normalizedLanguage = String(language || "pt-BR").trim().toLowerCase();
  const targetWordsPerSecond = normalizedLanguage.startsWith("pt")
    ? 2.9
    : 2.75;
  const center = Math.max(24, Math.round(Number(targetSeconds || 100) * targetWordsPerSecond));
  const minWords = Math.max(20, Math.round(center * 0.92));
  const maxWords = Math.max(minWords + 8, Math.round(center * 1.06));
  return {minWords, maxWords};
};

const PREVIEW_CTA_RE =
  /\b(compartilhe|partilha|salve|guarde|comente|comenta|curta|deixe seu like|deixa o like|segue|siga|follow|envie para|manda para|marque|marca alguem|marca alguém|fique ligado|fica ligado)\b/i;

const getPreviewStoryboardIssues = ({storyboard, targetSeconds, language, outputProfile}) => {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  const sceneCount = scenes.length;
  const wordCount = scenes.reduce((total, scene) => total + countWords(scene?.narration), 0);
  const profile = resolveOutputProfileConfig(outputProfile || DEFAULT_OUTPUT_PROFILE);
  const numericTargetSeconds = Number(targetSeconds);
  let minScenes = profile.minScenes;
  let maxScenes = profile.maxScenes;

  if (profile.id === "vertical-short") {
    if (numericTargetSeconds <= 60) {
      minScenes = 10;
      maxScenes = 12;
    } else if (numericTargetSeconds <= 90) {
      minScenes = 12;
      maxScenes = 14;
    } else {
      minScenes = 14;
      maxScenes = 16;
    }
  }

  const {minWords, maxWords} = getTargetWordRange(numericTargetSeconds, language);
  const warnings = [];

  if (sceneCount < minScenes || sceneCount > maxScenes) {
    warnings.push(`cenas ${sceneCount} fora da faixa ${minScenes}-${maxScenes}`);
  }

  const captionText = String(`${storyboard?.postCaption || ""} ${storyboard?.cta || ""}`).trim();
  if (captionText && PREVIEW_CTA_RE.test(captionText)) {
    warnings.push("postCaption/cta com chamada para acao");
  }

  return {
    sceneCount,
    wordCount,
    minScenes,
    maxScenes,
    minWords,
    maxWords,
    issues: [],
    warnings
  };
};

const MIN_TITLE_WORDS_WITHOUT_SOURCE = 6;
const MIN_TITLE_CHARS_WITHOUT_SOURCE = 32;
const MIN_SOURCE_TEXT_CHARS = 140;

const validateGenerateInputs = ({title, sourceText}) => {
  const normalizedTitle = String(title || "").trim();
  const normalizedSourceText = String(sourceText || "").trim();

  if (!normalizedTitle && normalizedSourceText.length < MIN_SOURCE_TEXT_CHARS) {
    return `Informe um titulo ou cole pelo menos ${MIN_SOURCE_TEXT_CHARS} caracteres de texto-base.`;
  }

  if (
    !normalizedSourceText &&
    (normalizedTitle.length < MIN_TITLE_CHARS_WITHOUT_SOURCE || countWords(normalizedTitle) < MIN_TITLE_WORDS_WITHOUT_SOURCE)
  ) {
    return `Sem texto-base, o titulo precisa ter pelo menos ${MIN_TITLE_WORDS_WITHOUT_SOURCE} palavras e ${MIN_TITLE_CHARS_WITHOUT_SOURCE} caracteres.`;
  }

  return "";
};

const extractWordEntries = (text) => {
  const entries = [];
  const source = String(text || "");

  for (const match of source.matchAll(/\S+/g)) {
    const rawToken = match[0];
    const leadingTrimmed = rawToken.replace(/^[^\p{L}\p{N}@#]+/u, "");
    const trailingTrimmed = leadingTrimmed.replace(/[^\p{L}\p{N}%.,;:?!…]+$/u, "");
    const wordText = trailingTrimmed || leadingTrimmed || rawToken;
    const tokenStart = match.index ?? 0;
    const leadingChars = rawToken.indexOf(wordText);
    const charStart = tokenStart + Math.max(0, leadingChars);
    const charEnd = charStart + Math.max(1, wordText.length) - 1;

    entries.push({
      text: wordText,
      rawText: rawToken,
      startChar: charStart,
      endChar: charEnd
    });
  }

  return entries;
};

const getRunPaths = (slug) => {
  const runDir = path.join(configuredVideoEngineRoot, "runs", slug);
  const publicRunDir = path.join(configuredVideoEngineRoot, "public", "runs", slug);

  return {
    runDir,
    storyboardPath: path.join(runDir, "storyboard.json"),
    storyboardQaPath: path.join(runDir, "storyboard-qa.json"),
    voiceoverPath: path.join(runDir, "voiceover.json"),
    assetPlanPath: path.join(runDir, "asset-plan.json"),
    renderPropsPath: path.join(runDir, "render-props.json"),
    agentReportPath: path.join(runDir, "agent-report.json"),
    orchestrationReportPath: path.join(runDir, "orchestration-report.json"),
    postPath: path.join(runDir, "post.txt"),
    assetDir: path.join(configuredVideoEngineRoot, "assets", "envato", slug),
    publicRunDir,
    publicAudioDir: path.join(publicRunDir, "audio"),
    publicVideoDir: path.join(publicRunDir, "video"),
    publicAudioPath: path.join(publicRunDir, "audio", "voiceover.mp3"),
    outPath: path.join(configuredVideoEngineRoot, "out", `${slug}.mp4`)
  };
};

const toIsoNow = () => new Date().toISOString();
const toTimestampMs = (value) => {
  const ms = Date.parse(String(value || "").trim());
  return Number.isFinite(ms) ? ms : null;
};

const getArtifactEpochMs = (jobOrSlug) => {
  if (!jobOrSlug || typeof jobOrSlug === "string") {
    return null;
  }

  return (
    toTimestampMs(jobOrSlug.artifactEpochAt) ||
    toTimestampMs(jobOrSlug.startedAt) ||
    toTimestampMs(jobOrSlug.createdAt)
  );
};

const normalizePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const isFreshArtifactForJob = (targetPath, jobOrSlug) => {
  if (!existsSync(targetPath)) {
    return false;
  }

  const epochMs = getArtifactEpochMs(jobOrSlug);
  if (!epochMs) {
    return true;
  }

  try {
    return statSync(targetPath).mtimeMs + ARTIFACT_FRESHNESS_TOLERANCE_MS >= epochMs;
  } catch {
    return false;
  }
};

const readJsonSyncIfExists = (targetPath) => {
  try {
    return JSON.parse(readFileSync(targetPath, "utf8"));
  } catch {
    return null;
  }
};

const resolveEffectiveStoryboardPath = (jobOrSlug) => {
  if (typeof jobOrSlug === "string") {
    return getRunPaths(jobOrSlug).storyboardPath;
  }

  const slug = String(jobOrSlug?.slug || "").trim();
  if (!slug) {
    return "";
  }

  const candidates = [
    String(jobOrSlug?.input?.storyboardFile || "").trim(),
    String(jobOrSlug?.storyboardPath || "").trim(),
    getRunPaths(slug).storyboardPath
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  return path.resolve(getRunPaths(slug).storyboardPath);
};

const getFreshSceneNumbers = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string" ? jobOrSlug : String(jobOrSlug?.slug || "").trim();
  if (!slug) {
    return new Set();
  }

  const {assetDir} = getRunPaths(slug);
  if (!existsSync(assetDir)) {
    return new Set();
  }

  const sceneNumbers = new Set();
  for (const entry of readdirSync(assetDir)) {
    const match = /^scene-(\d+)\.mp4$/i.exec(entry);
    if (!match) {
      continue;
    }

    const sceneNumber = normalizePositiveInt(match[1]);
    if (!sceneNumber) {
      continue;
    }

    const scenePath = path.join(assetDir, entry);
    if (typeof jobOrSlug === "string" || isFreshArtifactForJob(scenePath, jobOrSlug)) {
      sceneNumbers.add(sceneNumber);
    }
  }

  return sceneNumbers;
};

const getSceneCompletionStats = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string" ? jobOrSlug : String(jobOrSlug?.slug || "").trim();
  const paths = getRunPaths(slug);
  const storyboardPath = resolveEffectiveStoryboardPath(jobOrSlug);
  const storyboard = readJsonSyncIfExists(storyboardPath);
  const sceneCount = Array.isArray(storyboard?.scenes) ? storyboard.scenes.length : 0;
  const freshSceneNumbers = getFreshSceneNumbers(jobOrSlug);
  let existingSceneCount = 0;
  let firstMissingSceneNumber = null;

  for (let index = 0; index < sceneCount; index += 1) {
    const sceneNumber = index + 1;
    if (freshSceneNumbers.has(sceneNumber)) {
      existingSceneCount += 1;
      continue;
    }

    if (firstMissingSceneNumber === null) {
      firstMissingSceneNumber = sceneNumber;
    }
  }

  return {
    storyboardPath,
    storyboard,
    sceneCount,
    existingSceneCount,
    missingSceneCount: Math.max(0, sceneCount - existingSceneCount),
    firstMissingSceneNumber: normalizePositiveInt(firstMissingSceneNumber),
    freshSceneNumbers: Array.from(freshSceneNumbers).sort((left, right) => left - right)
  };
};

const getMissingSceneHintFromJob = (job) => {
  if (!job || String(job.status || "").trim().toLowerCase() !== "failed") {
    return null;
  }

  const haystack = []
    .concat(Array.isArray(job.logTail) ? job.logTail : [])
    .concat([job.error, job.failureSummary, job.rca?.summary])
    .filter(Boolean)
    .join("\n");

  const incompleteMatch = /incompleta nas cenas:\s*([0-9,\s]+)/i.exec(haystack);
  if (incompleteMatch?.[1]) {
    const firstValue = incompleteMatch[1]
      .split(",")
      .map((value) => normalizePositiveInt(value))
      .find((value) => value !== null);
    if (firstValue !== undefined) {
      return firstValue ?? null;
    }
  }

  const singleMatch = /falta a cena\s+(\d+)/i.exec(haystack);
  if (singleMatch?.[1]) {
    return normalizePositiveInt(singleMatch[1]);
  }

  return null;
};

const hasBasicResumeArtifacts = (job) => {
  if (job.type !== "generate" || job.status !== "failed" || job.input?.previewOnly) {
    return false;
  }

  const paths = getRunPaths(job.slug);
  const sceneStats = getSceneCompletionStats(job);

  if (
    !existsSync(sceneStats.storyboardPath || paths.storyboardPath) ||
    !isFreshArtifactForJob(paths.voiceoverPath, job) ||
    !isFreshArtifactForJob(paths.publicAudioPath, job)
  ) {
    return false;
  }

  return sceneStats.sceneCount > 0 && sceneStats.missingSceneCount === 0;
};

const getFirstMissingSceneNumber = (job) => {
  if (job.type !== "generate" || job.input?.previewOnly) {
    return null;
  }

  return getSceneCompletionStats(job).firstMissingSceneNumber;
};

const getQaReportForSlug = (slug) => {
  const paths = getRunPaths(slug);
  return readJsonSyncIfExists(paths.agentReportPath) || readJsonSyncIfExists(paths.orchestrationReportPath);
};

const getQaReportForJob = (jobOrSlug) => {
  if (!jobOrSlug || typeof jobOrSlug === "string") {
    return getQaReportForSlug(jobOrSlug);
  }

  const slug = String(jobOrSlug.slug || "").trim();
  if (!slug) {
    return null;
  }

  const paths = getRunPaths(slug);
  const reportCandidates = [paths.agentReportPath, paths.orchestrationReportPath];

  for (const reportPath of reportCandidates) {
    if (!isFreshArtifactForJob(reportPath, jobOrSlug)) {
      continue;
    }

    const report = readJsonSyncIfExists(reportPath);
    if (report) {
      return report;
    }
  }

  return null;
};

const isQaPassedForSlug = (slug) => {
  const report = getQaReportForSlug(slug);
  return report?.qa?.passed === true || Boolean(report?.finalVideo && report?.status === "completed");
};

const isQaPassedForJob = (jobOrSlug) => {
  const report = getQaReportForJob(jobOrSlug);
  return report?.qa?.passed === true || Boolean(report?.finalVideo && report?.status === "completed");
};

const getRecoverySourceJob = (job) => {
  if (!job) {
    return null;
  }

  if (job.type === "generate") {
    return job;
  }

  const referencedJobIds = [
    job.input?.sourceJobId,
    job.input?.resumeFromJobId,
    job.input?.approvedFromJobId
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const referencedJobId of referencedJobIds) {
    const referenced = jobs.get(referencedJobId);
    if (referenced?.type === "generate") {
      return referenced;
    }
  }

  return (
    Array.from(jobs.values())
      .filter((candidate) => candidate.slug === job.slug && candidate.type === "generate")
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] ||
    job
  );
};

const canPrepareAudioForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) {
    return false;
  }

  const paths = getRunPaths(sourceJob.slug);
  const sceneStats = getSceneCompletionStats(sourceJob);
  return (
    sceneStats.sceneCount > 0 &&
    sceneStats.missingSceneCount === 0 &&
    existsSync(sceneStats.storyboardPath || paths.storyboardPath)
  );
};

const canRenderOnlyForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) {
    return false;
  }

  const paths = getRunPaths(sourceJob.slug);
  const sceneStats = getSceneCompletionStats(sourceJob);
  return (
    sceneStats.sceneCount > 0 &&
    sceneStats.missingSceneCount === 0 &&
    existsSync(sceneStats.storyboardPath || paths.storyboardPath) &&
    isFreshArtifactForJob(paths.renderPropsPath, sourceJob) &&
    isFreshArtifactForJob(paths.publicAudioPath, sourceJob)
  );
};

const canValidateOnlyForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) {
    return false;
  }

  return isFreshArtifactForJob(getRunPaths(sourceJob.slug).outPath, sourceJob);
};

const buildJobStepChecklist = (job) => {
  if (!job?.slug || (job.type !== "generate" && job.type !== "scene-regenerate" && job.type !== "rerender")) {
    return [];
  }

  const paths = getRunPaths(job.slug);
  const sceneStats = getSceneCompletionStats(job);
  const storyboardQaPath = sceneStats.storyboardPath
    ? path.join(path.dirname(sceneStats.storyboardPath), "storyboard-qa.json")
    : path.join(paths.runDir, "storyboard-qa.json");
  const storyboardQa = readJsonSyncIfExists(storyboardQaPath);
  const voiceover = readJsonSyncIfExists(paths.voiceoverPath);
  const renderProps = readJsonSyncIfExists(paths.renderPropsPath);
  const agentReport = readJsonSyncIfExists(path.join(paths.runDir, "agent-report.json"));
  const fluxReport =
    readJsonSyncIfExists(path.join(paths.assetDir, "flux2-plan-report.json")) ||
    readJsonSyncIfExists(path.join(paths.assetDir, "plan-report.json"));

  const storyboardPassed = storyboardQa?.passed === true;
  const storyboardBlocked = storyboardQa?.passed === false;
  const timedWordCount = Array.isArray(voiceover?.timedWords) ? voiceover.timedWords.length : 0;
  const rushedSceneCount = Array.isArray(voiceover?.sceneTimingAnalysis?.rushedScenes)
    ? voiceover.sceneTimingAnalysis.rushedScenes.length
    : 0;
  const renderSceneCount = Array.isArray(renderProps?.scenes) ? renderProps.scenes.length : 0;
  const renderCaptionCount = Array.isArray(renderProps?.captions) ? renderProps.captions.length : 0;
  const qaPassed = agentReport?.qa?.passed === true || Boolean(agentReport?.finalVideo && agentReport?.status === "completed");

  return [
    {
      id: "storyboard",
      label: "Storyboard",
      status: storyboardPassed ? "completed" : storyboardBlocked ? "blocked" : existsSync(paths.storyboardPath) ? "ready" : "pending",
      summary: storyboardPassed
        ? `QA ok • ${sceneStats.sceneCount} cenas`
        : storyboardBlocked
          ? `QA reprovou • ${Array.isArray(storyboardQa?.issues) ? storyboardQa.issues.length : 0} issues`
          : existsSync(paths.storyboardPath)
            ? "Storyboard gerado, aguardando QA"
            : "Aguardando gerar storyboard",
      counts: {
        sceneCount: sceneStats.sceneCount,
        issueCount: Array.isArray(storyboardQa?.issues) ? storyboardQa.issues.length : 0,
        warningCount: Array.isArray(storyboardQa?.warnings) ? storyboardQa.warnings.length : 0
      }
    },
    {
      id: "assets",
      label: "Cenas / imagens",
      status:
        sceneStats.sceneCount > 0 && sceneStats.existingSceneCount === sceneStats.sceneCount
          ? "completed"
          : sceneStats.existingSceneCount > 0
            ? "partial"
            : fluxReport?.totals?.localAuditFailureCount > 0 || fluxReport?.totals?.promptValidationFailureCount > 0
              ? "blocked"
              : storyboardPassed
                ? "ready"
                : "pending",
      summary:
        sceneStats.sceneCount > 0 && sceneStats.existingSceneCount === sceneStats.sceneCount
          ? `Todas as ${sceneStats.sceneCount} cenas prontas`
          : sceneStats.existingSceneCount > 0
            ? `${sceneStats.existingSceneCount}/${sceneStats.sceneCount} cenas prontas`
            : fluxReport?.totals?.localAuditFailureCount > 0 || fluxReport?.totals?.promptValidationFailureCount > 0
              ? "Falhas na geracao visual"
              : "Aguardando gerar cenas",
      counts: {
        sceneCount: sceneStats.sceneCount,
        existingSceneCount: sceneStats.existingSceneCount,
        missingSceneCount: sceneStats.missingSceneCount
      }
    },
    {
      id: "voiceover",
      label: "Voz e timings",
      status:
        timedWordCount > 0 && rushedSceneCount === 0
          ? "completed"
          : voiceover
            ? "partial"
            : storyboardPassed
              ? "ready"
              : "pending",
      summary:
        timedWordCount > 0 && rushedSceneCount === 0
          ? `${timedWordCount} palavras alinhadas`
          : voiceover
            ? `${timedWordCount} palavras alinhadas • ${rushedSceneCount} cenas corridas`
            : "Aguardando gerar voiceover",
      counts: {
        timedWordCount,
        rushedSceneCount
      }
    },
    {
      id: "audio",
      label: "Audio final",
      status: existsSync(paths.publicAudioPath) ? "completed" : voiceover ? "ready" : "pending",
      summary: existsSync(paths.publicAudioPath) ? "voiceover.mp3 pronto" : "Aguardando MP3 final",
      counts: {}
    },
    {
      id: "renderPrep",
      label: "Legenda / render props",
      status:
        renderSceneCount > 0 && renderCaptionCount > 0
          ? "completed"
          : renderProps
            ? "partial"
            : voiceover
              ? "ready"
              : "pending",
      summary:
        renderSceneCount > 0 && renderCaptionCount > 0
          ? `${renderSceneCount} cenas • ${renderCaptionCount} captions`
          : renderProps
            ? "Props de render incompletas"
            : "Aguardando preparar render",
      counts: {
        sceneCount: renderSceneCount,
        captionCount: renderCaptionCount
      }
    },
    {
      id: "finalQa",
      label: "Video final / QA",
      status: qaPassed ? "completed" : existsSync(paths.outPath) ? "partial" : renderProps ? "ready" : "pending",
      summary: qaPassed ? "QA final ok" : existsSync(paths.outPath) ? "Video existe, falta validar" : "Aguardando render final",
      counts: {
        outputExists: existsSync(paths.outPath) ? 1 : 0
      }
    }
  ];
};

const getJobStepChecklist = (job) => {
  const paths = getRunPaths(job.slug);
  const effectiveStoryboardPath = resolveEffectiveStoryboardPath(job);
  const storyboardExists = existsSync(effectiveStoryboardPath);
  const sceneStats = getSceneCompletionStats(job);
  const sceneCount = sceneStats.sceneCount;
  const firstMissingSceneNumber =
    getMissingSceneHintFromJob(job) ||
    normalizePositiveInt(sceneStats.firstMissingSceneNumber);
  const allSceneClipsExist = sceneCount > 0 && sceneStats.missingSceneCount === 0;
  let qaPassed = isQaPassedForJob(job);
  const trustCompletedArtifacts = job?.status === "completed" || (qaPassed && allSceneClipsExist);
  const voiceoverJsonExists = trustCompletedArtifacts
    ? existsSync(paths.voiceoverPath)
    : isFreshArtifactForJob(paths.voiceoverPath, job);
  const voiceoverMp3Exists = trustCompletedArtifacts
    ? existsSync(paths.publicAudioPath)
    : isFreshArtifactForJob(paths.publicAudioPath, job);
  const renderPropsExists = trustCompletedArtifacts
    ? existsSync(paths.renderPropsPath)
    : isFreshArtifactForJob(paths.renderPropsPath, job);
  const outputExists = trustCompletedArtifacts
    ? existsSync(paths.outPath)
    : isFreshArtifactForJob(paths.outPath, job);
  let timedWordsReady = false;

  if (voiceoverJsonExists && isFreshArtifactForJob(paths.voiceoverPath, job)) {
    try {
      const voiceover = JSON.parse(readFileSync(paths.voiceoverPath, "utf8"));
      timedWordsReady = Array.isArray(voiceover?.timedWords) && voiceover.timedWords.length > 0;
    } catch {}
  } else {
    timedWordsReady = false;
  }

  let effectiveRenderPropsExists = renderPropsExists;
  let effectiveOutputExists = outputExists;

  if (!allSceneClipsExist && !trustCompletedArtifacts) {
    qaPassed = false;
    effectiveRenderPropsExists = false;
    effectiveOutputExists = false;
  }

  return {
    firstMissingSceneNumber,
    allSceneClipsExist,
    steps: [
      {
        key: "storyboard",
        label: "Storyboard",
        status: storyboardExists ? "completed" : "missing",
        detail: storyboardExists ? `${sceneCount || 0} cenas no storyboard` : "Storyboard ainda ausente"
      },
      {
        key: "assets",
        label: "Imagens e cenas",
        status: !storyboardExists ? "blocked" : allSceneClipsExist ? "completed" : "blocked",
        detail: !storyboardExists
          ? "Sem storyboard não há geração visual"
          : allSceneClipsExist
            ? `Todos os ${sceneCount} clips de cena existem`
            : `Falta a cena ${firstMissingSceneNumber || "?"}`
      },
      {
        key: "audio",
        label: "Voz",
        status: voiceoverJsonExists && voiceoverMp3Exists ? "completed" : voiceoverJsonExists ? "partial" : "missing",
        detail: voiceoverJsonExists && voiceoverMp3Exists
          ? "voiceover.json e voiceover.mp3 prontos"
          : voiceoverJsonExists
            ? "voiceover.json existe, mas o mp3 final não"
            : "A voz ainda não foi gerada"
      },
      {
        key: "timestamps",
        label: "Timestamps",
        status: qaPassed || effectiveOutputExists ? "completed" : timedWordsReady ? "completed" : voiceoverJsonExists ? "partial" : "missing",
        detail: qaPassed || effectiveOutputExists
          ? "Timestamps resolvidos no vídeo final"
          : timedWordsReady
          ? "timedWords prontos para karaokê e legendas"
          : voiceoverJsonExists
            ? "Há voz base, mas faltam timestamps sólidos"
            : "Aguardando voz para extrair timestamps"
      },
      {
        key: "render",
        label: "Render",
        status: effectiveOutputExists ? "completed" : effectiveRenderPropsExists ? "ready" : "missing",
        detail: effectiveOutputExists
          ? "MP4 final já existe"
          : effectiveRenderPropsExists
            ? "render-props prontos; pode renderizar"
            : "Ainda faltam props de render"
      },
      {
        key: "qa",
        label: "QA final",
        status: qaPassed ? "completed" : effectiveOutputExists ? "ready" : "missing",
        detail: qaPassed
          ? "QA final validada"
          : effectiveOutputExists
            ? "Video existe; pode validar"
            : "Aguardando video final para validar"
      }
    ]
  };
};

const ffprobeDurationSeconds = (targetPath) => {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetPath],
    {cwd: projectRoot, encoding: "utf8"}
  );

  if (result.status !== 0) {
    throw new Error(`ffprobe falhou para ${targetPath}`);
  }

  return Number.parseFloat(String(result.stdout || "0").trim()) || 0;
};

const buildFallbackTimedWords = ({scenes, sceneSpans, audioDurationSeconds, text}) => {
  const totalWeight = scenes.reduce((sum, scene) => sum + Math.max(6, countWords(scene.narration)), 0) || 1;
  const fallbackSpans = Array.isArray(sceneSpans) && sceneSpans.length === scenes.length && sceneSpans.length > 0
    ? sceneSpans
    : scenes.map((scene, index) => {
        const startChar = index === 0
          ? 0
          : scenes
              .slice(0, index)
              .reduce((sum, item) => sum + String(item.narration || "").length + 2, 0);
        const endChar = startChar + Math.max(1, String(scene.narration || "").length) - 1;
        return {sceneIndex: index, startChar, endChar};
      });
  let cursorSeconds = 0;
  const timedWords = [];

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const sceneWords = extractWordEntries(scene.narration);
    const sceneWeight = Math.max(6, sceneWords.length);
    const sceneDuration = audioDurationSeconds * (sceneWeight / totalWeight);
    const sceneStartChar = Number(fallbackSpans[index]?.startChar ?? 0);
    const sceneWordCount = Math.max(1, sceneWords.length);

    for (let wordIndex = 0; wordIndex < sceneWords.length; wordIndex += 1) {
      const word = sceneWords[wordIndex];
      const startSeconds = cursorSeconds + (sceneDuration * wordIndex) / sceneWordCount;
      const endSeconds =
        wordIndex === sceneWords.length - 1
          ? cursorSeconds + sceneDuration
          : cursorSeconds + (sceneDuration * (wordIndex + 1)) / sceneWordCount;

      timedWords.push({
        text: word.text,
        rawText: word.rawText,
        startSeconds: roundSeconds(startSeconds),
        endSeconds: roundSeconds(Math.max(endSeconds, startSeconds + 0.04)),
        startChar: sceneStartChar + word.startChar,
        endChar: sceneStartChar + word.endChar
      });
    }

    cursorSeconds += sceneDuration;
  }

  if (timedWords.length > 0) {
    timedWords[timedWords.length - 1].endSeconds = roundSeconds(audioDurationSeconds);
  }

  return timedWords;
};

const buildResumeAssetPlan = async ({slug, storyboard, publicVideoDir, assetDir}) => {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  const assetPlan = [];

  await mkdir(publicVideoDir, {recursive: true});

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const fileName = `scene-${String(index + 1).padStart(2, "0")}.mp4`;
    const sourceClipPath = path.join(assetDir, fileName);
    const publicClipPath = path.join(publicVideoDir, fileName);

    if (!existsSync(sourceClipPath)) {
      throw new Error(`Falta o clip ${fileName} em assets/envato/${slug}.`);
    }

    if (!existsSync(publicClipPath)) {
      await copyFile(sourceClipPath, publicClipPath);
    }

    assetPlan.push({
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      title: scene.title,
      narration: scene.narration,
      overlay: scene.overlay,
      searchQuery: scene.searchQuery,
      visualGoal: scene.visualGoal,
      candidateQueries: scene.candidateQueries,
      sceneType: scene.sceneType || "stock",
      clipPath: path.posix.join("runs", slug, "video", fileName),
      attribution: {
        source: "envato-local",
        path: sourceClipPath
      },
      queryUsed: scene.searchQuery || scene.candidateQueries?.[0] || null,
      failureReason: null
    });
  }

  return assetPlan;
};

const buildResumeRenderProps = ({
  slug,
  job,
  storyboard,
  voiceover,
  assetPlan,
  timedWords,
  audioDurationSeconds,
  outputProfile
}) => {
  const timeline = buildTimeline({
    scenes: assetPlan,
    audioDurationSeconds,
    fps: RESUME_RENDER_FPS,
    timedWords,
    sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : []
  });
  const musicPath = job.input?.noMusic ? null : null;

  return {
    title: storyboard.videoTitle || job.title,
    hook: storyboard.hook || "",
    cta: storyboard.cta || "",
    channelHandle: job.input?.channelHandle || "@teucanal",
    outputProfile: outputProfile.id,
    compositionId: outputProfile.compositionId,
    videoWidth: outputProfile.width,
    videoHeight: outputProfile.height,
    durationInFrames: timeline.durationInFrames,
    narrationPath: path.posix.join("runs", slug, "audio", "voiceover.mp3"),
    musicPath,
    scenes: timeline.scenes,
    captions: timeline.captions
  };
};

const getFailureStage = (job) => {
  const tail = Array.isArray(job?.logTail) ? job.logTail : [];
  const joined = tail.join("\n").toLowerCase();

  if (joined.includes("timestamps palavra-a-palavra") || joined.includes("stt part offset") || joined.includes("karaoke")) {
    return "timestamp-extraction";
  }

  if (joined.includes("a renderizar no remotion") || joined.includes("remotion")) {
    return "render";
  }

  if (joined.includes("a validar o render") || joined.includes("[qa]")) {
    return "qa";
  }

  if (joined.includes("gera voz") || joined.includes("voiceover")) {
    return "audio";
  }

  return job?.status === "failed" ? "pipeline" : null;
};

const getFailureSummary = (job) => {
  const error = String(job?.error || "").trim();
  const stage = getFailureStage(job);

  if (!error && !stage) {
    return "";
  }

  const hints = [];

  if (stage) {
    hints.push(`etapa=${stage}`);
  }

  if (error) {
    hints.push(`erro=${error}`);
  }

  return hints.join(" | ");
};

const JOB_STATE_META = {
  queued: {label: "Na fila", severity: "neutral", terminal: false},
  running: {label: "Em execucao", severity: "info", terminal: false},
  completed: {label: "Concluido", severity: "success", terminal: true},
  failed: {label: "Falhou", severity: "danger", terminal: true}
};

const JOB_STAGE_LABELS = {
  queue: "Fila",
  preview: "Preview",
  storyboard: "Storyboard",
  audio: "Audio",
  "timestamp-extraction": "Timestamps",
  render: "Render",
  qa: "QA",
  resume: "Retomada",
  pipeline: "Pipeline",
  completed: "Concluido",
  "video-published": "Publicado",
  "video-draft": "Rascunho",
  "video-ready": "Pronto"
};

const normalizeSignalText = (job) =>
  [
    job?.error || "",
    Array.isArray(job?.logTail) ? job.logTail.slice(-12).join("\n") : "",
    job?.status || "",
    job?.type || ""
  ]
    .join("\n")
    .toLowerCase();

const inferJobStageValue = (job) => {
  const status = String(job?.status || "").trim().toLowerCase();
  const signal = normalizeSignalText(job);

  if (status === "queued") {
    return "queue";
  }

  if (status === "completed") {
    return job?.input?.previewOnly ? "preview" : "completed";
  }

  if (status === "failed") {
    return getFailureStage(job) || "pipeline";
  }

  if (signal.includes("[resume]") || signal.includes("retomando")) {
    return "resume";
  }

  if (signal.includes("preview-only") || signal.includes("storyboard preview")) {
    return "preview";
  }

  if (signal.includes("timestamps palavra-a-palavra") || signal.includes("stt part offset") || signal.includes("karaoke")) {
    return "timestamp-extraction";
  }

  if (signal.includes("a validar o render") || signal.includes("[qa]")) {
    return "qa";
  }

  if (signal.includes("a renderizar no remotion") || signal.includes("remotion")) {
    return "render";
  }

  if (signal.includes("gera voz") || signal.includes("voiceover") || signal.includes("audio")) {
    return "audio";
  }

  if (signal.includes("storyboard") || signal.includes("roteiro")) {
    return "storyboard";
  }

  return "pipeline";
};

const getStageLabel = (value, fallback = "Pipeline") => JOB_STAGE_LABELS[value] || fallback;

const getJobStateInfo = (job) => {
  const status = String(job?.status || "queued").trim().toLowerCase();
  const meta = JOB_STATE_META[status] || {label: status || "desconhecido", severity: "neutral", terminal: false};

  return {
    value: status,
    label: meta.label,
    severity: meta.severity,
    terminal: Boolean(meta.terminal)
  };
};

const getJobStageInfo = (job) => {
  if (job?.stageValue) {
    return {
      value: job.stageValue,
      label: getStageLabel(job.stageValue),
      source: job.stageSource || "system",
      confidence: job.stageConfidence || "high"
    };
  }

  const value = inferJobStageValue(job);
  const status = String(job?.status || "").trim().toLowerCase();
  const source = status === "failed"
    ? "failure-log"
    : status === "completed"
      ? "status"
      : Array.isArray(job?.logTail) && job.logTail.length > 0
        ? "log"
        : "status";

  return {
    value,
    label: getStageLabel(value),
    source,
    confidence: source === "log" || source === "failure-log" ? "medium" : "low"
  };
};

const getJobRca = (job, stageInfo = getJobStageInfo(job)) => {
  const error = String(job?.error || "").trim();
  const signal = normalizeSignalText(job);
  const causes = [];
  const evidence = [];

  if (error) {
    evidence.push(error);
  }

  const latestLog = Array.isArray(job?.logTail) ? job.logTail.at(-1) || "" : "";
  if (latestLog) {
    evidence.push(latestLog);
  }

  if (signal.includes("timeout") || signal.includes("etimedout")) {
    causes.push("timeout");
  }

  if (signal.includes("enoent") || signal.includes("no such file") || signal.includes("falta o clip") || signal.includes("ausente")) {
    causes.push("missing-artifact");
  }

  if (signal.includes("ffmpeg") || signal.includes("ffprobe")) {
    causes.push("media-tooling");
  }

  if (signal.includes("gemini") || signal.includes("openrouter") || signal.includes("google api") || signal.includes("llm")) {
    causes.push("provider");
  }

  if (stageInfo.value === "audio") {
    causes.push("audio-generation");
  } else if (stageInfo.value === "render") {
    causes.push("rendering");
  } else if (stageInfo.value === "timestamp-extraction") {
    causes.push("timestamp-alignment");
  } else if (stageInfo.value === "qa") {
    causes.push("quality-gate");
  } else if (stageInfo.value === "resume") {
    causes.push("resume-rebuild");
  } else if (stageInfo.value === "storyboard") {
    causes.push("storyboard-generation");
  }

  return {
    summary: error || getFailureSummary(job) || stageInfo.label || "Sem detalhe disponivel",
    causes: [...new Set(causes)],
    evidence: evidence.slice(0, 3),
    confidence: error || causes.length > 0 ? "medium" : "low"
  };
};

const getJobRecommendedAction = (job, stageInfo = getJobStageInfo(job), rca = getJobRca(job, stageInfo)) => {
  const stepChecklist = getJobStepChecklist(job);
  const firstMissingSceneNumber = normalizePositiveInt(stepChecklist.firstMissingSceneNumber);
  const stepMap = Object.fromEntries(
    (Array.isArray(stepChecklist.steps) ? stepChecklist.steps : []).map((step) => [step.key, step])
  );
  const sourceJob = getRecoverySourceJob(job);
  const isPreview = Boolean(sourceJob?.input?.previewOnly || job?.input?.previewOnly);

  if (job?.status === "completed") {
    return {
      value: "review-output",
      label: "Revisar saida",
      details: "Abrir o arquivo final e validar se o resultado esta pronto para uso.",
      urgency: "low"
    };
  }

  if (!isPreview && firstMissingSceneNumber !== null) {
    const sceneNumber = firstMissingSceneNumber;
    return {
      value: "regenerate-missing-scene",
      label: `Regenerar cena ${sceneNumber}`,
      details: `A primeira cena faltante detectada e a ${sceneNumber}; reparar essa cena e mais seguro do que refazer tudo.`,
      urgency: "high"
    };
  }

  if (job?.status === "queued") {
    return {
      value: "wait-in-queue",
      label: "Aguardar fila",
      details: "O job ainda nao iniciou.",
      urgency: "low"
    };
  }

  if (
    !isPreview &&
    stepMap.assets?.status === "completed" &&
    canPrepareAudioForJob(job) &&
    stepMap.audio?.status !== "completed"
  ) {
    return {
      value: "generate-audio",
      label: "Gerar audio",
      details: "As cenas ja existem; o proximo passo correto e reconstruir voz, timings e props sem refazer imagens.",
      urgency: "high"
    };
  }

  if (
    !isPreview &&
    stepMap.assets?.status === "completed" &&
    stepMap.audio?.status === "completed" &&
    canRenderOnlyForJob(job) &&
    stepMap.render?.status !== "completed"
  ) {
    return {
      value: "render-only",
      label: "Renderizar video",
      details: "Storyboard, cenas e audio ja existem; vale renderizar sem repetir etapas anteriores.",
      urgency: "high"
    };
  }

  if (!isPreview && canValidateOnlyForJob(job) && stepMap.qa?.status !== "completed") {
    return {
      value: "validate-only",
      label: "Validar video",
      details: "O MP4 ja existe; rode a QA final sem reenfileirar a pipeline inteira.",
      urgency: "medium"
    };
  }

  if (job?.type === "generate" && job?.status === "failed" && hasBasicResumeArtifacts(job)) {
    return {
      value: "resume-rebuild",
      label: "Retomar com artefatos",
      details: "Storyboard, audio e cenas ja existem; a retomada e mais eficiente do que gerar do zero.",
      urgency: "high"
    };
  }

  if (job?.type === "generate" && job?.status === "failed" && canRetryFailedJobFromStoryboard(job)) {
    return {
      value: "retry-from-storyboard",
      label: "Refazer a partir do storyboard",
      details: "Existe storyboard reaproveitavel para reenfileirar sem perder o contexto.",
      urgency: "high"
    };
  }

  if (stageInfo.value === "audio") {
    return {
      value: "inspect-audio",
      label: "Revisar voz e TTS",
      details: "Conferir credenciais, voz selecionada e o passo de voiceover antes de reenfileirar.",
      urgency: "high"
    };
  }

  if (stageInfo.value === "render") {
    return {
      value: "inspect-render",
      label: "Revisar render",
      details: "Abrir o log do Remotion e validar assets, bitrate e timeout.",
      urgency: "high"
    };
  }

  if (stageInfo.value === "timestamp-extraction") {
    return {
      value: "inspect-timestamps",
      label: "Rever alinhamento de falas",
      details: "O problema parece estar nos timestamps ou no karaoke; vale inspecionar o texto-base e a segmentacao.",
      urgency: "medium"
    };
  }

  if (stageInfo.value === "qa") {
    return {
      value: "inspect-quality",
      label: "Revisar QA",
      details: "A etapa final de validacao sinalizou problema; revisar storyboard e saida final.",
      urgency: "medium"
    };
  }

  if (stageInfo.value === "resume") {
    return {
      value: "resume-rebuild",
      label: "Retomar com artefatos",
      details: "Os artefatos reaproveitaveis parecem presentes; vale retomar em vez de gerar do zero.",
      urgency: "medium"
    };
  }

  const primaryCause = rca.causes[0] || "pipeline";
  return {
    value: primaryCause === "missing-artifact" ? "inspect-artifacts" : "inspect-log",
    label: primaryCause === "missing-artifact" ? "Revisar artefatos ausentes" : "Revisar log e reenfileirar",
    details: "O RCA sugere que o log ou os artefatos do run precisam ser inspecionados antes de nova tentativa.",
    urgency: "medium"
  };
};

const buildCaseSummary = ({id, kind, title, slug, state, stage, rca, recommendedAction, updatedAt, channel = null, extra = {}}) => ({
  id,
  kind,
  title,
  slug,
  channel,
  state,
  stage,
  rca,
  recommendedAction,
  updatedAt,
  extra
});

const buildJobsSummary = (jobsList) => {
  const byState = {};
  const byStage = {};
  const byType = {};

  for (const job of jobsList) {
    const stateKey = job?.state?.value || String(job?.status || "unknown");
    const stageKey = job?.stage?.value || "unknown";
    const typeKey = String(job?.type || "unknown");

    byState[stateKey] = (byState[stateKey] || 0) + 1;
    byStage[stageKey] = (byStage[stageKey] || 0) + 1;
    byType[typeKey] = (byType[typeKey] || 0) + 1;
  }

  return {
    total: jobsList.length,
    queued: byState.queued || 0,
    running: byState.running || 0,
    completed: byState.completed || 0,
    failed: byState.failed || 0,
    byState,
    byStage,
    byType
  };
};

const getVideoStateInfo = (video) => {
  const status = video?.publishStatus === "published"
    || Boolean(video?.publishedAt)
    ? "published"
    : video?.publishStatus === "scheduled"
      ? "scheduled"
      : video?.isDraft
        ? "draft"
        : "ready";
  const labels = {
    published: {label: "Publicado", severity: "success"},
    scheduled: {label: "Agendado", severity: "info"},
    draft: {label: "Rascunho", severity: "neutral"},
    ready: {label: "Pronto", severity: "neutral"}
  };
  const meta = labels[status] || labels.ready;

  return {
    value: status,
    label: meta.label,
    severity: meta.severity,
    terminal: status === "published"
  };
};

const getVideoStageInfo = (video) => {
  const value = video?.publishStatus === "published"
    || Boolean(video?.publishedAt)
    ? "video-published"
    : video?.isDraft
      ? "video-draft"
      : "video-ready";

  return {
    value,
    label: getStageLabel(value),
    source: "video-metadata",
    confidence: "medium"
  };
};

const getVideoRca = (video, stateInfo = getVideoStateInfo(video)) => {
  if (stateInfo.value === "published") {
    return {
      summary: "Video publicado com sucesso.",
      causes: [],
      evidence: [video.publishedAt || video.updatedAt || ""].filter(Boolean),
      confidence: "high"
    };
  }

  if (stateInfo.value === "scheduled") {
    return {
      summary: "Video agendado aguardando janela de publicacao.",
      causes: ["scheduled"],
      evidence: [video.publishAt || ""].filter(Boolean),
      confidence: "high"
    };
  }

  if (stateInfo.value === "draft") {
    return {
      summary: "Video mantido como rascunho antes da publicacao.",
      causes: ["draft"],
      evidence: [video.storyboardUrl || "", video.thumbnailUrl || ""].filter(Boolean),
      confidence: "medium"
    };
  }

  return {
    summary: "Video pronto para revisão ou publicacao.",
    causes: ["ready"],
    evidence: [video.storyboardUrl || "", video.thumbnailUrl || ""].filter(Boolean),
    confidence: "medium"
  };
};

const getVideoRecommendedAction = (video, stateInfo = getVideoStateInfo(video)) => {
  if (stateInfo.value === "published") {
    return {
      value: "monitor-performance",
      label: "Acompanhar performance",
      details: "O item ja foi publicado; a proxima acao e observar resultados e reaproveitar aprendizados.",
      urgency: "low"
    };
  }

  if (stateInfo.value === "scheduled") {
    return {
      value: "wait-for-publish",
      label: "Aguardar publicacao",
      details: "O video ja esta agendado.",
      urgency: "low"
    };
  }

  if (stateInfo.value === "draft") {
    return {
      value: "publish-or-edit",
      label: "Revisar e publicar",
      details: "O rascunho ainda pode receber ajustes antes de ser enviado para publicacao.",
      urgency: "medium"
    };
  }

  return {
    value: "publish",
    label: "Publicar",
    details: "O video parece pronto para a proxima etapa de publicacao.",
    urgency: "medium"
  };
};

const buildVideoCaseSummary = (video) => {
  const state = getVideoStateInfo(video);
  const stage = getVideoStageInfo(video);
  const rca = getVideoRca(video, state);
  const recommendedAction = getVideoRecommendedAction(video, state);

  return buildCaseSummary({
    id: video.id,
    kind: "video",
    title: video.title,
    slug: video.slug,
    state,
    stage,
    rca,
    recommendedAction,
    updatedAt: video.updatedAt,
    channel: video.channel,
    extra: {
      publishStatus: video.publishStatus || "",
      publishedAt: video.publishedAt || null,
      storyboardUrl: video.storyboardUrl || null,
      thumbnailUrl: video.thumbnailUrl || null
    }
  });
};

const buildVideosSummary = (videos, failedJobs) => {
  const published = videos.filter((video) => video.publishStatus === "published" || Boolean(video.publishedAt)).length;
  const scheduled = videos.filter((video) => video.publishStatus === "scheduled").length;
  const drafts = videos.filter((video) => video.isDraft === true).length;

  return {
    total: videos.length,
    published,
    scheduled,
    drafts,
    failedJobs: failedJobs.length,
    retryableFailedJobs: failedJobs.filter((job) => job.retryFromStoryboardAvailable).length,
    readyCases: videos.filter((video) => video.publishStatus !== "published").length + failedJobs.length
  };
};

const rootEnvConfig = await parseEnvFile(rootEnvPath);
const configuredVideoEngineRoot = resolvePathFrom(projectRoot, rootEnvConfig.VIDEOS_ENVATO_ROOT, defaultVideoEngineRoot);
const videoEnvConfig = await parseEnvFile(path.join(configuredVideoEngineRoot, ".env"));
const postarRoot = resolvePathFrom(projectRoot, process.env.POSTAR_ROOT || rootEnvConfig.POSTAR_ROOT, defaultPostarRoot);
const secretsModulePath = path.join(configuredVideoEngineRoot, "scripts", "lib", "secrets.mjs");
let loadSecretsIntoEnv = () => {};

if (existsSync(secretsModulePath)) {
  ({loadSecretsIntoEnv} = await import(secretsModulePath));
}

const baseChildEnv = {
  ...rootEnvConfig,
  ...videoEnvConfig,
  ...process.env
};
AGENDADOR_API_BASE = normalizeAgendadorApiBase(
  baseChildEnv.AGENDADOR_ONLINE_URL ||
    baseChildEnv.AGENDADOR_URL ||
    process.env.AGENDADOR_ONLINE_URL ||
    DEFAULT_AGENDADOR_SITE_URL
);
let videoMetadata = (await readJsonFile(videosFile)) || {};

const getChannelConfig = (value) =>
  channelOptions.find((channel) => channel.value === value) || channelOptions[0];

const getChannelPreset = (value) => channelPresets[value] || channelPresets.foiumaideia;

const getDefaultVoiceForLanguage = (language) =>
  String(language || "").startsWith("en") ? DEFAULT_ENGLISH_VOICE : DEFAULT_VOICE;

const resolveRequestedVoice = ({selectedVoice, customVoice, language, channelPreset = null}) => {
  const requestedVoice = String(selectedVoice || "").trim();
  const trimmedCustomVoice = String(customVoice || "").trim();
  const channelVoice =
    channelPreset?.voiceByLanguage?.[language] ||
    channelPreset?.voice ||
    getDefaultVoiceForLanguage(language);

  if (requestedVoice === "__custom") {
    return trimmedCustomVoice;
  }

  if (VALID_VOICES.includes(requestedVoice)) {
    return requestedVoice;
  }

  return channelVoice;
};
const resolveEffectiveScriptGuidance = ({
  explicitScriptGuidance = "",
  explicitTone = "",
  channelPreset,
  tonePreset
}) => {
  const manualGuidance = String(explicitScriptGuidance || "").trim();
  if (manualGuidance) {
    return manualGuidance;
  }

  const requestedTone = String(explicitTone || "").trim();
  const channelTone = String(channelPreset?.tone || "").trim();
  const toneGuidance = String(tonePreset?.scriptGuidance || "").trim();
  const channelGuidance = String(channelPreset?.scriptGuidance || "").trim();

  if (requestedTone && channelTone && requestedTone !== channelTone) {
    return toneGuidance || channelGuidance;
  }

  return channelGuidance || toneGuidance;
};

const getChannelExportDir = (channelValue) => path.join(postarRoot, getChannelConfig(channelValue).folder);
const resolveFirstUsableEnvValue = (...keys) => {
  for (const key of keys.flat()) {
    const value = String(baseChildEnv[key] || process.env[key] || "").trim();
    if (value) {
      return {key, value};
    }
  }

  return null;
};

const resolveAgendadorChannelProfile = (channelValue) => {
  const channel = getChannelConfig(channelValue);
  const channelKey = channel.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const specificProfile = channelPublishProfiles[channel.value] || channelPublishProfiles.foiumaideia;
  const identifier = resolveFirstUsableEnvValue(
    specificProfile.identifierKeys,
    `AGENDADOR_ONLINE_${channelKey}_EMAIL`,
    `AGENDADOR_ONLINE_${channelKey}_USERNAME`,
    `AGENDADOR_${channelKey}_EMAIL`,
    `AGENDADOR_${channelKey}_USERNAME`
  );
  const password = resolveFirstUsableEnvValue(
    specificProfile.passwordKeys,
    `AGENDADOR_ONLINE_${channelKey}_PASSWORD`,
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD"
  );
  const publicUrl = resolveFirstUsableEnvValue(
    specificProfile.publicUrlKeys || [],
    `AGENDADOR_ONLINE_${channelKey}_URL`,
    `${channelKey}_URL`
  );

  return {
    channel: channel.value,
    label: channel.label,
    handle: channel.handle,
    identifier: identifier?.value || "",
    identifierSource: identifier?.key || "",
    password: password?.value || "",
    passwordSource: password?.key || "",
    publicUrl: publicUrl?.value || "",
    profileUrlSource: publicUrl?.key || "",
    apiBase: AGENDADOR_API_BASE,
    siteUrl: normalizeAgendadorSiteUrl(baseChildEnv.AGENDADOR_ONLINE_URL || baseChildEnv.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL)
  };
};

const hasAgendadorCredentialsForChannel = (channelValue) => {
  const profile = resolveAgendadorChannelProfile(channelValue);
  return Boolean(profile.identifier && profile.password);
};

const getDurationOptions = (profileValue) => getDurationOptionsForProfile(profileValue);
const outputProfileOptions = listOutputProfileOptions();
const defaultDurationOptions = getDurationOptionsForProfile(DEFAULT_OUTPUT_PROFILE);

const serializeImageStyleOption = (option) => ({
  label: option.label,
  value: option.value,
  description: option.description || "",
  previewImageUrl: option.previewLinkPath || "",
  previewLinkUrl: option.previewLinkPath || ""
});

const serializeImageModelOption = (option) => ({
  value: option.value,
  label: option.label,
  provider: option.provider || "",
  badge: option.badge || "",
  description: option.description || "",
  costLabel: option.costLabel || "",
  costDetail: option.costDetail || ""
});

const serializeVoiceOption = (option) => ({
  label: option.label,
  value: option.value,
  badge: option.badge || "",
  description: option.description || "",
  languages: Array.isArray(option.languages) ? option.languages : ["pt-BR", "en-US"]
});

const resolveImageModel = (value, fallback = DEFAULT_IMAGE_MODEL) => {
  const normalized = String(value || "").trim();
  return imageModelOptions.some((option) => option.value === normalized) ? normalized : fallback;
};

const sanitizeJob = (job) => {
  const stepChecklist = getJobStepChecklist(job);
  const firstMissingSceneNumber = normalizePositiveInt(stepChecklist.firstMissingSceneNumber);
  const resumeAvailable = hasBasicResumeArtifacts(job);
  const state = getJobStateInfo(job);
  const stage = getJobStageInfo(job);
  const rca = getJobRca(job);
  const recommendedAction = getJobRecommendedAction(job);
  const recoverySourceJob = getRecoverySourceJob(job);
  const isPreview = Boolean(recoverySourceJob?.input?.previewOnly || job.input?.previewOnly);

  return {
    id: job.id,
    type: job.type,
    title: job.title,
    slug: job.slug,
    queueLane: job.queueLane || null,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    heartbeatAt: job.heartbeatAt || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    queuePosition: job.queuePosition ?? null,
    input: {
      ...job.input,
      sourceTextFile: job.input?.sourceTextFile ? "[internal]" : ""
    },
    outputPath: job.outputPath || null,
    outputUrl: job.outputPath ? createFileUrl(job.outputPath) : null,
    storyboardPath: job.storyboardPath || null,
    storyboardUrl: job.storyboardPath ? createFileUrl(job.storyboardPath) : null,
    logTail: job.logTail,
    exitCode: typeof job.exitCode === "number" ? job.exitCode : null,
    error: job.error || null,
    failureStage: getFailureStage(job),
    failureSummary: getFailureSummary(job),
    resumeAvailable,
    forceFailAvailable: ["queued", "running"].includes(String(job.status || "").trim().toLowerCase()),
    sceneRegenerateAvailable: !isPreview && job.status !== "completed" && firstMissingSceneNumber !== null,
    audioPrepAvailable: !isPreview && canPrepareAudioForJob(job) && getJobStepChecklist(job).steps.find((step) => step.key === "audio")?.status !== "completed",
    renderOnlyAvailable: !isPreview && canRenderOnlyForJob(job) && getJobStepChecklist(job).steps.find((step) => step.key === "render")?.status !== "completed",
    validateOnlyAvailable: !isPreview && canValidateOnlyForJob(job) && getJobStepChecklist(job).steps.find((step) => step.key === "qa")?.status !== "completed",
    nextMissingSceneNumber: job.status === "completed" ? null : firstMissingSceneNumber,
    stepChecklist: stepChecklist.steps,
    state,
    stage,
    rca,
    recommendedAction,
    caseSummary: buildCaseSummary({
      id: job.id,
      kind: "job",
      title: job.title,
      slug: job.slug,
      state,
      stage,
      rca,
      recommendedAction,
      updatedAt: job.updatedAt,
      channel: job.input?.channel || null,
      extra: {
        type: job.type,
        queueLane: job.queueLane || null,
        queuePosition: job.queuePosition ?? null,
        resumeAvailable,
        nextMissingSceneNumber: job.status === "completed" ? null : firstMissingSceneNumber
      }
    })
  };
};

const persistVideoMetadata = async () => {
  await mkdir(dataDir, {recursive: true});
  await writeJsonFile(videosFile, videoMetadata);
};

const getVideoMetadataKey = ({channel, slug}) => `${String(channel || "foiumaideia").trim()}:${slugify(slug)}`;

const getVideoMetadataEntry = ({channel, slug}) => {
  const key = getVideoMetadataKey({channel, slug});
  return videoMetadata[key] || {};
};

const saveVideoMetadataEntry = async ({channel, slug}, updates) => {
  const key = getVideoMetadataKey({channel, slug});
  const current = videoMetadata[key] || {};
  videoMetadata = {
    ...videoMetadata,
    [key]: {
      ...current,
      ...updates,
      channel,
      slug: slugify(slug),
      updatedAt: new Date().toISOString()
    }
  };
  await persistVideoMetadata();
  return videoMetadata[key];
};

const removeVideoMetadataEntry = async ({channel, slug}) => {
  const key = getVideoMetadataKey({channel, slug});
  if (!(key in videoMetadata)) {
    return;
  }

  const nextMetadata = {...videoMetadata};
  delete nextMetadata[key];
  videoMetadata = nextMetadata;
  await persistVideoMetadata();
};

const findLatestJobForSlug = ({slug, channel}) =>
  Array.from(jobs.values())
    .filter((job) => job.slug === slug && (!channel || job.input?.channel === channel))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())[0] || null;

const formatFallbackTitleFromSlug = (slug) =>
  String(slug || "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-/g, " ")
    .trim();

const getVideoDurationSeconds = (targetPath) => {
  try {
    return roundSeconds(ffprobeDurationSeconds(targetPath));
  } catch {
    return null;
  }
};

const normalizePlatforms = (value) => {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = list
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item) => AGENDADOR_DEFAULT_PLATFORMS.includes(item));
  return normalized.length > 0 ? [...new Set(normalized)] : [...AGENDADOR_DEFAULT_PLATFORMS];
};

const normalizePublishAt = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const createVideoRecord = async ({channel, fileName, filePath}) => {
  const details = await stat(filePath);
  const slug = path.basename(fileName, path.extname(fileName));
  const runPaths = getRunPaths(slug);
  const storyboard = await readJsonFile(runPaths.storyboardPath);
  const latestJob = findLatestJobForSlug({slug, channel: channel.value});
  const persistedMetadata = await readVideoMeta(slug).catch(() => null);
  const metadata = {
    ...getVideoMetadataEntry({channel: channel.value, slug}),
    ...(persistedMetadata || {})
  };
  const creationParams = latestJob?.input
    ? {
        language: latestJob.input.language || null,
        outputProfile: latestJob.input.outputProfile || null,
        targetSeconds: Number(latestJob.input.targetSeconds || 0) || null,
        imageModel: latestJob.input.imageModel || null,
        imageStyle: latestJob.input.imageStyle || null,
        tone: latestJob.input.tone || null,
        voice: latestJob.input.voice || null,
        channel: latestJob.input.channel || channel.value,
        channelHandle: latestJob.input.channelHandle || channel.handle,
        noMusic: latestJob.input.noMusic === true,
        force: latestJob.input.force === true,
        previewOnly: latestJob.input.previewOnly === true
      }
    : null;
  const title =
    String(metadata.title || "").trim() ||
    String(storyboard?.videoTitle || "").trim() ||
    String(latestJob?.title || "").trim() ||
    formatFallbackTitleFromSlug(slug);
  const caption = String(
    metadata.caption ??
    storyboard?.postCaption ??
    ""
  ).trim();
  const publishAt = normalizePublishAt(metadata.publishAt);
  const platforms = normalizePlatforms(metadata.platforms);

  return {
    id: getVideoMetadataKey({channel: channel.value, slug}),
    slug,
    name: fileName,
    title,
    caption,
    hook: String(storyboard?.hook || "").trim(),
    channel: channel.value,
    channelHandle: channel.handle,
    channelLabel: channel.label,
    filePath,
    url: createFileUrl(filePath),
    storyboardPath: (await fileExists(runPaths.storyboardPath)) ? runPaths.storyboardPath : "",
    storyboardUrl: (await fileExists(runPaths.storyboardPath)) ? createFileUrl(runPaths.storyboardPath) : "",
    updatedAt: details.mtime.toISOString(),
    sizeBytes: details.size,
    durationSeconds: getVideoDurationSeconds(filePath),
    platforms,
    publishAt,
    isDraft: metadata.isDraft === true,
    notes: String(metadata.notes || "").trim(),
    thumbnailPath: String(metadata.thumbnailPath || "").trim() || null,
    thumbnailUrl: String(metadata.thumbnailUrl || "").trim() || null,
    coverUrl: String(metadata.coverUrl || "").trim() || null,
    lastPostId: metadata.lastPostId ?? null,
    lastPublishedAt: metadata.lastPublishedAt || null,
    publishStatus: metadata.publishStatus || "",
    publishError: metadata.publishError || "",
    publishedProfile: metadata.publishedProfile || "",
    jobId: latestJob?.id || null,
    creationParams,
    canRedo: Boolean(latestJob || existsSync(runPaths.storyboardPath)),
    canDelete: true,
    canPublish: true
  };
};

const listAllExports = async () => {
  const videos = [];

  for (const channel of channelOptions) {
    const exportDir = getChannelExportDir(channel.value);
    const entries = await readdir(exportDir).catch(() => []);

    for (const entry of entries.filter((item) => item.endsWith(".mp4")).sort()) {
      const filePath = path.join(exportDir, entry);

      try {
        videos.push(await createVideoRecord({channel, fileName: entry, filePath}));
      } catch {
        continue;
      }
    }
  }

  return videos.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
};

const persistJobs = async () => {
  await mkdir(dataDir, {recursive: true});
  await writeFile(
    jobsFile,
    JSON.stringify(
      Array.from(jobs.values())
        .map((job) => sanitizeJob(job))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
      null,
      2
    )
  );
};

const slugToCaption = (source) => {
  const base = path.basename(String(source || ""), path.extname(String(source || "")));
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const text = withoutDate.replace(/-/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : base;
};

const getVideoMetaPath = (slug) => path.join(videoLibraryDir, `${slugify(slug) || "video"}.json`);

const readVideoMeta = async (slug) => readJsonFile(getVideoMetaPath(slug));

const writeVideoMeta = async (slug, payload) => {
  await mkdir(videoLibraryDir, {recursive: true});
  const normalizedSlug = slugify(slug);
  const channel = String(payload?.channel || "foiumaideia").trim() || "foiumaideia";
  const key = getVideoMetadataKey({channel, slug: normalizedSlug});
  const nextPayload = {
    ...(videoMetadata[key] || {}),
    ...payload,
    channel,
    slug: normalizedSlug,
    updatedAt: String(payload?.updatedAt || new Date().toISOString())
  };
  videoMetadata = {
    ...videoMetadata,
    [key]: nextPayload
  };
  await writeFile(getVideoMetaPath(normalizedSlug), JSON.stringify(nextPayload, null, 2));
};

const findJobForVideoPath = (targetPath) =>
  Array.from(jobs.values())
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .find((job) => {
      if (!job.outputPath) {
        return false;
      }

      const normalizedOutput = path.resolve(job.outputPath);
      const normalizedTarget = path.resolve(targetPath);
      return normalizedOutput === normalizedTarget || path.basename(normalizedOutput) === path.basename(normalizedTarget);
    }) || null;

const inferChannelValueFromPath = (targetPath) =>
  channelOptions.find((channel) => path.dirname(targetPath) === getChannelExportDir(channel.value))?.value || "";

const inferVideoSlug = (targetPath) => {
  const matchedJob = findJobForVideoPath(targetPath);

  if (matchedJob?.slug) {
    return matchedJob.slug;
  }

  return slugify(path.basename(targetPath, path.extname(targetPath)));
};

const parsePostText = (rawText) => {
  const parts = String(rawText || "")
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  const caption = parts[0] || "";
  const hashtags = (parts[1] || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return {caption, hashtags};
};

const getTikTokDraftPath = (draftId) => path.join(tiktokDraftsDir, `${slugify(draftId) || "draft"}.json`);

const readTikTokDraft = async (draftId) => readJsonFile(getTikTokDraftPath(draftId));

const writeTikTokDraft = async (draftId, payload) => {
  await mkdir(tiktokDraftsDir, {recursive: true});
  await writeFile(getTikTokDraftPath(draftId), JSON.stringify(payload, null, 2));
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildTikTokHelperHtml = (draft) => {
  const helperTitle = draft.title || draft.slug || "TikTok helper";
  const captionJson = JSON.stringify(String(draft.caption || ""));
  const downloadName = escapeHtml(draft.downloadName || `${draft.slug || "video"}.mp4`);
  const thumbDownloadName = escapeHtml(draft.thumbnailDownloadName || `${draft.slug || "thumbnail"}.png`);
  const videoLink = escapeHtml(draft.videoUrl || "#");
  const thumbLink = escapeHtml(draft.thumbnailUrl || "");
  const uploadUrl = "https://www.tiktok.com/upload";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(helperTitle)} • TikTok helper</title>
    <style>
      :root {
        --bg: #f4efe6;
        --ink: #14221e;
        --muted: #5e6d67;
        --card: rgba(255,252,246,.92);
        --line: rgba(20,34,30,.14);
        --primary: #0f7b6c;
        --shadow: 0 24px 60px rgba(20,34,30,.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(215,239,233,.9), transparent 38%),
          radial-gradient(circle at bottom right, rgba(241,198,160,.34), transparent 24%),
          var(--bg);
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI Variable", sans-serif;
      }
      main { max-width: 1180px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
      .hero, .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero { padding: 24px; display: grid; gap: 10px; }
      .eyebrow { margin: 0; color: var(--primary); font-size: .78rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); line-height: .95; }
      .lede { margin: 0; color: var(--muted); line-height: 1.6; max-width: 820px; }
      .layout { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: 18px; }
      .card { padding: 18px; display: grid; gap: 14px; align-content: start; }
      .preview-video, .preview-thumb { width: 100%; border-radius: 18px; border: 1px solid var(--line); background: #0f1412; }
      .preview-video { aspect-ratio: 9/16; object-fit: contain; }
      .preview-thumb { aspect-ratio: 9/16; object-fit: cover; }
      .meta { color: var(--muted); line-height: 1.55; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; }
      .button {
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        padding: 13px 18px;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .button.primary { background: var(--primary); color: white; }
      .button.secondary { background: transparent; border: 1px solid var(--line); color: var(--ink); }
      .caption-box {
        margin: 0;
        min-height: 280px;
        border-radius: 20px;
        background: #151a18;
        color: #f7f2e8;
        font: .92rem/1.6 ui-monospace, Menlo, monospace;
        padding: 18px;
        white-space: pre-wrap;
      }
      .hint { color: var(--muted); font-size: .92rem; line-height: 1.5; }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
        main { padding: 18px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">TikTok Helper</p>
        <h1>${escapeHtml(helperTitle)}</h1>
        <p class="lede">No browser do usuário, não dá para pré-carregar automaticamente o MP4 dentro do TikTok por segurança do navegador. Este helper deixa tudo pronto: abrir o TikTok, copiar a legenda e baixar o vídeo e a thumbnail com um clique.</p>
      </section>

      <section class="layout">
        <article class="card">
          <video class="preview-video" controls playsinline preload="metadata" src="${videoLink}"></video>
          <p class="meta">${escapeHtml(draft.channelHandle || draft.channel || "")} • ${escapeHtml(downloadName)}</p>
          <div class="actions">
            <a class="button primary" href="${uploadUrl}" target="_blank" rel="noreferrer">Abrir upload do TikTok</a>
            <a class="button secondary" href="${videoLink}" download="${downloadName}">Baixar MP4</a>
            ${thumbLink ? `<a class="button secondary" href="${thumbLink}" download="${thumbDownloadName}">Baixar thumbnail</a>` : ""}
          </div>
          <p class="hint">Fluxo sugerido: 1. abrir upload do TikTok, 2. baixar/soltar o MP4, 3. copiar a legenda, 4. usar a thumbnail como referência visual da capa.</p>
        </article>

        <article class="card">
          ${thumbLink ? `<img class="preview-thumb" src="${thumbLink}" alt="Thumbnail do vídeo">` : ""}
          <div class="actions">
            <button class="button primary" id="copyCaptionButton" type="button">Copiar descrição</button>
            ${draft.storyboardUrl ? `<a class="button secondary" href="${escapeHtml(draft.storyboardUrl)}" target="_blank" rel="noreferrer">Abrir storyboard</a>` : ""}
          </div>
          <pre class="caption-box" id="captionBox">${escapeHtml(draft.caption || "")}</pre>
        </article>
      </section>
    </main>

    <script>
      const captionText = ${captionJson};
      const copyButton = document.getElementById("copyCaptionButton");
      copyButton?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(captionText);
          copyButton.textContent = "Descrição copiada";
          setTimeout(() => { copyButton.textContent = "Copiar descrição"; }, 1800);
        } catch (error) {
          window.alert("Falha ao copiar a descrição.");
        }
      });
    </script>
  </body>
</html>`;
};

const resolveChannelValue = (value, fallback = "foiumaideia") => {
  const normalized = String(value || "").trim();
  return channelOptions.some((channel) => channel.value === normalized) ? normalized : fallback;
};

const resolveStoredThumbnailArtifacts = async ({slug, meta = {}}) => {
  const paths = getRunPaths(slug);
  const thumbnailMetadataCandidates = [
    path.join(paths.publicRunDir, "thumbnail.json"),
    path.join(paths.runDir, "thumbnail.json")
  ];
  let thumbnailMetadata = null;

  for (const candidate of thumbnailMetadataCandidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    thumbnailMetadata = await readJsonFile(candidate);
    if (thumbnailMetadata) {
      break;
    }
  }

  const localThumbnailCandidates = [
    String(meta?.thumbnailPath || "").trim(),
    thumbnailMetadata?.publicThumbnailPath ? path.resolve(projectRoot, thumbnailMetadata.publicThumbnailPath) : "",
    thumbnailMetadata?.thumbnailPath ? path.resolve(projectRoot, thumbnailMetadata.thumbnailPath) : "",
    path.join(paths.publicRunDir, "thumbnail.png"),
    path.join(paths.runDir, "thumbnail.png"),
    path.join(paths.assetDir, "_flux2_images", "scene-01-seg-01.png")
  ].filter(Boolean);

  const thumbnailPath = localThumbnailCandidates.find((candidate) => existsSync(candidate)) || "";
  const localThumbnailUrl = thumbnailPath ? createFileUrl(thumbnailPath) : "";
  const remoteThumbnailUrl = String(meta?.thumbnailUrl || "").trim();
  const remoteCoverUrl = String(meta?.coverUrl || "").trim();
  const thumbnailUrl = localThumbnailUrl || remoteThumbnailUrl;
  const coverUrl = localThumbnailUrl || remoteCoverUrl || remoteThumbnailUrl;
  const thumbnailLabel =
    String(thumbnailMetadata?.hook || "").trim() ||
    String(thumbnailMetadata?.title || "").trim() ||
    "";

  return {
    thumbnailPath: thumbnailPath || null,
    thumbnailUrl: thumbnailUrl || null,
    coverUrl: coverUrl || null,
    thumbnailLabel: thumbnailLabel || null
  };
};

const buildVideoRecord = async ({targetPath, channelValue}) => {
  const details = await stat(targetPath);
  const matchedJob = findJobForVideoPath(targetPath);
  const slug = inferVideoSlug(targetPath);
  const paths = getRunPaths(slug);
  const storyboardPath = matchedJob?.storyboardPath || (existsSync(paths.storyboardPath) ? paths.storyboardPath : "");
  const storyboard = storyboardPath ? await readJsonFile(storyboardPath) : null;
  const postText = existsSync(paths.postPath) ? await readTextFile(paths.postPath) : "";
  const postMeta = parsePostText(postText);
  const persistedMeta = await readVideoMeta(slug).catch(() => null);
  const channel = getChannelConfig(
    resolveChannelValue(persistedMeta?.channel || channelValue || matchedJob?.input?.channel || inferChannelValueFromPath(targetPath))
  );
  const meta = {
    ...getVideoMetadataEntry({channel: channel.value, slug}),
    ...(persistedMeta || {})
  };
  const thumbnail = await resolveStoredThumbnailArtifacts({slug, meta});
  const title =
    String(meta?.title || "").trim() ||
    String(storyboard?.videoTitle || "").trim() ||
    String(matchedJob?.title || "").trim() ||
    slugToCaption(targetPath);
  const caption =
    String(meta?.caption || "").trim() ||
    String(postMeta.caption || "").trim() ||
    "";
  const hashtags = Array.isArray(meta?.hashtags) && meta.hashtags.length > 0
    ? meta.hashtags
    : postMeta.hashtags;
  const platforms = Array.isArray(meta?.platforms) && meta.platforms.length > 0
    ? meta.platforms
    : ["FB", "IG", "YT"];
  const creationParams = matchedJob?.input
    ? {
        language: matchedJob.input.language || null,
        outputProfile: matchedJob.input.outputProfile || null,
        targetSeconds: Number(matchedJob.input.targetSeconds || 0) || null,
        imageModel: matchedJob.input.imageModel || null,
        imageStyle: matchedJob.input.imageStyle || null,
        tone: matchedJob.input.tone || null,
        voice: matchedJob.input.voice || null,
        channel: matchedJob.input.channel || channel.value,
        channelHandle: matchedJob.input.channelHandle || channel.handle,
        noMusic: matchedJob.input.noMusic === true,
        force: matchedJob.input.force === true,
        previewOnly: matchedJob.input.previewOnly === true
      }
    : null;

  return {
    id: `${slug}:${path.basename(targetPath)}`,
    name: path.basename(targetPath),
    path: targetPath,
    url: createFileUrl(targetPath),
    updatedAt: details.mtime.toISOString(),
    sizeBytes: details.size,
    durationSeconds: getVideoDurationSeconds(targetPath),
    slug,
    title,
    caption,
    hashtags,
    channel: channel.value,
    channelHandle: channel.handle,
    storyboardPath: storyboardPath || null,
    storyboardUrl: storyboardPath ? createFileUrl(storyboardPath) : null,
    canRefazer: Boolean(storyboardPath),
    canDelete: true,
    canPublish: true,
    scheduleAt: String(meta?.scheduleAt || "").trim(),
    platforms,
    isDraft: meta?.isDraft === true,
    thumbnailPath: thumbnail.thumbnailPath,
    thumbnailUrl: thumbnail.thumbnailUrl,
    coverUrl: thumbnail.coverUrl,
    thumbnailLabel: thumbnail.thumbnailLabel,
    publishedAt: meta?.publishedAt || null,
    publishedPostId: meta?.publishedPostId || null,
    lastPublishPlatforms: Array.isArray(meta?.lastPublishPlatforms) ? meta.lastPublishPlatforms : [],
    lastPublishStatus: meta?.lastPublishStatus || null,
    publishedProfile: meta?.publishedProfile || null,
    creationParams,
    state: getVideoStateInfo({
      publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true,
      publishedAt: meta?.publishedAt || null
    }),
    stage: getVideoStageInfo({
      publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true,
      publishedAt: meta?.publishedAt || null
    }),
    rca: getVideoRca({
      publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true,
      publishedAt: meta?.publishedAt || null,
      updatedAt: details.mtime.toISOString(),
      scheduleAt: String(meta?.scheduleAt || "").trim()
    }),
    recommendedAction: getVideoRecommendedAction({
      publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true,
      publishedAt: meta?.publishedAt || null
    }),
    caseSummary: buildVideoCaseSummary({
      id: `${slug}:${path.basename(targetPath)}`,
      slug,
      title,
      channel: channel.value,
      updatedAt: details.mtime.toISOString(),
      publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true,
      publishedAt: meta?.publishedAt || null,
      storyboardUrl: storyboardPath ? createFileUrl(storyboardPath) : null,
      thumbnailUrl: thumbnail.thumbnailUrl || null
    })
  };
};

const listExportVideos = async ({limit = null} = {}) => {
  const videos = [];

  for (const channel of channelOptions) {
    const exportDir = getChannelExportDir(channel.value);
    const entries = await readdir(exportDir).catch(() => []);

    for (const entry of entries.filter((item) => item.endsWith(".mp4"))) {
      const targetPath = path.join(exportDir, entry);

      try {
        videos.push(await buildVideoRecord({targetPath, channelValue: channel.value}));
      } catch {
        continue;
      }
    }
  }

  const sorted = videos.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  return Number.isInteger(limit) ? sorted.slice(0, Math.max(0, limit)) : sorted;
};

const getRetryStoryboardPathForJob = (job) => {
  const directPath = String(job?.storyboardPath || "").trim();

  if (directPath && existsSync(directPath)) {
    return directPath;
  }

  if (!job?.slug) {
    return "";
  }

  const fallbackPath = getRunPaths(job.slug).storyboardPath;
  return existsSync(fallbackPath) ? fallbackPath : "";
};

const canRetryFailedJobFromStoryboard = (job) =>
  job?.type === "generate" &&
  job?.status === "failed" &&
  job?.input?.previewOnly !== true &&
  Boolean(getRetryStoryboardPathForJob(job));

const listFailedLibraryJobs = async () => {
  return Array.from(jobs.values())
    .filter((job) => job.type === "generate" && job.status === "failed" && job.input?.previewOnly !== true)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map((job) => {
      const storyboardPath = getRetryStoryboardPathForJob(job);
      const channel = getChannelConfig(job.input?.channel);
      const state = getJobStateInfo(job);
      const stage = getJobStageInfo(job);
      const rca = getJobRca(job, stage);
      const recommendedAction = getJobRecommendedAction(job, stage, rca);

      return {
        id: job.id,
        title: job.title,
        slug: job.slug,
        channel: channel.value,
        channelHandle: channel.handle,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        failureStage: getFailureStage(job),
        failureSummary: getFailureSummary(job),
        error: job.error || "",
        storyboardPath: storyboardPath || "",
        storyboardUrl: storyboardPath ? createFileUrl(storyboardPath) : "",
        retryFromStoryboardAvailable: canRetryFailedJobFromStoryboard(job),
        previewOnly: Boolean(job.input?.previewOnly),
        targetSeconds: Number(job.input?.targetSeconds || 0) || null,
        outputProfile: job.input?.outputProfile || null,
        state,
        stage,
        rca,
        recommendedAction,
        caseSummary: buildCaseSummary({
          id: job.id,
          kind: "job",
          title: job.title,
          slug: job.slug,
          state,
          stage,
          rca,
          recommendedAction,
          updatedAt: job.updatedAt,
          channel: channel.value,
          extra: {
            retryFromStoryboardAvailable: canRetryFailedJobFromStoryboard(job),
            previewOnly: Boolean(job.input?.previewOnly),
            outputProfile: job.input?.outputProfile || null
          }
        })
      };
    });
};

const resolveVideoTarget = async ({slug, filePath}) => {
  const resolvedPath = filePath ? ensureAllowedFilePath(filePath) : "";

  if (resolvedPath) {
    return {
      slug: slugify(slug || inferVideoSlug(resolvedPath)),
      path: resolvedPath
    };
  }

  const normalizedSlug = slugify(slug);

  if (!normalizedSlug) {
    throw new Error("Informe o slug ou o caminho do video.");
  }

  const videos = await listExportVideos();
  const matched = videos.find((video) => video.slug === normalizedSlug);

  if (!matched) {
    throw new Error("Video nao encontrado.");
  }

  return {
    slug: normalizedSlug,
    path: matched.path
  };
};

const ensureAgendadorSecrets = async () => {
  const secretsModulePath = path.join(configuredVideoEngineRoot, "scripts", "lib", "secrets.mjs");
  const {loadSecretsIntoEnv} = await import(secretsModulePath);
  loadSecretsIntoEnv([
    "AGENDADOR_ONLINE_URL",
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD",
    "AGENDADOR_EMAIL",
    "AGENDADOR_USERNAME",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME",
    "AGENDADOR_ONLINE_QUIET2MIN_EMAIL",
    "AGENDADOR_ONLINE_QUIET2MIN_USERNAME",
    "AGENDADOR_ONLINE_ATE2MIN_EMAIL",
    "AGENDADOR_ONLINE_ATE2MIN_USERNAME",
    "FOIUMAIDEIA_URL",
    "FOIUMAIDEIA_USER"
  ]);
};

const agendadorFetch = async (endpoint, {method = "GET", token = "", body, form} = {}) => {
  const response = await fetch(`${AGENDADOR_API_BASE}${endpoint}`, {
    method,
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(body ? {"Content-Type": "application/json"} : {})
    },
    body: form ?? (body ? JSON.stringify(body) : undefined)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(payload?.error || `${method} ${endpoint} falhou com ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg falhou com code ${code}`));
    });
  });

const ensureUploadableForAgendador = async (inputPath) => {
  const maxBytes = AGENDADOR_MAX_UPLOAD_MB * 1024 * 1024;
  const current = await stat(inputPath);

  if (current.size <= maxBytes) {
    return {
      filePath: inputPath,
      compressed: false,
      size: current.size
    };
  }

  await mkdir(videoLibraryDir, {recursive: true});
  const outputPath = path.join(videoLibraryDir, `compressed-${path.basename(inputPath)}`);
  const attempts = [
    {videoBitrate: "1000k", audioBitrate: "96k"},
    {videoBitrate: "800k", audioBitrate: "80k"},
    {videoBitrate: "650k", audioBitrate: "64k"}
  ];

  for (const attempt of attempts) {
    await unlink(outputPath).catch(() => {});

    await runFfmpeg([
      "-i",
      inputPath,
      "-vf",
      "scale='min(720,iw)':-2:force_original_aspect_ratio=decrease",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      attempt.videoBitrate,
      "-maxrate",
      attempt.videoBitrate,
      "-bufsize",
      "2M",
      "-c:a",
      "aac",
      "-b:a",
      attempt.audioBitrate,
      "-movflags",
      "+faststart",
      outputPath
    ]);

    const compressed = await stat(outputPath);
    if (compressed.size <= maxBytes) {
      return {
        filePath: outputPath,
        compressed: true,
        size: compressed.size
      };
    }
  }

  throw new Error(`Nao consegui comprimir o video abaixo de ${AGENDADOR_MAX_UPLOAD_MB} MB para publicar.`);
};

const getAgendadorToken = async (channelValue) => {
  await ensureAgendadorSecrets();
  const profile = resolveAgendadorChannelProfile(channelValue);

  if (!profile.identifier || !profile.password) {
    throw new Error(`Faltam credenciais do agendador para ${profile.label}.`);
  }

  const auth = await agendadorFetch("/auth/login", {
    method: "POST",
    body: {
      identifier: profile.identifier,
      email: profile.identifier,
      password: profile.password
    }
  });
  const token = auth?.token;

  if (!token) {
    throw new Error("A autenticacao do agendador nao devolveu token.");
  }

  return token;
};

const uploadMediaToAgendador = async (token, filePath, mimeType) => {
  const prepared = await ensureUploadableForAgendador(filePath);
  const buffer = await readFile(prepared.filePath);
  const form = new FormData();
  form.set("file", new Blob([buffer], {type: mimeType}), path.basename(prepared.filePath));
  const payload = await agendadorFetch("/upload", {
    method: "POST",
    token,
    form
  });
  return payload?.url || "";
};

const uploadVideoToAgendador = async (token, filePath) => uploadMediaToAgendador(token, filePath, "video/mp4");

const getThumbnailMimeType = (filePath) => {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
};

const resolvePreferredThumbnailSource = async (targetPath, slug) => {
  const meta = await readVideoMeta(slug).catch(() => null);
  const stored = await resolveStoredThumbnailArtifacts({slug, meta: meta || {}});

  if (stored.thumbnailPath && existsSync(stored.thumbnailPath)) {
    return stored.thumbnailPath;
  }

  return "";
};

const ensurePublishThumbnail = async (targetPath, slug) => {
  const preferredThumbnailPath = await resolvePreferredThumbnailSource(targetPath, slug);

  if (preferredThumbnailPath) {
    return preferredThumbnailPath;
  }

  await mkdir(videoLibraryDir, {recursive: true});
  const thumbnailDir = path.join(videoLibraryDir, "thumbnails");
  await mkdir(thumbnailDir, {recursive: true});
  const thumbnailPath = path.join(thumbnailDir, `${slugify(slug)}.jpg`);
  const sourceStat = await stat(targetPath);
  const thumbnailStat = existsSync(thumbnailPath) ? await stat(thumbnailPath).catch(() => null) : null;

  if (thumbnailStat && thumbnailStat.mtimeMs >= sourceStat.mtimeMs) {
    return thumbnailPath;
  }

  const durationSeconds = getVideoDurationSeconds(targetPath);
  const seekSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(1.5, Math.min(8, durationSeconds * 0.12))
    : 2;

  await unlink(thumbnailPath).catch(() => {});
  await runFfmpeg([
    "-ss",
    seekSeconds.toFixed(2),
    "-i",
    targetPath,
    "-frames:v",
    "1",
    "-vf",
    "scale='min(1080,iw)':-2:force_original_aspect_ratio=decrease",
    "-q:v",
    "2",
    thumbnailPath
  ]);

  return thumbnailPath;
};

const uploadThumbnailToAgendador = async (token, filePath) => {
  if (!existsSync(filePath)) {
    return "";
  }

  return uploadMediaToAgendador(token, filePath, getThumbnailMimeType(filePath));
};

const isAccountPublishReady = (account) => {
  if (!account?.connected) {
    return false;
  }

  if (account?.publish_ready === false) {
    return false;
  }

  const status = String(account?.status || "").trim().toUpperCase();
  return !["NEEDS_RECONNECT", "RECONNECT", "DISCONNECTED", "FAILED"].includes(status);
};

const describeAccountPublishIssue = (account, provider) => {
  if (!account) {
    return `${provider} sem vinculo no agendador`;
  }

  if (!account.connected) {
    return `${provider} nao esta conectada`;
  }

  if (account.publish_ready === false) {
    return account.last_refresh_error || `${provider} nao esta pronta para publicar`;
  }

  const status = String(account.status || "").trim();
  if (status && !["CONNECTED", "READY", "PUBLISH_READY"].includes(status.toUpperCase())) {
    return account.last_refresh_error || `${provider} com status ${status}`;
  }

  return `${provider} nao esta pronta para publicar`;
};

const schedulePersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistJobs().catch((error) => {
      process.stderr.write(`Falha ao persistir jobs: ${error.message}\n`);
    });
  }, 150);
};

const getJobQueueLane = (job) =>
  job?.type === "generate" && job?.input?.previewOnly ? PREVIEW_QUEUE_LANE : HEAVY_QUEUE_LANE;

const getQueueForLane = (lane) => (lane === PREVIEW_QUEUE_LANE ? previewQueue : heavyQueue);

const getActiveJobIdForLane = (lane) => (lane === PREVIEW_QUEUE_LANE ? activePreviewJobId : activeHeavyJobId);

const setActiveJobIdForLane = (lane, jobId) => {
  if (lane === PREVIEW_QUEUE_LANE) {
    activePreviewJobId = jobId;
    return;
  }

  activeHeavyJobId = jobId;
};

const getQueueLengths = () => ({
  previewQueueLength: previewQueue.length,
  heavyQueueLength: heavyQueue.length,
  queueLength: previewQueue.length + heavyQueue.length
});

const removeJobFromQueues = (jobId) => {
  const previewIndex = previewQueue.indexOf(jobId);
  if (previewIndex >= 0) {
    previewQueue.splice(previewIndex, 1);
  }

  const heavyIndex = heavyQueue.indexOf(jobId);
  if (heavyIndex >= 0) {
    heavyQueue.splice(heavyIndex, 1);
  }
};

const failJobAndReleaseQueue = (job, errorMessage) => {
  const lane = job.queueLane || getJobQueueLane(job);
  const nowIso = toIsoNow();

  removeJobFromQueues(job.id);
  if (getActiveJobIdForLane(lane) === job.id) {
    setActiveJobIdForLane(lane, null);
  }

  job.status = "failed";
  job.error = errorMessage;
  job.completedAt = nowIso;
  job.updatedAt = nowIso;
  job.heartbeatAt = nowIso;
  job.queuePosition = null;
  job.stageValue = getFailureStage(job) || job.stageValue || "pipeline";
  job.stageSource = "system";
  job.stageConfidence = "high";
  job.stageUpdatedAt = nowIso;

  if (typeof job.exitCode !== "number") {
    job.exitCode = 1;
  }

  clearJobProcess(job);
  appendLog(job, errorMessage, "stderr");
  refreshQueuePositions();
  schedulePersist();
  startQueueWorker(lane).catch((error) => {
    process.stderr.write(`Falha ao reiniciar fila ${lane} apos liberar job ${job.id}: ${error.message}\n`);
  });
};

const sendEvent = (response, event, payload) => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const broadcastJob = (job) => {
  const payload = sanitizeJob(job);
  const subscribers = streams.get(job.id);

  if (subscribers) {
    for (const response of subscribers) {
      try {
        sendEvent(response, "update", payload);
      } catch {
        subscribers.delete(response);
      }
    }
  }

  schedulePersist();
};

const updateJobHeartbeat = (job) => {
  job.heartbeatAt = toIsoNow();
};

const setJobStage = (job, stageValue, source = "system", confidence = "high") => {
  if (!stageValue) {
    return;
  }

  const nowIso = toIsoNow();
  const changed =
    job.stageValue !== stageValue ||
    job.stageSource !== source ||
    job.stageConfidence !== confidence;

  job.stageValue = stageValue;
  job.stageSource = source;
  job.stageConfidence = confidence;
  job.stageUpdatedAt = nowIso;
  job.heartbeatAt = nowIso;

  if (changed) {
    job.updatedAt = nowIso;
  }
};

const registerJobProcess = (job, child) => {
  if (!child?.pid) {
    return;
  }

  jobProcesses.set(job.id, child);
  job.processId = child.pid;
  job.processStartedAt = toIsoNow();
  updateJobHeartbeat(job);
};

const clearJobProcess = (job) => {
  jobProcesses.delete(job.id);
  job.processId = null;
};

const collectDescendantPids = (pid, seen = new Set()) => {
  if (!pid || seen.has(pid)) {
    return [];
  }

  seen.add(pid);
  const result = spawnSync("pgrep", ["-P", String(pid)], {encoding: "utf8"});
  const childPids = String(result.stdout || "")
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);

  const descendants = [];
  for (const childPid of childPids) {
    descendants.push(childPid, ...collectDescendantPids(childPid, seen));
  }

  return descendants;
};

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const terminateJobProcessTree = async (job) => {
  const pid = Number(job?.processId || 0);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  const pids = [...new Set([...collectDescendantPids(pid), pid])].filter((value) => value > 0).reverse();
  if (pids.length === 0) {
    return false;
  }

  for (const targetPid of pids) {
    try {
      process.kill(targetPid, "SIGTERM");
    } catch {}
  }

  await wait(800);

  for (const targetPid of pids) {
    if (!isPidAlive(targetPid)) {
      continue;
    }

    try {
      process.kill(targetPid, "SIGKILL");
    } catch {}
  }

  clearJobProcess(job);
  return true;
};

const refreshQueuePositions = () => {
  const queuedPreviewIds = previewQueue.filter((jobId) => jobs.get(jobId)?.status === "queued");
  const queuedHeavyIds = heavyQueue.filter((jobId) => jobs.get(jobId)?.status === "queued");

  for (const job of jobs.values()) {
    const lane = job.queueLane || getJobQueueLane(job);
    job.queueLane = lane;

    if (job.status !== "queued") {
      job.queuePosition = null;
      continue;
    }

    const queuedIds = lane === PREVIEW_QUEUE_LANE ? queuedPreviewIds : queuedHeavyIds;
    job.queuePosition = queuedIds.indexOf(job.id) + 1;
  }

  for (const job of jobs.values()) {
    broadcastJob(job);
  }
};

const appendLog = (job, chunk, source) => {
  const prefix = source === "stderr" ? "[stderr] " : "";
  const lines = String(chunk || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    return;
  }

  job.logTail.push(...lines.map((line) => `${prefix}${line}`));

  if (job.logTail.length > MAX_LOG_LINES) {
    job.logTail = job.logTail.slice(-MAX_LOG_LINES);
  }

  updateJobHeartbeat(job);

  if (String(job.status || "").trim().toLowerCase() === "running") {
    const inferredStage = inferJobStageValue(job);
    if (inferredStage && inferredStage !== job.stageValue) {
      setJobStage(job, inferredStage, "log", "medium");
    }
  }

  broadcastJob(job);
};

const updateJob = (job, updates) => {
  const nowIso = toIsoNow();
  Object.assign(job, updates, {updatedAt: nowIso});
  job.heartbeatAt = nowIso;
  broadcastJob(job);
};

const combineStylePrompt = ({language, tone, customStylePrompt}) => {
  const preset = tonePresets[tone] || tonePresets.natural_clean;
  const fallbackLanguage = String(language || "pt-BR").startsWith("en") ? "en-US" : "pt-BR";
  const basePrompt = preset.voiceStyles[fallbackLanguage];
  const customPrompt = String(customStylePrompt || "").trim();

  if (!customPrompt) {
    return basePrompt;
  }

  if (!basePrompt) {
    return customPrompt;
  }

  return `${basePrompt}, ${customPrompt}`;
};

const resolveChannelCustomStylePrompt = ({channelPreset, language}) => {
  const fallbackLanguage = String(language || "pt-BR").startsWith("en") ? "en-US" : "pt-BR";

  if (channelPreset?.customStylePromptByLanguage?.[fallbackLanguage]) {
    return String(channelPreset.customStylePromptByLanguage[fallbackLanguage] || "").trim();
  }

  return String(channelPreset?.customStylePrompt || "").trim();
};

const buildProfileRuntimeEnv = (profileValue, targetSeconds) => {
  const profile = resolveOutputProfileConfig(profileValue);
  const numericTargetSeconds = Number(targetSeconds);
  let minScenes = profile.minScenes;
  let maxScenes = profile.maxScenes;

  if (profile.id === "vertical-short") {
    if (numericTargetSeconds <= 60) {
      minScenes = 10;
      maxScenes = 12;
    } else if (numericTargetSeconds <= 90) {
      minScenes = 12;
      maxScenes = 14;
    } else {
      minScenes = 14;
      maxScenes = 16;
    }
  }

  return {
    OUTPUT_PROFILE: profile.id,
    RENDER_COMPOSITION_ID: profile.compositionId,
    OUTPUT_WIDTH: String(profile.width),
    OUTPUT_HEIGHT: String(profile.height),
    MIN_SCENE_COUNT: String(minScenes),
    MAX_SCENE_COUNT: String(maxScenes),
    TARGET_DURATION_SECONDS: String(
      Number.isFinite(Number(targetSeconds)) ? Number(targetSeconds) : profile.defaultTargetSeconds
    )
  };
};

const getProfileTargetSeconds = (profileValue, requestedTargetSeconds) => {
  const profile = resolveOutputProfileConfig(profileValue);
  const numericTarget = Number(requestedTargetSeconds);

  if (Number.isFinite(numericTarget) && numericTarget > 0) {
    return numericTarget;
  }

  return profile.defaultTargetSeconds;
};

const createGenerateJobCommand = (job) => {
  const exportDir = getChannelExportDir(job.input.channel);
  const profile = resolveOutputProfileConfig(job.input.outputProfile);
  const args = [
    path.join(projectRoot, "scripts", "foiumaideia.mjs"),
    "--title",
    job.title,
    "--slug",
    job.slug,
    "--output-profile",
    profile.id,
    "--target-seconds",
    String(job.input.targetSeconds),
    "--project-root",
    configuredVideoEngineRoot,
    "--export-dir",
    exportDir,
    "--language",
    job.input.language,
    "--voice",
    job.input.voice,
    "--image-style",
    job.input.imageStyle,
    "--style-prompt",
    job.input.stylePrompt,
    "--script-guidance",
    job.input.scriptGuidance,
    "--no-open"
  ];

  if (job.input.previewOnly) {
    args.push("--preview-only");
  }

  if (job.input.force) {
    args.push("--force");
  }

  if (job.input.channelHandle) {
    args.push("--channel-handle", job.input.channelHandle);
  }

  if (job.input.sourceTextFile) {
    args.push("--source-text-file", job.input.sourceTextFile);
  }

  if (job.input.storyboardFile) {
    args.push("--storyboard-file", job.input.storyboardFile);
  }

  if (job.input.noMusic) {
    args.push("--no-music");
  }

  return {
    command: "node",
    args,
    cwd: projectRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds),
      IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GOOGLE_IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      DEFAULT_OPEN: "false"
    }
  };
};

const createRerenderJobCommand = (job) => {
  // Legacy path kept for compatibility, though rerender is not exposed in the current UI.
  const profile = resolveOutputProfileConfig(job.input.outputProfile);

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug",
      job.slug,
      "--output-profile",
      profile.id,
      "--voice",
      job.input.voice,
      "--style-prompt",
      job.input.stylePrompt
    ],
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      DEFAULT_OPEN: "false"
    }
  };
};

const createAudioPrepJobCommand = (job) => {
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug",
      job.slug,
      "--output-profile",
      profile.id,
      "--voice",
      job.input.voice,
      "--style-prompt",
      job.input.stylePrompt,
      "--no-render"
    ],
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds || profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      DEFAULT_OPEN: "false"
    }
  };
};

const createRenderOnlyJobCommand = (job) => {
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug",
      job.slug,
      "--output-profile",
      profile.id,
      "--voice",
      job.input.voice,
      "--style-prompt",
      job.input.stylePrompt,
      "--reuse-existing-audio"
    ],
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds || profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      DEFAULT_OPEN: "false"
    }
  };
};

const createValidateOnlyJobCommand = (job) => {
  const args = [
    path.join(configuredVideoEngineRoot, "scripts", "validate-run.mjs"),
    "--slug",
    job.slug
  ];
  const targetSeconds = Number(job.input.targetSeconds);
  if (Number.isFinite(targetSeconds) && targetSeconds > 0) {
    args.push("--target-seconds", String(targetSeconds));
  }

  return {
    command: "node",
    args,
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      DEFAULT_OPEN: "false"
    }
  };
};

const createSceneRegenerateJobCommand = (job) => {
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);
  const sceneNumber = Number(job.input.sceneNumber);

  return {
    command: "node",
    args: [
      path.join(projectRoot, "scripts", "generate-flux2-assets.mjs"),
      "--storyboard-file",
      job.input.storyboardFile,
      "--slug",
      job.slug,
      "--style-preset",
      job.input.imageStyle || DEFAULT_VISUAL_STYLE_PRESET,
      "--scene-number",
      String(sceneNumber),
      "--force"
    ],
    cwd: projectRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds),
      IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GOOGLE_IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      OUTPUT_PROFILE: profile.id,
      DEFAULT_OPEN: "false"
    }
  };
};

const finalizeGenerateJob = async (job) => {
  const exportDir = getChannelExportDir(job.input.channel);
  const storyboardPath = job.input.storyboardFile
    ? path.resolve(job.input.storyboardFile)
    : path.join(configuredVideoEngineRoot, "runs", job.slug, "storyboard.json");

  if (job.input.previewOnly) {
    job.storyboardPath = storyboardPath;
    job.outputPath = storyboardPath;
    return;
  }

  job.storyboardPath = storyboardPath;
  job.outputPath = await resolveLocalizedExportPath({
    exportDir,
    slug: job.slug,
    fallbackTitle: job.title,
    storyboardPath
  });
};

const finalizeRerenderJob = async (job) => {
  const outPath = path.join(configuredVideoEngineRoot, "out", `${job.slug}.mp4`);
  const exportDir = getChannelExportDir(job.input.channel);
  const storyboardPath = path.join(configuredVideoEngineRoot, "runs", job.slug, "storyboard.json");
  const finalPath = await resolveLocalizedExportPath({
    exportDir,
    slug: job.slug,
    fallbackTitle: job.title,
    storyboardPath
  });

  await mkdir(exportDir, {recursive: true});
  await copyFile(outPath, finalPath);
  job.outputPath = finalPath;
  job.storyboardPath = storyboardPath;
};

const finalizeAudioPrepJob = async (job) => {
  const paths = getRunPaths(job.slug);
  job.storyboardPath = paths.storyboardPath;
  job.outputPath = isFreshArtifactForJob(paths.publicAudioPath, job) ? paths.publicAudioPath : paths.voiceoverPath;
};

const finalizeValidateOnlyJob = async (job) => {
  const paths = getRunPaths(job.slug);
  job.storyboardPath = paths.storyboardPath;
  job.outputPath = isFreshArtifactForJob(paths.outPath, job) ? paths.outPath : null;
};

const finalizeSceneRegenerateJob = async (job) => {
  const sceneNumber = Number(job.input.sceneNumber);
  const sceneNum = String(sceneNumber).padStart(2, "0");
  const paths = getRunPaths(job.slug);
  job.storyboardPath = resolveEffectiveStoryboardPath(job);
  job.outputPath = path.join(paths.assetDir, `scene-${sceneNum}.mp4`);
  const shouldAutoContinue = job.input?.autoContinueAfterSceneRepair !== false;

  const sourceLikeJob = getRecoverySourceJob(job) || {
    ...job,
    type: "generate",
    status: "failed"
  };
  const missingAfterRepair = getFirstMissingSceneNumber(sourceLikeJob);

  if (shouldAutoContinue && missingAfterRepair !== null) {
    const chainedSceneJob = {
      id: createId(),
      type: "scene-regenerate",
      title: job.title,
      slug: job.slug,
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logTail: [`[scene-repair] continuando automaticamente na cena ${missingAfterRepair} depois da cena ${sceneNumber}`],
      input: {
        ...job.input,
        sceneNumber: missingAfterRepair
      },
      outputPath: null,
      storyboardPath: paths.storyboardPath,
      artifactEpochAt: job.artifactEpochAt || job.createdAt,
      exitCode: null,
      error: null
    };
    const enqueued = enqueueJob(chainedSceneJob);
    job.followUpJobId = enqueued.id;
    appendLog(job, `[scene-repair] cena ${sceneNumber} concluida; proxima cena faltante ${missingAfterRepair}. follow-up ${enqueued.id}\n`);
    return;
  }

  if (!shouldAutoContinue && missingAfterRepair !== null) {
    appendLog(job, `[scene-repair] cena ${sceneNumber} concluida; auto-continue desativado. proxima cena faltante ${missingAfterRepair}\n`);
    return;
  }

  const stepChecklist = getJobStepChecklist(sourceLikeJob);
  const stepMap = Object.fromEntries(stepChecklist.steps.map((step) => [step.key, step]));
  let followUpJob = null;

  if (shouldAutoContinue && canPrepareAudioForJob(sourceLikeJob) && stepMap.audio?.status !== "completed") {
    followUpJob = buildAudioPrepJob(sourceLikeJob, {autoContinueRecovery: true});
    appendLog(job, "[scene-repair] todas as cenas prontas; proximo passo: gerar audio\n");
  } else if (shouldAutoContinue && canRenderOnlyForJob(sourceLikeJob) && stepMap.render?.status !== "completed") {
    followUpJob = buildRenderOnlyJob(sourceLikeJob, {autoContinueRecovery: true});
    appendLog(job, "[scene-repair] todas as cenas prontas; proximo passo: renderizar\n");
  } else if (shouldAutoContinue && canValidateOnlyForJob(sourceLikeJob) && stepMap.qa?.status !== "completed") {
    followUpJob = buildValidateOnlyJob(sourceLikeJob);
    appendLog(job, "[scene-repair] video ja existe; proximo passo: validar QA\n");
  } else if (shouldAutoContinue && hasBasicResumeArtifacts(sourceLikeJob)) {
    followUpJob = buildResumedGenerateJob(sourceLikeJob);
    appendLog(job, "[scene-repair] todas as cenas prontas; retomando com artefatos existentes\n");
  } else if (shouldAutoContinue && existsSync(paths.storyboardPath)) {
    followUpJob = await buildRetryFromStoryboardGenerateJob(sourceLikeJob);
    appendLog(job, "[scene-repair] fallback: reenfileirando a partir do storyboard\n");
  }

  if (!followUpJob) {
    appendLog(job, "[scene-repair] nenhuma continuacao automatica foi necessaria\n");
    return;
  }

  const enqueued = enqueueJob(followUpJob);
  job.followUpJobId = enqueued.id;
  appendLog(job, `[scene-repair] follow-up job ${enqueued.id} criado\n`);
};

const writeResumeArtifacts = async ({job, storyboard, voiceover, assetPlan, renderProps, timedWords, audioDurationSeconds}) => {
  const paths = getRunPaths(job.slug);
  const voiceoverPayload = {
    ...voiceover,
    provider: voiceover.provider || "resume-fallback",
    timingSource: voiceover.timedWords?.length ? "existing" : "resume-fallback",
    timedWords,
    sceneTimingAnalysis: analyzeSceneSpeechPacing({
      scenes: assetPlan,
      timedWords,
      audioDurationSeconds,
      sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : []
    })
  };

  await mkdir(paths.runDir, {recursive: true});
  await mkdir(paths.publicAudioDir, {recursive: true});
  await mkdir(paths.publicVideoDir, {recursive: true});
  await writeFile(paths.assetPlanPath, JSON.stringify(assetPlan, null, 2));
  await writeFile(paths.voiceoverPath, JSON.stringify(voiceoverPayload, null, 2));
  await writeFile(paths.renderPropsPath, JSON.stringify(renderProps, null, 2));
  await writeFile(
    paths.postPath,
    `${String(storyboard.postCaption || "").trim()}\n\n${Array.isArray(storyboard.hashtags) ? storyboard.hashtags.join(" ") : ""}\n`
  );

  return voiceoverPayload;
};

const runResumedGenerateJob = async (job) => {
  const paths = getRunPaths(job.slug);
  const outputProfile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);
  updateJob(job, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null
  });
  setJobStage(job, "resume");

  appendLog(job, `[resume] retomando a partir de ${job.input.resumeFromJobId || "artefatos existentes"}\n`);
  appendLog(job, `[resume] run=${job.slug} profile=${outputProfile.id} channel=${job.input.channel || "unknown"}\n`);

  try {
    const storyboard = await readJsonFile(paths.storyboardPath);
    if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
      throw new Error(`Storyboard ausente ou invalido em ${paths.storyboardPath}`);
    }

    const voiceover = await readJsonFile(paths.voiceoverPath);
    if (!voiceover) {
      throw new Error(`voiceover.json ausente em ${paths.voiceoverPath}`);
    }

    if (!isFreshArtifactForJob(paths.publicAudioPath, job)) {
      throw new Error(`voiceover.mp3 ausente em ${paths.publicAudioPath}`);
    }

    const audioDurationSeconds = ffprobeDurationSeconds(paths.publicAudioPath);
    const assetPlan = await buildResumeAssetPlan({
      slug: job.slug,
      storyboard,
      publicVideoDir: paths.publicVideoDir,
      assetDir: paths.assetDir
    });

    const timedWords =
      Array.isArray(voiceover.timedWords) && voiceover.timedWords.length > 0
        ? voiceover.timedWords
        : buildFallbackTimedWords({
            scenes: storyboard.scenes,
            sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : [],
            audioDurationSeconds,
            text: voiceover.text || ""
          });

    if (timedWords.length === 0) {
      throw new Error("Nao foi possivel reconstruir timedWords para a retomada.");
    }

    const renderProps = buildResumeRenderProps({
      slug: job.slug,
      job,
      storyboard,
      voiceover,
      assetPlan,
      timedWords,
      audioDurationSeconds,
      outputProfile
    });

    await writeResumeArtifacts({
      job,
      storyboard,
      voiceover,
      assetPlan,
      renderProps,
      timedWords,
      audioDurationSeconds
    });
    updateJob(job, {storyboardPath: paths.storyboardPath});

    appendLog(
      job,
      `[resume] artefatos reaproveitados: ${assetPlan.length} clips, ${timedWords.length} palavras, audio=${audioDurationSeconds.toFixed(2)}s\n`
    );
    appendLog(job, "[resume] a renderizar no Remotion com props reconstruidos\n");

    await mkdir(path.dirname(paths.outPath), {recursive: true});

    const child = spawn(
      "npx",
      [
        "remotion",
        "render",
        "src/index.ts",
        outputProfile.compositionId,
        paths.outPath,
        `--props=${JSON.stringify(renderProps)}`,
        `--timeout=${process.env.REMOTION_TIMEOUT_MS || "1800000"}`,
        `--concurrency=${process.env.REMOTION_CONCURRENCY || "2"}`,
        `--scale=${process.env.REMOTION_SCALE || "0.75"}`,
        `--video-bitrate=${process.env.REMOTION_VIDEO_BITRATE || "9M"}`,
        `--audio-bitrate=${process.env.REMOTION_AUDIO_BITRATE || "256k"}`,
        `--x264-preset=${process.env.REMOTION_X264_PRESET || "medium"}`
      ],
      {
        cwd: configuredVideoEngineRoot,
        env: {
          ...baseChildEnv,
          CI: "1",
          NO_COLOR: "1",
          FORCE_COLOR: "0"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    registerJobProcess(job, child);
    setJobStage(job, "render");

    const collect = (chunk, source) => appendLog(job, chunk, source);
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

    const exitCode = await new Promise((resolve) => {
      child.on("error", (error) => {
        clearJobProcess(job);
        updateJob(job, {
          status: "failed",
          completedAt: new Date().toISOString(),
          processId: null,
          exitCode: null,
          error: error.message
        });
        resolve(1);
      });

      child.on("close", (code) => {
        resolve(typeof code === "number" ? code : 1);
      });
    });

    job.exitCode = exitCode;
    job.completedAt = new Date().toISOString();
    clearJobProcess(job);

    if (exitCode !== 0) {
      updateJob(job, {
        status: "failed",
        error: job.logTail.at(-1) || `Retomada terminou com codigo ${exitCode}`
      });
      return;
    }

    const exportDir = getChannelExportDir(job.input.channel);
    const finalPath = await resolveLocalizedExportPath({
      exportDir,
      slug: job.slug,
      fallbackTitle: storyboard.videoTitle || job.title,
      storyboardPath: paths.storyboardPath
    });

    await mkdir(exportDir, {recursive: true});
    await copyFile(paths.outPath, finalPath);
    updateJob(job, {
      status: "completed",
      outputPath: finalPath,
      storyboardPath: paths.storyboardPath,
      error: null
    });
    setJobStage(job, "completed");
    appendLog(job, `[resume] finalizado em ${finalPath}\n`);
  } catch (error) {
    clearJobProcess(job);
    updateJob(job, {
      status: "failed",
      completedAt: new Date().toISOString(),
      exitCode: typeof job.exitCode === "number" ? job.exitCode : null,
      error: error instanceof Error ? error.message : String(error)
    });
    appendLog(job, `[resume] falhou: ${error instanceof Error ? error.message : String(error)}\n`);
  }
};

const executeChildProcess = async (job, processConfig) => {
  updateJob(job, {
    status: "running",
    startedAt: new Date().toISOString(),
    error: null
  });
  setJobStage(
    job,
    job.type === "audio-prep"
      ? "audio"
      : job.type === "render-only"
        ? "render"
        : job.type === "validate-only"
          ? "qa"
          : job.type === "scene-regenerate"
            ? "pipeline"
            : "pipeline"
  );

  return new Promise((resolve) => {
    const child = spawn(processConfig.command, processConfig.args, {
      cwd: processConfig.cwd,
      env: processConfig.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    registerJobProcess(job, child);

    child.stdout.on("data", (chunk) => appendLog(job, chunk, "stdout"));
    child.stderr.on("data", (chunk) => appendLog(job, chunk, "stderr"));

    child.on("error", (error) => {
      clearJobProcess(job);
      updateJob(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message
      });
      resolve();
    });

    child.on("close", async (code) => {
      job.exitCode = typeof code === "number" ? code : null;
      job.completedAt = new Date().toISOString();
      clearJobProcess(job);

      if (code === 0) {
        try {
          if (job.type === "generate") {
            await finalizeGenerateJob(job);
          } else if (job.type === "scene-regenerate") {
            await finalizeSceneRegenerateJob(job);
          } else if (job.type === "audio-prep") {
            await finalizeAudioPrepJob(job);
          } else if (job.type === "render-only") {
            await finalizeRerenderJob(job);
          } else if (job.type === "validate-only") {
            await finalizeValidateOnlyJob(job);
          } else {
            await finalizeRerenderJob(job);
          }

          updateJob(job, {status: "completed"});
          setJobStage(job, "completed");

          if (job.input?.autoContinueRecovery === true) {
            const sourceJob = getRecoverySourceJob(job) || job;
            let followUpJob = null;

            if (job.type === "audio-prep" && canRenderOnlyForJob(sourceJob) && !isFreshArtifactForJob(getRunPaths(sourceJob.slug).outPath, sourceJob)) {
              followUpJob = buildRenderOnlyJob(sourceJob, {autoContinueRecovery: true});
            } else if (job.type === "render-only" && canValidateOnlyForJob(sourceJob) && !isQaPassedForSlug(sourceJob.slug)) {
              followUpJob = buildValidateOnlyJob(sourceJob);
            }

            if (followUpJob) {
              const enqueued = enqueueJob(followUpJob);
              job.followUpJobId = enqueued.id;
              appendLog(job, `[recovery] follow-up enfileirado: ${enqueued.id}\n`);
            }
          }
        } catch (error) {
          updateJob(job, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        updateJob(job, {
          status: "failed",
          error: job.logTail.at(-1) || `Processo terminou com codigo ${code}`
        });
      }

      resolve();
    });
  });
};

let isProcessingPreviewQueue = false;
let isProcessingHeavyQueue = false;

const isLaneProcessing = (lane) => (lane === PREVIEW_QUEUE_LANE ? isProcessingPreviewQueue : isProcessingHeavyQueue);

const setLaneProcessing = (lane, processing) => {
  if (lane === PREVIEW_QUEUE_LANE) {
    isProcessingPreviewQueue = processing;
    return;
  }

  isProcessingHeavyQueue = processing;
};

const startQueueWorker = async (lane) => {
  const queue = getQueueForLane(lane);

  if (isLaneProcessing(lane) || getActiveJobIdForLane(lane) || queue.length === 0) {
    refreshQueuePositions();
    return;
  }

  setLaneProcessing(lane, true);

  try {
    while (queue.length > 0) {
      const nextJobId = queue.shift();
      const job = jobs.get(nextJobId);

      if (!job) {
        continue;
      }

      setActiveJobIdForLane(lane, job.id);
      refreshQueuePositions();

      try {
        if (job.type === "generate" && job.input?.resumeFromJobId) {
          await runResumedGenerateJob(job);
        } else if (job.type === "generate") {
          const processConfig = createGenerateJobCommand(job);
          await executeChildProcess(job, processConfig);
        } else if (job.type === "scene-regenerate") {
          const processConfig = createSceneRegenerateJobCommand(job);
          await executeChildProcess(job, processConfig);
        } else if (job.type === "audio-prep") {
          const processConfig = createAudioPrepJobCommand(job);
          await executeChildProcess(job, processConfig);
        } else if (job.type === "render-only") {
          const processConfig = createRenderOnlyJobCommand(job);
          await executeChildProcess(job, processConfig);
        } else if (job.type === "validate-only") {
          const processConfig = createValidateOnlyJobCommand(job);
          await executeChildProcess(job, processConfig);
        } else {
          const processConfig = createRerenderJobCommand(job);
          await executeChildProcess(job, processConfig);
        }
      } finally {
        setActiveJobIdForLane(lane, null);
        refreshQueuePositions();
      }
    }
  } finally {
    setLaneProcessing(lane, false);
  }
};

const enqueueJob = (job) => {
  const nowIso = toIsoNow();
  job.queueLane = getJobQueueLane(job);
  job.createdAt = job.createdAt || nowIso;
  job.updatedAt = nowIso;
  job.heartbeatAt = job.heartbeatAt || nowIso;
  job.artifactEpochAt = job.artifactEpochAt || job.createdAt || nowIso;
  job.stageValue = job.stageValue || "queue";
  job.stageSource = job.stageSource || "system";
  job.stageConfidence = job.stageConfidence || "high";
  job.stageUpdatedAt = job.stageUpdatedAt || nowIso;
  jobs.set(job.id, job);
  getQueueForLane(job.queueLane).push(job.id);
  refreshQueuePositions();
  schedulePersist();
  startQueueWorker(job.queueLane).catch((error) => {
    process.stderr.write(`Falha ao iniciar job ${job.id}: ${error.message}\n`);
  });
  return sanitizeJob(job);
};

const listRecentExports = async () => listExportVideos({limit: 3});

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {"Content-Type": "application/json; charset=utf-8"});
  response.end(JSON.stringify(payload));
};

const readRequestBody = async (request) => {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;

    if (totalBytes > MAX_BODY_BYTES) {
      throw new Error("Payload muito grande.");
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  return rawBody ? JSON.parse(rawBody) : {};
};

const allowedRoots = [projectRoot, configuredVideoEngineRoot, postarRoot, dataDir].filter(Boolean);

const ensureAllowedFilePath = (rawPath) => {
  const resolved = path.resolve(String(rawPath || ""));

  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );

  if (!isAllowed) {
    throw new Error("Caminho fora das pastas permitidas.");
  }

  return resolved;
};

const parseRangeHeader = (rangeHeader, fileSize) => {
  const match = String(rangeHeader || "").match(/^bytes=(\d*)-(\d*)$/i);

  if (!match) {
    return null;
  }

  const startRaw = match[1];
  const endRaw = match[2];

  let start = startRaw ? Number.parseInt(startRaw, 10) : NaN;
  let end = endRaw ? Number.parseInt(endRaw, 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) {
    return null;
  }

  if (Number.isNaN(start)) {
    const suffixLength = Math.max(0, end);
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else if (Number.isNaN(end)) {
    end = fileSize - 1;
  }

  if (start < 0 || end < start || start >= fileSize) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1)
  };
};

const serveStaticFile = async (request, response, filePath) => {
  try {
    const resolved = ensureAllowedFilePath(filePath);
    const details = await stat(resolved);

    if (!details.isFile()) {
      sendJson(response, 404, {error: "Arquivo nao encontrado."});
      return;
    }

    const contentType = contentTypes[path.extname(resolved)] || "application/octet-stream";
    const shouldDisableCache = [".html", ".js", ".css"].includes(path.extname(resolved).toLowerCase());
    const cacheHeaders = shouldDisableCache
      ? {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0"
        }
      : {};
    const range = parseRangeHeader(request.headers.range, details.size);

    if (range) {
      response.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${details.size}`,
        "Accept-Ranges": "bytes",
        ...cacheHeaders
      });
      createReadStream(resolved, {start: range.start, end: range.end}).pipe(response);
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": details.size,
      "Accept-Ranges": "bytes",
      ...cacheHeaders
    });
    createReadStream(resolved).pipe(response);
  } catch (error) {
    sendJson(response, 404, {error: error instanceof Error ? error.message : "Arquivo nao encontrado."});
  }
};

const resolveStylePreviewPath = (pathname) => {
  const normalized = String(pathname || "").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("/style-previews/")) {
    return path.join(stylePreviewDir, path.basename(normalized));
  }

  const matchedOption = imageStyleOptions.find((option) => `/${option.previewFile}` === normalized);
  return matchedOption ? matchedOption.previewImagePath : "";
};

const resolvePublicStaticPath = (pathname) => {
  const normalized = String(pathname || "").trim();
  if (!normalized || normalized === "/") {
    return "";
  }

  const candidate = path.resolve(publicDir, `.${normalized}`);
  if (candidate === publicDir || !candidate.startsWith(`${publicDir}${path.sep}`)) {
    return "";
  }

  return existsSync(candidate) ? candidate : "";
};

const VALID_LANGUAGES = ["pt-BR", "en-US"];
const VALID_TONES = Object.keys(tonePresets);
const VALID_VOICES = voiceOptions.map((option) => option.value);
const MAX_TITLE_LENGTH = 200;
const MAX_SOURCE_TEXT_LENGTH = 50_000;
const MAX_CUSTOM_VOICE_LENGTH = 100;
const MAX_STYLE_PROMPT_LENGTH = 500;

const handleGenerateRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceText = String(body.sourceText || "").trim().slice(0, MAX_SOURCE_TEXT_LENGTH);
  const title = String(body.title || deriveTitleFromText(sourceText)).trim().slice(0, MAX_TITLE_LENGTH);
  const inputValidationError = validateGenerateInputs({title, sourceText});

  if (!title) {
    sendJson(response, 400, {error: "Informe um titulo ou cole um texto completo."});
    return;
  }

  if (inputValidationError) {
    sendJson(response, 400, {error: inputValidationError});
    return;
  }

  const language = VALID_LANGUAGES.includes(body.language) ? body.language : "pt-BR";
  const tone = VALID_TONES.includes(body.tone) ? body.tone : "natural_clean";
  const selectedVoice = String(body.voice || "").trim();
  const customVoice = String(body.customVoice || "").trim().slice(0, MAX_CUSTOM_VOICE_LENGTH);
  const outputProfile = resolveOutputProfileConfig(body.outputProfile);
  const channel = getChannelConfig(String(body.channel || "foiumaideia"));
  const channelPreset = getChannelPreset(channel.value);
  const imageModel = resolveImageModel(body.imageModel, resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL));
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice,
    language,
    channelPreset
  });

  if (!voice) {
    sendJson(response, 400, {error: "Escolha uma voz valida."});
    return;
  }

  const targetSeconds = getProfileTargetSeconds(outputProfile.id, Number(body.targetSeconds));
  const slug = `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const sourceTextFile = sourceText ? path.join(inputsDir, `${createId()}-source.txt`) : "";

  if (sourceTextFile) {
    await mkdir(inputsDir, {recursive: true});
    await writeFile(sourceTextFile, sourceText);
  }

  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const explicitCustomStylePrompt = String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH).trim();
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const job = {
    id: createId(),
    type: "generate",
    title,
    slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [],
    input: {
      title,
      hasSourceText: Boolean(sourceText),
      sourceTextCharacters: sourceText.length,
      sourceTextFile,
      storyboardFile: "",
      channel: channel.value,
      outputProfile: outputProfile.id,
      language,
      targetSeconds,
      imageModel,
      imageStyle: imageStyleOptions.some((option) => option.value === body.imageStyle)
        ? String(body.imageStyle)
        : DEFAULT_VISUAL_STYLE_PRESET,
      voice,
      tone,
      stylePrompt: combineStylePrompt({
        language,
        tone,
        customStylePrompt: explicitCustomStylePrompt || channelCustomStylePrompt
      }),
      scriptGuidance: resolveEffectiveScriptGuidance({
        explicitScriptGuidance: body.scriptGuidance,
        explicitTone: body.tone,
        channelPreset,
        tonePreset
      }),
      channelHandle: channel.handle,
      noMusic: Boolean(body.noMusic),
      force: body.force !== false,
      previewOnly: Boolean(body.previewOnly),
      approvedFromJobId: null
    },
    outputPath: null,
    storyboardPath: null,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(job)});
};

const handleApprovePreviewRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const previewJobId = String(body.jobId || "").trim();
  const previewJob = jobs.get(previewJobId);

  if (!previewJob) {
    sendJson(response, 404, {error: "Preview nao encontrado."});
    return;
  }

  if (previewJob.type !== "generate" || !previewJob.input?.previewOnly) {
    sendJson(response, 400, {error: "O job informado nao e um preview valido."});
    return;
  }

  if (previewJob.status !== "completed" || !previewJob.storyboardPath) {
    sendJson(response, 400, {error: "O preview ainda nao terminou ou nao gerou storyboard."});
    return;
  }

  const approvedStoryboard = await readJsonFile(previewJob.storyboardPath);
  const previewValidation = getPreviewStoryboardIssues({
    storyboard: approvedStoryboard,
    targetSeconds: previewJob.input?.targetSeconds,
    language: previewJob.input?.language,
    outputProfile: previewJob.input?.outputProfile
  });

  if (!approvedStoryboard?.scenes?.length) {
    sendJson(response, 400, {error: "O preview nao gerou cenas validas."});
    return;
  }

  if (previewValidation.issues.length > 0) {
    sendJson(response, 400, {
      error: `Preview fora da faixa para finalizar: ${previewValidation.issues.join("; ")}.`,
      validation: previewValidation
    });
    return;
  }

  const approvedJob = {
    id: createId(),
    type: "generate",
    title: previewJob.title,
    slug: previewJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [],
    input: {
      ...previewJob.input,
      sourceTextFile: "",
      storyboardFile: previewJob.storyboardPath,
      previewOnly: false,
      force: true,
      approvedFromJobId: previewJob.id
    },
    outputPath: null,
    storyboardPath: previewJob.storyboardPath,
    artifactEpochAt: new Date().toISOString(),
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(approvedJob)});
};

const handleRerenderRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const slug = slugify(String(body.slug || ""));

  if (!slug) {
    sendJson(response, 400, {error: "Informe o slug da run para regravar a voz."});
    return;
  }

  const language = VALID_LANGUAGES.includes(body.language) ? body.language : "pt-BR";
  const tone = VALID_TONES.includes(body.tone) ? body.tone : "natural_clean";
  const selectedVoice = String(body.voice || "").trim();
  const customVoice = String(body.customVoice || "").trim().slice(0, MAX_CUSTOM_VOICE_LENGTH);
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice,
    language,
    channelPreset: null
  });

  if (!voice) {
    sendJson(response, 400, {error: "Escolha uma voz valida."});
    return;
  }

  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const storyboard = await readJsonFile(path.join(configuredVideoEngineRoot, "runs", slug, "storyboard.json"));
  const renderProps = await readJsonFile(path.join(configuredVideoEngineRoot, "runs", slug, "render-props.json"));
  const title = storyboard?.videoTitle || slug;
  const outputProfile = resolveOutputProfileConfig(body.outputProfile || renderProps?.outputProfile || storyboard?.outputProfile);
  const job = {
    id: createId(),
    type: "rerender",
    title,
    slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [],
    input: {
      slug,
      language,
      voice,
      tone,
      outputProfile: outputProfile.id,
      stylePrompt: combineStylePrompt({
        language,
        tone,
        customStylePrompt: String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH)
      }),
      scriptGuidance: resolveEffectiveScriptGuidance({
        explicitScriptGuidance: body.scriptGuidance,
        explicitTone: body.tone,
        channelPreset: {tone, scriptGuidance: ""},
        tonePreset
      })
    },
    outputPath: null,
    storyboardPath: null,
    artifactEpochAt: new Date().toISOString(),
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(job)});
};

const buildResumedGenerateJob = (sourceJob) => ({
  id: createId(),
  type: "generate",
  title: sourceJob.title,
  slug: sourceJob.slug,
  status: "queued",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  logTail: [
    `[resume] retomando job ${sourceJob.id}`,
    `[resume] etapa anterior: ${getFailureStage(sourceJob) || "desconhecida"}`,
    `[resume] detalhe: ${getFailureSummary(sourceJob) || sourceJob.error || "sem detalhe"}`
  ],
  input: {
    ...sourceJob.input,
    previewOnly: false,
    force: true,
    resumeFromJobId: sourceJob.id
  },
  outputPath: null,
  storyboardPath: null,
  artifactEpochAt: sourceJob.artifactEpochAt || sourceJob.createdAt,
  exitCode: null,
  error: null
});

const buildAudioPrepJob = (sourceJob, options = {}) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  return {
    id: createId(),
    type: "audio-prep",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[recovery] cenas prontas; a reconstruir audio, timings e render-props"],
    input: {
      ...recoveryJob.input,
      previewOnly: false,
      force: false,
      sourceJobId: recoveryJob.id,
      autoContinueRecovery: options.autoContinueRecovery === true
    },
    outputPath: null,
    storyboardPath: getRunPaths(recoveryJob.slug).storyboardPath,
    artifactEpochAt: recoveryJob.artifactEpochAt || recoveryJob.createdAt,
    exitCode: null,
    error: null
  };
};

const buildRenderOnlyJob = (sourceJob, options = {}) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  return {
    id: createId(),
    type: "render-only",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[recovery] audio e cenas prontos; a renderizar sem regenerar assets"],
    input: {
      ...recoveryJob.input,
      previewOnly: false,
      force: false,
      sourceJobId: recoveryJob.id,
      autoContinueRecovery: options.autoContinueRecovery === true
    },
    outputPath: null,
    storyboardPath: getRunPaths(recoveryJob.slug).storyboardPath,
    artifactEpochAt: recoveryJob.artifactEpochAt || recoveryJob.createdAt,
    exitCode: null,
    error: null
  };
};

const buildValidateOnlyJob = (sourceJob) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  return {
    id: createId(),
    type: "validate-only",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[recovery] video pronto; a rodar QA final sem reenfileirar a pipeline"],
    input: {
      ...recoveryJob.input,
      previewOnly: false,
      force: false,
      sourceJobId: recoveryJob.id
    },
    outputPath: null,
    storyboardPath: getRunPaths(recoveryJob.slug).storyboardPath,
    artifactEpochAt: recoveryJob.artifactEpochAt || recoveryJob.createdAt,
    exitCode: null,
    error: null
  };
};

const buildAutoRerenderJob = (sourceJob) => {
  const paths = getRunPaths(sourceJob.slug);
  const storyboard = readJsonSyncIfExists(paths.storyboardPath);
  const renderProps = readJsonSyncIfExists(paths.renderPropsPath);
  const language = VALID_LANGUAGES.includes(sourceJob.input?.language) ? sourceJob.input.language : "pt-BR";
  const tone = VALID_TONES.includes(sourceJob.input?.tone) ? sourceJob.input.tone : "natural_clean";
  const voice = VALID_VOICES.includes(String(sourceJob.input?.voice || "").trim())
    ? String(sourceJob.input.voice).trim()
    : getDefaultVoiceForLanguage(language);
  const outputProfile = resolveOutputProfileConfig(
    sourceJob.input?.outputProfile ||
    renderProps?.outputProfile ||
    storyboard?.outputProfile
  );

  return {
    id: createId(),
    type: "rerender",
    title: sourceJob.title || storyboard?.videoTitle || sourceJob.slug,
    slug: sourceJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[scene-repair] todas as cenas prontas; reenfileirando audio + render"],
    input: {
      slug: sourceJob.slug,
      channel: sourceJob.input?.channel || "foiumaideia",
      language,
      voice,
      tone,
      outputProfile: outputProfile.id,
      stylePrompt: String(sourceJob.input?.stylePrompt || "").trim(),
      scriptGuidance: String(sourceJob.input?.scriptGuidance || "").trim()
    },
    outputPath: null,
    storyboardPath: paths.storyboardPath,
    exitCode: null,
    error: null
  };
};

const buildRetryFromStoryboardGenerateJob = async (sourceJob) => {
  const storyboardPath = getRetryStoryboardPathForJob(sourceJob);
  const storyboard = await readJsonFile(storyboardPath);

  if (!storyboard?.scenes?.length) {
    throw new Error("Nao achei storyboard valido para refazer esse job.");
  }

  const channel = getChannelConfig(sourceJob.input?.channel);
  const channelPreset = getChannelPreset(channel.value);
  const outputProfile = resolveOutputProfileConfig(sourceJob.input?.outputProfile || storyboard.outputProfile);
  const targetSeconds = getProfileTargetSeconds(outputProfile.id, Number(sourceJob.input?.targetSeconds || outputProfile.defaultTargetSeconds));
  const language = VALID_LANGUAGES.includes(sourceJob.input?.language) ? sourceJob.input.language : "pt-BR";
  const tone = VALID_TONES.includes(sourceJob.input?.tone) ? sourceJob.input.tone : (channelPreset.tone || "natural_clean");
  const selectedVoice = String(sourceJob.input?.voice || DEFAULT_VOICE).trim();
  const voice = VALID_VOICES.includes(selectedVoice) ? selectedVoice : DEFAULT_VOICE;
  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const title = String(storyboard.videoTitle || sourceJob.title || slugToCaption(sourceJob.slug)).trim();

  return {
    id: createId(),
    type: "generate",
    title,
    slug: sourceJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [`[failed-job] refazendo a partir do storyboard do job ${sourceJob.id}`],
    input: {
      ...sourceJob.input,
      title,
      hasSourceText: false,
      sourceTextCharacters: 0,
      sourceTextFile: "",
      storyboardFile: storyboardPath,
      channel: channel.value,
      outputProfile: outputProfile.id,
      language,
      targetSeconds,
      voice,
      tone,
      stylePrompt:
        sourceJob.input?.stylePrompt ||
        combineStylePrompt({language, tone, customStylePrompt: channelCustomStylePrompt}),
      scriptGuidance:
        String(sourceJob.input?.scriptGuidance || "").trim() ||
        resolveEffectiveScriptGuidance({
          explicitTone: sourceJob.input?.tone,
          channelPreset,
          tonePreset
        }),
      previewOnly: false,
      force: sourceJob.input?.force === false ? false : true,
      approvedFromJobId: sourceJob.id
    },
    outputPath: null,
    storyboardPath: storyboardPath,
    exitCode: null,
    error: null
  };
};

const handleResumeRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceJobId = String(body.jobId || "").trim();
  const sourceJob = jobs.get(sourceJobId);

  if (!sourceJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  if (sourceJob.type !== "generate" || sourceJob.input?.previewOnly) {
    sendJson(response, 400, {error: "Somente jobs de generate falhados podem ser retomados."});
    return;
  }

  if (sourceJob.status !== "failed") {
    sendJson(response, 400, {error: "O job selecionado ainda nao falhou."});
    return;
  }

  const paths = getRunPaths(sourceJob.slug);
  const storyboard = await readJsonFile(paths.storyboardPath);
  const voiceover = await readJsonFile(paths.voiceoverPath);

  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    sendJson(response, 409, {error: `Nao encontrei storyboard em ${paths.storyboardPath}.`});
    return;
  }

  if (!voiceover) {
    sendJson(response, 409, {error: `Nao encontrei voiceover.json em ${paths.voiceoverPath}.`});
    return;
  }

  if (!existsSync(paths.publicAudioPath)) {
    sendJson(response, 409, {error: `Nao encontrei voiceover.mp3 em ${paths.publicAudioPath}.`});
    return;
  }

  const missingScene = storyboard.scenes.findIndex((scene, index) => {
    const fileName = `scene-${String(index + 1).padStart(2, "0")}.mp4`;
    return !existsSync(path.join(paths.assetDir, fileName));
  });

  if (missingScene !== -1) {
    sendJson(response, 409, {
      error: `Falta o asset scene-${String(missingScene + 1).padStart(2, "0")}.mp4 em assets/envato/${sourceJob.slug}.`
    });
    return;
  }

  const resumedJob = buildResumedGenerateJob(sourceJob);

  sendJson(response, 201, {job: enqueueJob(resumedJob)});
};

const handleVideosRequest = async (response) => {
  const videos = await listExportVideos();
  const failedJobs = await listFailedLibraryJobs();
  const cases = [...videos.map((video) => video.caseSummary), ...failedJobs.map((job) => job.caseSummary)];
  const agendadorProfiles = channelOptions.map((channel) => {
    const profile = resolveAgendadorChannelProfile(channel.value);
    return {
      channel: channel.value,
      label: channel.label,
      configured: Boolean(profile.identifier && profile.password),
      identifierSource: profile.identifierSource || "",
      publicUrl: profile.publicUrl || "",
      profileUrlSource: profile.profileUrlSource || ""
    };
  });
  sendJson(response, 200, {
    videos,
    failedJobs,
    cases,
    summary: buildVideosSummary(videos, failedJobs),
    agendador: {
      configured: agendadorProfiles.some((item) => item.configured),
      keychainBacked: HAS_SECURITY_CLI,
      siteUrl: normalizeAgendadorSiteUrl(baseChildEnv.AGENDADOR_ONLINE_URL || baseChildEnv.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL),
      apiBase: AGENDADOR_API_BASE,
      profiles: agendadorProfiles
    }
  });
};

const handleVideoMetaRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const existingMeta = await readVideoMeta(target.slug);
  const title = String(body.title || "").trim().slice(0, 200);
  const caption = String(body.caption || "").trim().slice(0, 5000);
  const scheduleAt = String(body.scheduleAt || "").trim().slice(0, 64);
  const isDraft = body.isDraft === true;
  const channel = getChannelConfig(resolveChannelValue(body.channel || existingMeta?.channel || inferChannelValueFromPath(target.path)));
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 30)
    : Array.isArray(existingMeta?.hashtags) ? existingMeta.hashtags : [];
  const platforms = Array.isArray(body.platforms)
    ? body.platforms.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean).slice(0, 6)
    : Array.isArray(existingMeta?.platforms) ? existingMeta.platforms : ["FB", "IG", "YT"];
  const safePlatforms = platforms.length > 0 ? platforms : ["FB", "IG", "YT"];

  await writeVideoMeta(target.slug, {
    ...existingMeta,
    title,
    caption,
    scheduleAt,
    isDraft,
    channel: channel.value,
    hashtags,
    platforms: safePlatforms,
    updatedAt: new Date().toISOString()
  });

  const video = await buildVideoRecord({targetPath: target.path});
  sendJson(response, 200, {video});
};

const handleVideoRefazerRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const paths = getRunPaths(target.slug);
  const storyboard = await readJsonFile(paths.storyboardPath);

  if (!storyboard?.scenes?.length) {
    sendJson(response, 409, {error: "Nao achei storyboard para refazer este video."});
    return;
  }

  const previousJob = Array.from(jobs.values())
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .find((job) => job.slug === target.slug && job.type === "generate");
  const channel = getChannelConfig(body.channel || previousJob?.input?.channel);
  const channelPreset = getChannelPreset(channel.value);
  const outputProfile = resolveOutputProfileConfig(body.outputProfile || previousJob?.input?.outputProfile || storyboard.outputProfile);
  const targetSeconds = getProfileTargetSeconds(
    outputProfile.id,
    Number(body.targetSeconds || previousJob?.input?.targetSeconds || outputProfile.defaultTargetSeconds)
  );
  const language = VALID_LANGUAGES.includes(body.language) ? body.language : (previousJob?.input?.language || "pt-BR");
  const tone = VALID_TONES.includes(body.tone) ? body.tone : (previousJob?.input?.tone || channelPreset.tone || "natural_clean");
  const selectedVoice = String(body.voice || previousJob?.input?.voice || DEFAULT_VOICE).trim();
  const voice = VALID_VOICES.includes(selectedVoice) ? selectedVoice : DEFAULT_VOICE;
  const imageModel = resolveImageModel(
    body.imageModel || previousJob?.input?.imageModel,
    resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL)
  );
  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const explicitCustomStylePrompt = String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH).trim();
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const title = String(storyboard.videoTitle || previousJob?.title || slugToCaption(target.path)).trim();
  const job = {
    id: createId(),
    type: "generate",
    title,
    slug: target.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[library] refazendo a partir do storyboard salvo"],
    input: {
      title,
      hasSourceText: false,
      sourceTextCharacters: 0,
      sourceTextFile: "",
      storyboardFile: paths.storyboardPath,
      channel: channel.value,
      outputProfile: outputProfile.id,
      language,
      targetSeconds,
      imageModel,
      imageStyle: previousJob?.input?.imageStyle || DEFAULT_VISUAL_STYLE_PRESET,
      voice,
      tone,
      stylePrompt:
        previousJob?.input?.stylePrompt ||
        combineStylePrompt({
          language,
          tone,
          customStylePrompt: explicitCustomStylePrompt || channelCustomStylePrompt
        }),
      scriptGuidance:
        String(previousJob?.input?.scriptGuidance || "").trim() ||
        resolveEffectiveScriptGuidance({
          explicitTone: body.tone || previousJob?.input?.tone,
          channelPreset,
          tonePreset
        }),
      channelHandle: channel.handle,
      noMusic: previousJob?.input?.noMusic !== false,
      force: true,
      previewOnly: false,
      approvedFromJobId: previousJob?.id || null
    },
    outputPath: null,
    storyboardPath: paths.storyboardPath,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(job)});
};

const handleRetryFailedJobRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceJobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const sourceJob = jobs.get(sourceJobId);

  if (!sourceJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  if (!canRetryFailedJobFromStoryboard(sourceJob)) {
    sendJson(response, 409, {error: "Esse job falhado nao tem storyboard reaproveitavel para refazer."});
    return;
  }

  const retriedJob = await buildRetryFromStoryboardGenerateJob(sourceJob);

  sendJson(response, 201, {job: enqueueJob(retriedJob)});
};

const handleRegenerateMissingSceneRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceJobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const sourceJob = jobs.get(sourceJobId);

  if (!sourceJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const storyboardPath = getRetryStoryboardPathForJob(sourceJob) || getRunPaths(sourceJob.slug).storyboardPath;
  const storyboard = await readJsonFile(storyboardPath);
  if (!storyboard?.scenes?.length) {
    sendJson(response, 409, {error: "Nao achei storyboard valido para regenerar a cena."});
    return;
  }

  const requestedSceneNumber = normalizePositiveInt(body.sceneNumber);
  const detectedMissingSceneNumber = sourceJob.type === "generate"
    ? normalizePositiveInt(getFirstMissingSceneNumber(sourceJob))
    : null;
  const sceneNumber = detectedMissingSceneNumber || requestedSceneNumber;

  if (!Number.isInteger(sceneNumber) || sceneNumber < 1 || sceneNumber > storyboard.scenes.length) {
    sendJson(response, 409, {error: "Nao consegui identificar uma cena faltante para regenerar."});
    return;
  }

  const channel = getChannelConfig(sourceJob.input?.channel);
  const channelPreset = getChannelPreset(channel.value);
  const outputProfile = resolveOutputProfileConfig(sourceJob.input?.outputProfile || storyboard.outputProfile);
  const targetSeconds = getProfileTargetSeconds(outputProfile.id, Number(sourceJob.input?.targetSeconds || outputProfile.defaultTargetSeconds));
  const language = VALID_LANGUAGES.includes(sourceJob.input?.language) ? sourceJob.input.language : "pt-BR";
  const tone = VALID_TONES.includes(sourceJob.input?.tone) ? sourceJob.input.tone : (channelPreset.tone || "natural_clean");
  const selectedVoice = String(sourceJob.input?.voice || DEFAULT_VOICE).trim();
  const voice = VALID_VOICES.includes(selectedVoice) ? selectedVoice : DEFAULT_VOICE;
  const sceneJob = {
    id: createId(),
    type: "scene-regenerate",
    title: sourceJob.title,
    slug: sourceJob.slug,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [`[scene-repair] regenerando cena ${sceneNumber} do job ${sourceJob.id}`],
    input: {
      ...sourceJob.input,
      storyboardFile: storyboardPath,
      outputProfile: outputProfile.id,
      targetSeconds,
      language,
      tone,
      voice,
      sceneNumber,
      sourceJobId: sourceJob.id,
      autoContinueAfterSceneRepair: body.autoContinueAfterSceneRepair !== false
    },
    outputPath: null,
    storyboardPath,
    artifactEpochAt: sourceJob.artifactEpochAt || sourceJob.createdAt,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(sceneJob)});
};

const handleGenerateAudioRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const jobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const selectedJob = jobs.get(jobId);

  if (!selectedJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  if (!canPrepareAudioForJob(sourceJob)) {
    sendJson(response, 409, {error: "Este job ainda nao tem storyboard/cenas/render-props suficientes para gerar audio isoladamente."});
    return;
  }

  const job = buildAudioPrepJob(sourceJob);
  sendJson(response, 201, {job: enqueueJob(job)});
};

const handleRenderOnlyRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const jobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const selectedJob = jobs.get(jobId);

  if (!selectedJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  if (!canRenderOnlyForJob(sourceJob)) {
    sendJson(response, 409, {error: "Ainda faltam audio, render-props ou cenas para renderizar direto."});
    return;
  }

  const job = buildRenderOnlyJob(sourceJob);
  sendJson(response, 201, {job: enqueueJob(job)});
};

const handleValidateOnlyRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const jobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const selectedJob = jobs.get(jobId);

  if (!selectedJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  if (!canValidateOnlyForJob(sourceJob)) {
    sendJson(response, 409, {error: "Nao existe MP4 final para validar neste slug."});
    return;
  }

  const job = buildValidateOnlyJob(sourceJob);
  sendJson(response, 201, {job: enqueueJob(job)});
};

const handleForceFailJobRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const jobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const job = jobs.get(jobId);

  if (!job) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const normalizedStatus = String(job.status || "").trim().toLowerCase();
  if (!["queued", "running"].includes(normalizedStatus)) {
    sendJson(response, 409, {error: "So e possivel destravar jobs queued ou running."});
    return;
  }

  if (normalizedStatus === "running") {
    await terminateJobProcessTree(job);
  }

  failJobAndReleaseQueue(job, "Job marcado manualmente como travado para liberar a fila.");
  sendJson(response, 200, {job: sanitizeJob(job)});
};

const handleVideoDeleteRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const video = await buildVideoRecord({targetPath: target.path});
  const paths = getRunPaths(target.slug);
  const channel = getChannelConfig(body.channel || video.channel || "foiumaideia");

  await safeUnlink(target.path);
  await safeUnlink(paths.outPath);
  await safeUnlink(getVideoMetaPath(target.slug));
  await removeVideoMetadataEntry({channel: channel.value, slug: target.slug}).catch(() => {});

  sendJson(response, 200, {
    ok: true,
    slug: target.slug,
    deletedPath: target.path
  });
};

const handleVideoPublishRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const video = await buildVideoRecord({targetPath: target.path});
  const meta = await readVideoMeta(target.slug);
  const publishChannel = getChannelConfig(String(body.channel || video.channel || meta?.channel || "foiumaideia"));
  const publishProfile = resolveAgendadorChannelProfile(publishChannel.value);
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.map((item) => String(item || "").trim()).filter(Boolean)
    : Array.isArray(meta?.hashtags) && meta.hashtags.length > 0
      ? meta.hashtags
      : Array.isArray(video.hashtags) ? video.hashtags : [];
  const captionBase = String(body.caption || meta?.caption || video.caption || slugToCaption(target.path)).trim();
  const caption = [captionBase, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const requestedPlatforms = Array.isArray(body.platforms) ? body.platforms : meta?.platforms;
  const platforms = (Array.isArray(requestedPlatforms) ? requestedPlatforms : ["FB", "IG", "YT"])
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
  const safePlatforms = platforms.length > 0 ? platforms : ["FB", "IG", "YT"];
  const publishDate = String(body.scheduleAt || meta?.scheduleAt || "").trim() || new Date().toISOString();
  const isDraft = body.isDraft === true;
  const token = await getAgendadorToken(publishChannel.value);
  const accountsPayload = await agendadorFetch("/social-accounts", {token});
  const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const missingProviders = safePlatforms
    .map((provider) => {
      const account = accounts.find((item) => String(item.provider || "").trim().toUpperCase() === provider);
      return isAccountPublishReady(account) ? null : describeAccountPublishIssue(account, provider);
    })
    .filter(Boolean);

  if (missingProviders.length > 0) {
    sendJson(response, 409, {error: `Conecte as redes: ${missingProviders.join(", ")}`});
    return;
  }

  const mediaUrl = await uploadVideoToAgendador(token, target.path);
  let thumbnailPath = "";
  let thumbnailUrl = "";

  try {
    thumbnailPath = await ensurePublishThumbnail(target.path, target.slug);
    thumbnailUrl = thumbnailPath ? await uploadThumbnailToAgendador(token, thumbnailPath) : "";
  } catch (error) {
    console.warn(`[agendador] thumbnail opcional ignorada: ${error instanceof Error ? error.message : String(error)}`);
  }

  const basePostBody = {
    date: publishDate,
    mediaUrl,
    caption,
    platforms: safePlatforms,
    isDraft
  };
  const enrichedPostBody = thumbnailUrl
    ? {
        ...basePostBody,
        thumbnailUrl,
        coverUrl: thumbnailUrl
      }
    : basePostBody;

  let created;
  try {
    created = await agendadorFetch("/posts", {
      method: "POST",
      token,
      body: enrichedPostBody
    });
  } catch (error) {
    if (thumbnailUrl && [400, 422].includes(Number(error.status || 0))) {
      created = await agendadorFetch("/posts", {
        method: "POST",
        token,
        body: basePostBody
      });
      thumbnailUrl = "";
    } else {
      throw error;
    }
  }

  const publishStatus = isDraft ? "draft" : new Date(publishDate).getTime() > Date.now() ? "scheduled" : "published";
  const publishedAt = publishStatus === "published" ? new Date().toISOString() : null;

  await writeVideoMeta(target.slug, {
    ...meta,
    title: String(body.title || meta?.title || video.title || "").trim(),
    caption: captionBase,
    hashtags,
    scheduleAt: publishDate,
    isDraft,
    platforms: safePlatforms,
    channel: publishChannel.value,
    agendadorIdentifier: publishProfile.identifier,
    agendadorIdentifierSource: publishProfile.identifierSource,
    agendadorProfileUrl: publishProfile.publicUrl || "",
    thumbnailPath: thumbnailPath || meta?.thumbnailPath || "",
    thumbnailUrl: thumbnailUrl || meta?.thumbnailUrl || "",
    updatedAt: new Date().toISOString(),
    publishedAt,
    publishedPostId: created?.post?.id ?? null,
    lastPublishPlatforms: safePlatforms,
    lastPublishStatus: publishStatus,
    publishStatus,
    publishedProfile: publishChannel.value
  });

  sendJson(response, 200, {
    ok: true,
    post: created?.post ?? created ?? null,
    video: await buildVideoRecord({targetPath: target.path})
  });
};

const handleVideoTikTokHelperRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const video = await buildVideoRecord({targetPath: target.path});
  const meta = await readVideoMeta(target.slug).catch(() => null);
  const hashtags = Array.isArray(body.hashtags)
    ? body.hashtags.map((item) => String(item || "").trim()).filter(Boolean)
    : Array.isArray(meta?.hashtags) && meta.hashtags.length > 0
      ? meta.hashtags
      : Array.isArray(video.hashtags) ? video.hashtags : [];
  const captionBase = String(body.caption || meta?.caption || video.caption || slugToCaption(target.path)).trim();
  const caption = [captionBase, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const draftId = `${target.slug}-${Date.now().toString(36)}`;
  const draft = {
    id: draftId,
    slug: target.slug,
    title: String(body.title || meta?.title || video.title || "").trim() || slugToCaption(target.path),
    channel: String(body.channel || meta?.channel || video.channel || "").trim(),
    channelHandle: video.channelHandle || "",
    caption,
    videoUrl: video.url,
    thumbnailUrl: String(video.thumbnailUrl || video.coverUrl || "").trim(),
    storyboardUrl: String(video.storyboardUrl || "").trim(),
    downloadName: path.basename(target.path),
    thumbnailDownloadName: `${target.slug}-thumbnail${path.extname(String(video.thumbnailPath || video.thumbnailUrl || ".png")) || ".png"}`,
    createdAt: new Date().toISOString()
  };

  await writeTikTokDraft(draftId, draft);

  sendJson(response, 200, {
    ok: true,
    helperUrl: `/tiktok-helper?id=${encodeURIComponent(draftId)}`,
    message: "Helper do TikTok aberto. O upload do MP4 no site do TikTok ainda precisa ser confirmado manualmente no browser."
  });
};

const handleConfigRequest = async (response) => {
  sendJson(response, 200, {
    defaults: {
      channel: channelOptions[0].value,
      language: "pt-BR",
      targetSeconds: 60,
      outputProfile: DEFAULT_OUTPUT_PROFILE,
      imageModel: resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL),
      imageStyle: DEFAULT_VISUAL_STYLE_PRESET,
      tone: "shortform_native",
      voice: DEFAULT_VOICE,
      noMusic: true,
      force: true
    },
    defaultVoicesByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    voices: voiceOptions.map(serializeVoiceOption),
    channels: channelOptions,
    channelPresets,
    outputProfiles: outputProfileOptions,
    imageModels: imageModelOptions.map(serializeImageModelOption),
    imageStyles: imageStyleOptions.map(serializeImageStyleOption),
    tones: Object.entries(tonePresets).map(([value, config]) => ({
      value,
      label: config.label,
      description: config.description || ""
    })),
    durations: defaultDurationOptions,
    durationsByProfile: Object.fromEntries(
      outputProfileOptions.map((profile) => [profile.value, profile.durations])
    ),
    agendador: {
      siteUrl: normalizeAgendadorSiteUrl(baseChildEnv.AGENDADOR_ONLINE_URL || baseChildEnv.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL),
      apiBase: AGENDADOR_API_BASE,
      profiles: channelOptions.map((channel) => {
        const profile = resolveAgendadorChannelProfile(channel.value);
        return {
          channel: channel.value,
          label: channel.label,
          handle: channel.handle,
          configured: Boolean(profile.identifier && profile.password),
          identifierSource: profile.identifierSource || "",
          publicUrl: profile.publicUrl || "",
          profileUrlSource: profile.profileUrlSource || ""
        };
      })
    }
  });
};

const validateStartup = () => {
  const hasEnvValue = (value) => String(value || "").trim().length > 0;
  const requestedTtsProvider = String(baseChildEnv.TTS_PROVIDER || "auto").trim().toLowerCase();
  const llmProvider = String(baseChildEnv.LLM_PROVIDER || baseChildEnv.STORY_PROVIDER || "codex").trim().toLowerCase();
  const requiredKeys = [];

  if (llmProvider === "openrouter") {
    requiredKeys.push("OPENROUTER_API_KEY");
  } else if (llmProvider === "gemini" || llmProvider === "google") {
    requiredKeys.push("GOOGLE_API_KEY");
  } else if (llmProvider === "vertex" || llmProvider === "vertexai") {
    requiredKeys.push("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT");
  }

  if (
    requestedTtsProvider === "google" ||
    requestedTtsProvider === "gcloud" ||
    requestedTtsProvider === "google-cloud" ||
    requestedTtsProvider === "google-gemini-tts" ||
    requestedTtsProvider === "gemini-tts" ||
    requestedTtsProvider === "gemini"
  ) {
    requiredKeys.push("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT");
  } else if (requestedTtsProvider === "elevenlabs") {
    requiredKeys.push("ELEVENLABS_API_KEY");
  } else if (requestedTtsProvider === "azure") {
    requiredKeys.push("AZURE_SPEECH_KEY");
  }

  const missing = requiredKeys.filter((key) => !baseChildEnv[key]);

  if (missing.length > 0) {
    process.stderr.write(`ERRO: Chaves ausentes no .env: ${missing.join(", ")}\n`);
    process.exit(1);
  }

  if (
    requestedTtsProvider === "azure" &&
    !hasEnvValue(baseChildEnv.AZURE_SPEECH_REGION) &&
    !hasEnvValue(baseChildEnv.AZURE_SPEECH_ENDPOINT)
  ) {
    process.stderr.write("ERRO: Azure Speech requer AZURE_SPEECH_REGION ou AZURE_SPEECH_ENDPOINT.\n");
    process.exit(1);
  }

  if (requestedTtsProvider === "auto") {
    const azureConfigured =
      hasEnvValue(baseChildEnv.AZURE_SPEECH_KEY) &&
      (hasEnvValue(baseChildEnv.AZURE_SPEECH_REGION) || hasEnvValue(baseChildEnv.AZURE_SPEECH_ENDPOINT));
    const googleConfigured =
      hasEnvValue(baseChildEnv.GOOGLE_APPLICATION_CREDENTIALS) &&
      hasEnvValue(baseChildEnv.GOOGLE_CLOUD_PROJECT);
    const elevenlabsConfigured = hasEnvValue(baseChildEnv.ELEVENLABS_API_KEY);

    if (!azureConfigured && !googleConfigured && !elevenlabsConfigured) {
      process.stderr.write("ERRO: TTS_PROVIDER=auto, mas nenhum provider de voz esta configurado.\n");
      process.exit(1);
    }
  }

  if (!existsSync(rootEnvPath)) {
    process.stderr.write(`ERRO: Arquivo .env nao encontrado em ${rootEnvPath}\n`);
    process.exit(1);
  }
};

validateStartup();

await mkdir(dataDir, {recursive: true});
await mkdir(inputsDir, {recursive: true});
await mkdir(videoLibraryDir, {recursive: true});
await mkdir(tiktokDraftsDir, {recursive: true});
await mkdir(postarRoot, {recursive: true});
await Promise.all(channelOptions.map((channel) => mkdir(getChannelExportDir(channel.value), {recursive: true})));

const persistedJobs = await readJsonFile(jobsFile);

if (Array.isArray(persistedJobs)) {
  for (const persistedJob of persistedJobs) {
    const nowIso = toIsoNow();

    if (persistedJob.status === "running" || persistedJob.status === "queued") {
      persistedJob.status = "failed";
      persistedJob.error = "Servidor reiniciado antes da conclusao deste job.";
      persistedJob.completedAt = persistedJob.completedAt || nowIso;
      persistedJob.updatedAt = nowIso;
      persistedJob.heartbeatAt = nowIso;
      persistedJob.stageValue = getFailureStage(persistedJob) || persistedJob.stageValue || "pipeline";
      persistedJob.stageSource = "system";
      persistedJob.stageConfidence = "high";
      persistedJob.stageUpdatedAt = nowIso;
    }

    jobs.set(persistedJob.id, {
      ...persistedJob,
      queueLane: persistedJob.queueLane || getJobQueueLane(persistedJob),
      logTail: Array.isArray(persistedJob.logTail) ? persistedJob.logTail : [],
      heartbeatAt: persistedJob.heartbeatAt || persistedJob.updatedAt || persistedJob.createdAt || nowIso,
      artifactEpochAt: persistedJob.artifactEpochAt || persistedJob.createdAt || nowIso,
      stageValue: persistedJob.stageValue || inferJobStageValue(persistedJob),
      stageSource: persistedJob.stageSource || "system",
      stageConfidence: persistedJob.stageConfidence || "medium",
      stageUpdatedAt: persistedJob.stageUpdatedAt || persistedJob.updatedAt || nowIso
    });
  }
}

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (method === "GET" && pathname === "/") {
      await serveStaticFile(request, response, path.join(publicDir, "index.html"));
      return;
    }

    if (method === "GET" && ["/app.js", "/styles.css"].includes(pathname)) {
      await serveStaticFile(request, response, path.join(publicDir, pathname.slice(1)));
      return;
    }

    const stylePreviewPath = resolveStylePreviewPath(pathname);
    if (method === "GET" && stylePreviewPath) {
      await serveStaticFile(request, response, stylePreviewPath);
      return;
    }

    const publicStaticPath = resolvePublicStaticPath(pathname);
    if (method === "GET" && publicStaticPath) {
      await serveStaticFile(request, response, publicStaticPath);
      return;
    }

    if (method === "GET" && pathname === "/api/config") {
      await handleConfigRequest(response);
      return;
    }

    if (method === "GET" && pathname === "/api/jobs") {
      const payload = Array.from(jobs.values())
        .map((job) => sanitizeJob(job))
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
      const queueLengths = getQueueLengths();
      sendJson(response, 200, {
        jobs: payload,
        cases: payload.map((job) => job.caseSummary),
        summary: buildJobsSummary(payload),
        activeJobId: activeHeavyJobId || activePreviewJobId || null,
        activePreviewJobId,
        activeHeavyJobId,
        ...queueLengths
      });
      return;
    }

    if (method === "GET" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/stream")) {
      const jobId = pathname.split("/")[3];
      const job = jobs.get(jobId);

      if (!job) {
        sendJson(response, 404, {error: "Job nao encontrado."});
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      });
      response.write("\n");

      const subscribers = streams.get(jobId) || new Set();
      subscribers.add(response);
      streams.set(jobId, subscribers);
      sendEvent(response, "update", sanitizeJob(job));

      const keepAlive = setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {
          clearInterval(keepAlive);
          subscribers.delete(response);
        }
      }, 25000);

      const cleanup = () => {
        clearInterval(keepAlive);
        subscribers.delete(response);
      };

      request.on("close", cleanup);
      response.on("error", cleanup);

      return;
    }

    if (method === "GET" && pathname.startsWith("/api/jobs/")) {
      const jobId = pathname.split("/")[3];
      const job = jobs.get(jobId);

      if (!job) {
        sendJson(response, 404, {error: "Job nao encontrado."});
        return;
      }

      sendJson(response, 200, {job: sanitizeJob(job)});
      return;
    }

    if (method === "GET" && pathname === "/api/runs") {
      sendJson(response, 200, {runs: await listRecentExports()});
      return;
    }

    if (method === "GET" && pathname === "/api/videos") {
      await handleVideosRequest(response);
      return;
    }

    if (method === "GET" && pathname === "/api/file") {
      const filePath = url.searchParams.get("path");

      if (!filePath) {
        sendJson(response, 400, {error: "Parametro path ausente."});
        return;
      }

      await serveStaticFile(request, response, filePath);
      return;
    }

    if (method === "GET" && pathname === "/tiktok-helper") {
      const draftId = String(url.searchParams.get("id") || "").trim();
      if (!draftId) {
        sendJson(response, 400, {error: "Parametro id ausente."});
        return;
      }

      const draft = await readTikTokDraft(draftId);
      if (!draft) {
        sendJson(response, 404, {error: "Draft do TikTok nao encontrado."});
        return;
      }

      response.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
      response.end(buildTikTokHelperHtml(draft));
      return;
    }

    if (method === "POST" && pathname === "/api/generate") {
      await handleGenerateRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/approve-preview") {
      await handleApprovePreviewRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/rerender-voice") {
      await handleRerenderRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/videos/meta") {
      await handleVideoMetaRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/videos/refazer") {
      await handleVideoRefazerRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/videos/delete") {
      await handleVideoDeleteRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/videos/publish") {
      await handleVideoPublishRequest(request, response);
      return;
    }

    if (method === "POST" && pathname === "/api/videos/tiktok-helper") {
      await handleVideoTikTokHelperRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/retry-from-storyboard")) {
      await handleRetryFailedJobRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/regenerate-missing-scene")) {
      await handleRegenerateMissingSceneRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/generate-audio")) {
      await handleGenerateAudioRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/render-only")) {
      await handleRenderOnlyRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/validate")) {
      await handleValidateOnlyRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/force-fail")) {
      await handleForceFailJobRequest(request, response);
      return;
    }

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/resume")) {
      const jobId = pathname.split("/")[3];
      await handleResumeRequest(request, response, jobId);
      return;
    }

    sendJson(response, 404, {error: "Rota nao encontrada."});
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Erro interno."
    });
  }
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
});

const gracefulShutdown = async () => {
  process.stdout.write("\nEncerrando servidor...\n");

  for (const [, subscribers] of streams) {
    for (const response of subscribers) {
      try {
        response.end();
      } catch { /* ignore */ }
    }
  }

  streams.clear();
  await Promise.all(
    Array.from(jobs.values())
      .filter((job) => Number.isInteger(Number(job?.processId || 0)) && Number(job.processId) > 0)
      .map((job) => terminateJobProcessTree(job).catch(() => false))
  ).catch(() => {});

  persistJobs().catch(() => {}).finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  });
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(`ERRO: Porta ${DEFAULT_PORT} ja esta em uso. Encerre o outro processo ou mude WEB_PORT.\n`);
  } else {
    process.stderr.write(`ERRO ao iniciar servidor: ${error.message}\n`);
  }

  process.exit(1);
});

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  process.stdout.write(
    `UI local pronta em http://${DEFAULT_HOST}:${DEFAULT_PORT}\nExportando videos em ${postarRoot}\n`
  );
});
