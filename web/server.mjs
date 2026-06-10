import http from "node:http";
import {spawn, spawnSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync} from "node:fs";
import {copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile} from "node:fs/promises";
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
  buildImageStyleOptions,
  channelOptions,
  channelPublishProfiles,
  channelPresets,
  TIKTOK_DEFAULT_AUDIO,
  TIKTOK_DEFAULT_AUDIO_CHANNELS
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
import {callJsonProvider, resolveLlmProvider, generateHookVariants, buildVariantStoryboard} from "../video-engine/scripts/lib/llm-provider.mjs";
import {logJsonLine, serializeError} from "./lib/logger.mjs";
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
  getVideoMetadataEntry,
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
  buildVideoRecord,
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
  getActiveJobIds,
  getQueueLengths,
  getLaneConcurrency,
  laneHasCapacity,
  addActiveJobForLane,
  removeActiveJobForLane,
  countLaneRunners,
  incrementLaneRunners,
  decrementLaneRunners,
  rebuildQueueStateFromJobs,
  refreshQueuePositions,
  failJobAndReleaseQueue,
  enqueueJob
} from "./lib/job-queue.mjs";
import {
  init as initJobExecution,
  registerJobProcess,
  clearJobProcess,
  isJobProcessAlive,
  getJobProcessPid,
  collectDescendantPids,
  terminateJobProcessTree,
  executeChildProcess,
  getJobIdleTimeoutMs,
  getJobTimeoutMs,
  createGenerateJobCommand,
  createRerenderJobCommand,
  createAudioPrepJobCommand,
  createRenderOnlyJobCommand,
  createValidateOnlyJobCommand,
  createSceneRegenerateJobCommand
} from "./lib/job-execution.mjs";
import {parseQA, splitIntoBatches, runSimulador, loadJobs as loadSimuladorJobs, saveJobs as saveSimuladorJobs} from "../scripts/simulador.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "web", "public");
const defaultDataDir = path.join(projectRoot, ".web-ui");
const dataDir = resolvePathFrom(projectRoot, process.env.WEB_DATA_DIR, defaultDataDir);
const localTempRootDir = path.join(projectRoot, ".tmp");
const localSystemTempDir = path.join(localTempRootDir, "system");
const localXdgCacheDir = path.join(localTempRootDir, "xdg-cache");
const localPuppeteerCacheDir = path.join(localTempRootDir, "puppeteer-cache");
const inputsDir = path.join(dataDir, "inputs");
const videoLibraryDir = path.join(dataDir, "videos");
const tiktokDraftsDir = path.join(dataDir, "tiktok-drafts");
const runtimeAuthFile = path.join(dataDir, "runtime-auth.json");
const jobsFile = path.join(dataDir, "jobs.json");
const videosFile = path.join(dataDir, "videos.json");
const rootEnvPath = path.join(projectRoot, ".env");
const defaultVideoEngineRoot = path.join(projectRoot, "video-engine");
const defaultPostarRoot = path.resolve(projectRoot, "..", "..", "postar");
const DEFAULT_PORT = Number(process.env.WEB_PORT || 3210);
const DEFAULT_HOST = process.env.WEB_HOST || "0.0.0.0";
const APP_ROLE = String(process.env.VIDEO_STUDIO_ROLE || "all").trim().toLowerCase();
const RUN_HTTP_SERVER = APP_ROLE !== "worker";
const RUN_QUEUE_WORKER = APP_ROLE !== "api";
const AUTO_START_QUEUED_JOBS = String(process.env.WEB_AUTO_START_QUEUED_JOBS || "false").trim().toLowerCase() === "true";
const RESUME_RENDER_FPS = 30;
const MAX_LOG_LINES = 2000;
const MAX_BODY_BYTES = 1_500_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const JOB_SYNC_INTERVAL_MS = 2000;
const JOB_RETENTION_DAYS = normalizePositiveInt(process.env.WEB_JOB_RETENTION_DAYS) || 14;
const JOB_RETENTION_COUNT = normalizePositiveInt(process.env.WEB_JOB_RETENTION_COUNT) || 500;
const JOB_TEMP_FILE_PATTERN = /^jobs\.json\.\d+\.\d+\.tmp$/;
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
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".yaml": "application/yaml; charset=utf-8",
  ".yml": "application/yaml; charset=utf-8"
};

const SECURITY_RESPONSE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()"
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join("; ");

// Presets imported from ./lib/presets.mjs
// Utils imported from ./lib/utils.mjs




const imageStyleOptions = buildImageStyleOptions(stylePreviewDir);


const jobs = new Map();
const streams = new Map();
let persistTimer = null;
let jobsFileMtimeMs = 0;
let jobsDiskSyncTimer = null;


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
  const issues = [];
  const warnings = [];

  if (sceneCount < minScenes || sceneCount > maxScenes) {
    issues.push(`cenas ${sceneCount} fora da faixa ${minScenes}-${maxScenes}`);
  }

  if (wordCount < minWords || wordCount > maxWords) {
    issues.push(`roteiro com ${wordCount} palavras fora da faixa ${minWords}-${maxWords}`);
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
    issues,
    warnings
  };
};

/**
 * Pre-flight TikTok storyboard validation. Runs at job submission, before
 * any image generation, so deviations from the locked TikTok format are
 * surfaced as warnings up front instead of as render-time failures.
 *
 * The report is non-blocking by default; only catastrophic structural
 * issues (zero-shot scenes) set `block: true`. Everything else is a warning.
 *
 * @param {object} args
 * @param {object} args.storyboard - Parsed storyboard JSON.
 * @param {string} [args.channelValue] - Channel id to decide if a default audio preset would apply.
 * @returns {{ok: boolean, block: boolean, warnings: string[], errors: string[], summary: object}}
 */
const validateTikTokStoryboard = ({storyboard = null, channelValue = ""} = {}) => {
  const warnings = [];
  const errors = [];

  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  const totalScenes = scenes.length;

  let totalShots = 0;
  let totalDurationSec = 0;
  let scenesWithZeroShots = 0;
  let shotsMissingImagePrompt = 0;
  let singleShotScenes = 0;

  scenes.forEach((scene, sceneIndex) => {
    const shots = Array.isArray(scene?.shots) ? scene.shots : [];
    if (shots.length === 0) {
      scenesWithZeroShots += 1;
      errors.push(`scene ${sceneIndex + 1} (${scene?.title || "sem titulo"}) tem zero shots`);
      return;
    }
    if (shots.length === 1) singleShotScenes += 1;
    totalShots += shots.length;

    shots.forEach((shot) => {
      const duration = Number.parseFloat(String(shot?.duration ?? "").replace(/s$/i, ""));
      if (Number.isFinite(duration) && duration > 0) {
        totalDurationSec += duration;
      } else if (Number.isFinite(Number(scene?.duration))) {
        totalDurationSec += Number(scene.duration) / shots.length;
      } else {
        totalDurationSec += 2;
      }
      if (!String(shot?.imagePrompt || "").trim()) {
        shotsMissingImagePrompt += 1;
      }
    });
  });

  if (totalDurationSec < 45 || totalDurationSec > 70) {
    warnings.push(`duracao estimada ${totalDurationSec.toFixed(1)}s fora da faixa TikTok 45-70s`);
  }
  if (totalShots < 18) {
    warnings.push(`apenas ${totalShots} imagens (TikTok recomenda 24-30, minimo 18 para variedade visual)`);
  }
  if (shotsMissingImagePrompt > 0) {
    warnings.push(`${shotsMissingImagePrompt} shot(s) sem imagePrompt — fallback chain sera usada`);
  }
  if (singleShotScenes > 2) {
    warnings.push(`${singleShotScenes} cenas com apenas 1 shot — TikTok premia variedade (2-3 shots/cena)`);
  }
  if (totalScenes > 0 && (totalScenes < 9 || totalScenes > 11)) {
    warnings.push(`${totalScenes} cenas fora da faixa TikTok 9-11`);
  }

  const hasStoryboardAudio = Boolean(
    storyboard?.audio &&
      typeof storyboard.audio === "object" &&
      String(storyboard.audio.provider || "").toLowerCase() === "elevenlabs" &&
      String(storyboard.audio.voiceId || "").trim()
  );
  const channelHasDefaultAudioPreset = TIKTOK_DEFAULT_AUDIO_CHANNELS.includes(String(channelValue || ""));
  if (!hasStoryboardAudio && !channelHasDefaultAudioPreset) {
    warnings.push(`storyboard sem campo audio e channel "${channelValue}" sem preset default — TTS cairá no GCP padrao`);
  }

  return {
    ok: errors.length === 0,
    block: scenesWithZeroShots > 0,
    warnings,
    errors,
    summary: {
      totalScenes,
      totalShots,
      totalDurationSec: Number(totalDurationSec.toFixed(1)),
      scenesWithZeroShots,
      shotsMissingImagePrompt,
      singleShotScenes,
      hasStoryboardAudio,
      channelHasDefaultAudioPreset
    }
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
    channelHandle: job.input?.channelHandle || "",
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

// Resolve audio provider/voice from a storyboard-supplied audio block or a
// channel-level default preset. Returns null when neither applies, in which
// case the caller falls through to the legacy body.audioProvider/body.voice path.
const resolveAudioOverride = ({body = {}, channelValue = ""}) => {
  const storyboardAudio =
    body && body.storyboard && typeof body.storyboard === "object" && body.storyboard.audio && typeof body.storyboard.audio === "object"
      ? body.storyboard.audio
      : null;

  if (storyboardAudio) {
    const provider = String(storyboardAudio.provider || "").toLowerCase().trim();
    const voiceId = String(storyboardAudio.voiceId || storyboardAudio.voice || "").trim();
    const modelId = String(storyboardAudio.modelId || "").trim();
    const voiceName = String(storyboardAudio.voiceName || "").trim();
    if (provider === "elevenlabs" && voiceId) {
      return {
        source: "storyboard",
        audioProvider: "elevenlabs",
        voice: voiceId,
        modelId: modelId || TIKTOK_DEFAULT_AUDIO.modelId,
        voiceName: voiceName || ""
      };
    }
  }

  // No storyboard audio supplied — apply the locked TikTok preset for
  // foiumaideia/quiet2min/ate2min so storyboards no longer need to specify audio.
  const userExplicitlyChose =
    String(body?.audioProvider || "").toLowerCase().trim() === "elevenlabs" && String(body?.voice || "").trim();
  if (TIKTOK_DEFAULT_AUDIO_CHANNELS.includes(channelValue) && !userExplicitlyChose) {
    return {
      source: "channel-preset",
      audioProvider: TIKTOK_DEFAULT_AUDIO.provider,
      voice: TIKTOK_DEFAULT_AUDIO.voiceId,
      modelId: TIKTOK_DEFAULT_AUDIO.modelId,
      voiceName: TIKTOK_DEFAULT_AUDIO.voiceName
    };
  }

  return null;
};

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
  costDetail: option.costDetail || "",
  previewImageUrl: option.previewFile ? `/style-gallery/images/models/${option.previewFile}` : ""
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
  const queueLane = job.queueLane || getJobQueueLane(job);
  const normalizedStatus = String(job.status || "").trim().toLowerCase();
  const startAvailable =
    !AUTO_START_QUEUED_JOBS &&
    normalizedStatus === "queued" &&
    !getActiveJobIdForLane(queueLane) &&
    Number(job.queuePosition || 0) === 1;

  return {
    id: job.id,
    type: job.type,
    title: job.title,
    slug: job.slug,
    caseId: job.caseId || null,
    attempt: job.attempt || null,
    queueLane: queueLane || null,
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
    startAvailable,
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
    queueMode: AUTO_START_QUEUED_JOBS ? "auto" : "manual",
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
    logTail: Array.isArray(job.logTail) ? job.logTail.slice(-50) : [],
    heartbeatAt: job.heartbeatAt || job.updatedAt || job.createdAt || nowIso,
    artifactEpochAt: job.artifactEpochAt || job.createdAt || nowIso,
    stageValue: job.stageValue || inferJobStageValue(job),
    stageSource: job.stageSource || "system",
    stageConfidence: job.stageConfidence || "medium",
    stageUpdatedAt: job.stageUpdatedAt || job.updatedAt || nowIso
  };
};

const getJobFreshnessMs = (job) => {
  const timestamps = [
    job?.updatedAt,
    job?.heartbeatAt,
    job?.completedAt,
    job?.startedAt,
    job?.createdAt
  ]
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value));

  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
};

const isTerminalJobRecord = (job) =>
  ["completed", "failed", "cancelled", "canceled"].includes(String(job?.status || "").trim().toLowerCase());

const isLocallyRunningJobRecord = (job) =>
  Number(job?.processId || 0) > 0 &&
  ["queued", "running"].includes(String(job?.status || "").trim().toLowerCase());

const mergeJobRecords = (left, right) => {
  if (!left) return right;
  if (!right) return left;
  // Terminal status in memory always wins over non-terminal from disk —
  // prevents race where a stale "running" record on disk overwrites a
  // "completed" or "failed" record that the close handler already applied.
  if (isLocallyRunningJobRecord(left) && isTerminalJobRecord(right)) return left;
  if (isTerminalJobRecord(left) && !isTerminalJobRecord(right)) return left;
  if (isTerminalJobRecord(right) && !isTerminalJobRecord(left)) return right;
  if (isLocallyRunningJobRecord(left) && isLocallyRunningJobRecord(right)) {
    return getJobFreshnessMs(right) >= getJobFreshnessMs(left) ? right : left;
  }
  if (isLocallyRunningJobRecord(left) && !isTerminalJobRecord(right)) return left;
  if (isLocallyRunningJobRecord(right) && !isTerminalJobRecord(left)) return right;
  return getJobFreshnessMs(right) >= getJobFreshnessMs(left) ? right : left;
};

