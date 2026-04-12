import http from "node:http";
import {spawn, spawnSync} from "node:child_process";
import {createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  DEFAULT_OUTPUT_PROFILE,
  getDurationOptionsForProfile,
  listOutputProfileOptions,
  resolveOutputProfileConfig
} from "../config/output-profiles.mjs";
import {DEFAULT_VISUAL_STYLE_PRESET} from "../config/visual-style-presets.mjs";
import {analyzeSceneSpeechPacing, buildTimeline} from "../video-engine/scripts/lib/timings.mjs";
import {
  init as initJobState,
  getArtifactEpochMs,
  isPreviewStoryboardSlug,
  getPreviewStoryboardSlug,
  getStoryboardPathCandidates,
  findExistingStoryboardPath,
  isUsableSceneClipPath,
  isReadySceneClipForJob,
  isFreshArtifactForJob,
  readJsonSyncIfExists,
  getArtifactSnapshot,
  doesQaReportMatchOutputArtifact,
  resolveEffectiveStoryboardPath,
  shouldAllowPreviewStoryboardFallback,
  resolveOperationalStoryboardPath,
  getFreshSceneNumbers,
  getSceneCompletionStats,
  getMissingSceneHintFromJob,
  hasBasicResumeArtifacts,
  getFirstMissingSceneNumber,
  getReferencedRecoveryJobIds,
  getLatestGenerateJobForSlug,
  getRecoverySourceJob,
  getRecoveryArtifactEpochAt,
  getQaReportForSlug,
  getQaReportForJob,
  isQaPassedReport,
  isQaPassedForSlug,
  isQaPassedForJob,
  canPrepareAudioForJob,
  canRenderOnlyForJob,
  canValidateOnlyForJob,
  getFailureStage,
  getFailureSummary,
  normalizeFailureLine,
  isLowSignalFailureLine,
  getMostRelevantFailureLogLine,
  getProcessFailureMessage,
  normalizeSignalText,
  inferJobStageValue,
  getStageLabel,
  getJobStateInfo,
  getJobStageInfo,
  getJobRca,
  getJobFailureTaxonomy,
  getJobRecommendedAction,
  buildJobStepChecklist,
  getJobStepChecklist,
  buildCaseSummary,
  buildJobsSummary
} from "./lib/job-state.mjs";
import {
  init as initAgendador,
  getAgendadorSiteUrl,
  getAgendadorApiBase,
  resolveAgendadorChannelProfile,
  hasAgendadorCredentialsForChannel,
  normalizePlatforms,
  agendadorFetch,
  getAgendadorToken,
  uploadVideoToAgendador,
  uploadThumbnailToAgendador,
  isAccountPublishReady,
  describeAccountPublishIssue
} from "./lib/agendador.mjs";
import {
  FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE,
  tonePresets,
  DEFAULT_VOICE,
  DEFAULT_ENGLISH_VOICE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_GENERATION_MODE,
  voiceOptions,
  imageModelOptions,
  generationModeOptions,
  imageStylePreviewFiles,
  buildImageStyleOptions,
  channelOptions,
  channelPublishProfiles,
  channelPresets
} from "./lib/presets.mjs";
import {addRoute, matchRoute} from "./lib/routes.mjs";
import {
  parseEnvFile,
  resolvePathFrom,
  slugify,
  deriveTitleFromText,
  createId,
  readJsonFile,
  PROCESS_UID,
  getDesiredOwnerForPath,
  syncPathOwnership,
  syncPathMode,
  ensureManagedDir,
  writeManagedFile,
  copyManagedFile,
  normalizeManagedTree,
  writeJsonFile,
  fileExists,
  createFileUrl,
  readTextFile,
  safeUnlink,
  toVideoId,
  fromVideoId,
  roundSeconds,
  countWords,
  escapeHtml,
  toIsoNow,
  toTimestampMs,
  normalizePositiveInt
} from "./lib/utils.mjs";
import {buildTikTokHelperHtml, readTikTokDraft, writeTikTokDraft} from "./lib/tiktok-helper.mjs";
import {
  init as initVideoLibrary,
  getVideoStateInfo,
  getVideoStageInfo,
  getVideoRca,
  getVideoRecommendedAction,
  buildVideoCaseSummary,
  buildVideosSummary,
  getVideoMetadataKey,
  persistVideoMetadata,
  getVideoMetadataEntry,
  saveVideoMetadataEntry,
  removeVideoMetadataEntry,
  getVideoMetaPath,
  readVideoMeta,
  writeVideoMeta,
  findJobForVideoPath,
  inferVideoSlug,
  findLatestJobForSlug,
  findLatestCompletedJobForSlug,
  hasRecoveredSuccessfulArtifactsForSlug,
  findLatestDisplayJobForSlug,
  getRetryStoryboardPathForJob,
  canRetryFailedJobFromStoryboard,
  getVideoDurationSeconds,
  createVideoRecord,
  buildVideoRecord,
  listAllExports,
  listExportVideos,
  listFailedLibraryJobs,
  resolveVideoTarget,
  inferChannelValueFromPath,
  slugToCaption
} from "./lib/video-library.mjs";
import {
  init as initJobQueue,
  getJobQueueLane,
  getQueueForLane,
  getActiveJobIdForLane,
  setActiveJobIdForLane,
  getActiveJobIds,
  getQueueLengths,
  isLaneProcessing,
  setLaneProcessing,
  refreshQueuePositions,
  failJobAndReleaseQueue,
  enqueueJob
} from "./lib/job-queue.mjs";
import {
  init as initJobExecution,
  registerJobProcess,
  clearJobProcess,
  collectDescendantPids,
  terminateJobProcessTree,
  executeChildProcess,
  createGenerateJobCommand,
  createRerenderJobCommand,
  createAudioPrepJobCommand,
  createRenderOnlyJobCommand,
  createValidateOnlyJobCommand,
  createSceneRegenerateJobCommand
} from "./lib/job-execution.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "web", "public");
const dataDir = path.join(projectRoot, ".web-ui");
const localTempRootDir = path.join(projectRoot, ".tmp");
const localSystemTempDir = path.join(localTempRootDir, "system");
const localXdgCacheDir = path.join(localTempRootDir, "xdg-cache");
const localPuppeteerCacheDir = path.join(localTempRootDir, "puppeteer-cache");
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
const MAX_LOG_LINES = 2000;
const MAX_BODY_BYTES = 1_500_000;
const MISSING_RUN_SLUG = "__missing_run_slug__";
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

// Presets imported from ./lib/presets.mjs
// Utils imported from ./lib/utils.mjs




const imageStyleOptions = buildImageStyleOptions(stylePreviewDir);


