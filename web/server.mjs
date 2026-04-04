import http from "node:http";
import {spawn, spawnSync} from "node:child_process";
import {createReadStream, existsSync, readFileSync} from "node:fs";
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
const AGENDADOR_API_BASE = "https://agendador.online/api";
const AGENDADOR_DEFAULT_PLATFORMS = ["FB", "IG", "YT"];
const AGENDADOR_MAX_UPLOAD_MB = 24;
const HAS_SECURITY_CLI = spawnSync("sh", ["-lc", "command -v security >/dev/null 2>&1"], {stdio: "ignore"}).status === 0;

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8"
};

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
    scriptGuidance:
      "Write like a sharp Brazilian short-form creator reacting to a bad tech idea that gives people false confidence. The tone should feel human, sarcastic, slightly exaggerated, and very internet-native, like a smart friend warning you before you do something dumb. Use casual spoken Brazilian Portuguese when the video is in pt-BR. Prefer lines that sound like real reactions, such as 'isso da ruim', 'nao cai nessa', 'eu ja vi gente fazer isso', or 'essa ideia nao foi uma boa ideia', whenever they fit naturally. Start with a hard statement, warning, accusation, or shocking reveal. Build momentum through consequence, embarrassment, cost, and fail energy. Keep the script punchy, specific, and visually concrete. Keep each scene focused on one clear beat, but let the full script carry real progression instead of feeling like generic educational filler. Use ALL CAPS selectively for the words that need the strongest hit. Let the ending land as a memorable sting that makes the bad idea feel obviously stupid in hindsight. Do not add audio directions, editing directions, or narration outside the script itself.",
    voiceStyles: {
      "pt-BR": "com ritmo curto, visual e nativo de redes sociais",
      "en-US": "with a native short-form social rhythm"
    }
  },
  forte_impactante: {
    label: "FORTE-IMPACTANTE",
    description: "Curto, afiado e com mais tensao, contraste e impacto imediato.",
    scriptGuidance:
      "Write like a high-retention short-form creator with sharp contrast and immediate stakes. Open with a strong curiosity hook in the first sentence. Each scene must introduce a new concrete visual, a surprising fact, or a clear escalation. Use short spoken lines, strong nouns and verbs, and direct internet-native language. Avoid essay tone, soft summaries, filler transitions, connector crutches, and sleepy explanations. Keep it punchy, visual, slightly provocative, but still clear and credible. End cleanly without CTA.",
    voiceStyles: {
      "pt-BR": "com voz firme, envolvente, energica e impactante, sem soar teatral",
      "en-US": "with a firm, energetic and high-retention delivery without sounding theatrical"
    }
  },
  platform_hybrid: {
    label: "PLATAFORMA-HIBRIDA",
    description: "Hook de TikTok, curiosidade de Reddit, beleza de Instagram, nostalgia de Facebook e progressao de YouTube.",
    scriptGuidance:
      "Write like an internet-native hybrid short. Start with a sharp, weird, curiosity-driven hook in the first sentence. Make each scene deliver one obvious visual beat, one concrete object, and one fast payoff. Blend TikTok punch, Reddit curiosity, Instagram readability, Facebook nostalgia, and YouTube progression. Prefer bold contrast, specific nouns, modern spoken phrasing, and short lines that sound good aloud. Avoid essay tone, filler transitions, generic summaries, soft setup, and repetitive structure. Keep the story moving forward like a ranking or reveal sequence. End cleanly without CTA.",
    voiceStyles: {
      "pt-BR": "com voz firme, curiosa, rapida e muito nativa de internet, sem soar artificial",
      "en-US": "with a firm, curious, fast and internet-native delivery without sounding artificial"
    }
  },
  storyteller: {
    label: "Contador de história",
    description: "Narrativa mais envolvente, com progressao emocional e viradas limpas.",
    scriptGuidance:
      "Write like a visual storyteller with curiosity, emotional buildup, memorable turns, and clean scene progression. Keep it spoken, vivid, and human. Avoid connector crutches and do not include CTA.",
    voiceStyles: {
      "pt-BR": "como um contador de historia envolvente, fluido e expressivo",
      "en-US": "like an engaging storyteller, fluid and expressive"
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
  wellness_spiritual_light: {
    label: "Wellness • Espiritual leve",
    description: "Tom contemplativo e suave, com presenca e sentido, sem exagero mistico.",
    scriptGuidance:
      "Write a light spiritual wellness script with presence, softness and inner stillness. Keep it grounded, simple and intimate. Avoid dogma, grand promises, mystical excess, CTA, and filler transitions. End with peace, silence or breath, not motivation hype.",
    voiceStyles: {
      "pt-BR": "com voz suave, contemplativa e tranquila",
      "en-US": "with a soft, contemplative and peaceful voice"
    }
  },
  wellness_selfworth: {
    label: "Wellness • Autoestima silenciosa",
    description: "Fortalece valor proprio com delicadeza, sem frases prontas de autoajuda.",
    scriptGuidance:
      "Write a wellness script about self-worth in a quiet, grounded and intimate way. Focus on dignity, self-respect, boundaries and emotional steadiness. Avoid cliches, empty empowerment slogans, CTA, and dramatic motivational phrasing. Keep it simple, spoken and believable.",
    voiceStyles: {
      "pt-BR": "com voz humana, firme e delicada",
      "en-US": "with a warm, steady and intimate voice"
    }
  },
  wellness_breath_reset: {
    label: "Wellness • Respirar e desacelerar",
    description: "Pausa mental, respiracao e desaceleracao para videos de reset curto.",
    scriptGuidance:
      "Write a short wellness reset centered on breathing, slowing down and mental decompression. The script should feel like a brief pause in the day. Use very clear, slow and visual language. No CTA, no coaching slogans, no overexplaining. End with spaciousness and calm.",
    voiceStyles: {
      "pt-BR": "com voz leve, pausada e respirada",
      "en-US": "with a light, spacious and slow voice"
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

const voiceOptions = [
  {label: "Iapetus • Gemini TTS usada no último vídeo", value: "Iapetus"},
  {label: "Antonio • masculino natural", value: "pt-BR-AntonioNeural"},
  {label: "Brenda • feminina clara", value: "pt-BR-BrendaNeural"},
  {label: "Donato • masculino firme", value: "pt-BR-DonatoNeural"},
  {label: "Elza • feminina suave", value: "pt-BR-ElzaNeural"},
  {label: "Fabio • masculino equilibrado", value: "pt-BR-FabioNeural"},
  {label: "Francisca • feminina acolhedora", value: "pt-BR-FranciscaNeural"},
  {label: "Giovanna • feminina leve", value: "pt-BR-GiovannaNeural"},
  {label: "Humberto • masculino grave", value: "pt-BR-HumbertoNeural"},
  {label: "Julio • masculino objetivo", value: "pt-BR-JulioNeural"},
  {label: "Leila • feminina didática", value: "pt-BR-LeilaNeural"},
  {label: "Leticia • infantil", value: "pt-BR-LeticiaNeural"},
  {label: "Manuela • feminina natural", value: "pt-BR-ManuelaNeural"},
  {label: "Macerio • multilíngue", value: "pt-BR-MacerioMultilingualNeural"},
  {label: "Macerio • DragonHD premium", value: "pt-BR-Macerio:DragonHDLatestNeural"},
  {label: "Nicolau • masculino confiante", value: "pt-BR-NicolauNeural"},
  {label: "Thalita • feminina expressiva", value: "pt-BR-ThalitaNeural"},
  {label: "Thalita • multilíngue", value: "pt-BR-ThalitaMultilingualNeural"},
  {label: "Thalita • DragonHD premium", value: "pt-BR-Thalita:DragonHDLatestNeural"},
  {label: "Valerio • masculino sereno", value: "pt-BR-ValerioNeural"},
  {label: "Yara • feminina quente", value: "pt-BR-YaraNeural"},
  {label: "Personalizada", value: "__custom"}
];

const imageStyleOptions = Object.values(VISUAL_STYLE_PRESETS).map((preset) => ({
  label: preset.label,
  value: preset.id,
  description: preset.description
}));
const assetModeOptions = [
  {
    label: "Flex2 + SDXL (Local)",
    value: "flux2",
    description: "Gera imagens com o pipeline local Flex2 + SDXL."
  },
  {
    label: "Google Vertex",
    value: "google-cloud",
    description: "Gera imagens direto no Google Vertex, sem usar o pipeline local de imagem."
  }
];
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

const channelPresets = {
  foiumaideia: {
    tone: "shortform_native",
    voice: DEFAULT_VOICE,
    imageStyle: "editorial_line_green",
    outputProfile: "vertical-short",
    targetSeconds: 60,
    assetMode: "google-cloud",
    customStylePrompt: "com ritmo curto, visual e nativo de redes sociais, com voz firme, curiosa, ritmada e muito nativa de internet, sem soar teatral",
    scriptGuidance:
      "Write practical, curiosity-driven videos about technology, history, health, innovation, AI, automation and productivity. Open with a sharp internet-native hook, make the payoff arrive early, keep every scene visual and concrete, and close with a memorable final reveal or takeaway without CTA."
  },
  quiet2min: {
    tone: "wellness_comfort",
    voice: DEFAULT_VOICE,
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePrompt: "com voz calma, acolhedora, serena e ritmo suave",
    scriptGuidance:
      "Write calm, reflective and soothing short scripts focused on personal growth, emotional clarity, inner peace and gentle self-help. The tone should feel peaceful, grounded, reassuring and visually concrete, like a quiet reset for the day."
  },
  ate2min: {
    tone: "wellness_end_of_day",
    voice: DEFAULT_VOICE,
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePrompt: "com voz calorosa, tranquila, humana e inspiradora",
    scriptGuidance:
      "Write brief reflective stories with a calm, human and inspiring tone. Prioritize emotional clarity, practical wisdom, soft transitions and a memorable ending that fits within two minutes."
  }
};

const PREVIEW_QUEUE_LANE = "preview";
const HEAVY_QUEUE_LANE = "heavy";
const DEFAULT_ASSET_MODE = "flux2";

const jobs = new Map();
const streams = new Map();
const previewQueue = [];
const heavyQueue = [];
let activePreviewJobId = null;
let activeHeavyJobId = null;
let persistTimer = null;

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
  const issues = [];

  if (sceneCount < minScenes || sceneCount > maxScenes) {
    issues.push(`cenas ${sceneCount} fora da faixa ${minScenes}-${maxScenes}`);
  }

  const captionText = String(`${storyboard?.postCaption || ""} ${storyboard?.cta || ""}`).trim();
  if (captionText && PREVIEW_CTA_RE.test(captionText)) {
    issues.push("postCaption/cta com chamada para acao");
  }

  return {
    sceneCount,
    wordCount,
    minScenes,
    maxScenes,
    minWords,
    maxWords,
    issues
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
    voiceoverPath: path.join(runDir, "voiceover.json"),
    assetPlanPath: path.join(runDir, "asset-plan.json"),
    renderPropsPath: path.join(runDir, "render-props.json"),
    postPath: path.join(runDir, "post.txt"),
    assetDir: path.join(configuredVideoEngineRoot, "assets", "envato", slug),
    publicRunDir,
    publicAudioDir: path.join(publicRunDir, "audio"),
    publicVideoDir: path.join(publicRunDir, "video"),
    publicAudioPath: path.join(publicRunDir, "audio", "voiceover.mp3"),
    outPath: path.join(configuredVideoEngineRoot, "out", `${slug}.mp4`)
  };
};

const hasBasicResumeArtifacts = (job) => {
  if (job.type !== "generate" || job.status !== "failed" || job.input?.previewOnly) {
    return false;
  }

  const paths = getRunPaths(job.slug);

  if (
    !existsSync(paths.storyboardPath) ||
    !existsSync(paths.voiceoverPath) ||
    !existsSync(paths.publicAudioPath)
  ) {
    return false;
  }

  try {
    const storyboard = JSON.parse(readFileSync(paths.storyboardPath, "utf8"));
    const sceneCount = Array.isArray(storyboard?.scenes) ? storyboard.scenes.length : 0;

    if (sceneCount === 0) {
      return false;
    }

    for (let index = 0; index < sceneCount; index += 1) {
      const fileName = `scene-${String(index + 1).padStart(2, "0")}.mp4`;
      if (!existsSync(path.join(paths.assetDir, fileName))) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
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
let videoMetadata = (await readJsonFile(videosFile)) || {};

const getChannelConfig = (value) =>
  channelOptions.find((channel) => channel.value === value) || channelOptions[0];

const getChannelPreset = (value) => channelPresets[value] || channelPresets.foiumaideia;

const getChannelExportDir = (channelValue) => path.join(postarRoot, getChannelConfig(channelValue).folder);
const getDurationOptions = (profileValue) => getDurationOptionsForProfile(profileValue);
const outputProfileOptions = listOutputProfileOptions();
const defaultDurationOptions = getDurationOptionsForProfile(DEFAULT_OUTPUT_PROFILE);

const createFileUrl = (filePath) => `/api/file?path=${encodeURIComponent(filePath)}`;

const sanitizeJob = (job) => ({
  id: job.id,
  type: job.type,
  title: job.title,
  slug: job.slug,
  queueLane: job.queueLane || null,
  status: job.status,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
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
  resumeAvailable: hasBasicResumeArtifacts(job)
});

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
  const metadata = getVideoMetadataEntry({channel: channel.value, slug});
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
    lastPostId: metadata.lastPostId ?? null,
    lastPublishedAt: metadata.lastPublishedAt || null,
    publishStatus: metadata.publishStatus || "",
    publishError: metadata.publishError || "",
    jobId: latestJob?.id || null,
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
  await writeFile(getVideoMetaPath(slug), JSON.stringify(payload, null, 2));
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

const buildVideoRecord = async ({targetPath, channelValue}) => {
  const details = await stat(targetPath);
  const matchedJob = findJobForVideoPath(targetPath);
  const slug = inferVideoSlug(targetPath);
  const channel = getChannelConfig(channelValue || matchedJob?.input?.channel || inferChannelValueFromPath(targetPath));
  const paths = getRunPaths(slug);
  const storyboardPath = matchedJob?.storyboardPath || (existsSync(paths.storyboardPath) ? paths.storyboardPath : "");
  const storyboard = storyboardPath ? await readJsonFile(storyboardPath) : null;
  const postText = existsSync(paths.postPath) ? await readTextFile(paths.postPath) : "";
  const postMeta = parsePostText(postText);
  const meta = await readVideoMeta(slug);
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
    publishedAt: meta?.publishedAt || null,
    publishedPostId: meta?.publishedPostId || null,
    lastPublishPlatforms: Array.isArray(meta?.lastPublishPlatforms) ? meta.lastPublishPlatforms : [],
    lastPublishStatus: meta?.lastPublishStatus || null
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
        outputProfile: job.input?.outputProfile || null
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
  process.env.AGENDADOR_EMAIL = process.env.AGENDADOR_EMAIL || baseChildEnv.AGENDADOR_EMAIL || "";
  process.env.AGENDADOR_PASSWORD = process.env.AGENDADOR_PASSWORD || baseChildEnv.AGENDADOR_PASSWORD || "";

  if (process.env.AGENDADOR_EMAIL && process.env.AGENDADOR_PASSWORD) {
    return;
  }

  const secretsModulePath = path.join(configuredVideoEngineRoot, "scripts", "lib", "secrets.mjs");
  const {loadSecretsIntoEnv} = await import(secretsModulePath);
  loadSecretsIntoEnv(["AGENDADOR_EMAIL", "AGENDADOR_PASSWORD"]);
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
    throw new Error(payload?.error || `${method} ${endpoint} falhou com ${response.status}.`);
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

const getAgendadorToken = async () => {
  await ensureAgendadorSecrets();

  if (!process.env.AGENDADOR_EMAIL || !process.env.AGENDADOR_PASSWORD) {
    throw new Error("Faltam AGENDADOR_EMAIL e AGENDADOR_PASSWORD no .env ou no Keychain.");
  }

  const auth = await agendadorFetch("/auth/login", {
    method: "POST",
    body: {
      email: process.env.AGENDADOR_EMAIL,
      password: process.env.AGENDADOR_PASSWORD
    }
  });
  const token = auth?.token;

  if (!token) {
    throw new Error("A autenticacao do agendador nao devolveu token.");
  }

  return token;
};

const uploadVideoToAgendador = async (token, filePath) => {
  const prepared = await ensureUploadableForAgendador(filePath);
  const buffer = await readFile(prepared.filePath);
  const form = new FormData();
  form.set("file", new Blob([buffer], {type: "video/mp4"}), path.basename(prepared.filePath));
  const payload = await agendadorFetch("/upload", {
    method: "POST",
    token,
    form
  });
  return payload?.url || "";
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

  broadcastJob(job);
};

const updateJob = (job, updates) => {
  Object.assign(job, updates, {updatedAt: new Date().toISOString()});
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
  const assetMode = assetModeOptions.some((option) => option.value === job.input.assetMode)
    ? job.input.assetMode
    : DEFAULT_ASSET_MODE;
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
    "--asset-mode",
    assetMode,
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

    if (!existsSync(paths.publicAudioPath)) {
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
        `--concurrency=${process.env.REMOTION_CONCURRENCY || "6"}`,
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

    job.processId = child.pid;
    broadcastJob(job);

    const collect = (chunk, source) => appendLog(job, chunk, source);
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

    const exitCode = await new Promise((resolve) => {
      child.on("error", (error) => {
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
    job.processId = null;

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
    appendLog(job, `[resume] finalizado em ${finalPath}\n`);
  } catch (error) {
    job.processId = null;
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

  return new Promise((resolve) => {
    const child = spawn(processConfig.command, processConfig.args, {
      cwd: processConfig.cwd,
      env: processConfig.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    job.processId = child.pid;
    broadcastJob(job);

    child.stdout.on("data", (chunk) => appendLog(job, chunk, "stdout"));
    child.stderr.on("data", (chunk) => appendLog(job, chunk, "stderr"));

    child.on("error", (error) => {
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
      job.processId = null;

      if (code === 0) {
        try {
          if (job.type === "generate") {
            await finalizeGenerateJob(job);
          } else {
            await finalizeRerenderJob(job);
          }

          updateJob(job, {status: "completed"});
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
  job.queueLane = getJobQueueLane(job);
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

const allowedRoots = [projectRoot, configuredVideoEngineRoot, postarRoot].filter(Boolean);

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
    const range = parseRangeHeader(request.headers.range, details.size);

    if (range) {
      response.writeHead(206, {
        "Content-Type": contentType,
        "Content-Length": range.end - range.start + 1,
        "Content-Range": `bytes ${range.start}-${range.end}/${details.size}`,
        "Accept-Ranges": "bytes"
      });
      createReadStream(resolved, {start: range.start, end: range.end}).pipe(response);
      return;
    }

    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": details.size,
      "Accept-Ranges": "bytes"
    });
    createReadStream(resolved).pipe(response);
  } catch (error) {
    sendJson(response, 404, {error: error instanceof Error ? error.message : "Arquivo nao encontrado."});
  }
};

const VALID_LANGUAGES = ["pt-BR", "en-US"];
const VALID_TONES = Object.keys(tonePresets);
const VALID_VOICES = voiceOptions.map((option) => option.value);
const VALID_ASSET_MODES = assetModeOptions.map((option) => option.value);
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
  const selectedVoice = String(body.voice || DEFAULT_VOICE).trim();
  const customVoice = String(body.customVoice || "").trim().slice(0, MAX_CUSTOM_VOICE_LENGTH);
  const voice = selectedVoice === "__custom" ? customVoice : (VALID_VOICES.includes(selectedVoice) ? selectedVoice : DEFAULT_VOICE);
  const assetMode = VALID_ASSET_MODES.includes(String(body.assetMode || "").trim())
    ? String(body.assetMode).trim()
    : DEFAULT_ASSET_MODE;
  const outputProfile = resolveOutputProfileConfig(body.outputProfile);

  if (!voice) {
    sendJson(response, 400, {error: "Escolha uma voz valida."});
    return;
  }

  const channel = getChannelConfig(String(body.channel || "foiumaideia"));
  const channelPreset = getChannelPreset(channel.value);
  const targetSeconds = getProfileTargetSeconds(outputProfile.id, Number(body.targetSeconds));
  const slug = `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const sourceTextFile = sourceText ? path.join(inputsDir, `${createId()}-source.txt`) : "";

  if (sourceTextFile) {
    await mkdir(inputsDir, {recursive: true});
    await writeFile(sourceTextFile, sourceText);
  }

  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
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
      assetMode,
      imageStyle: imageStyleOptions.some((option) => option.value === body.imageStyle)
        ? String(body.imageStyle)
        : DEFAULT_VISUAL_STYLE_PRESET,
      voice,
      tone,
      stylePrompt: combineStylePrompt({
        language,
        tone,
        customStylePrompt: String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH)
      }),
      scriptGuidance: String(body.scriptGuidance || tonePreset.scriptGuidance || channelPreset.scriptGuidance || "").trim(),
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
  const selectedVoice = String(body.voice || DEFAULT_VOICE).trim();
  const customVoice = String(body.customVoice || "").trim().slice(0, MAX_CUSTOM_VOICE_LENGTH);
  const voice = selectedVoice === "__custom" ? customVoice : (VALID_VOICES.includes(selectedVoice) ? selectedVoice : DEFAULT_VOICE);

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
      scriptGuidance: tonePreset.scriptGuidance
    },
    outputPath: null,
    storyboardPath: null,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(job)});
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

  const resumedJob = {
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
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(resumedJob)});
};

const handleVideosRequest = async (response) => {
  const videos = await listExportVideos();
  const failedJobs = await listFailedLibraryJobs();
  sendJson(response, 200, {
    videos,
    failedJobs,
    agendador: {
      configured: Boolean(baseChildEnv.AGENDADOR_EMAIL && baseChildEnv.AGENDADOR_PASSWORD),
      keychainBacked: HAS_SECURITY_CLI
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
  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
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
      assetMode: previousJob?.input?.assetMode || DEFAULT_ASSET_MODE,
      imageStyle: previousJob?.input?.imageStyle || DEFAULT_VISUAL_STYLE_PRESET,
      voice,
      tone,
      stylePrompt: previousJob?.input?.stylePrompt || combineStylePrompt({language, tone, customStylePrompt: ""}),
      scriptGuidance: previousJob?.input?.scriptGuidance || tonePreset.scriptGuidance || channelPreset.scriptGuidance || "",
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

  const storyboardPath = getRetryStoryboardPathForJob(sourceJob);
  const storyboard = await readJsonFile(storyboardPath);

  if (!storyboard?.scenes?.length) {
    sendJson(response, 409, {error: "Nao achei storyboard valido para refazer esse job."});
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
  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const title = String(storyboard.videoTitle || sourceJob.title || slugToCaption(sourceJob.slug)).trim();
  const retriedJob = {
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
      stylePrompt: sourceJob.input?.stylePrompt || combineStylePrompt({language, tone, customStylePrompt: ""}),
      scriptGuidance: sourceJob.input?.scriptGuidance || tonePreset.scriptGuidance || channelPreset.scriptGuidance || "",
      channelHandle: channel.handle,
      noMusic: sourceJob.input?.noMusic !== false,
      force: true,
      previewOnly: false,
      approvedFromJobId: sourceJob.id
    },
    outputPath: null,
    storyboardPath,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueJob(retriedJob)});
};

const handleVideoDeleteRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const paths = getRunPaths(target.slug);

  await safeUnlink(target.path);
  await safeUnlink(paths.outPath);
  await safeUnlink(getVideoMetaPath(target.slug));
  await removeVideoMetadataEntry({channel: body.channel || "foiumaideia", slug: target.slug}).catch(() => {});

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
  const token = await getAgendadorToken();
  const accountsPayload = await agendadorFetch("/social-accounts", {token});
  const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const missingProviders = safePlatforms.filter((provider) => {
    const account = accounts.find((item) => item.provider === provider);
    return !account?.connected;
  });

  if (missingProviders.length > 0) {
    sendJson(response, 409, {error: `Conecte as redes: ${missingProviders.join(", ")}`});
    return;
  }

  const mediaUrl = await uploadVideoToAgendador(token, target.path);
  const created = await agendadorFetch("/posts", {
    method: "POST",
    token,
    body: {
      date: publishDate,
      mediaUrl,
      caption,
      platforms: safePlatforms,
      isDraft
    }
  });

  await writeVideoMeta(target.slug, {
    ...meta,
    title: String(body.title || meta?.title || video.title || "").trim(),
    caption: captionBase,
    hashtags,
    scheduleAt: publishDate,
    isDraft,
    platforms: safePlatforms,
    updatedAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    publishedPostId: created?.post?.id ?? null,
    lastPublishPlatforms: safePlatforms,
    lastPublishStatus: isDraft ? "draft" : "scheduled"
  });

  sendJson(response, 200, {
    ok: true,
    post: created?.post ?? created ?? null,
    video: await buildVideoRecord({targetPath: target.path})
  });
};

const handleConfigRequest = async (response) => {
  sendJson(response, 200, {
    defaults: {
      channel: channelOptions[0].value,
      language: "pt-BR",
      targetSeconds: 60,
      outputProfile: DEFAULT_OUTPUT_PROFILE,
      assetMode: "google-cloud",
      imageStyle: DEFAULT_VISUAL_STYLE_PRESET,
      tone: "shortform_native",
      voice: DEFAULT_VOICE,
      noMusic: true,
      force: true
    },
    voices: voiceOptions,
    channels: channelOptions,
    channelPresets,
    outputProfiles: outputProfileOptions,
    assetModes: assetModeOptions,
    imageStyles: imageStyleOptions,
    tones: Object.entries(tonePresets).map(([value, config]) => ({
      value,
      label: config.label,
      description: config.description || ""
    })),
    durations: defaultDurationOptions,
    durationsByProfile: Object.fromEntries(
      outputProfileOptions.map((profile) => [profile.value, profile.durations])
    )
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
await mkdir(postarRoot, {recursive: true});
await Promise.all(channelOptions.map((channel) => mkdir(getChannelExportDir(channel.value), {recursive: true})));

const persistedJobs = await readJsonFile(jobsFile);

if (Array.isArray(persistedJobs)) {
  for (const persistedJob of persistedJobs) {
    if (persistedJob.status === "running" || persistedJob.status === "queued") {
      persistedJob.status = "failed";
      persistedJob.error = "Servidor reiniciado antes da conclusao deste job.";
      persistedJob.completedAt = persistedJob.completedAt || new Date().toISOString();
    }

    jobs.set(persistedJob.id, {
      ...persistedJob,
      queueLane: persistedJob.queueLane || getJobQueueLane(persistedJob),
      logTail: Array.isArray(persistedJob.logTail) ? persistedJob.logTail : []
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

    if (method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/retry-from-storyboard")) {
      await handleRetryFailedJobRequest(request, response);
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

const gracefulShutdown = () => {
  process.stdout.write("\nEncerrando servidor...\n");

  for (const [, subscribers] of streams) {
    for (const response of subscribers) {
      try {
        response.end();
      } catch { /* ignore */ }
    }
  }

  streams.clear();
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