const hydratePersistedJob = (persistedJob, {markRunningAsFailed = false} = {}) => {
  const nowIso = toIsoNow();
  const hydrated = {
    ...persistedJob,
    queueLane: persistedJob.queueLane || getJobQueueLane(persistedJob),
    logTail: Array.isArray(persistedJob.logTail) ? persistedJob.logTail : [],
    heartbeatAt: persistedJob.heartbeatAt || persistedJob.updatedAt || persistedJob.createdAt || nowIso,
    artifactEpochAt: persistedJob.artifactEpochAt || persistedJob.createdAt || nowIso,
    stageValue: persistedJob.stageValue || inferJobStageValue(persistedJob),
    stageSource: persistedJob.stageSource || "system",
    stageConfidence: persistedJob.stageConfidence || "medium",
    stageUpdatedAt: persistedJob.stageUpdatedAt || persistedJob.updatedAt || nowIso
  };

  if (markRunningAsFailed && hydrated.status === "running") {
    const restartMessage = "Worker reiniciado antes da conclusao deste job.";
    const failureContext = String(
      hydrated.error ||
      getProcessFailureMessage(hydrated, "") ||
      ""
    ).trim();

    hydrated.status = "failed";
    hydrated.terminationReason = hydrated.terminationReason || restartMessage;
    hydrated.error = failureContext && failureContext !== restartMessage
      ? `${failureContext} | ${restartMessage}`
      : restartMessage;
    hydrated.completedAt = hydrated.completedAt || nowIso;
    hydrated.updatedAt = nowIso;
    hydrated.heartbeatAt = nowIso;
    hydrated.stageValue = getFailureStage(hydrated) || hydrated.stageValue || "pipeline";
    hydrated.stageSource = "system";
    hydrated.stageConfidence = "high";
    hydrated.stageUpdatedAt = nowIso;
  }

  return hydrated;
};