const jobs = new Map();
const streams = new Map();
let persistTimer = null;


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
  const normalizedSlug = String(slug ?? "").trim() || MISSING_RUN_SLUG;
  const runDir = path.join(configuredVideoEngineRoot, "runs", normalizedSlug);
  const publicRunDir = path.join(configuredVideoEngineRoot, "public", "runs", normalizedSlug);

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
    assetDir: path.join(configuredVideoEngineRoot, "assets", "envato", normalizedSlug),
    publicRunDir,
    publicAudioDir: path.join(publicRunDir, "audio"),
    publicVideoDir: path.join(publicRunDir, "video"),
    publicAudioPath: path.join(publicRunDir, "audio", "voiceover.mp3"),
    outPath: path.join(configuredVideoEngineRoot, "out", `${normalizedSlug}.mp4`)
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
      throw new Error(`Falta o clip ${fileName} em assets/${slug}.`);
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
        source: "generated-local",
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
  outputProfile,
  existingRenderProps
}) => {
  const timeline = buildTimeline({
    scenes: assetPlan,
    audioDurationSeconds,
    fps: RESUME_RENDER_FPS,
    timedWords,
    sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : []
  });
  const musicPath = job.input?.noMusic ? null : existingRenderProps?.musicPath || null;

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

const rootEnvConfig = await parseEnvFile(rootEnvPath);
const configuredVideoEngineRoot = resolvePathFrom(
  projectRoot,
  rootEnvConfig.VIDEO_ENGINE_ROOT || rootEnvConfig.VIDEOS_ENVATO_ROOT,
  defaultVideoEngineRoot
);
initJobState({getRunPaths, getJobs: () => jobs, canRetryFailedJobFromStoryboard});
const videoEnvConfig = await parseEnvFile(path.join(configuredVideoEngineRoot, ".env"));
const postarRoot = resolvePathFrom(projectRoot, process.env.POSTAR_ROOT || rootEnvConfig.POSTAR_ROOT, defaultPostarRoot);
const secretsModulePath = path.join(configuredVideoEngineRoot, "scripts", "lib", "secrets.mjs");
let loadSecretsIntoEnv = () => {};

if (existsSync(secretsModulePath)) {
  ({loadSecretsIntoEnv} = await import(secretsModulePath));
}

await Promise.all([
  mkdir(localSystemTempDir, {recursive: true}),
  mkdir(localXdgCacheDir, {recursive: true}),
  mkdir(localPuppeteerCacheDir, {recursive: true})
]);

process.env.TMPDIR = process.env.TMPDIR || localSystemTempDir;
process.env.TMP = process.env.TMP || process.env.TMPDIR;
process.env.TEMP = process.env.TEMP || process.env.TMPDIR;
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || localXdgCacheDir;
process.env.PUPPETEER_CACHE_DIR = process.env.PUPPETEER_CACHE_DIR || localPuppeteerCacheDir;
process.env.REMOTION_CONCURRENCY = process.env.REMOTION_CONCURRENCY || "1";

const baseChildEnv = {
  ...rootEnvConfig,
  ...videoEnvConfig,
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR,
  REMOTION_CONCURRENCY: process.env.REMOTION_CONCURRENCY,
  ...process.env
};
let videoMetadata = (await readJsonFile(videosFile)) || {};

const getChannelConfig = (value) =>
  channelOptions.find((channel) => channel.value === value) || channelOptions[0];

const getChannelPreset = (value) => channelPresets[value] || channelPresets.foiumaideia;

const getDefaultVoiceForLanguage = (language) =>
  String(language || "").startsWith("en") ? DEFAULT_ENGLISH_VOICE : DEFAULT_VOICE;

const resolveRequestedVoice = ({selectedVoice, customVoice, language, channelPreset = null, audioProvider = "gcp"}) => {
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

  // Accept ElevenLabs voice IDs (alphanumeric 20-char IDs) when provider is elevenlabs
  if (audioProvider === "elevenlabs" && requestedVoice.length >= 10 && /^[a-zA-Z0-9]+$/.test(requestedVoice)) {
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

const serializeGenerationModeOption = (option) => ({
  value: option.value,
  label: option.label,
  badge: option.badge || "",
  description: option.description || ""
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

const resolveGenerationMode = (value, fallback = DEFAULT_GENERATION_MODE) => {
  const normalized = String(value || "").trim();
  return generationModeOptions.some((option) => option.value === normalized) ? normalized : fallback;
};

const sanitizeJob = (job) => {
  const stepChecklist = getJobStepChecklist(job);
  const stepMap = Object.fromEntries(
    (Array.isArray(stepChecklist.steps) ? stepChecklist.steps : []).map((step) => [step.key, step])
  );
  const firstMissingSceneNumber = normalizePositiveInt(stepChecklist.firstMissingSceneNumber);
  const resumeAvailable = hasBasicResumeArtifacts(job);
  const state = getJobStateInfo(job);
  const stage = getJobStageInfo(job);
  const rca = getJobRca(job);
  const failureTaxonomy = getJobFailureTaxonomy({...job, rca});
  const recommendedAction = getJobRecommendedAction(job);
  const recoverySourceJob = getRecoverySourceJob(job);
  const isPreview = Boolean(recoverySourceJob?.input?.previewOnly || job.input?.previewOnly);
  const effectiveStoryboardPath = findExistingStoryboardPath(job);

  return {
    id: job.id,
    type: job.type,
    title: job.title,
    slug: job.slug,
    caseId: job.caseId || null,
    attempt: job.attempt || null,
    queueLane: job.queueLane || null,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    heartbeatAt: job.heartbeatAt || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    artifactEpochAt: job.artifactEpochAt || null,
    stageValue: job.stageValue || null,
    stageSource: job.stageSource || null,
    stageConfidence: job.stageConfidence || null,
    stageUpdatedAt: job.stageUpdatedAt || null,
    queuePosition: job.queuePosition ?? null,
    input: {
      ...job.input,
      sourceTextFile: job.input?.sourceTextFile ? "[internal]" : ""
    },
    outputPath: job.outputPath || null,
    outputUrl: job.outputPath ? createFileUrl(job.outputPath) : null,
    storyboardPath: effectiveStoryboardPath || null,
    storyboardUrl: effectiveStoryboardPath ? createFileUrl(effectiveStoryboardPath) : null,
    followUpJobId: job.followUpJobId || null,
    logTail: job.logTail,
    exitCode: typeof job.exitCode === "number" ? job.exitCode : null,
    error: job.error || null,
    failureStage: getFailureStage(job),
    failureSummary: getFailureSummary(job),
    resumeAvailable,
    retryFromStoryboardAvailable: !isPreview && canRetryFailedJobFromStoryboard(job),
    forceFailAvailable: ["queued", "running"].includes(String(job.status || "").trim().toLowerCase()),
    sceneRegenerateAvailable: !isPreview && job.status === "failed" && firstMissingSceneNumber !== null,
    audioPrepAvailable: !isPreview && canPrepareAudioForJob(job) && stepMap.audio?.status !== "completed",
    renderOnlyAvailable: !isPreview && canRenderOnlyForJob(job) && stepMap.render?.status !== "completed",
    validateOnlyAvailable: !isPreview && canValidateOnlyForJob(job) && stepMap.qa?.status !== "completed",
    nextMissingSceneNumber: job.status === "completed" ? null : firstMissingSceneNumber,
    stepChecklist: stepChecklist.steps,
    state,
    stage,
    rca,
    failureTaxonomy,
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

const serializeJobForPersistence = (job) => {
  const nowIso = toIsoNow();
  return {
    ...job,
    queueLane: job.queueLane || getJobQueueLane(job),
    logTail: Array.isArray(job.logTail) ? job.logTail : [],
    heartbeatAt: job.heartbeatAt || job.updatedAt || job.createdAt || nowIso,
    artifactEpochAt: job.artifactEpochAt || job.createdAt || nowIso,
    stageValue: job.stageValue || inferJobStageValue(job),
    stageSource: job.stageSource || "system",
    stageConfidence: job.stageConfidence || "medium",
    stageUpdatedAt: job.stageUpdatedAt || job.updatedAt || nowIso
  };
};

const persistJobs = async () => {
  await ensureManagedDir(dataDir);
  const payload = JSON.stringify(
    Array.from(jobs.values())
      .map((job) => serializeJobForPersistence(job))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    null,
    2
  );
  const tempJobsFile = path.join(dataDir, `jobs.json.${process.pid}.${Date.now()}.tmp`);
  await writeManagedFile(tempJobsFile, payload);
  await rename(tempJobsFile, jobsFile);
};

const persistJobsSync = () => {
  mkdirSync(dataDir, {recursive: true, mode: 0o755});
  const payload = JSON.stringify(
    Array.from(jobs.values())
      .map((job) => serializeJobForPersistence(job))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    null,
    2
  );
  const tempJobsFile = path.join(dataDir, `jobs.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempJobsFile, payload);
  renameSync(tempJobsFile, jobsFile);
};

const slugHasMaterializedArtifacts = (slug) => {
  const paths = getRunPaths(slug);
  return (
    existsSync(paths.runDir) ||
    existsSync(paths.assetDir) ||
    existsSync(paths.outPath)
  );
};

const buildUniqueGenerateSlug = (title) => {
  const slugBase = slugify(title) || "video";
  const datePrefix = new Date().toISOString().slice(0, 10);
  const rootSlug = `${datePrefix}-${slugBase}`;
  let candidate = rootSlug;
  let suffix = 2;

  while (
    Array.from(jobs.values()).some((job) => String(job?.slug || "").trim() === candidate) ||
    slugHasMaterializedArtifacts(candidate)
  ) {
    candidate = `${rootSlug}-${suffix}`;
    suffix += 1;
  }

  return candidate;
};

const getNextAttemptForCase = (caseId) => {
  if (!caseId) {
    return 1;
  }

  let maxAttempt = 0;
  for (const job of jobs.values()) {
    if (job.caseId === caseId && typeof job.attempt === "number") {
      maxAttempt = Math.max(maxAttempt, job.attempt);
    }
  }

  return maxAttempt + 1;
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
  const thumbnailDetails = thumbnailPath ? await stat(thumbnailPath).catch(() => null) : null;
  const localThumbnailUrl = thumbnailPath ? createFileUrl(thumbnailPath, thumbnailDetails ? Math.trunc(thumbnailDetails.mtimeMs) : null) : "";
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

initAgendador({
  baseChildEnv,
  configuredVideoEngineRoot,
  videoLibraryDir,
  getChannelConfig,
  channelPublishProfiles,
  ensureManagedDir,
  getDesiredOwnerForPath,
  syncPathOwnership,
  syncPathMode,
  runFfmpeg
});

const resolvePreferredThumbnailSource = async (targetPath, slug) => {
  const meta = await readVideoMeta(slug).catch(() => null); /* expected: meta file may not exist yet */
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

  await ensureManagedDir(videoLibraryDir);
  const thumbnailDir = path.join(videoLibraryDir, "thumbnails");
  await ensureManagedDir(thumbnailDir);
  const thumbnailPath = path.join(thumbnailDir, `${slugify(slug)}.jpg`);
  const desiredThumbnailOwner = await getDesiredOwnerForPath(thumbnailPath);
  const sourceStat = await stat(targetPath);
  const thumbnailStat = existsSync(thumbnailPath) ? await stat(thumbnailPath).catch(() => null) : null; /* expected: race with unlink */

  if (thumbnailStat && thumbnailStat.mtimeMs >= sourceStat.mtimeMs) {
    return thumbnailPath;
  }

  const durationSeconds = getVideoDurationSeconds(targetPath);
  const seekSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.max(1.5, Math.min(8, durationSeconds * 0.12))
    : 2;

  await unlink(thumbnailPath).catch(() => {}); /* best-effort: old thumbnail may not exist */
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
  await syncPathOwnership(thumbnailPath, desiredThumbnailOwner);
  await syncPathMode(thumbnailPath, 0o644);

  return thumbnailPath;
};

const schedulePersist = ({immediate = false} = {}) => {
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

    try {
      persistJobsSync();
    } catch (error) {
      process.stderr.write(`Falha ao persistir jobs: ${error.message}\n`);
    }
    return;
  }

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

const sendEvent = (response, event, payload) => {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const broadcastJob = (job, {skipPersist = false} = {}) => {
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

  if (!skipPersist) {
    schedulePersist();
  }
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

initJobQueue({
  jobs,
  broadcastJob,
  schedulePersist,
  sanitizeJob,
  toIsoNow,
  appendLog,
  getFailureStage,
  clearJobProcess
});

const updateJob = (job, updates) => {
  const nowIso = toIsoNow();
  Object.assign(job, updates, {updatedAt: nowIso});
  job.heartbeatAt = nowIso;
  const nextStatus = String(updates?.status || "").trim().toLowerCase();
  const persistImmediately = nextStatus === "completed" || nextStatus === "failed";
  broadcastJob(job, {skipPersist: true});
  schedulePersist({immediate: persistImmediately});
};

const combineStylePrompt = ({language, tone, customStylePrompt}) => {
  const preset = tonePresets[tone] || tonePresets.natural_clean;
  const fallbackLanguage = String(language || "pt-BR").startsWith("en") ? "en-US" : "pt-BR";
  const basePrompt = preset.voiceStyles[fallbackLanguage];
  const customPrompt = String(customStylePrompt || "").trim();
  const normalizePrompt = (value) =>
    String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.,;:!?]+$/g, "")
      .toLowerCase();

  if (!customPrompt) {
    return basePrompt;
  }

  if (!basePrompt) {
    return customPrompt;
  }

  const normalizedBase = normalizePrompt(basePrompt);
  const normalizedCustom = normalizePrompt(customPrompt);

  if (!normalizedBase) {
    return customPrompt;
  }

  if (!normalizedCustom) {
    return basePrompt;
  }

  if (normalizedBase === normalizedCustom) {
    return basePrompt;
  }

  if (normalizedCustom.startsWith(`${normalizedBase} `) || normalizedCustom.startsWith(`${normalizedBase},`)) {
    return customPrompt;
  }

  if (normalizedBase.startsWith(`${normalizedCustom} `) || normalizedBase.startsWith(`${normalizedCustom},`)) {
    return basePrompt;
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













const finalizeGenerateJob = async (job) => {
  const exportDir = getChannelExportDir(job.input.channel);
  const storyboardPath = resolveEffectiveStoryboardPath(job);

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
  const storyboardPath = resolveEffectiveStoryboardPath(job);
  const finalPath = await resolveLocalizedExportPath({
    exportDir,
    slug: job.slug,
    fallbackTitle: job.title,
    storyboardPath
  });

  await ensureManagedDir(exportDir);
  await copyManagedFile(outPath, finalPath);
  job.outputPath = finalPath;
  job.storyboardPath = storyboardPath;
};

const finalizeAudioPrepJob = async (job) => {
  const paths = getRunPaths(job.slug);
  job.storyboardPath = resolveEffectiveStoryboardPath(job);
  job.outputPath = isFreshArtifactForJob(paths.publicAudioPath, job) ? paths.publicAudioPath : paths.voiceoverPath;
};

const finalizeValidateOnlyJob = async (job) => {
  const paths = getRunPaths(job.slug);
  job.storyboardPath = resolveEffectiveStoryboardPath(job);
  job.outputPath = isFreshArtifactForJob(paths.outPath, job) ? paths.outPath : null;
};

const invalidateSceneRepairCaches = async ({slug, sceneNumber}) => {
  const paths = getRunPaths(slug);
  const sceneNum = String(sceneNumber).padStart(2, "0");
  const targets = [
    path.join(paths.publicVideoDir, `scene-${sceneNum}.mp4`),
    paths.outPath,
    paths.agentReportPath,
    paths.orchestrationReportPath
  ];

  await Promise.all(
    targets.map((targetPath) =>
      unlink(targetPath).catch(() => {}) /* best-effort cleanup: file may already be gone */
    )
  );
};

const finalizeSceneRegenerateJob = async (job) => {
  const sceneNumber = Number(job.input.sceneNumber);
  const sceneNum = String(sceneNumber).padStart(2, "0");
  const paths = getRunPaths(job.slug);
  job.storyboardPath = resolveEffectiveStoryboardPath(job);
  job.outputPath = path.join(paths.assetDir, `scene-${sceneNum}.mp4`);
  const shouldAutoContinue = job.input?.autoContinueAfterSceneRepair !== false;
  await invalidateSceneRepairCaches({slug: job.slug, sceneNumber});
  appendLog(job, `[scene-repair] cache invalido para scene-${sceneNum} e saidas finais do run\n`);

  const sourceLikeJob = getRecoverySourceJob(job) || job;
  const missingAfterRepair = getFirstMissingSceneNumber(sourceLikeJob);

  if (shouldAutoContinue && missingAfterRepair !== null) {
    const chainedSceneJob = {
      id: createId(),
      type: "scene-regenerate",
      title: job.title,
      slug: job.slug,
      caseId: job.caseId || null,
      attempt: job.attempt || null,
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
      artifactEpochAt: getRecoveryArtifactEpochAt(job),
      exitCode: null,
      error: null
    };
    const enqueued = enqueueAndStart(chainedSceneJob);
    updateJob(job, {followUpJobId: enqueued.id});
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
    followUpJob = buildAudioPrepJob(job, {autoContinueRecovery: true});
    appendLog(job, "[scene-repair] todas as cenas prontas; proximo passo: gerar audio\n");
  } else if (shouldAutoContinue && canRenderOnlyForJob(sourceLikeJob) && stepMap.render?.status !== "completed") {
    followUpJob = buildRenderOnlyJob(job, {autoContinueRecovery: true});
    appendLog(job, "[scene-repair] todas as cenas prontas; proximo passo: renderizar\n");
  } else if (shouldAutoContinue && canValidateOnlyForJob(sourceLikeJob) && stepMap.qa?.status !== "completed") {
    followUpJob = buildValidateOnlyJob(job);
    appendLog(job, "[scene-repair] video ja existe; proximo passo: validar QA\n");
  } else if (shouldAutoContinue && hasBasicResumeArtifacts(sourceLikeJob)) {
    followUpJob = buildResumedGenerateJob(sourceLikeJob);
    appendLog(job, "[scene-repair] todas as cenas prontas; retomando com artefatos existentes\n");
  } else if (shouldAutoContinue && getRetryStoryboardPathForJob(sourceLikeJob)) {
    followUpJob = await buildRetryFromStoryboardGenerateJob(sourceLikeJob);
    appendLog(job, "[scene-repair] fallback: reenfileirando a partir do storyboard\n");
  }

  if (!followUpJob) {
    appendLog(job, "[scene-repair] nenhuma continuacao automatica foi necessaria\n");
    return;
  }

  const enqueued = enqueueAndStart(followUpJob);
  updateJob(job, {followUpJobId: enqueued.id});
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
  await writeFile(paths.storyboardPath, JSON.stringify(storyboard, null, 2));
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
    const storyboardSourcePath = getRetryStoryboardPathForJob(job) || resolveEffectiveStoryboardPath(job);
    const storyboard = await readJsonFile(storyboardSourcePath);
    if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
      throw new Error(`Storyboard ausente ou invalido em ${storyboardSourcePath}`);
    }

    const voiceover = await readJsonFile(paths.voiceoverPath);
    const existingRenderProps = await readJsonFile(paths.renderPropsPath);
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
      outputProfile,
      existingRenderProps
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
        `--scale=${process.env.REMOTION_SCALE || "1"}`,
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
        error: getProcessFailureMessage(job, `Retomada terminou com codigo ${exitCode}`)
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

    await ensureManagedDir(exportDir);
    await copyManagedFile(paths.outPath, finalPath);
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



const finalizeJob = async (job) => {
  if (job.type === "generate") await finalizeGenerateJob(job);
  else if (job.type === "scene-regenerate") await finalizeSceneRegenerateJob(job);
  else if (job.type === "audio-prep") await finalizeAudioPrepJob(job);
  else if (job.type === "render-only") await finalizeRerenderJob(job);
  else if (job.type === "validate-only") await finalizeValidateOnlyJob(job);
  else await finalizeRerenderJob(job);
};

const handleAutoContinue = async (job) => {
  if (job.input?.autoContinueRecovery !== true) return;
  const sourceJob = getRecoverySourceJob(job) || job;
  let followUpJob = null;

  if (job.type === "audio-prep" && canRenderOnlyForJob(job) && !isFreshArtifactForJob(getRunPaths(sourceJob.slug).outPath, job)) {
    followUpJob = buildRenderOnlyJob(job, {autoContinueRecovery: true});
  } else if (job.type === "render-only" && canValidateOnlyForJob(job) && !isQaPassedForJob(job)) {
    followUpJob = buildValidateOnlyJob(job);
  }

  if (followUpJob) {
    const enqueued = enqueueAndStart(followUpJob);
    updateJob(job, {followUpJobId: enqueued.id});
    appendLog(job, `[recovery] follow-up enfileirado: ${enqueued.id}\n`);
  }
};

initJobExecution({
  projectRoot,
  configuredVideoEngineRoot,
  baseChildEnv,
  resolveOutputProfileConfig,
  buildProfileRuntimeEnv,
  getChannelExportDir,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_GENERATION_MODE,
  DEFAULT_OUTPUT_PROFILE,
  DEFAULT_VISUAL_STYLE_PRESET,
  toIsoNow,
  updateJobHeartbeat,
  updateJob,
  setJobStage,
  appendLog,
  getProcessFailureMessage,
  finalizeJob,
  handleAutoContinue
});

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

/** @param {object} job */
const enqueueAndStart = (job) => enqueueJob(job, startQueueWorker);

/** @param {object} job @param {string} errorMessage */
const failAndRelease = (job, errorMessage) => failJobAndReleaseQueue(job, errorMessage, startQueueWorker);

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

initVideoLibrary({
  getRunPaths,
  findExistingStoryboardPath,
  getChannelConfig,
  getChannelExportDir,
  isQaPassedForSlug,
  getJobStateInfo,
  getJobStageInfo,
  getJobRca,
  getJobRecommendedAction,
  buildCaseSummary,
  getStageLabel,
  getFailureStage,
  getFailureSummary,
  ensureAllowedFilePath,
  resolveStoredThumbnailArtifacts,
  resolveChannelValue,
  getJobs: () => jobs,
  getVideoMetadata: () => videoMetadata,
  setVideoMetadata: (v) => { videoMetadata = v; },
  getChannelOptions: () => channelOptions,
  projectRoot,
  dataDir,
  videoLibraryDir,
  videosFile
});

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
  const generationMode = resolveGenerationMode(body.generationMode, resolveGenerationMode(baseChildEnv.GENERATION_MODE));
  const audioProvider = body.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp";
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice,
    language,
    channelPreset,
    audioProvider
  });

  if (!voice) {
    sendJson(response, 400, {error: "Escolha uma voz valida."});
    return;
  }

  const targetSeconds = getProfileTargetSeconds(outputProfile.id, Number(body.targetSeconds));
  const slug = buildUniqueGenerateSlug(title);
  const caseId = createId();
  const sourceTextFile = sourceText ? path.join(inputsDir, `${createId()}-source.txt`) : "";

  if (sourceTextFile) {
    await ensureManagedDir(inputsDir);
    await writeManagedFile(sourceTextFile, sourceText);
  }

  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const explicitCustomStylePrompt = String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH).trim();
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const job = {
    id: createId(),
    type: "generate",
    title,
    slug,
    caseId,
    attempt: 1,
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
      generationMode,
      imageStyle: imageStyleOptions.some((option) => option.value === body.imageStyle)
        ? String(body.imageStyle)
        : DEFAULT_VISUAL_STYLE_PRESET,
      voice,
      audioProvider,
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

  sendJson(response, 201, {job: enqueueAndStart(job)});
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeStoryboardText = (value, fallback = "", maxLength = 0) => {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  const safeFallback = String(fallback ?? "").replace(/\r\n/g, "\n").trim();
  const chosen = normalized || safeFallback;
  return maxLength > 0 ? chosen.slice(0, maxLength) : chosen;
};

const buildApprovedStoryboardFromPreview = (previewStoryboard, editedStoryboard) => {
  if (!isPlainObject(previewStoryboard)) {
    return null;
  }

  if (editedStoryboard && !isPlainObject(editedStoryboard)) {
    throw new Error("Storyboard editado invalido.");
  }

  const previewScenes = Array.isArray(previewStoryboard.scenes) ? previewStoryboard.scenes : [];
  const editedScenes = Array.isArray(editedStoryboard?.scenes) ? editedStoryboard.scenes : previewScenes;

  if (editedStoryboard && editedStoryboard.scenes && editedScenes.length !== previewScenes.length) {
    throw new Error("O storyboard editado precisa manter a mesma quantidade de cenas do preview.");
  }

  const approvedStoryboard = {
    ...previewStoryboard,
    videoTitle: normalizeStoryboardText(editedStoryboard?.videoTitle, previewStoryboard.videoTitle, 200),
    hook: normalizeStoryboardText(editedStoryboard?.hook, previewStoryboard.hook, 280),
    postCaption: normalizeStoryboardText(editedStoryboard?.postCaption, previewStoryboard.postCaption, 5000),
    styleNotes: normalizeStoryboardText(editedStoryboard?.styleNotes, previewStoryboard.styleNotes, 2000),
    cta: normalizeStoryboardText(editedStoryboard?.cta, previewStoryboard.cta, 240),
    scenes: previewScenes.map((scene, index) => {
      const editedScene = isPlainObject(editedScenes[index]) ? editedScenes[index] : {};
      return {
        ...scene,
        title: normalizeStoryboardText(editedScene.title, scene.title, 160),
        narration: normalizeStoryboardText(editedScene.narration, scene.narration, 2000),
        overlay: normalizeStoryboardText(editedScene.overlay, scene.overlay, 120),
        searchQuery: normalizeStoryboardText(editedScene.searchQuery, scene.searchQuery, 500),
        visualGoal: normalizeStoryboardText(editedScene.visualGoal, scene.visualGoal, 2000)
      };
    })
  };

  if (Array.isArray(previewStoryboard.hashtags)) {
    approvedStoryboard.hashtags = [...previewStoryboard.hashtags];
  }

  return approvedStoryboard;
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

  const previewStoryboard = await readJsonFile(previewJob.storyboardPath);
  const approvedStoryboard = buildApprovedStoryboardFromPreview(previewStoryboard, body.storyboard);

  if (!approvedStoryboard) {
    sendJson(response, 400, {error: "Nao consegui carregar o storyboard aprovado."});
    return;
  }

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

  await writeFile(previewJob.storyboardPath, `${JSON.stringify(approvedStoryboard, null, 2)}\n`);

  const approvedJob = {
    id: createId(),
    type: "generate",
    title: previewJob.title,
    slug: previewJob.slug,
    caseId: previewJob.caseId || createId(),
    attempt: 1,
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

  sendJson(response, 201, {job: enqueueAndStart(approvedJob)});
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
    channelPreset: null,
    audioProvider: body.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp"
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

  sendJson(response, 201, {job: enqueueAndStart(job)});
};

const buildResumedGenerateJob = (sourceJob) => ({
  id: createId(),
  type: "generate",
  title: sourceJob.title,
  slug: sourceJob.slug,
  caseId: sourceJob.caseId || null,
  attempt: sourceJob.attempt || null,
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
    generationMode: resolveGenerationMode(sourceJob.input?.generationMode, resolveGenerationMode(baseChildEnv.GENERATION_MODE)),
    previewOnly: false,
    force: true,
    resumeFromJobId: sourceJob.id
  },
  outputPath: null,
  storyboardPath: findExistingStoryboardPath(sourceJob) || null,
  artifactEpochAt: sourceJob.artifactEpochAt || sourceJob.createdAt,
  exitCode: null,
  error: null
});

const buildAudioPrepJob = (sourceJob, options = {}) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  const recoveryReferenceJob = sourceJob && typeof sourceJob === "object" ? sourceJob : recoveryJob;
  return {
    id: createId(),
    type: "audio-prep",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    caseId: recoveryJob.caseId || sourceJob.caseId || null,
    attempt: recoveryJob.attempt || sourceJob.attempt || null,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[recovery] cenas prontas; a reconstruir audio, timings e render-props"],
    input: {
      ...recoveryJob.input,
      previewOnly: false,
      force: false,
      sourceJobId: recoveryReferenceJob?.id || recoveryJob.id,
      autoContinueRecovery: options.autoContinueRecovery === true
    },
    outputPath: null,
    storyboardPath: resolveEffectiveStoryboardPath(recoveryJob),
    artifactEpochAt: getRecoveryArtifactEpochAt(recoveryReferenceJob || recoveryJob),
    exitCode: null,
    error: null
  };
};

const buildRenderOnlyJob = (sourceJob, options = {}) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  const recoveryReferenceJob = sourceJob && typeof sourceJob === "object" ? sourceJob : recoveryJob;
  return {
    id: createId(),
    type: "render-only",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    caseId: recoveryJob.caseId || sourceJob.caseId || null,
    attempt: recoveryJob.attempt || sourceJob.attempt || null,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: ["[recovery] audio e cenas prontos; a renderizar sem regenerar assets"],
    input: {
      ...recoveryJob.input,
      previewOnly: false,
      force: false,
      sourceJobId: recoveryReferenceJob?.id || recoveryJob.id,
      autoContinueRecovery: options.autoContinueRecovery === true
    },
    outputPath: null,
    storyboardPath: resolveEffectiveStoryboardPath(recoveryJob),
    artifactEpochAt: getRecoveryArtifactEpochAt(recoveryReferenceJob || recoveryJob),
    exitCode: null,
    error: null
  };
};

const buildValidateOnlyJob = (sourceJob) => {
  const recoveryJob = getRecoverySourceJob(sourceJob) || sourceJob;
  const artifactEpochAt =
    sourceJob?.type === "render-only"
      ? (
          sourceJob?.completedAt ||
          sourceJob?.updatedAt ||
          sourceJob?.artifactEpochAt ||
          sourceJob?.createdAt ||
          toIsoNow()
        )
      : (
          sourceJob?.artifactEpochAt ||
          sourceJob?.createdAt ||
          recoveryJob?.artifactEpochAt ||
          recoveryJob?.createdAt ||
          toIsoNow()
        );
  return {
    id: createId(),
    type: "validate-only",
    title: recoveryJob.title,
    slug: recoveryJob.slug,
    caseId: recoveryJob.caseId || sourceJob.caseId || null,
    attempt: recoveryJob.attempt || sourceJob.attempt || null,
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
    storyboardPath: resolveEffectiveStoryboardPath(recoveryJob),
    artifactEpochAt,
    exitCode: null,
    error: null
  };
};

const buildAutoRerenderJob = (sourceJob) => {
  const paths = getRunPaths(sourceJob.slug);
  const effectiveStoryboardPath = resolveEffectiveStoryboardPath(sourceJob);
  const storyboard = readJsonSyncIfExists(effectiveStoryboardPath);
  const renderProps = readJsonSyncIfExists(paths.renderPropsPath);
  const language = VALID_LANGUAGES.includes(sourceJob.input?.language) ? sourceJob.input.language : "pt-BR";
  const tone = VALID_TONES.includes(sourceJob.input?.tone) ? sourceJob.input.tone : "natural_clean";
  const voice = resolveRequestedVoice({
    selectedVoice: String(sourceJob.input?.voice || "").trim(),
    customVoice: "",
    language,
    channelPreset: null,
    audioProvider: sourceJob.input?.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp"
  });
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
    storyboardPath: effectiveStoryboardPath || paths.storyboardPath,
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
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice: "",
    language,
    channelPreset,
    audioProvider: sourceJob.input?.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp"
  });
  const generationMode = resolveGenerationMode(
    sourceJob.input?.generationMode,
    resolveGenerationMode(baseChildEnv.GENERATION_MODE)
  );
  const tonePreset = tonePresets[tone] || tonePresets.natural_clean;
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const title = String(storyboard.videoTitle || sourceJob.title || slugToCaption(sourceJob.slug)).trim();
  const caseId = sourceJob.caseId || createId();
  const attempt = getNextAttemptForCase(caseId);
  const retrySlug = buildUniqueGenerateSlug(title);

  return {
    id: createId(),
    type: "generate",
    title,
    slug: retrySlug,
    caseId,
    attempt,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [`[failed-job] refazendo a partir do storyboard do job ${sourceJob.id} (tentativa ${attempt})`],
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
      generationMode,
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
  const storyboardPath = getRetryStoryboardPathForJob(sourceJob) || resolveEffectiveStoryboardPath(sourceJob);
  const storyboard = await readJsonFile(storyboardPath);
  const voiceover = await readJsonFile(paths.voiceoverPath);

  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    sendJson(response, 409, {error: `Nao encontrei storyboard em ${storyboardPath}.`});
    return;
  }

  if (!voiceover) {
    sendJson(response, 409, {error: `Nao encontrei voiceover.json em ${paths.voiceoverPath}.`});
    return;
  }

  if (!isFreshArtifactForJob(paths.publicAudioPath, sourceJob)) {
    sendJson(response, 409, {error: `Nao encontrei voiceover.mp3 em ${paths.publicAudioPath}.`});
    return;
  }

  const missingScene = storyboard.scenes.findIndex((scene, index) => {
    const fileName = `scene-${String(index + 1).padStart(2, "0")}.mp4`;
    return !isReadySceneClipForJob(path.join(paths.assetDir, fileName), sourceJob);
  });

  if (missingScene !== -1) {
    sendJson(response, 409, {
      error: `Falta o asset scene-${String(missingScene + 1).padStart(2, "0")}.mp4 em assets/${sourceJob.slug}.`
    });
    return;
  }

  const resumedJob = buildResumedGenerateJob(sourceJob);

  sendJson(response, 201, {job: enqueueAndStart(resumedJob)});
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
      siteUrl: getAgendadorSiteUrl(),
      apiBase: getAgendadorApiBase(),
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
  const storyboardPath = resolveEffectiveStoryboardPath(target.slug);
  const storyboard = await readJsonFile(storyboardPath);

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
  const approveAudioProvider = (body.audioProvider || previousJob?.input?.audioProvider) === "elevenlabs" ? "elevenlabs" : "gcp";
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice: "",
    language,
    channelPreset,
    audioProvider: approveAudioProvider
  });
  const imageModel = resolveImageModel(
    body.imageModel || previousJob?.input?.imageModel,
    resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL)
  );
  const generationMode = resolveGenerationMode(
    body.generationMode || previousJob?.input?.generationMode,
    resolveGenerationMode(baseChildEnv.GENERATION_MODE)
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
      storyboardFile: storyboardPath,
      channel: channel.value,
      outputProfile: outputProfile.id,
      language,
      targetSeconds,
      imageModel,
      generationMode,
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
    storyboardPath,
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueAndStart(job)});
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

  sendJson(response, 201, {job: enqueueAndStart(retriedJob)});
};

const handleRegenerateMissingSceneRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceJobId = String(body.jobId || "").trim() || String(request.url?.split("/")[3] || "").trim();
  const selectedJob = jobs.get(sourceJobId);

  if (!selectedJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  if (selectedJob.status !== "failed") {
    sendJson(response, 409, {error: "A regeneracao manual de cena so fica disponivel para jobs falhados."});
    return;
  }

  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  const storyboardPath = getRetryStoryboardPathForJob(sourceJob) || getRunPaths(sourceJob.slug).storyboardPath;
  const storyboard = await readJsonFile(storyboardPath);
  if (!storyboard?.scenes?.length) {
    sendJson(response, 409, {error: "Nao achei storyboard valido para regenerar a cena."});
    return;
  }

  const requestedSceneNumber = normalizePositiveInt(body.sceneNumber);
  const detectedMissingSceneNumber = normalizePositiveInt(getFirstMissingSceneNumber(sourceJob));
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
  const voice = resolveRequestedVoice({
    selectedVoice,
    customVoice: "",
    language,
    channelPreset,
    audioProvider: sourceJob.input?.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp"
  });
  const sceneJob = {
    id: createId(),
    type: "scene-regenerate",
    title: sourceJob.title,
    slug: sourceJob.slug,
    caseId: sourceJob.caseId || null,
    attempt: sourceJob.attempt || null,
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
    artifactEpochAt: getRecoveryArtifactEpochAt(sourceJob),
    exitCode: null,
    error: null
  };

  sendJson(response, 201, {job: enqueueAndStart(sceneJob)});
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
  sendJson(response, 201, {job: enqueueAndStart(job)});
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
  sendJson(response, 201, {job: enqueueAndStart(job)});
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
  sendJson(response, 201, {job: enqueueAndStart(job)});
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

  failAndRelease(job, "Job marcado manualmente como travado para liberar a fila.");
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
  await removeVideoMetadataEntry({channel: channel.value, slug: target.slug}).catch((err) => { console.error(`removeVideoMetadataEntry failed for ${target.slug}:`, err.message); });

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
  const rawPublishDate = String(body.scheduleAt || meta?.scheduleAt || "").trim() || new Date().toISOString();
  // If the resolved date is in the past (e.g. stale metadata from an old job), publish immediately instead
  const publishDate = new Date(rawPublishDate).getTime() <= Date.now()
    ? new Date().toISOString()
    : rawPublishDate;
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
  const meta = await readVideoMeta(target.slug).catch(() => null); /* expected: meta file may not exist */
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

  await writeTikTokDraft(tiktokDraftsDir, draftId, draft);

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
      generationMode: resolveGenerationMode(baseChildEnv.GENERATION_MODE),
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
    generationModes: generationModeOptions.map(serializeGenerationModeOption),
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
      siteUrl: getAgendadorSiteUrl(),
      apiBase: getAgendadorApiBase(),
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

await ensureManagedDir(dataDir);
await ensureManagedDir(inputsDir);
await ensureManagedDir(videoLibraryDir);
await ensureManagedDir(tiktokDraftsDir);
await ensureManagedDir(postarRoot);
await Promise.all(channelOptions.map((channel) => ensureManagedDir(getChannelExportDir(channel.value))));
await normalizeManagedTree(dataDir, {maxDepth: 2});
await Promise.all(channelOptions.map((channel) => normalizeManagedTree(getChannelExportDir(channel.value), {maxDepth: 1})));

const persistedJobs = await readJsonFile(jobsFile);

if (Array.isArray(persistedJobs)) {
  for (const persistedJob of persistedJobs) {
    const nowIso = toIsoNow();

    if (persistedJob.status === "running" || persistedJob.status === "queued") {
      const restartMessage = "Servidor reiniciado antes da conclusao deste job.";
      const failureContext = String(
        persistedJob.error ||
        getProcessFailureMessage(persistedJob, "") ||
        ""
      ).trim();

      persistedJob.status = "failed";
      persistedJob.error = failureContext && failureContext !== restartMessage
        ? `${failureContext} | ${restartMessage}`
        : restartMessage;
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

if (Array.isArray(persistedJobs)) {
  await persistJobs();
}

const BASIC_AUTH_PASSWORD = process.env.VIDEO_STUDIO_PASSWORD || "007007";
const BASIC_AUTH_REALM = "Video Studio";

const checkBasicAuth = (request) => {
  const header = request.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    return false;
  }

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : decoded;
  return password === BASIC_AUTH_PASSWORD;
};

const handleJobsListRequest = async (_req, res) => {
  const payload = Array.from(jobs.values())
    .map((job) => sanitizeJob(job))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const queueLengths = getQueueLengths();
  sendJson(res, 200, {
    jobs: payload,
    cases: payload.map((job) => job.caseSummary),
    summary: buildJobsSummary(payload),
    ...getActiveJobIds(),
    ...queueLengths
  });
};

const handleJobStreamRequest = async (req, res, {params}) => {
  const job = jobs.get(params.id);
  if (!job) { sendJson(res, 404, {error: "Job nao encontrado."}); return; }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write("\n");

  const subscribers = streams.get(params.id) || new Set();
  subscribers.add(res);
  streams.set(params.id, subscribers);
  sendEvent(res, "update", sanitizeJob(job));

  const keepAlive = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(keepAlive); subscribers.delete(res); }
  }, 25000);

  const cleanup = () => { clearInterval(keepAlive); subscribers.delete(res); };
  req.on("close", cleanup);
  res.on("error", cleanup);
};

const handleJobDetailRequest = async (_req, res, {params}) => {
  const job = jobs.get(params.id);
  if (!job) { sendJson(res, 404, {error: "Job nao encontrado."}); return; }
  sendJson(res, 200, {job: sanitizeJob(job)});
};

const handleRunsRequest = async (_req, res) => {
  sendJson(res, 200, {runs: await listRecentExports()});
};

const handleFileRequest = async (req, res, {url}) => {
  const filePath = url.searchParams.get("path");
  if (!filePath) { sendJson(res, 400, {error: "Parametro path ausente."}); return; }
  await serveStaticFile(req, res, filePath);
};

const handleTikTokHelperPageRequest = async (_req, res, {url}) => {
  const draftId = String(url.searchParams.get("id") || "").trim();
  if (!draftId) { sendJson(res, 400, {error: "Parametro id ausente."}); return; }
  const draft = await readTikTokDraft(tiktokDraftsDir, draftId);
  if (!draft) { sendJson(res, 404, {error: "Draft do TikTok nao encontrado."}); return; }
  res.writeHead(200, {"Content-Type": "text/html; charset=utf-8"});
  res.end(buildTikTokHelperHtml(draft));
};

const handleJobResumeRequest = async (req, res, {params}) => {
  await handleResumeRequest(req, res, params.id);
};

let elevenLabsVoicesCache = null;
let elevenLabsVoicesCacheAt = 0;
const ELEVENLABS_VOICES_TTL_MS = 300_000;

const handleElevenLabsVoicesRequest = async (_req, res) => {
  const apiKey = String(baseChildEnv.ELEVENLABS_API_KEY || "").trim();
  if (!apiKey) return sendJson(res, 200, {voices: []});

  if (elevenLabsVoicesCache && Date.now() - elevenLabsVoicesCacheAt < ELEVENLABS_VOICES_TTL_MS) {
    return sendJson(res, 200, {voices: elevenLabsVoicesCache});
  }

  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: {"xi-api-key": apiKey}
    });
    if (!r.ok) return sendJson(res, 200, {voices: []});
    const data = await r.json();
    elevenLabsVoicesCache = (data.voices || []).map((v) => ({
      value: v.voice_id,
      label: v.name,
      category: v.category || "",
      languages: (v.labels?.language || "").split(",").map((l) => l.trim()).filter(Boolean)
    }));
    elevenLabsVoicesCacheAt = Date.now();
    sendJson(res, 200, {voices: elevenLabsVoicesCache});
  } catch {
    sendJson(res, 200, {voices: []});
  }
};

// ── Route table ──────────────────────────────────────────────────────────────

addRoute("GET",  "/api/config",                              (_req, res) => handleConfigRequest(res));
addRoute("GET",  "/api/elevenlabs-voices",                   handleElevenLabsVoicesRequest);
addRoute("GET",  "/api/jobs",                                handleJobsListRequest);
addRoute("GET",  "/api/jobs/:id/stream",                     handleJobStreamRequest);
addRoute("GET",  "/api/jobs/:id",                            handleJobDetailRequest);
addRoute("GET",  "/api/runs",                                handleRunsRequest);
addRoute("GET",  "/api/videos",                              (_req, res) => handleVideosRequest(res));
addRoute("GET",  "/api/file",                                handleFileRequest);
addRoute("GET",  "/tiktok-helper",                           handleTikTokHelperPageRequest);
addRoute("POST", "/api/generate",                            handleGenerateRequest);
addRoute("POST", "/api/approve-preview",                     handleApprovePreviewRequest);
addRoute("POST", "/api/rerender-voice",                      handleRerenderRequest);
addRoute("POST", "/api/videos/meta",                         handleVideoMetaRequest);
addRoute("POST", "/api/videos/refazer",                      handleVideoRefazerRequest);
addRoute("POST", "/api/videos/delete",                       handleVideoDeleteRequest);
addRoute("POST", "/api/videos/publish",                      handleVideoPublishRequest);
addRoute("POST", "/api/videos/tiktok-helper",                handleVideoTikTokHelperRequest);
addRoute("POST", "/api/jobs/:id/retry-from-storyboard",      handleRetryFailedJobRequest);
addRoute("POST", "/api/jobs/:id/regenerate-missing-scene",   handleRegenerateMissingSceneRequest);
addRoute("POST", "/api/jobs/:id/generate-audio",             handleGenerateAudioRequest);
addRoute("POST", "/api/jobs/:id/render-only",                handleRenderOnlyRequest);
addRoute("POST", "/api/jobs/:id/validate",                   handleValidateOnlyRequest);
addRoute("POST", "/api/jobs/:id/force-fail",                 handleForceFailJobRequest);
addRoute("POST", "/api/jobs/:id/resume",                     handleJobResumeRequest);

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (!checkBasicAuth(request)) {
    response.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${BASIC_AUTH_REALM}"`,
      "Content-Type": "text/plain"
    });
    response.end("Unauthorized");
    return;
  }

  try {
    // ── Static files ───────────────────────────────────────────────────────
    if (method === "GET") {
      if (pathname === "/") {
        await serveStaticFile(request, response, path.join(publicDir, "index.html"));
        return;
      }
      if (["/app.js", "/styles.css"].includes(pathname)) {
        await serveStaticFile(request, response, path.join(publicDir, pathname.slice(1)));
        return;
      }
      const stylePreviewPath = resolveStylePreviewPath(pathname);
      if (stylePreviewPath) { await serveStaticFile(request, response, stylePreviewPath); return; }
      const publicStaticPath = resolvePublicStaticPath(pathname);
      if (publicStaticPath) { await serveStaticFile(request, response, publicStaticPath); return; }
    }

    // ── Route table ────────────────────────────────────────────────────────
    const matched = matchRoute(method, pathname);
    if (matched) {
      await matched.handler(request, response, {url, pathname, params: matched.params});
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
      .map((job) => terminateJobProcessTree(job).catch(() => false)) /* best-effort: process may already be gone */
  ).catch((err) => { console.error('shutdown: failed to terminate job processes:', err.message); });

  persistJobs().catch((err) => { console.error('shutdown: failed to persist jobs:', err.message); }).finally(() => {
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