const getTerminalJobTimestampMs = (job) => {
  const timestamp = new Date(job.completedAt || job.updatedAt || job.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const pruneRetainedJobs = () => {
  const cutoffMs = Date.now() - JOB_RETENTION_DAYS * MS_PER_DAY;
  const terminalJobs = Array.from(jobs.values())
    .filter((job) => ["completed", "failed"].includes(String(job.status || "").trim().toLowerCase()))
    .sort((left, right) => getTerminalJobTimestampMs(right) - getTerminalJobTimestampMs(left));

  let prunedCount = 0;

  for (let index = 0; index < terminalJobs.length; index += 1) {
    const job = terminalJobs[index];
    const keepByCount = index < JOB_RETENTION_COUNT;
    const keepByAge = getTerminalJobTimestampMs(job) >= cutoffMs;

    if (keepByCount || keepByAge) {
      continue;
    }

    jobs.delete(job.id);
    streams.delete(job.id);
    prunedCount += 1;
  }

  return prunedCount;
};

const cleanupStaleJobsTempFiles = async () => {
  const entries = await readdir(dataDir, {withFileTypes: true}).catch(() => []);
  let removedCount = 0;

  for (const entry of entries) {
    if (!entry?.isFile?.() || !JOB_TEMP_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    await safeUnlink(path.join(dataDir, entry.name));
    removedCount += 1;
  }

  return removedCount;
};

const persistJobs = async () => {
  await ensureManagedDir(dataDir);
  pruneRetainedJobs();
  const diskJobs = await readJsonFile(jobsFile).catch(() => []);
  const mergedJobs = new Map();

  if (Array.isArray(diskJobs)) {
    for (const persistedJob of diskJobs) {
      const hydrated = hydratePersistedJob(persistedJob, {markRunningAsFailed: false});
      mergedJobs.set(hydrated.id, hydrated);
    }
  }

  for (const job of jobs.values()) {
    const serialized = serializeJobForPersistence(job);
    mergedJobs.set(serialized.id, mergeJobRecords(serialized, mergedJobs.get(serialized.id)));
  }

  const payload = JSON.stringify(
    Array.from(mergedJobs.values())
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    null,
    2
  );
  const tempJobsFile = path.join(dataDir, `jobs.json.${process.pid}.${Date.now()}.tmp`);
  await writeManagedFile(tempJobsFile, payload);
  await rename(tempJobsFile, jobsFile);
  // Our own write must not re-enter via the disk-sync loop: a re-ingest of a
  // snapshot merged milliseconds ago can resurrect records the close handler
  // or orphan detector already superseded.
  const written = await stat(jobsFile).catch(() => null);
  if (written) jobsFileMtimeMs = Math.max(jobsFileMtimeMs, written.mtimeMs);
};

const persistJobsSync = () => {
  mkdirSync(dataDir, {recursive: true, mode: 0o755});
  pruneRetainedJobs();
  const diskJobs = (() => {
    try {
      return JSON.parse(readFileSync(jobsFile, "utf8"));
    } catch {
      return [];
    }
  })();
  const mergedJobs = new Map();

  if (Array.isArray(diskJobs)) {
    for (const persistedJob of diskJobs) {
      const hydrated = hydratePersistedJob(persistedJob, {markRunningAsFailed: false});
      mergedJobs.set(hydrated.id, hydrated);
    }
  }

  for (const job of jobs.values()) {
    const serialized = serializeJobForPersistence(job);
    mergedJobs.set(serialized.id, mergeJobRecords(serialized, mergedJobs.get(serialized.id)));
  }

  const payload = JSON.stringify(
    Array.from(mergedJobs.values())
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    null,
    2
  );
  const tempJobsFile = path.join(dataDir, `jobs.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tempJobsFile, payload);
  renameSync(tempJobsFile, jobsFile);
  try {
    jobsFileMtimeMs = Math.max(jobsFileMtimeMs, statSync(jobsFile).mtimeMs);
  } catch { /* keep previous mtime */ }
};

const syncJobsFromDisk = async ({broadcastChanges = false} = {}) => {
  const details = await stat(jobsFile).catch(() => null);
  if (!details) {
    return {changed: 0, sourceCount: 0};
  }

  if (details.mtimeMs <= jobsFileMtimeMs) {
    return {changed: 0, sourceCount: jobs.size};
  }

  const persisted = await readJsonFile(jobsFile).catch(() => null);
  if (!Array.isArray(persisted)) {
    jobsFileMtimeMs = details.mtimeMs;
    return {changed: 0, sourceCount: jobs.size};
  }

  let changed = 0;
  const seenIds = new Set();

  for (const persistedJob of persisted) {
    const hydrated = hydratePersistedJob(persistedJob, {markRunningAsFailed: false});
    seenIds.add(hydrated.id);
    const current = jobs.get(hydrated.id);

    if (current && isLocallyRunningJobRecord(current) && isTerminalJobRecord(hydrated)) {
      // Adopt an external terminal record (e.g. cancel via another role) only
      // if it postdates the current attempt; a leftover terminal record from a
      // previous attempt must not poison a freshly started process.
      const terminalAtMs = new Date(hydrated.completedAt || hydrated.updatedAt || 0).getTime();
      const attemptStartMs = new Date(current.processStartedAt || current.startedAt || 0).getTime();
      if (attemptStartMs > 0 && terminalAtMs > 0 && terminalAtMs < attemptStartMs) {
        continue;
      }
      Object.assign(current, hydrated, {
        processId: current.processId,
        processStartedAt: current.processStartedAt || hydrated.processStartedAt || null
      });
      changed += 1;
      if (broadcastChanges) {
        broadcastJob(current, {skipPersist: true});
      }
      continue;
    }

    const merged = mergeJobRecords(current, hydrated);

    if (!current || merged !== current) {
      jobs.set(hydrated.id, merged);
      changed += 1;
      if (broadcastChanges) {
        broadcastJob(merged, {skipPersist: true});
      }
    }
  }

  for (const [jobId, job] of jobs.entries()) {
    if (!seenIds.has(jobId)) {
      const runningLocally = Number(job?.processId || 0) > 0;
      if (!runningLocally) {
        jobs.delete(jobId);
        changed += 1;
      }
    }
  }

  if (changed === 0) {
    jobsFileMtimeMs = details.mtimeMs;
    return {changed, sourceCount: persisted.length};
  }

  rebuildQueueStateFromJobs();
  refreshQueuePositions();
  jobsFileMtimeMs = details.mtimeMs;

  if (RUN_QUEUE_WORKER) {
    for (const job of jobs.values()) {
      const runningLocally = Number(job?.processId || 0) > 0;
      if (runningLocally && !["running", "queued"].includes(String(job.status || "").trim().toLowerCase())) {
        const terminalAtMs = new Date(job.completedAt || job.updatedAt || 0).getTime();
        const attemptStartMs = new Date(job.processStartedAt || job.startedAt || 0).getTime();
        if (attemptStartMs > 0 && terminalAtMs > 0 && terminalAtMs < attemptStartMs) {
          continue;
        }
        appendLog(job, "[worker-sync] job alterado externamente; encerrando processo local.\n", "stderr");
        void terminateJobProcessTree(job).catch(() => false);
      }
    }
  }

  return {changed, sourceCount: persisted.length};
};

// ── Orphan job detector ──────────────────────────────────────────────────────
// Safety net: if a job is "running" but has no live process and heartbeat is
// stale, resolve it as completed (if output exists) or failed.
const ORPHAN_CHECK_INTERVAL_MS = 30_000;
const ORPHAN_HEARTBEAT_STALE_MS = 8 * 60_000; // 8 minutes without heartbeat (tolerates slow LLM/render phases under load)
let lastOrphanCheckMs = 0;

const resolveOrphanJobs = () => {
  const now = Date.now();
  if (now - lastOrphanCheckMs < ORPHAN_CHECK_INTERVAL_MS) return;
  lastOrphanCheckMs = now;

  let resolvedCount = 0;

  for (const job of jobs.values()) {
    if (job.status !== "running") continue;

    // Authoritative liveness: if this server still owns a live child for the job,
    // never orphan it — even if the heartbeat is stale or job.processId was
    // clobbered to null by the disk-sync loop. Bumping the heartbeat here also
    // keeps quiet phases (long renders, slow image audits) fresh on disk.
    if (isJobProcessAlive(job.id)) {
      updateJobHeartbeat(job);
      if (!job.processId) {
        job.processId = getJobProcessPid(job.id);
      }
      continue;
    }

    const heartbeat = Math.max(
      ...[job.heartbeatAt, job.updatedAt, job.startedAt, job.processStartedAt, job.stageUpdatedAt]
        .map((value) => new Date(value || 0).getTime())
        .filter((value) => Number.isFinite(value))
    );
    if (!Number.isFinite(heartbeat) || now - heartbeat < ORPHAN_HEARTBEAT_STALE_MS) continue;

    // Fallback: check the recorded process id if one survived.
    const pid = Number(job.processId || 0);
    if (pid > 0) {
      try { process.kill(pid, 0); continue; } catch { /* process is dead */ }
    }

    const paths = getRunPaths(job.slug);
    const hasOutput = existsSync(paths.outPath);
    const resolvedStatus = hasOutput ? "completed" : "failed";
    const reason = `Orphan detector: job sem processo vivo ha ${Math.round((now - heartbeat) / 60_000)}min.`;

    logJsonLine("warn", "orphan_job_resolved", {
      jobId: job.id, slug: job.slug, resolvedStatus, heartbeatAge: now - heartbeat
    });

    if (hasOutput) {
      try {
        const exportDir = getChannelExportDir(job.input?.channel || "foiumaideia");
        const exportPath = path.join(exportDir, `${job.slug}.mp4`);
        if (!existsSync(exportPath) && existsSync(paths.outPath)) {
          copyFileSync(paths.outPath, exportPath);
        }
        job.outputPath = job.outputPath || exportPath;
      } catch { /* best-effort export */ }
    }

    updateJob(job, {
      status: resolvedStatus,
      completedAt: job.completedAt || new Date().toISOString(),
      error: resolvedStatus === "failed" ? reason : job.error || null
    });
    removeActiveJobForLane(job.queueLane || getJobQueueLane(job), job.id);
    resolvedCount += 1;
  }

  // Resolving an orphan frees a lane slot; kick the worker so the queue does
  // not stall waiting for an external jobs.json change.
  if (resolvedCount > 0 && RUN_QUEUE_WORKER) {
    refreshQueuePositions();
    void startQueueWorker("preview").catch(() => {});
    void startQueueWorker("heavy").catch(() => {});
  }
};

const startJobsDiskSyncLoop = () => {
  if (jobsDiskSyncTimer) {
    clearInterval(jobsDiskSyncTimer);
  }

  jobsDiskSyncTimer = setInterval(() => {
    resolveOrphanJobs();
    syncJobsFromDisk({broadcastChanges: RUN_HTTP_SERVER})
      .then((result) => {
        if (RUN_QUEUE_WORKER && AUTO_START_QUEUED_JOBS && result.changed > 0) {
          void startQueueWorker("preview");
          void startQueueWorker("heavy");
        }
      })
      .catch((error) => {
        logJsonLine("warn", "jobs_disk_sync_failed", {error: serializeError(error)});
      });
  }, JOB_SYNC_INTERVAL_MS);
};

const slugHasMaterializedArtifacts = (slug) => {
  const paths = getRunPaths(slug);
  return (
    existsSync(paths.runDir) ||
    existsSync(paths.assetDir) ||
    existsSync(paths.outPath)
  );
};

const buildUniqueGenerateSlug = (title, {reservedSlugs = []} = {}) => {
  const slugBase = slugify(title) || "video";
  const datePrefix = new Date().toISOString().slice(0, 10);
  const rootSlug = `${datePrefix}-${slugBase}`;
  const reserved = new Set(
    Array.from(reservedSlugs || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
  let candidate = rootSlug;
  let suffix = 2;

  while (
    reserved.has(candidate) ||
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

const removeStreamSubscriber = (jobId, response) => {
  const subscribers = streams.get(jobId);
  if (!subscribers) {
    return;
  }

  subscribers.delete(response);

  if (subscribers.size === 0) {
    streams.delete(jobId);
  }
};

const broadcastJob = (job, {skipPersist = false} = {}) => {
  const payload = sanitizeJob(job);
  const subscribers = streams.get(job.id);

  if (subscribers) {
    for (const response of subscribers) {
      try {
        sendEvent(response, "update", payload);
      } catch {
        removeStreamSubscriber(job.id, response);
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
    const renderPropsPath = path.join(localSystemTempDir, `resume-render-props-${job.id}.json`);
    await writeFile(renderPropsPath, JSON.stringify(renderProps, null, 2));
    const exitCode = await (async () => {
      const renderTimeoutMs = getJobTimeoutMs(job);
      const idleTimeoutMs = getJobIdleTimeoutMs(job);
      const formatTimeoutLabel = (timeoutMs) => {
        const totalMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
        return totalMinutes % 60 === 0 ? `${totalMinutes / 60}h` : `${totalMinutes}min`;
      };
      const renderTimeoutLabel = formatTimeoutLabel(renderTimeoutMs);
      const idleTimeoutLabel = formatTimeoutLabel(idleTimeoutMs);

      try {
        const child = spawn(
          "npx",
          [
            "remotion",
            "render",
            "src/index.ts",
            outputProfile.compositionId,
            paths.outPath,
            `--props=${renderPropsPath}`,
            `--timeout=${renderTimeoutMs}`,
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
              REMOTION_TIMEOUT_MS: String(renderTimeoutMs),
              CI: "1",
              NO_COLOR: "1",
              FORCE_COLOR: "0"
            },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );

        registerJobProcess(job, child);
        setJobStage(job, "render");

        let idleTimer = null;
        let terminationReason = "";
        const terminateResumeRender = (reason) => {
          if (terminationReason) {
            return;
          }

          terminationReason = reason;
          updateJob(job, {terminationReason: reason});
          appendLog(job, `${reason}\n`, "stderr");
          void terminateJobProcessTree(job);
        };
        const refreshIdleTimer = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
          }
          idleTimer = setTimeout(() => {
            terminateResumeRender(`[timeout] Resume ficou ${idleTimeoutLabel} sem atividade no processo — matando render.`);
          }, idleTimeoutMs);
        };
        const renderTimeout = setTimeout(() => {
          terminateResumeRender(`[timeout] Resume excedeu ${renderTimeoutLabel} de runtime total — matando render.`);
        }, renderTimeoutMs);

        const collect = (chunk, source) => {
          refreshIdleTimer();
          appendLog(job, chunk, source);
        };
        refreshIdleTimer();
        child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
        child.stderr.on("data", (chunk) => collect(chunk, "stderr"));

        return await new Promise((resolve) => {
          child.on("error", (error) => {
            clearJobProcess(job);
            clearTimeout(renderTimeout);
            if (idleTimer) {
              clearTimeout(idleTimer);
            }
            updateJob(job, {
              status: "failed",
              completedAt: new Date().toISOString(),
              processId: null,
              exitCode: null,
              error: error.message,
              terminationReason: terminationReason || error.message
            });
            resolve(1);
          });

          child.on("close", (code) => {
            clearTimeout(renderTimeout);
            if (idleTimer) {
              clearTimeout(idleTimer);
            }
            if (terminationReason) {
              updateJob(job, {terminationReason});
            }
            resolve(typeof code === "number" ? code : 1);
          });
        });
      } finally {
        await safeUnlink(renderPropsPath);
      }
    })();

    job.exitCode = exitCode;
    job.completedAt = new Date().toISOString();
    clearJobProcess(job);

    if (exitCode !== 0) {
      updateJob(job, {
        status: "failed",
        error: String(job.terminationReason || getProcessFailureMessage(job, `Retomada terminou com codigo ${exitCode}`)),
        terminationReason: String(job.terminationReason || "")
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

const runQueuedJob = async (job) => {
  const dependsOnJobId = String(job.input?.dependsOnJobId || "").trim();
  if (dependsOnJobId) {
    const dependencyJob = jobs.get(dependsOnJobId);
    const dependencyError = !dependencyJob
      ? `Dependencia ${dependsOnJobId} nao encontrada para este job.`
      : dependencyJob.status !== "completed"
        ? `Dependencia ${dependsOnJobId} terminou como ${dependencyJob.status}; a versao espelho nao sera executada.`
        : "";

    if (dependencyError) {
      appendLog(job, `[dependency] ${dependencyError}\n`, "stderr");
      updateJob(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        exitCode: 1,
        error: dependencyError,
        terminationReason: dependencyError
      });
      return;
    }
  }

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
};

// One runner loop = one occupied lane slot. Each runner synchronously claims a
// job (shift + addActive) before yielding, so concurrent runners never pick
// the same job.
const runLaneWorker = async (lane) => {
  const queue = getQueueForLane(lane);
  incrementLaneRunners(lane);

  try {
    while (queue.length > 0 && laneHasCapacity(lane)) {
      const nextJobId = queue.shift();
      const job = jobs.get(nextJobId);

      if (!job) {
        continue;
      }

      addActiveJobForLane(lane, job.id);
      refreshQueuePositions();

      try {
        await runQueuedJob(job);
      } finally {
        removeActiveJobForLane(lane, job.id);
        refreshQueuePositions();
      }

      if (!AUTO_START_QUEUED_JOBS) {
        break;
      }
    }
  } finally {
    decrementLaneRunners(lane);
  }
};

const startQueueWorker = async (lane) => {
  if (!RUN_QUEUE_WORKER) {
    return;
  }

  const queue = getQueueForLane(lane);
  const runners = [];

  while (
    queue.length > 0 &&
    countLaneRunners(lane) < getLaneConcurrency(lane) &&
    laneHasCapacity(lane)
  ) {
    runners.push(runLaneWorker(lane));
  }

  if (runners.length === 0) {
    refreshQueuePositions();
    return;
  }

  await Promise.all(runners);
};

/** @param {object} job */
const enqueueAndStart = (job) => {
  const enqueued = enqueueJob(job, startQueueWorker, {autoStart: AUTO_START_QUEUED_JOBS});
  logJsonLine("info", "job_enqueued", {
    jobId: job.id,
    type: job.type,
    slug: job.slug,
    status: job.status,
    queueLane: job.queueLane || getJobQueueLane(job),
    previewOnly: job.input?.previewOnly === true
  });
  return enqueued;
};

/** @param {object} job @param {string} errorMessage */
const failAndRelease = (job, errorMessage) => {
  logJsonLine("warn", "job_force_failed", {
    jobId: job?.id,
    slug: job?.slug,
    status: job?.status,
    message: errorMessage
  });
  return failJobAndReleaseQueue(job, errorMessage, startQueueWorker, {autoStartNext: AUTO_START_QUEUED_JOBS});
};

const startQueuedJob = async (job) => {
  if (!RUN_QUEUE_WORKER) {
    throw new Error("Este processo nao executa jobs.");
  }

  if (AUTO_START_QUEUED_JOBS) {
    throw new Error("A fila automatica esta ativa; este start manual nao e necessario.");
  }

  if (!job) {
    throw new Error("Job nao encontrado.");
  }

  const normalizedStatus = String(job.status || "").trim().toLowerCase();
  if (normalizedStatus !== "queued") {
    throw new Error("So e possivel iniciar jobs queued.");
  }

  const lane = job.queueLane || getJobQueueLane(job);
  const activeJobId = getActiveJobIdForLane(lane);
  if (activeJobId) {
    throw new Error(`Ja existe um job em execucao nesta fila: ${activeJobId}.`);
  }

  const queue = getQueueForLane(lane);
  if (queue[0] !== job.id) {
    throw new Error("So e possivel iniciar manualmente o primeiro job da fila.");
  }

  await startQueueWorker(lane);
  return sanitizeJob(jobs.get(job.id) || job);
};

const listRecentExports = async () => listExportVideos({limit: 3});

const getResponseRequestId = (response) => String(response.getHeader("X-Request-Id") || "").trim();

const getRemoteAddress = (request) =>
  String(
    request.headers["x-forwarded-for"] ||
    request.socket?.remoteAddress ||
    ""
  )
    .split(",")[0]
    .trim();

const applySecurityHeaders = (request, response) => {
  for (const [header, value] of Object.entries(SECURITY_RESPONSE_HEADERS)) {
    if (!response.hasHeader(header)) {
      response.setHeader(header, value);
    }
  }

  if (!response.hasHeader("Content-Security-Policy")) {
    response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }

  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").trim().toLowerCase();
  if (forwardedProto === "https" && !response.hasHeader("Strict-Transport-Security")) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
};

const sendJson = (response, statusCode, payload) => {
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(statusCode, {"Content-Type": "application/json; charset=utf-8"});
  response.end(JSON.stringify(payload));
};

const buildHealthPayload = () => ({
  ok: true,
  service: "video-studio",
  role: APP_ROLE,
  now: toIsoNow(),
  uptimeSeconds: Math.round(process.uptime()),
  queueMode: AUTO_START_QUEUED_JOBS ? "auto" : "manual",
  queue: {
    ...getQueueLengths(),
    ...getActiveJobIds()
  },
  jobs: {
    total: jobs.size,
    running: Array.from(jobs.values()).filter((job) => job.status === "running").length,
    queued: Array.from(jobs.values()).filter((job) => job.status === "queued").length,
    failed: Array.from(jobs.values()).filter((job) => job.status === "failed").length
  },
  retention: {
    days: JOB_RETENTION_DAYS,
    count: JOB_RETENTION_COUNT
  },
  auth: {
    source: BASIC_AUTH_PASSWORD_SOURCE
  }
});

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

const resolveRequestedJobId = ({routeJobId = "", bodyJobId = ""} = {}) => {
  const normalizedRouteJobId = String(routeJobId || "").trim();
  const normalizedBodyJobId = String(bodyJobId || "").trim();

  if (normalizedRouteJobId && normalizedBodyJobId && normalizedRouteJobId !== normalizedBodyJobId) {
    throw new Error("O job informado no body nao confere com o job da rota.");
  }

  return normalizedRouteJobId || normalizedBodyJobId;
};

const allowedRoots = [projectRoot, configuredVideoEngineRoot, postarRoot, dataDir].filter(Boolean);

const DENIED_FILE_PATTERNS = [".env", ".key", "secrets.mjs", "secrets.json", "gcp-ate.json", "jobs.json"];

const VIDEO_ENGINE_ARTIFACT_PATTERNS = [
  /^runs\/[^/]+\/(?:storyboard(?:-qa)?\.json|voiceover\.json|asset-plan\.json|render-props\.json|agent-report\.json|orchestration-report\.json|post\.txt|thumbnail(?:\.json|\.png))$/i,
  /^public\/runs\/[^/]+\/(?:audio\/[^/]+\.(?:mp3|wav)|video\/[^/]+\.mp4|thumbnail\.png)$/i,
  /^assets\/envato\/[^/]+\/(?:scene-\d+\.mp4|_flux2_images\/[^/]+\.png|(?:manifest|flux2-manifest)\.json)$/i,
  /^out\/[^/]+\.mp4$/i
];

const DATA_ARTIFACT_PATTERNS = [
  /^videos\/thumbnails\/[^/]+\.(?:png|jpe?g|webp)$/i
];

const isPathWithinRoot = (targetPath, rootPath) =>
  Boolean(rootPath) && (targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`));

const toPosixRelativePath = (rootPath, targetPath) =>
  path.relative(rootPath, targetPath).split(path.sep).join("/");

const ensureAllowedFilePath = (rawPath) => {
  const resolved = path.resolve(String(rawPath || ""));
  const basename = path.basename(resolved).toLowerCase();

  if (DENIED_FILE_PATTERNS.some((p) => basename === p || basename.endsWith(p))) {
    throw new Error("Acesso negado a ficheiro protegido.");
  }

  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );

  if (!isAllowed) {
    throw new Error("Caminho fora das pastas permitidas.");
  }

  return resolved;
};

const ensureAllowedArtifactFilePath = (rawPath) => {
  const resolved = path.resolve(String(rawPath || ""));
  const basename = path.basename(resolved).toLowerCase();

  if (DENIED_FILE_PATTERNS.some((pattern) => basename === pattern || basename.endsWith(pattern))) {
    throw new Error("Acesso negado a ficheiro protegido.");
  }

  const realPath = realpathSync(resolved);
  const inVideoEngineArtifacts = isPathWithinRoot(realPath, configuredVideoEngineRoot)
    && VIDEO_ENGINE_ARTIFACT_PATTERNS.some((pattern) => pattern.test(toPosixRelativePath(configuredVideoEngineRoot, realPath)));
  const inExportArtifacts = isPathWithinRoot(realPath, postarRoot)
    && /\.mp4$/i.test(toPosixRelativePath(postarRoot, realPath));
  const inDataArtifacts = isPathWithinRoot(realPath, dataDir)
    && DATA_ARTIFACT_PATTERNS.some((pattern) => pattern.test(toPosixRelativePath(dataDir, realPath)));

  if (!inVideoEngineArtifacts && !inExportArtifacts && !inDataArtifacts) {
    throw new Error("Arquivo fora da lista de artefatos expostos.");
  }

  return realPath;
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

const serveStaticFile = async (request, response, filePath, {pathResolver = ensureAllowedFilePath} = {}) => {
  try {
    const resolved = pathResolver(filePath);
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
const MAX_PUBLISH_TITLE_LENGTH = 100;
const MAX_SOURCE_TEXT_LENGTH = 50_000;
const MAX_CUSTOM_VOICE_LENGTH = 100;
const MAX_STYLE_PROMPT_LENGTH = 500;
const MAX_LONG_CAPTION_LENGTH = 5000;
const MAX_SOCIAL_CAPTION_LENGTH = 2200;
const DUAL_WELLNESS_CHANNEL_MODE = "ate2min|quiet2min";
const DUAL_WELLNESS_SOURCE_CHANNEL = "ate2min";
const DUAL_WELLNESS_TARGET_CHANNEL = "quiet2min";
const TRANSLATION_ENV_KEYS = [
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "OPENROUTER_API_KEY",
  "LLM_PROVIDER",
  "STORY_PROVIDER",
  "STORY_MODEL",
  "GEMINI_MODEL",
  "ZAI_API_KEY",
  "ZAI_MODEL"
];
const STORYBOARD_TEXT_PACK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    videoTitle: {type: "string"},
    hook: {type: "string"},
    postCaption: {type: "string"},
    cta: {type: "string"},
    hashtags: {
      type: "array",
      items: {type: "string"}
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {type: "string"},
          narration: {type: "string"},
          overlay: {type: "string"}
        },
        required: ["title", "narration", "overlay"]
      }
    }
  },
  required: ["videoTitle", "hook", "postCaption", "cta", "hashtags", "scenes"]
};

const hydrateProcessEnvForLlm = () => {
  for (const key of TRANSLATION_ENV_KEYS) {
    if (!process.env[key] && baseChildEnv[key]) {
      process.env[key] = String(baseChildEnv[key]);
    }
  }
};

const resolveStoryboardTranslationProvider = () => {
  hydrateProcessEnvForLlm();

  if (String(baseChildEnv.GOOGLE_CLOUD_PROJECT || "").trim()) {
    return "vertex";
  }

  if (String(baseChildEnv.GOOGLE_API_KEY || "").trim()) {
    return "gemini";
  }

  return resolveLlmProvider(baseChildEnv.LLM_PROVIDER || baseChildEnv.STORY_PROVIDER || "codex");
};

const buildStoryboardTextPack = (storyboard) => ({
  videoTitle: String(storyboard?.videoTitle || "").trim(),
  hook: String(storyboard?.hook || "").trim(),
  postCaption: String(storyboard?.postCaption || "").trim(),
  cta: String(storyboard?.cta || "").trim(),
  hashtags: Array.isArray(storyboard?.hashtags) ? storyboard.hashtags.map((item) => String(item || "").trim()).filter(Boolean) : [],
  scenes: Array.isArray(storyboard?.scenes)
    ? storyboard.scenes.map((scene) => ({
        title: String(scene?.title || "").trim(),
        narration: String(scene?.narration || "").trim(),
        overlay: String(scene?.overlay || "").trim()
      }))
    : []
});

const applyTranslatedStoryboardTextPack = (storyboard, translatedPack) => ({
  ...storyboard,
  videoTitle: String(translatedPack?.videoTitle || storyboard?.videoTitle || "").trim(),
  hook: String(translatedPack?.hook || storyboard?.hook || "").trim(),
  postCaption: String(translatedPack?.postCaption || storyboard?.postCaption || "").trim(),
  cta: String(translatedPack?.cta || storyboard?.cta || "").trim(),
  hashtags: Array.isArray(translatedPack?.hashtags)
    ? translatedPack.hashtags.map((item) => String(item || "").trim()).filter(Boolean)
    : (Array.isArray(storyboard?.hashtags) ? storyboard.hashtags : []),
  scenes: Array.isArray(storyboard?.scenes)
    ? storyboard.scenes.map((scene, index) => {
        const translatedScene = translatedPack?.scenes?.[index] || {};
        return {
          ...scene,
          title: String(translatedScene.title || scene?.title || "").trim(),
          narration: String(translatedScene.narration || scene?.narration || "").trim(),
          overlay: String(translatedScene.overlay || scene?.overlay || "").trim()
        };
      })
    : []
});

const translateStoryboardForQuiet2Min = async (storyboard) => {
  const sourcePack = buildStoryboardTextPack(storyboard);
  if (!Array.isArray(sourcePack.scenes) || sourcePack.scenes.length === 0) {
    throw new Error("Storyboard em pt-BR sem cenas suficientes para gerar a versão em inglês.");
  }

  const provider = resolveStoryboardTranslationProvider();
  const model = String(baseChildEnv.STORY_MODEL || baseChildEnv.GEMINI_MODEL || "gemini-2.5-flash").trim();
  const translatedPack = await callJsonProvider({
    provider,
    apiKey: String(baseChildEnv.OPENROUTER_API_KEY || "").trim(),
    model,
    schema: STORYBOARD_TEXT_PACK_SCHEMA,
    cwd: projectRoot,
    usageContext: "dual-channel-storyboard-translation",
    messages: [
      {
        role: "system",
        content:
          "You localize short-form storyboard text packs from Brazilian Portuguese to native English. Keep the same scene order, emotional arc, and viewer intent. The message should gently challenge complacency with one honest truth, then end with restored self-worth, dignity, and calm confidence. Return JSON only."
      },
      {
        role: "user",
        content: [
          "Translate this storyboard text pack from pt-BR to en-US for the channel @quiet2min.",
          "Rules:",
          "1. Keep the same number of scenes and the same scene order.",
          "2. Translate only viewer-facing text: title, hook, caption, CTA, hashtags, scene title, narration, and overlay.",
          "3. Keep overlays short and mobile-readable, ideally 2 to 5 words.",
          "4. Make the English sound native, calm, truthful, and emotionally intelligent, never cheesy or guru-like.",
          "5. Preserve the uncomfortable truth / wake-up energy, but end with reassurance and self-respect.",
          `JSON:\n${JSON.stringify(sourcePack, null, 2)}`
        ].join("\n")
      }
    ]
  });

  if (!Array.isArray(translatedPack?.scenes) || translatedPack.scenes.length !== sourcePack.scenes.length) {
    throw new Error("A tradução do storyboard voltou com quantidade de cenas diferente do original.");
  }

  return applyTranslatedStoryboardTextPack(storyboard, translatedPack);
};

const buildGenerateJobRecord = ({
  body,
  title,
  sourceText,
  sourceTextFile,
  storyboardFile,
  channelValue,
  language,
  caseId,
  slug,
  attempt = 1,
  reuseAssetsFromSlug = "",
  dependsOnJobId = "",
  dualChannelMode = ""
}) => {
  const selectedVoice = String(body.voice || "").trim();
  const customVoice = String(body.customVoice || "").trim().slice(0, MAX_CUSTOM_VOICE_LENGTH);
  const outputProfile = resolveOutputProfileConfig(body.outputProfile);
  const channel = getChannelConfig(channelValue);
  const channelPreset = getChannelPreset(channel.value);
  const preferredTone = String(channelPreset?.tone || "shortform_native").trim() || "shortform_native";
  const requestedTone = VALID_TONES.includes(String(body.tone || "").trim()) ? String(body.tone).trim() : preferredTone;
  const imageModel = resolveImageModel(body.imageModel, resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL));
  const generationMode = resolveGenerationMode(body.generationMode, resolveGenerationMode(baseChildEnv.GENERATION_MODE));
  const audioOverride = resolveAudioOverride({body, channelValue: channel.value});
  const audioProvider = audioOverride
    ? audioOverride.audioProvider
    : (body.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp");
  const audioModelId = audioOverride?.modelId || "";
  const voice = audioOverride?.voice
    ? audioOverride.voice
    : resolveRequestedVoice({
        selectedVoice,
        customVoice,
        language,
        channelPreset,
        audioProvider
      });

  if (!voice) {
    throw new Error("Escolha uma voz valida.");
  }

  const targetSeconds = getProfileTargetSeconds(
    outputProfile.id,
    Number(body.targetSeconds || channelPreset?.targetSeconds || outputProfile.defaultTargetSeconds)
  );
  const tonePreset = tonePresets[requestedTone] || tonePresets.natural_clean;
  const explicitCustomStylePrompt = String(body.customStylePrompt || "").slice(0, MAX_STYLE_PROMPT_LENGTH).trim();
  const channelCustomStylePrompt = resolveChannelCustomStylePrompt({channelPreset, language});
  const preferredImageStyle = String(channelPreset?.imageStyle || DEFAULT_VISUAL_STYLE_PRESET).trim() || DEFAULT_VISUAL_STYLE_PRESET;
  const requestedImageStyle = String(body.imageStyle || "").trim();
  const requestedNoMusic = Object.prototype.hasOwnProperty.call(body, "noMusic")
    ? Boolean(body.noMusic)
    : channel.value === "foiumaideia";

  return {
    id: createId(),
    type: "generate",
    title,
    slug,
    caseId,
    attempt,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logTail: [],
    followUpJobId: null,
    input: {
      title,
      hasSourceText: Boolean(sourceText),
      sourceTextCharacters: sourceText.length,
      sourceTextFile,
      storyboardFile,
      channel: channel.value,
      outputProfile: outputProfile.id,
      language,
      targetSeconds,
      imageModel,
      generationMode,
      imageStyle: imageStyleOptions.some((option) => option.value === requestedImageStyle)
        ? requestedImageStyle
        : preferredImageStyle,
      voice,
      audioProvider,
      audioModelId,
      tone: requestedTone,
      stylePrompt: combineStylePrompt({
        language,
        tone: requestedTone,
        customStylePrompt: explicitCustomStylePrompt || channelCustomStylePrompt
      }),
      scriptGuidance: resolveEffectiveScriptGuidance({
        explicitScriptGuidance: body.scriptGuidance,
        explicitTone: requestedTone,
        channelPreset,
        tonePreset
      }),
      channelHandle: channel.handle,
      noMusic: requestedNoMusic,
      force: body.force !== false,
      previewOnly: storyboardFile ? false : Boolean(body.previewOnly),
      approvedFromJobId: null,
      reuseAssetsFromSlug: String(reuseAssetsFromSlug || "").trim(),
      dependsOnJobId: String(dependsOnJobId || "").trim(),
      dualChannelMode: String(dualChannelMode || "").trim()
    },
    outputPath: null,
    storyboardPath: null,
    exitCode: null,
    error: null
  };
};

const handleGenerateRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const sourceText = String(body.sourceText || "").trim().slice(0, MAX_SOURCE_TEXT_LENGTH);
  const title = String(body.title || deriveTitleFromText(sourceText)).trim().slice(0, MAX_TITLE_LENGTH);
  const hasStoryboardInBody = body.storyboard && typeof body.storyboard === "object" && Array.isArray(body.storyboard.scenes) && body.storyboard.scenes.length > 0;
  const generateForBothChannels = body.generateForBothChannels === true;
  const inputValidationError = hasStoryboardInBody ? "" : validateGenerateInputs({title, sourceText});

  if (!title) {
    sendJson(response, 400, {error: "Informe um titulo ou cole um texto completo."});
    return;
  }

  if (inputValidationError) {
    sendJson(response, 400, {error: inputValidationError});
    return;
  }

  const caseId = createId();
  const sourceTextFile = sourceText ? path.join(inputsDir, `${createId()}-source.txt`) : "";

  if (sourceTextFile) {
    await ensureManagedDir(inputsDir);
    await writeManagedFile(sourceTextFile, sourceText);
  }

  let storyboardFile = "";
  let storyboardValidation = null;
  if (hasStoryboardInBody) {
    await ensureManagedDir(inputsDir);
    storyboardFile = path.join(inputsDir, `${createId()}-storyboard.json`);
    await writeManagedFile(storyboardFile, JSON.stringify(body.storyboard, null, 2));

    const submittedChannel = String(body.channel || "").trim() || (body.generateForBothChannels ? "foiumaideia" : "");
    storyboardValidation = validateTikTokStoryboard({
      storyboard: body.storyboard,
      channelValue: submittedChannel
    });
    if (storyboardValidation.warnings.length > 0) {
      process.stdout.write(`[storyboard-validation] warnings: ${storyboardValidation.warnings.join("; ")}\n`);
    }
    if (storyboardValidation.block) {
      sendJson(response, 400, {
        error: `Storyboard invalido: ${storyboardValidation.errors.join("; ")}`,
        validation: storyboardValidation
      });
      return;
    }
  }

  if (generateForBothChannels) {
    if (!hasStoryboardInBody) {
      sendJson(response, 400, {error: "Para gerar @ate2min + @quiet2min com os mesmos assets, cole o storyboard JSON em pt-BR."});
      return;
    }

    const translatedStoryboard = await translateStoryboardForQuiet2Min(body.storyboard);
    const translatedStoryboardFile = path.join(inputsDir, `${createId()}-storyboard-en.json`);
    await writeManagedFile(translatedStoryboardFile, JSON.stringify(translatedStoryboard, null, 2));

    const primaryTitle = String(body.storyboard?.videoTitle || title).trim() || title;
    const secondaryTitle = String(translatedStoryboard?.videoTitle || primaryTitle).trim() || primaryTitle;
    const primarySlug = buildUniqueGenerateSlug(primaryTitle);
    const primaryJob = buildGenerateJobRecord({
      body: {...body, channel: DUAL_WELLNESS_SOURCE_CHANNEL},
      title: primaryTitle,
      sourceText,
      sourceTextFile,
      storyboardFile,
      channelValue: DUAL_WELLNESS_SOURCE_CHANNEL,
      language: "pt-BR",
      caseId,
      slug: primarySlug,
      attempt: 1,
      dualChannelMode: DUAL_WELLNESS_CHANNEL_MODE
    });
    const secondaryJob = buildGenerateJobRecord({
      body: {...body, channel: DUAL_WELLNESS_TARGET_CHANNEL},
      title: secondaryTitle,
      sourceText,
      sourceTextFile,
      storyboardFile: translatedStoryboardFile,
      channelValue: DUAL_WELLNESS_TARGET_CHANNEL,
      language: "en-US",
      caseId,
      slug: buildUniqueGenerateSlug(secondaryTitle, {reservedSlugs: [primarySlug]}),
      attempt: 2,
      reuseAssetsFromSlug: primaryJob.slug,
      dependsOnJobId: primaryJob.id,
      dualChannelMode: DUAL_WELLNESS_CHANNEL_MODE
    });

    primaryJob.followUpJobId = secondaryJob.id;
    secondaryJob.input.primaryChannelJobId = primaryJob.id;

    const enqueuedPrimaryJob = enqueueAndStart(primaryJob);
    const enqueuedSecondaryJob = enqueueAndStart(secondaryJob);
    sendJson(response, 201, {
      job: enqueuedPrimaryJob,
      jobs: [enqueuedPrimaryJob, enqueuedSecondaryJob],
      dualChannelMode: true,
      ...(storyboardValidation ? {storyboardValidation} : {})
    });
    return;
  }

  const language = VALID_LANGUAGES.includes(body.language) ? body.language : "pt-BR";
  const channel = getChannelConfig(String(body.channel || "foiumaideia"));
  const job = buildGenerateJobRecord({
    body,
    title,
    sourceText,
    sourceTextFile,
    storyboardFile,
    channelValue: channel.value,
    language,
    caseId,
    slug: buildUniqueGenerateSlug(title),
    attempt: 1
  });

  sendJson(response, 201, {
    job: enqueueAndStart(job),
    ...(storyboardValidation ? {storyboardValidation} : {})
  });
};

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeStoryboardText = (value, fallback = "", maxLength = 0) => {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  const safeFallback = String(fallback ?? "").replace(/\r\n/g, "\n").trim();
  const chosen = normalized || safeFallback;
  return maxLength > 0 ? chosen.slice(0, maxLength) : chosen;
};

const normalizePublishTitle = (value, fallback = "") =>
  String(value || fallback || "").trim().slice(0, MAX_PUBLISH_TITLE_LENGTH);

const normalizeLongCaption = (value, fallback = "") =>
  String(value || fallback || "").trim().slice(0, MAX_LONG_CAPTION_LENGTH);

const normalizeSocialCaption = (value, fallback = "") =>
  String(value || fallback || "").trim().slice(0, MAX_SOCIAL_CAPTION_LENGTH);

const resolvePublishTitleForVideo = ({body = {}, meta = null, video = null, fallback = ""} = {}) =>
  normalizePublishTitle(
    body.publishTitle || meta?.publishTitle || body.title || meta?.title || video?.publishTitle || video?.title,
    fallback
  );

const resolveSocialCaptionForVideo = ({body = {}, meta = null, video = null, fallback = ""} = {}) =>
  normalizeSocialCaption(
    body.socialCaption || meta?.socialCaption || body.caption || meta?.caption || video?.socialCaption || video?.caption,
    fallback
  );

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
      audioProvider: body.audioProvider === "elevenlabs" ? "elevenlabs" : "gcp",
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
      force: sourceJob.input?.reuseAssetsFromSlug
        ? false
        : sourceJob.input?.force === false ? false : true,
      approvedFromJobId: sourceJob.id
    },
    outputPath: null,
    storyboardPath: storyboardPath,
    exitCode: null,
    error: null
  };
};

const findDualChannelSecondaryTemplate = (primaryJob) => {
  if (
    String(primaryJob?.input?.dualChannelMode || "").trim() !== DUAL_WELLNESS_CHANNEL_MODE ||
    String(primaryJob?.input?.channel || "").trim() !== DUAL_WELLNESS_SOURCE_CHANNEL
  ) {
    return null;
  }

  const directFollowUp = primaryJob.followUpJobId ? jobs.get(primaryJob.followUpJobId) || null : null;
  if (String(directFollowUp?.input?.channel || "").trim() === DUAL_WELLNESS_TARGET_CHANNEL) {
    return directFollowUp;
  }

  return Array.from(jobs.values())
    .filter((job) =>
      job?.type === "generate" &&
      String(job?.caseId || "").trim() === String(primaryJob.caseId || "").trim() &&
      String(job?.input?.dualChannelMode || "").trim() === DUAL_WELLNESS_CHANNEL_MODE &&
      String(job?.input?.channel || "").trim() === DUAL_WELLNESS_TARGET_CHANNEL
    )
    .sort((left, right) =>
      getJobFreshnessMs(right) - getJobFreshnessMs(left)
    )[0] || null;
};

const buildDualChannelRetryFollowUpJob = async ({sourcePrimaryJob, retriedPrimaryJob}) => {
  const secondaryTemplate = findDualChannelSecondaryTemplate(sourcePrimaryJob);
  if (!secondaryTemplate) {
    return null;
  }

  const storyboardPath = getRetryStoryboardPathForJob(secondaryTemplate);
  if (!storyboardPath || !existsSync(storyboardPath)) {
    return null;
  }

  const storyboard = await readJsonFile(storyboardPath).catch(() => null);
  const title = String(storyboard?.videoTitle || secondaryTemplate.title || slugToCaption(secondaryTemplate.slug)).trim();
  const nowIso = new Date().toISOString();

  return {
    id: createId(),
    type: "generate",
    title,
    slug: buildUniqueGenerateSlug(title),
    caseId: retriedPrimaryJob.caseId || sourcePrimaryJob.caseId || secondaryTemplate.caseId || createId(),
    attempt: Math.max(
      Number(retriedPrimaryJob.attempt || 0) + 1,
      getNextAttemptForCase(retriedPrimaryJob.caseId || sourcePrimaryJob.caseId || secondaryTemplate.caseId)
    ),
    status: "queued",
    createdAt: nowIso,
    updatedAt: nowIso,
    logTail: [
      `[dual-channel] refeito a partir do job ${secondaryTemplate.id}; aguardando PT ${retriedPrimaryJob.id}`
    ],
    followUpJobId: null,
    input: {
      ...secondaryTemplate.input,
      title,
      hasSourceText: false,
      sourceTextCharacters: 0,
      sourceTextFile: "",
      storyboardFile: storyboardPath,
      channel: DUAL_WELLNESS_TARGET_CHANNEL,
      language: "en-US",
      previewOnly: false,
      force: false,
      reuseAssetsFromSlug: retriedPrimaryJob.slug,
      dependsOnJobId: retriedPrimaryJob.id,
      primaryChannelJobId: retriedPrimaryJob.id,
      approvedFromJobId: secondaryTemplate.id,
      dualChannelMode: DUAL_WELLNESS_CHANNEL_MODE
    },
    outputPath: null,
    storyboardPath,
    artifactEpochAt: nowIso,
    exitCode: null,
    error: null
  };
};

const handleResumeRequest = async (request, response, routeJobId = "") => {
  const body = await readRequestBody(request);
  let sourceJobId = "";

  try {
    sourceJobId = resolveRequestedJobId({routeJobId, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

  if (!sourceJobId) {
    sendJson(response, 400, {error: "Job ausente."});
    return;
  }

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
  const nowMs = Date.now();
  const videoLibraryCache = globalThis.__videoLibraryCache || {expiresAt: 0, payload: null};
  globalThis.__videoLibraryCache = videoLibraryCache;

  if (videoLibraryCache.payload && videoLibraryCache.expiresAt > nowMs) {
    sendJson(response, 200, videoLibraryCache.payload);
    return;
  }

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
  const payload = {
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
  };
  videoLibraryCache.payload = payload;
  videoLibraryCache.expiresAt = nowMs + 15000;
  sendJson(response, 200, payload);
};

const handleVideoMetaRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const target = await resolveVideoTarget({
    slug: body.slug,
    filePath: body.path
  });
  const existingMeta = await readVideoMeta(target.slug);
  const title = String(body.title || "").trim().slice(0, 200);
  const publishTitle = normalizePublishTitle(body.publishTitle || "", title);
  const caption = normalizeLongCaption(body.caption || "");
  const socialCaption = normalizeSocialCaption(body.socialCaption || "", caption);
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
  const hookWinner = String(body.hookWinner ?? existingMeta?.hookWinner ?? "").trim().slice(0, 40);

  await writeVideoMeta(target.slug, {
    ...existingMeta,
    title,
    publishTitle,
    caption,
    socialCaption,
    scheduleAt,
    isDraft,
    channel: channel.value,
    hashtags,
    platforms: safePlatforms,
    hookWinner,
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

const handleRetryFailedJobRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let sourceJobId = "";

  try {
    sourceJobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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
  const dualChannelFollowUpJob = await buildDualChannelRetryFollowUpJob({
    sourcePrimaryJob: sourceJob,
    retriedPrimaryJob: retriedJob
  });

  if (dualChannelFollowUpJob) {
    retriedJob.followUpJobId = dualChannelFollowUpJob.id;
  }

  const enqueuedRetriedJob = enqueueAndStart(retriedJob);
  const enqueuedFollowUpJob = dualChannelFollowUpJob ? enqueueAndStart(dualChannelFollowUpJob) : null;

  sendJson(response, 201, {
    job: enqueuedRetriedJob,
    ...(enqueuedFollowUpJob ? {jobs: [enqueuedRetriedJob, enqueuedFollowUpJob]} : {})
  });
};

const handleRegenerateMissingSceneRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let sourceJobId = "";

  try {
    sourceJobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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

const handleGenerateAudioRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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

const handleRenderOnlyRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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

const handleValidateOnlyRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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

const handleForceFailJobRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

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

const handleStartQueuedJobRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

  const job = jobs.get(jobId);

  if (!job) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  try {
    const startedJob = await startQueuedJob(job);
    sendJson(response, 200, {job: startedJob});
  } catch (error) {
    sendJson(response, 409, {error: error instanceof Error ? error.message : String(error)});
  }
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

// Build + persist a TikTok manual-upload draft for a video and return its helper URL.
// Used both by the dedicated TikTok-helper route and as the automatic fallback when
// TikTok is requested in a publish (agendador's TikTok dispatch is unreliable / 500s).
const createTikTokDraftForVideo = async ({target, video, meta, body, hashtags, publishTitle, socialCaption}) => {
  const fallbackTitle = slugToCaption(target.path);
  const caption = [socialCaption, (Array.isArray(hashtags) ? hashtags : []).join(" ")].filter(Boolean).join("\n\n");
  const draftId = `${target.slug}-${Date.now().toString(36)}`;
  const draft = {
    id: draftId,
    slug: target.slug,
    title: publishTitle || fallbackTitle,
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
  return {draftId, helperUrl: `/tiktok-helper?id=${encodeURIComponent(draftId)}`};
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
  const requestedPlatforms = Array.isArray(body.platforms) ? body.platforms : meta?.platforms;
  const platforms = (Array.isArray(requestedPlatforms) ? requestedPlatforms : ["FB", "IG", "YT"])
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
  const safePlatforms = platforms.length > 0 ? platforms : ["FB", "IG", "YT"];
  // TikTok is dispatched manually via the helper (agendador's TikTok posting 500s),
  // so split it out: agendador handles the rest, TikTok falls back to a manual draft.
  const tkRequested = safePlatforms.includes("TK");
  const agendadorPlatforms = safePlatforms.filter((platform) => platform !== "TK");
  const fallbackTitle = slugToCaption(target.path);
  const title = String(body.title || meta?.title || video.title || "").trim().slice(0, MAX_TITLE_LENGTH);
  const publishTitle = resolvePublishTitleForVideo({body, meta, video, fallback: fallbackTitle});
  const descriptionCaption = normalizeLongCaption(body.caption || meta?.caption || video.caption || fallbackTitle);
  const socialCaption = resolveSocialCaptionForVideo({body, meta, video, fallback: descriptionCaption});
  const requiresShortCaption = safePlatforms.some((platform) => platform !== "YT");

  if (safePlatforms.includes("YT") && !publishTitle) {
    sendJson(response, 400, {error: "Informe um título de publicação para o YouTube."});
    return;
  }

  if (requiresShortCaption && socialCaption.length > MAX_SOCIAL_CAPTION_LENGTH) {
    sendJson(response, 400, {error: `A legenda curta para cross-post fora do YouTube deve ter até ${MAX_SOCIAL_CAPTION_LENGTH} caracteres.`});
    return;
  }

  if (requiresShortCaption && !String(body.socialCaption || meta?.socialCaption || "").trim() && descriptionCaption.length > MAX_SOCIAL_CAPTION_LENGTH) {
    sendJson(response, 400, {error: `A descrição atual passou de ${MAX_SOCIAL_CAPTION_LENGTH} caracteres. Preencha a legenda curta para publicar fora do YouTube.`});
    return;
  }

  const captionBase = safePlatforms.includes("YT") && safePlatforms.length === 1
    ? descriptionCaption
    : socialCaption;
  const caption = [
    safePlatforms.includes("YT") && publishTitle ? publishTitle : "",
    captionBase,
    hashtags.join(" ")
  ].filter(Boolean).join("\n\n");
  const rawPublishDate = String(body.scheduleAt || meta?.scheduleAt || "").trim() || new Date().toISOString();
  // If the resolved date is in the past (e.g. stale metadata from an old job), publish immediately instead
  const publishDate = new Date(rawPublishDate).getTime() <= Date.now()
    ? new Date().toISOString()
    : rawPublishDate;
  const isDraft = body.isDraft === true;

  // TikTok-only request: skip agendador entirely and return a manual-upload draft.
  if (agendadorPlatforms.length === 0) {
    const {helperUrl} = await createTikTokDraftForVideo({target, video, meta, body, hashtags, publishTitle, socialCaption});
    sendJson(response, 200, {
      ok: true,
      tiktokOnly: true,
      tiktokHelperUrl: helperUrl,
      message: "O TikTok é publicado por upload manual. Abra o helper, baixe o MP4 e poste no TikTok com a legenda já pronta."
    });
    return;
  }

  const token = await getAgendadorToken(publishChannel.value);
  const accountsPayload = await agendadorFetch("/social-accounts", {token});
  const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
  const missingProviders = agendadorPlatforms
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
    title: publishTitle || undefined,
    caption,
    platforms: agendadorPlatforms,
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
    const isValidationError = [400, 422].includes(Number(error.status || 0));
    const retryBodyWithoutThumbnail = thumbnailUrl && isValidationError
      ? (() => {
          const next = {...basePostBody};
          return next;
        })()
      : null;
    const retryBodyWithoutTitle = isValidationError && (basePostBody.title || enrichedPostBody.title)
      ? (() => {
          const next = {...(retryBodyWithoutThumbnail || basePostBody)};
          delete next.title;
          return next;
        })()
      : null;

    if (retryBodyWithoutThumbnail) {
      try {
        created = await agendadorFetch("/posts", {
          method: "POST",
          token,
          body: retryBodyWithoutThumbnail
        });
        thumbnailUrl = "";
      } catch (retryError) {
        if (retryBodyWithoutTitle && [400, 422].includes(Number(retryError.status || 0))) {
          created = await agendadorFetch("/posts", {
            method: "POST",
            token,
            body: retryBodyWithoutTitle
          });
          thumbnailUrl = "";
        } else {
          throw retryError;
        }
      }
    } else if (retryBodyWithoutTitle) {
      created = await agendadorFetch("/posts", {
        method: "POST",
        token,
        body: retryBodyWithoutTitle
      });
    } else {
      throw error;
    }
  }

  const publishStatus = isDraft ? "draft" : new Date(publishDate).getTime() > Date.now() ? "scheduled" : "published";
  const publishedAt = publishStatus === "published" ? new Date().toISOString() : null;

  await writeVideoMeta(target.slug, {
    ...meta,
    title,
    publishTitle,
    caption: descriptionCaption,
    socialCaption,
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

  // TikTok was also requested alongside FB/IG/YT — agendador can't post it, so
  // attach a manual-upload helper draft to the response.
  let tiktokHelperUrl = "";
  if (tkRequested) {
    try {
      ({helperUrl: tiktokHelperUrl} = await createTikTokDraftForVideo({target, video, meta, body, hashtags, publishTitle, socialCaption}));
    } catch (error) {
      process.stdout.write(`[publish] aviso: não foi possível preparar o helper do TikTok: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  sendJson(response, 200, {
    ok: true,
    post: created?.post ?? created ?? null,
    ...(tiktokHelperUrl ? {tiktokHelperUrl, tiktokMessage: "TikTok não publica automático: abra o helper e suba o MP4 manualmente."} : {}),
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
  const fallbackTitle = slugToCaption(target.path);
  const publishTitle = resolvePublishTitleForVideo({body, meta, video, fallback: fallbackTitle});
  const descriptionCaption = normalizeLongCaption(body.caption || meta?.caption || video.caption || fallbackTitle);
  const socialCaption = resolveSocialCaptionForVideo({body, meta, video, fallback: descriptionCaption});

  if (!socialCaption) {
    sendJson(response, 400, {error: "Informe uma legenda curta para abrir o helper do TikTok."});
    return;
  }

  if (!String(body.socialCaption || meta?.socialCaption || "").trim() && descriptionCaption.length > MAX_SOCIAL_CAPTION_LENGTH) {
    sendJson(response, 400, {error: `A descrição atual passou de ${MAX_SOCIAL_CAPTION_LENGTH} caracteres. Preencha a legenda curta para o TikTok.`});
    return;
  }

  const caption = [socialCaption, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const draftId = `${target.slug}-${Date.now().toString(36)}`;
  const draft = {
    id: draftId,
    slug: target.slug,
    title: publishTitle || fallbackTitle,
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

// Generate A/B hook variants (SPEC v2) for an existing video's storyboard.
// Returns the variants plus ready-to-render variant storyboards (same body,
// swapped opening hook) that the UI can submit to POST /api/generate.
const handleHookVariantsRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const slug = String(body.slug || "").trim();
  if (!slug) {
    sendJson(response, 400, {error: "Informe o slug do vídeo."});
    return;
  }

  const {storyboardPath, runDir} = getRunPaths(slug);
  const storyboard = await readJsonFile(storyboardPath);
  if (!storyboard || !Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0) {
    sendJson(response, 404, {error: "Storyboard não encontrado para esse vídeo."});
    return;
  }

  const channelPreset = getChannelPreset(String(body.channel || "").trim());
  const language = VALID_LANGUAGES.includes(body.language)
    ? body.language
    : (channelPreset?.language || "pt-BR");
  const count = Math.max(2, Math.min(3, Number(body.count) || 3));
  const provider = resolveStoryboardTranslationProvider();
  const model = String(baseChildEnv.STORY_MODEL || baseChildEnv.GEMINI_MODEL || "gemini-2.5-flash").trim();

  let variants;
  try {
    variants = await generateHookVariants({
      storyboard,
      language,
      count,
      provider,
      apiKey: String(baseChildEnv.OPENROUTER_API_KEY || "").trim(),
      model,
      cwd: projectRoot
    });
  } catch (error) {
    sendJson(response, 502, {error: `Falha ao gerar variantes de hook: ${error instanceof Error ? error.message : String(error)}`});
    return;
  }

  try {
    await writeManagedFile(
      path.join(runDir, "hook-variants.json"),
      `${JSON.stringify({slug, language, generatedAt: toIsoNow(), variants}, null, 2)}\n`
    );
  } catch (error) {
    process.stdout.write(`[hook-variants] aviso: não foi possível persistir hook-variants.json: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  sendJson(response, 200, {
    ok: true,
    slug,
    language,
    variants,
    variantStoryboards: variants.map((variant) => buildVariantStoryboard(storyboard, variant))
  });
};

// Query agendador for the per-platform status of a video's last published post,
// so the UI can show which networks succeeded/failed and retry the failed ones.
const handlePublishStatusRequest = async (request, response) => {
  const body = await readRequestBody(request);
  const slug = String(body.slug || "").trim();
  if (!slug) {
    sendJson(response, 400, {error: "Informe o slug do vídeo."});
    return;
  }

  const meta = await readVideoMeta(slug).catch(() => null);
  const channelValue = getChannelConfig(String(body.channel || meta?.channel || meta?.publishedProfile || "foiumaideia")).value;
  const postId = Number(meta?.publishedPostId || 0);

  if (!postId) {
    sendJson(response, 200, {ok: true, postId: null, targets: [], message: "Sem publicação registrada para este vídeo."});
    return;
  }

  try {
    const token = await getAgendadorToken(channelValue);
    const data = await agendadorFetch("/posts?limit=100", {token});
    const post = (Array.isArray(data?.posts) ? data.posts : []).find((item) => Number(item.id) === postId);
    if (!post) {
      sendJson(response, 200, {ok: true, postId, targets: [], message: "Post não encontrado no agendador."});
      return;
    }
    const targets = (Array.isArray(post.targets) ? post.targets : []).map((targetItem) => ({
      platform: String(targetItem.provider || "").toUpperCase() || `ACCT${targetItem.social_account_id}`,
      status: String(targetItem.status || "").toUpperCase(),
      error: targetItem.last_error ? String(targetItem.last_error) : ""
    }));
    sendJson(response, 200, {ok: true, postId, postStatus: String(post.status || "").toUpperCase(), channel: channelValue, targets});
  } catch (error) {
    sendJson(response, 502, {error: `Falha ao consultar status: ${error instanceof Error ? error.message : String(error)}`});
  }
};

const handleConfigRequest = async (response) => {
  const defaultChannel = getChannelConfig("foiumaideia");
  const defaultChannelPreset = getChannelPreset(defaultChannel.value);
  const defaultLanguage = "pt-BR";
  sendJson(response, 200, {
    defaults: {
      channel: defaultChannel.value,
      language: defaultLanguage,
      targetSeconds: Number(defaultChannelPreset?.targetSeconds || 60),
      outputProfile: DEFAULT_OUTPUT_PROFILE,
      imageModel: resolveImageModel(defaultChannelPreset?.imageModel, resolveImageModel(baseChildEnv.GOOGLE_IMAGE_MODEL || baseChildEnv.IMAGE_MODEL)),
      generationMode: resolveGenerationMode(baseChildEnv.GENERATION_MODE),
      imageStyle: String(defaultChannelPreset?.imageStyle || DEFAULT_VISUAL_STYLE_PRESET),
      tone: String(defaultChannelPreset?.tone || "shortform_native"),
      voice: String(defaultChannelPreset?.voiceByLanguage?.[defaultLanguage] || defaultChannelPreset?.voice || DEFAULT_VOICE),
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
  if (!existsSync(rootEnvPath)) {
    process.stderr.write(`ERRO: Arquivo .env nao encontrado em ${rootEnvPath}\n`);
    process.exit(1);
  }

  if (!RUN_QUEUE_WORKER) {
    return;
  }

  const hasEnvValue = (value) => String(value || "").trim().length > 0;
  const requestedTtsProvider = String(baseChildEnv.TTS_PROVIDER || "auto").trim().toLowerCase();
  const llmProvider = String(baseChildEnv.LLM_PROVIDER || baseChildEnv.STORY_PROVIDER || "codex").trim().toLowerCase();
  const requiredKeys = [];

  if (llmProvider === "openrouter") {
    requiredKeys.push("OPENROUTER_API_KEY");
  } else if (llmProvider === "gemini" || llmProvider === "google") {
    requiredKeys.push("GOOGLE_API_KEY");
  } else if (llmProvider === "vertex" || llmProvider === "vertexai") {
    requiredKeys.push("GOOGLE_CLOUD_PROJECT");
  }

  if (
    requestedTtsProvider === "google" ||
    requestedTtsProvider === "gcloud" ||
    requestedTtsProvider === "google-cloud" ||
    requestedTtsProvider === "google-gemini-tts" ||
    requestedTtsProvider === "gemini-tts" ||
    requestedTtsProvider === "gemini"
  ) {
    requiredKeys.push("GOOGLE_CLOUD_PROJECT");
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
      hasEnvValue(baseChildEnv.GOOGLE_CLOUD_PROJECT);
    const elevenlabsConfigured = hasEnvValue(baseChildEnv.ELEVENLABS_API_KEY);

    if (!azureConfigured && !googleConfigured && !elevenlabsConfigured) {
      process.stderr.write("ERRO: TTS_PROVIDER=auto, mas nenhum provider de voz esta configurado.\n");
      process.exit(1);
    }
  }
};

validateStartup();

await ensureManagedDir(dataDir);
await ensureManagedDir(inputsDir);
await ensureManagedDir(videoLibraryDir);
await ensureManagedDir(tiktokDraftsDir);
await ensureManagedDir(postarRoot);
await cleanupStaleJobsTempFiles();
await Promise.all(channelOptions.map((channel) => ensureManagedDir(getChannelExportDir(channel.value))));
await normalizeManagedTree(dataDir, {maxDepth: 2});
await Promise.all(channelOptions.map((channel) => normalizeManagedTree(getChannelExportDir(channel.value), {maxDepth: 1})));

const persistedJobs = await readJsonFile(jobsFile);

if (Array.isArray(persistedJobs)) {
  for (const persistedJob of persistedJobs) {
    const hydrated = hydratePersistedJob(persistedJob, {markRunningAsFailed: RUN_QUEUE_WORKER});
    jobs.set(hydrated.id, hydrated);
  }
}

rebuildQueueStateFromJobs();
refreshQueuePositions();
jobsFileMtimeMs = (await stat(jobsFile).catch(() => null))?.mtimeMs || 0;

const prunedJobsOnStartup = pruneRetainedJobs();

if (Array.isArray(persistedJobs)) {
  await persistJobs();
}

logJsonLine("info", "startup_state_loaded", {
  persistedJobs: Array.isArray(persistedJobs) ? persistedJobs.length : 0,
  retainedJobs: jobs.size,
  prunedJobsOnStartup
});

const resolveBasicAuthConfig = async () => {
  const explicitPassword = String(baseChildEnv.VIDEO_STUDIO_PASSWORD || process.env.VIDEO_STUDIO_PASSWORD || "").trim();
  if (explicitPassword) {
    return {
      password: explicitPassword,
      source: "env"
    };
  }

  const persistedAuth = await readJsonFile(runtimeAuthFile).catch(() => null);
  const persistedPassword = String(persistedAuth?.basicAuthPassword || "").trim();
  if (persistedPassword) {
    return {
      password: persistedPassword,
      source: "runtime-file"
    };
  }

  const generatedPassword = randomBytes(18).toString("base64url");
  await writeManagedFile(
    runtimeAuthFile,
    `${JSON.stringify({basicAuthPassword: generatedPassword, generatedAt: toIsoNow()}, null, 2)}\n`,
    undefined,
    0o600
  );
  logJsonLine("warn", "basic_auth_runtime_password_generated", {
    authFile: runtimeAuthFile
  });
  return {
    password: generatedPassword,
    source: "runtime-file"
  };
};

const {password: BASIC_AUTH_PASSWORD, source: BASIC_AUTH_PASSWORD_SOURCE} = await resolveBasicAuthConfig();
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
  const url = new URL(_req.url, "http://localhost");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
  const allJobs = Array.from(jobs.values())
    .map((job) => sanitizeJob(job))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const payload = allJobs.slice(offset, offset + limit);
  const queueLengths = getQueueLengths();
  sendJson(res, 200, {
    jobs: payload,
    total: allJobs.length,
    limit,
    offset,
    cases: payload.map((job) => job.caseSummary),
    summary: buildJobsSummary(allJobs),
    ...getActiveJobIds(),
    ...queueLengths
  });
};

const handleHealthRequest = async (_req, res) => {
  sendJson(res, 200, buildHealthPayload());
};

const getRuntimeDocPath = (name) => {
  const normalized = String(name || "").trim().toLowerCase();
  if (normalized === "api-reference") {
    return path.join(projectRoot, "docs", "api-reference.md");
  }
  if (normalized === "operations-reference") {
    return path.join(projectRoot, "docs", "operations-reference.md");
  }
  return "";
};

const handleOpenApiSpecRequest = async (req, res) => {
  await serveStaticFile(req, res, path.join(projectRoot, "docs", "openapi.yaml"));
};

const handleRuntimeDocRequest = async (req, res, {params}) => {
  const targetPath = getRuntimeDocPath(params.name);
  if (!targetPath) {
    sendJson(res, 404, {error: "Documento nao encontrado."});
    return;
  }
  await serveStaticFile(req, res, targetPath);
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
    try { res.write(": ping\n\n"); } catch { clearInterval(keepAlive); removeStreamSubscriber(params.id, res); }
  }, 25000);

  const cleanup = () => { clearInterval(keepAlive); removeStreamSubscriber(params.id, res); };
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
  await serveStaticFile(req, res, filePath, {pathResolver: ensureAllowedArtifactFilePath});
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

const handleResetPublishRequest = async (request, response, {params}) => {
  const slug = String(params.slug || "").trim();
  if (!slug) { sendJson(response, 400, {error: "Slug ausente."}); return; }
  const existingMeta = await readVideoMeta(slug).catch(() => null);
  if (!existingMeta) { sendJson(response, 404, {error: "Metadados do video nao encontrados."}); return; }
  await writeVideoMeta(slug, {
    ...existingMeta,
    publishStatus: "ready",
    publishedAt: null,
    scheduleAt: null,
    lastPublishStatus: null,
    isDraft: false,
    updatedAt: new Date().toISOString()
  });
  sendJson(response, 200, {ok: true});
};

const getSceneManifestPathCandidates = (slug) => {
  const {assetDir} = getRunPaths(slug);
  return [
    path.join(assetDir, "manifest.json"),
    path.join(assetDir, "flux2-manifest.json")
  ];
};

const readSceneManifestEntries = async (slug) => {
  const manifestCandidates = getSceneManifestPathCandidates(slug);

  for (const manifestPath of manifestCandidates) {
    const parsed = await readJsonFile(manifestPath).catch(() => null);
    if (Array.isArray(parsed)) {
      return {entries: parsed, shape: "array", manifestPath};
    }
    if (Array.isArray(parsed?.entries)) {
      return {entries: parsed.entries, shape: "entries", manifestPath};
    }
  }

  return {entries: [], shape: "array", manifestPath: manifestCandidates[0] || ""};
};

const writeSceneManifestEntries = async (slug, entries) => {
  const manifestCandidates = getSceneManifestPathCandidates(slug);

  for (const manifestPath of manifestCandidates) {
    if (!existsSync(manifestPath)) {
      continue;
    }

    const parsed = await readJsonFile(manifestPath).catch(() => null);
    const payload = Array.isArray(parsed)
      ? entries
      : isPlainObject(parsed)
        ? {...parsed, entries}
        : entries;
    await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
};

const runCommandOrThrow = (command, args, errorPrefix) => {
  const result = spawnSync(command, args, {encoding: "utf8"});

  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || "").trim() || `exit code ${result.status}`;
    throw new Error(`${errorPrefix}: ${details}`);
  }
};

const renderStaticSceneClip = ({imagePath, videoPath, durationSeconds, profile}) => {
  const filter = [
    `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease`,
    `pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:white`,
    "format=yuv420p"
  ].join(",");

  runCommandOrThrow(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-vf",
      filter,
      "-t",
      String(durationSeconds),
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-an",
      videoPath
    ],
    "Falha ao gerar clip estatico da cena aprovada"
  );
};

const concatSceneSegmentClips = async ({clips, outputPath, tempDir}) => {
  if (clips.length === 0) {
    throw new Error("Nenhum clip de segmento disponivel para concatenar a cena.");
  }

  if (clips.length === 1) {
    await copyFile(clips[0], outputPath);
    return;
  }

  const listPath = path.join(tempDir, `manual-scene-concat-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(listPath, clips.map((clipPath) => `file '${clipPath.replaceAll("'", "'\\''")}'`).join("\n"));
    runCommandOrThrow(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        outputPath
      ],
      "Falha ao concatenar os clips da cena aprovada"
    );
  } finally {
    await unlink(listPath).catch(() => {});
  }
};

const getSceneReviewItemsForJob = async (selectedJob) => {
  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  const slug = String(sourceJob?.slug || "").trim();

  if (!slug) {
    return [];
  }

  const {entries} = await readSceneManifestEntries(slug);
  const assetDir = path.join(configuredVideoEngineRoot, "assets", "envato", slug);
  const imagesDir = path.join(assetDir, "_flux2_images");
  let files = [];

  try {
    files = await readdir(imagesDir);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => String(entry?.status || "").trim() === "failed")
    .map((entry) => {
      const sceneNumber = normalizePositiveInt(entry.scene);
      const segNumber = normalizePositiveInt(entry.segment);
      if (!sceneNumber || !segNumber) {
        return null;
      }

      const sceneNum = String(sceneNumber).padStart(2, "0");
      const segmentNum = String(segNumber).padStart(2, "0");
      const attemptPrefix = `scene-${sceneNum}-seg-${segmentNum}__attempt-`;
      const attempts = files
        .filter((file) => file.startsWith(attemptPrefix) && file.endsWith(".png"))
        .map((file) => {
          const match = file.match(/__attempt-(\d+)\.png$/);
          const attempt = normalizePositiveInt(match?.[1]) || 0;
          const absolutePath = path.join(imagesDir, file);
          const details = existsSync(absolutePath) ? statSync(absolutePath) : null;
          return {
            attempt,
            file,
            absolutePath,
            url: `/api/file?path=${encodeURIComponent(absolutePath)}`,
            sizeBytes: details?.size || 0,
            updatedAt: details ? new Date(details.mtimeMs).toISOString() : null
          };
        })
        .sort((left, right) => right.attempt - left.attempt);

      if (attempts.length === 0) {
        return null;
      }

      return {
        sceneNumber,
        segNumber,
        title: String(entry.title || "").trim(),
        error: String(entry.error || entry.localAudit?.summary || "").trim(),
        coverageText: String(entry.coverageText || "").trim(),
        action: String(entry.action || "").trim(),
        prompt: String(entry.prompt || "").trim(),
        recommendedAttempt: attempts[0]?.attempt || null,
        attempts
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sceneNumber - right.sceneNumber || left.segNumber - right.segNumber);
};

const approveSceneReviewAttempt = async ({selectedJob, sceneNumber, segNumber, attempt, autoContinue = true}) => {
  const sourceJob = getRecoverySourceJob(selectedJob) || selectedJob;
  const slug = String(sourceJob?.slug || "").trim();

  if (!slug) {
    throw new Error("Job sem slug para aprovar tentativa de cena.");
  }

  const {entries} = await readSceneManifestEntries(slug);
  const sceneEntry = entries.find(
    (entry) =>
      normalizePositiveInt(entry.scene) === sceneNumber &&
      normalizePositiveInt(entry.segment) === segNumber
  );

  if (!sceneEntry) {
    throw new Error("Nao achei a entrada da cena/segmento no manifesto.");
  }

  const profile = resolveOutputProfileConfig(sourceJob.input?.outputProfile || DEFAULT_OUTPUT_PROFILE);
  const paths = getRunPaths(slug);
  const imagesDir = path.join(paths.assetDir, "_flux2_images");
  const sceneNum = String(sceneNumber).padStart(2, "0");
  const segmentNum = String(segNumber).padStart(2, "0");
  const attemptImagePath = path.join(imagesDir, `scene-${sceneNum}-seg-${segmentNum}__attempt-${attempt}.png`);
  const finalImagePath = path.join(imagesDir, `scene-${sceneNum}-seg-${segmentNum}.png`);
  const finalSegmentClipPath = path.join(imagesDir, `scene-${sceneNum}-seg-${segmentNum}.mp4`);
  const finalSceneClipPath = path.join(paths.assetDir, `scene-${sceneNum}.mp4`);

  if (!existsSync(attemptImagePath)) {
    throw new Error(`Nao achei a tentativa ${attempt} para a cena ${sceneNum} seg ${segmentNum}.`);
  }

  await copyFile(attemptImagePath, finalImagePath);
  renderStaticSceneClip({
    imagePath: finalImagePath,
    videoPath: finalSegmentClipPath,
    durationSeconds: Math.max(1, Number(sceneEntry.duration || 5)),
    profile
  });

  const sceneSegmentEntries = entries
    .filter((entry) => normalizePositiveInt(entry.scene) === sceneNumber)
    .sort((left, right) => normalizePositiveInt(left.segment) - normalizePositiveInt(right.segment));
  const segmentClips = sceneSegmentEntries.map((entry) => {
    const currentSeg = String(normalizePositiveInt(entry.segment)).padStart(2, "0");
    const clipPath = path.join(imagesDir, `scene-${sceneNum}-seg-${currentSeg}.mp4`);
    if (!existsSync(clipPath)) {
      throw new Error(`Ainda falta o clip do segmento ${currentSeg} da cena ${sceneNum}.`);
    }
    return clipPath;
  });

  await concatSceneSegmentClips({
    clips: segmentClips,
    outputPath: finalSceneClipPath,
    tempDir: imagesDir
  });

  const approvedAt = new Date().toISOString();
  const updatedEntries = entries.map((entry) => {
    if (
      normalizePositiveInt(entry.scene) !== sceneNumber ||
      normalizePositiveInt(entry.segment) !== segNumber
    ) {
      return entry;
    }

    return {
      ...entry,
      status: "approved-manual",
      error: null,
      localAudit: {
        ...(isPlainObject(entry.localAudit) ? entry.localAudit : {}),
        passed: true,
        provider: String(entry.localAudit?.provider || "manual-review"),
        summary: `Aprovado manualmente no site a partir do attempt ${attempt}.`,
        reasons: [],
        manualApproval: {
          approvedAt,
          attempt,
          sourcePath: attemptImagePath
        }
      },
      manualApproval: {
        approvedAt,
        attempt,
        sourcePath: attemptImagePath
      }
    };
  });

  await writeSceneManifestEntries(slug, updatedEntries);

  const approvalJob = {
    id: createId(),
    type: "scene-regenerate",
    title: sourceJob.title,
    slug,
    caseId: sourceJob.caseId || null,
    attempt: sourceJob.attempt || null,
    status: "completed",
    createdAt: approvedAt,
    updatedAt: approvedAt,
    completedAt: approvedAt,
    logTail: [
      `[scene-review] cena ${sceneNumber} seg ${segNumber} aprovada manualmente`,
      `[scene-review] attempt ${attempt} -> ${finalImagePath}`,
      `[scene-review] clip final reconstruido em ${finalSceneClipPath}`
    ],
    input: {
      ...sourceJob.input,
      storyboardFile: getRetryStoryboardPathForJob(sourceJob) || resolveEffectiveStoryboardPath(sourceJob),
      sceneNumber,
      sourceJobId: sourceJob.id,
      autoContinueAfterSceneRepair: autoContinue
    },
    outputPath: finalSceneClipPath,
    storyboardPath: getRetryStoryboardPathForJob(sourceJob) || resolveEffectiveStoryboardPath(sourceJob),
    artifactEpochAt: getRecoveryArtifactEpochAt(sourceJob),
    exitCode: 0,
    error: null
  };

  jobs.set(approvalJob.id, approvalJob);
  await finalizeSceneRegenerateJob(approvalJob);
  updateJob(approvalJob, {
    status: "completed",
    completedAt: approvedAt,
    error: null
  });

  return approvalJob;
};

const handleJobScenesRequest = async (_request, response, {params}) => {
  const job = jobs.get(params.id);
  if (!job) { sendJson(response, 404, {error: "Job nao encontrado."}); return; }
  const slug = job.slug || "";
  if (!slug) { sendJson(response, 400, {error: "Job sem slug."}); return; }
  const assetDir = path.join(configuredVideoEngineRoot, "assets", "envato", slug);
  const imagesDir = path.join(assetDir, "_flux2_images");
  let files = [];
  try {
    files = await readdir(imagesDir);
  } catch {
    sendJson(response, 200, {scenes: []});
    return;
  }
  // Build map of scene-seg -> best image file (final pick = no __attempt suffix wins; otherwise highest attempt)
  const pngFiles = files.filter((f) => f.endsWith(".png"));
  const sceneMap = new Map();
  for (const file of pngFiles) {
    // Match scene-NN-seg-NN.png or scene-NN-seg-NN__attempt-N.png
    const finalMatch = file.match(/^scene-(\d+)-seg-(\d+)\.png$/);
    const attemptMatch = file.match(/^scene-(\d+)-seg-(\d+)__attempt-(\d+)\.png$/);
    if (finalMatch) {
      const key = `${finalMatch[1]}-${finalMatch[2]}`;
      // Final (no attempt) always wins
      sceneMap.set(key, {sceneNumber: parseInt(finalMatch[1], 10), segNumber: parseInt(finalMatch[2], 10), file, isFinal: true, attempt: Infinity});
    } else if (attemptMatch) {
      const key = `${attemptMatch[1]}-${attemptMatch[2]}`;
      const attempt = parseInt(attemptMatch[3], 10);
      const existing = sceneMap.get(key);
      if (!existing || (!existing.isFinal && attempt > existing.attempt)) {
        sceneMap.set(key, {sceneNumber: parseInt(attemptMatch[1], 10), segNumber: parseInt(attemptMatch[2], 10), file, isFinal: false, attempt});
      }
    }
  }
  const scenes = Array.from(sceneMap.values())
    .sort((a, b) => a.sceneNumber - b.sceneNumber || a.segNumber - b.segNumber)
    .map(({sceneNumber, segNumber, file}) => ({
      sceneNumber,
      segNumber,
      url: `/api/file?path=${encodeURIComponent(path.join(imagesDir, file))}`
    }));
  sendJson(response, 200, {scenes});
};

const handleJobSceneReviewRequest = async (_request, response, {params}) => {
  const job = jobs.get(params.id);

  if (!job) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  const reviewItems = await getSceneReviewItemsForJob(job);
  sendJson(response, 200, {reviewItems});
};

const handleApproveSceneAttemptRequest = async (request, response, {params} = {}) => {
  const body = await readRequestBody(request);
  let jobId = "";

  try {
    jobId = resolveRequestedJobId({routeJobId: params?.id, bodyJobId: body.jobId});
  } catch (error) {
    sendJson(response, 400, {error: error.message});
    return;
  }

  const selectedJob = jobs.get(jobId);

  if (!selectedJob) {
    sendJson(response, 404, {error: "Job nao encontrado."});
    return;
  }

  if (selectedJob.status !== "failed") {
    sendJson(response, 409, {error: "A aprovacao manual so fica disponivel para jobs falhados."});
    return;
  }

  const sceneNumber = normalizePositiveInt(body.sceneNumber);
  const segNumber = normalizePositiveInt(body.segNumber);
  const attempt = normalizePositiveInt(body.attempt);

  if (!sceneNumber || !segNumber || !attempt) {
    sendJson(response, 400, {error: "sceneNumber, segNumber e attempt sao obrigatorios."});
    return;
  }

  try {
    const approvalJob = await approveSceneReviewAttempt({
      selectedJob,
      sceneNumber,
      segNumber,
      attempt,
      autoContinue: body.autoContinue !== false
    });
    const followUpJob = approvalJob.followUpJobId ? jobs.get(approvalJob.followUpJobId) || null : null;
    sendJson(response, 201, {job: approvalJob, followUpJob});
  } catch (error) {
    sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
  }
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

// ── Simulador handlers ───────────────────────────────────────────────────────

const simuladorDataDir = path.join(projectRoot, ".simulador");

const handleSimuladorGenerate = async (req, res) => {
  const body = await readRequestBody(req);
  const text = String(body.text || "").trim();
  const title = String(body.title || "Simulado").trim().slice(0, 200);
  if (!text) { sendJson(res, 400, {error: "Texto vazio."}); return; }

  const questions = parseQA(text);
  if (!questions.length) { sendJson(res, 400, {error: "Nenhuma questão encontrada."}); return; }

  const batches = splitIntoBatches(questions);
  sendJson(res, 200, {
    message: `${questions.length} questões → ${batches.length} vídeo(s)`,
    questionCount: questions.length,
    batchCount: batches.length,
    jobs: batches.map((b, i) => ({
      id: `pending-${i}`,
      title: batches.length > 1 ? `${title} (Parte ${i + 1}/${batches.length})` : title,
      questionCount: b.length,
      status: "processing"
    }))
  });

  // Fire and forget — run in background
  runSimulador({text, title}).catch((err) => {
    process.stderr.write(`[simulador] Erro: ${err.message}\n`);
  });
};

const handleSimuladorJobs = async (_req, res) => {
  const jobs = await loadSimuladorJobs();
  sendJson(res, 200, jobs);
};

const handleSimuladorVideo = async (req, res, {params}) => {
  const jobId = params.id;
  const jobs = await loadSimuladorJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job || !job.videoPath || !existsSync(job.videoPath)) {
    sendJson(res, 404, {error: "Vídeo não encontrado."});
    return;
  }
  await serveStaticFile(req, res, job.videoPath);
};

const handleSimuladorDeleteJob = async (_req, res, {params}) => {
  const jobId = params.id;
  const jobs = await loadSimuladorJobs();
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) { sendJson(res, 404, {error: "Job não encontrado."}); return; }

  const job = jobs[idx];
  // Remove video file
  if (job.videoPath && existsSync(job.videoPath)) {
    try { await unlink(job.videoPath); } catch { /* ignore */ }
  }
  // Remove run dir
  const runDir = path.join(simuladorDataDir, "runs", jobId);
  if (existsSync(runDir)) {
    try { await rm(runDir, {recursive: true, force: true}); } catch { /* ignore */ }
  }

  jobs.splice(idx, 1);
  await saveSimuladorJobs(jobs);
  sendJson(res, 200, {ok: true});
};

// ── Route table ──────────────────────────────────────────────────────────────

addRoute("POST", "/api/simulador/generate",                  handleSimuladorGenerate);
addRoute("GET",  "/api/simulador/jobs",                      handleSimuladorJobs);
addRoute("GET",  "/api/simulador/video/:id",                 handleSimuladorVideo);
addRoute("DELETE", "/api/simulador/jobs/:id",                handleSimuladorDeleteJob);

addRoute("GET",  "/api/config",                              (_req, res) => handleConfigRequest(res));
addRoute("GET",  "/api/health",                              handleHealthRequest);
addRoute("GET",  "/api/openapi.yaml",                        handleOpenApiSpecRequest);
addRoute("GET",  "/api/docs/:name",                          handleRuntimeDocRequest);
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
addRoute("POST", "/api/videos/hook-variants",                handleHookVariantsRequest);
addRoute("POST", "/api/videos/publish-status",               handlePublishStatusRequest);
addRoute("POST", "/api/videos/:slug/reset-publish",          handleResetPublishRequest);
addRoute("GET",  "/api/jobs/:id/scenes",                     handleJobScenesRequest);
addRoute("GET",  "/api/jobs/:id/scene-review",               handleJobSceneReviewRequest);
addRoute("POST", "/api/jobs/:id/retry-from-storyboard",      handleRetryFailedJobRequest);
addRoute("POST", "/api/jobs/:id/regenerate-missing-scene",   handleRegenerateMissingSceneRequest);
addRoute("POST", "/api/jobs/:id/approve-scene-attempt",      handleApproveSceneAttemptRequest);
addRoute("POST", "/api/jobs/:id/generate-audio",             handleGenerateAudioRequest);
addRoute("POST", "/api/jobs/:id/render-only",                handleRenderOnlyRequest);
addRoute("POST", "/api/jobs/:id/validate",                   handleValidateOnlyRequest);
addRoute("POST", "/api/jobs/:id/start",                      handleStartQueuedJobRequest);
addRoute("POST", "/api/jobs/:id/force-fail",                 handleForceFailJobRequest);
addRoute("POST", "/api/jobs/:id/resume",                     handleJobResumeRequest);

const server = http.createServer(async (request, response) => {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const requestId = createId();
  const requestStartedAt = Date.now();

  response.setHeader("X-Request-Id", requestId);
  applySecurityHeaders(request, response);

  response.on("finish", () => {
    logJsonLine("info", "http_request", {
      requestId,
      method,
      pathname,
      statusCode: response.statusCode,
      durationMs: Date.now() - requestStartedAt,
      remoteAddress: getRemoteAddress(request),
      userAgent: String(request.headers["user-agent"] || "").slice(0, 200)
    });
  });

  if (!checkBasicAuth(request)) {
    response.writeHead(401, {
      "WWW-Authenticate": `Basic realm="${BASIC_AUTH_REALM}"`,
      "Content-Type": "text/plain"
    });
    response.end("Unauthorized");
    logJsonLine("warn", "auth_denied", {
      requestId,
      method,
      pathname,
      remoteAddress: getRemoteAddress(request)
    });
    return;
  }

  try {
    // ── Static files ───────────────────────────────────────────────────────
    if (method === "GET") {
      if (pathname === "/") {
        await serveStaticFile(request, response, path.join(publicDir, "index.html"));
        return;
      }
      if (pathname === "/static" || pathname === "/static/") {
        await serveStaticFile(request, response, path.join(publicDir, "static", "index.html"));
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
    logJsonLine("error", "http_request_failed", {
      requestId,
      method,
      pathname,
      remoteAddress: getRemoteAddress(request),
      error: serializeError(error)
    });
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Erro interno."
    });
  }
});

process.on("unhandledRejection", (reason) => {
  logJsonLine("error", "unhandled_rejection", {error: serializeError(reason)});
  process.stderr.write(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}\n`);
});

process.on("uncaughtException", (error) => {
  logJsonLine("error", "uncaught_exception", {error: serializeError(error)});
  process.stderr.write(`Uncaught exception: ${error instanceof Error ? error.stack : error}\n`);
});

const gracefulShutdown = async () => {
  logJsonLine("info", "server_shutdown_started", {
    activeStreams: streams.size,
    activeJobs: Array.from(jobs.values()).filter((job) => Number(job?.processId) > 0).length,
    role: APP_ROLE
  });
  process.stdout.write("\nEncerrando servidor...\n");

  if (jobsDiskSyncTimer) {
    clearInterval(jobsDiskSyncTimer);
    jobsDiskSyncTimer = null;
  }

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
    if (RUN_HTTP_SERVER) {
      server.close(() => process.exit(0));
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(1), 5000);
  });
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

server.on("error", (error) => {
  logJsonLine("error", "server_listen_failed", {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    error: serializeError(error)
  });
  if (error.code === "EADDRINUSE") {
    process.stderr.write(`ERRO: Porta ${DEFAULT_PORT} ja esta em uso. Encerre o outro processo ou mude WEB_PORT.\n`);
  } else {
    process.stderr.write(`ERRO ao iniciar servidor: ${error.message}\n`);
  }

  process.exit(1);
});

const cleanupTmpOnStartup = async () => {
  try {
    const tmpDir = path.join(projectRoot, ".tmp", "system");
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const entries = await readdir(tmpDir).catch(() => []);
    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = path.join(tmpDir, entry);
      const s = await stat(fullPath).catch(() => null);
      if (s && Date.now() - s.mtimeMs > ONE_DAY) {
        await rm(fullPath, {recursive: true, force: true}).catch(() => {});
        cleaned += 1;
      }
    }
    if (cleaned > 0) process.stderr.write(`Limpeza: ${cleaned} itens stale removidos de .tmp/system/\n`);
  } catch {}
};

const startRoleRuntime = async () => {
  await cleanupTmpOnStartup();
  startJobsDiskSyncLoop();

  if (RUN_QUEUE_WORKER) {
    await syncJobsFromDisk({broadcastChanges: false}).catch(() => ({changed: 0}));
    if (AUTO_START_QUEUED_JOBS) {
      await Promise.all([
        startQueueWorker("preview"),
        startQueueWorker("heavy")
      ]);
    }
    logJsonLine("info", "queue_worker_ready", {
      role: APP_ROLE,
      queueMode: AUTO_START_QUEUED_JOBS ? "auto" : "manual",
      previewQueueLength: getQueueLengths().previewQueueLength,
      heavyQueueLength: getQueueLengths().heavyQueueLength
    });
  }
};

if (RUN_HTTP_SERVER) {
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    void startRoleRuntime();
    process.stdout.write(
      `UI local pronta em http://${DEFAULT_HOST}:${DEFAULT_PORT}\nExportando videos em ${postarRoot}\n`
    );
    logJsonLine("info", "server_listening", {
      role: APP_ROLE,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      postarRoot,
      authSource: BASIC_AUTH_PASSWORD_SOURCE
    });
  });
} else {
  void startRoleRuntime().then(() => {
    process.stdout.write(`Worker pronto. Exportando videos em ${postarRoot}\n`);
    logJsonLine("info", "worker_running", {
      role: APP_ROLE,
      postarRoot,
      authSource: BASIC_AUTH_PASSWORD_SOURCE
    });
  });
}
