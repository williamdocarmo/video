/**
 * @module job-state
 * Job state inspection — checklist, stage, RCA, taxonomy, recommended actions.
 * Extracted from web/server.mjs. Uses init() for dependency injection.
 */
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import path from "node:path";
import {analyzeFailureText} from "../../scripts/lib/scene-failure-taxonomy.mjs";
import {normalizePositiveInt, toTimestampMs, toIsoNow} from "./utils.mjs";

const MIN_VALID_SCENE_CLIP_BYTES = 1024;
const ARTIFACT_FRESHNESS_TOLERANCE_MS = 1500;

/** @type {() => Map} */
let _getJobs = () => new Map();
/** @type {(slug: string) => object} */
let _getRunPaths = () => ({});
/** @type {(job: object) => boolean} */
let _canRetryFailedJobFromStoryboard = () => false;

/**
 * Inject runtime dependencies.
 * @param {object} deps
 * @param {function} deps.getRunPaths
 * @param {function} deps.getJobs - returns the jobs Map
 * @param {function} deps.canRetryFailedJobFromStoryboard
 */
export const init = ({getRunPaths, getJobs, canRetryFailedJobFromStoryboard}) => {
  if (getRunPaths) _getRunPaths = getRunPaths;
  if (getJobs) _getJobs = getJobs;
  if (canRetryFailedJobFromStoryboard) _canRetryFailedJobFromStoryboard = canRetryFailedJobFromStoryboard;
};

// ── Artifact inspection helpers ──────────────────────────────────────

/** @param {object|string} jobOrSlug */
export const getArtifactEpochMs = (jobOrSlug) => {
  if (!jobOrSlug || typeof jobOrSlug === "string") {
    return null;
  }
  return (
    toTimestampMs(jobOrSlug.artifactEpochAt) ||
    toTimestampMs(jobOrSlug.startedAt) ||
    toTimestampMs(jobOrSlug.createdAt)
  );
};

export const isPreviewStoryboardSlug = (slug) => String(slug || "").trim().endsWith("-preview");

export const getPreviewStoryboardSlug = (slug) => {
  const normalized = String(slug || "").trim();
  if (!normalized || normalized.endsWith("-preview")) return "";
  return `${normalized}-preview`;
};

/** @returns {string[]} */
export const getStoryboardPathCandidates = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string"
    ? String(jobOrSlug || "").trim()
    : String(jobOrSlug?.slug || "").trim();
  if (!slug) return [];

  const candidates = [];
  if (typeof jobOrSlug !== "string") {
    candidates.push(String(jobOrSlug?.input?.storyboardFile || "").trim());
    candidates.push(String(jobOrSlug?.storyboardPath || "").trim());
  }
  candidates.push(_getRunPaths(slug).storyboardPath);
  const previewSlug = getPreviewStoryboardSlug(slug);
  if (previewSlug) candidates.push(_getRunPaths(previewSlug).storyboardPath);
  return [...new Set(candidates.filter(Boolean).map((c) => path.resolve(c)))];
};

export const findExistingStoryboardPath = (jobOrSlug, {allowPreviewFallback = true} = {}) => {
  const slug = typeof jobOrSlug === "string"
    ? String(jobOrSlug || "").trim()
    : String(jobOrSlug?.slug || "").trim();
  const previewStoryboardPath = isPreviewStoryboardSlug(slug)
    ? ""
    : path.resolve(_getRunPaths(getPreviewStoryboardSlug(slug)).storyboardPath);

  for (const candidate of getStoryboardPathCandidates(jobOrSlug)) {
    if (!allowPreviewFallback && previewStoryboardPath && path.resolve(candidate) === previewStoryboardPath) continue;
    if (existsSync(candidate)) return candidate;
  }
  return "";
};

export const isUsableSceneClipPath = (targetPath) => {
  try {
    const details = statSync(targetPath);
    return details.isFile() && details.size >= MIN_VALID_SCENE_CLIP_BYTES;
  } catch { return false; }
};

export const isFreshArtifactForJob = (targetPath, jobOrSlug) => {
  if (!existsSync(targetPath)) return false;
  const epochMs = getArtifactEpochMs(jobOrSlug);
  if (!epochMs) return true;
  try {
    return statSync(targetPath).mtimeMs + ARTIFACT_FRESHNESS_TOLERANCE_MS >= epochMs;
  } catch { return false; }
};

export const isReadySceneClipForJob = (targetPath, jobOrSlug) =>
  isUsableSceneClipPath(targetPath) &&
  (typeof jobOrSlug === "string" || isFreshArtifactForJob(targetPath, jobOrSlug));

export const readJsonSyncIfExists = (targetPath) => {
  try { return JSON.parse(readFileSync(targetPath, "utf8")); }
  catch { return null; }
};

export const getArtifactSnapshot = (targetPath) => {
  try {
    const details = statSync(targetPath);
    if (!details.isFile()) return null;
    return {size: details.size, mtimeMs: details.mtimeMs};
  } catch { return null; }
};

export const doesQaReportMatchOutputArtifact = ({report, slug, outPath}) => {
  const snapshot = getArtifactSnapshot(outPath);
  if (!snapshot) return false;

  const reportedSlug = String(report?.slug || report?.qa?.slug || "").trim();
  if (reportedSlug && reportedSlug !== slug) return false;

  const reportedMtimeMs = Number(
    report?.qa?.outputMtimeMs ??
    report?.validationMeta?.outputMtimeMs ??
    report?.validation?.metrics?.outputMtimeMs
  );
  if (Number.isFinite(reportedMtimeMs)) {
    return Math.abs(reportedMtimeMs - snapshot.mtimeMs) <= ARTIFACT_FRESHNESS_TOLERANCE_MS;
  }

  const reportedSize = Number(
    report?.qa?.outputSizeBytes ??
    report?.validationMeta?.outputSizeBytes ??
    report?.validation?.checks?.outputSizeBytes
  );
  if (Number.isFinite(reportedSize) && reportedSize > 0) return reportedSize === snapshot.size;
  return false;
};

// ── Storyboard resolution ────────────────────────────────────────────

export const resolveEffectiveStoryboardPath = (jobOrSlug) => {
  const existingPath = findExistingStoryboardPath(jobOrSlug);
  if (existingPath) return existingPath;
  const slug = typeof jobOrSlug === "string"
    ? String(jobOrSlug || "").trim()
    : String(jobOrSlug?.slug || "").trim();
  if (!slug) return "";
  return getStoryboardPathCandidates(jobOrSlug)[0] || path.resolve(_getRunPaths(slug).storyboardPath);
};

export const shouldAllowPreviewStoryboardFallback = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string"
    ? String(jobOrSlug || "").trim()
    : String(jobOrSlug?.slug || "").trim();
  return isPreviewStoryboardSlug(slug) || Boolean(jobOrSlug?.input?.previewOnly);
};

export const resolveOperationalStoryboardPath = (jobOrSlug) => {
  const allowPreviewFallback = shouldAllowPreviewStoryboardFallback(jobOrSlug);
  const existingPath = findExistingStoryboardPath(jobOrSlug, {allowPreviewFallback});
  if (existingPath) return existingPath;
  const slug = typeof jobOrSlug === "string"
    ? String(jobOrSlug || "").trim()
    : String(jobOrSlug?.slug || "").trim();
  if (!slug) return "";
  return path.resolve(_getRunPaths(slug).storyboardPath);
};

// ── Scene stats ──────────────────────────────────────────────────────

/** @returns {Set<number>} */
export const getFreshSceneNumbers = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string" ? jobOrSlug : String(jobOrSlug?.slug || "").trim();
  if (!slug) return new Set();
  const {assetDir} = _getRunPaths(slug);
  if (!existsSync(assetDir)) return new Set();

  const sceneNumbers = new Set();
  for (const entry of readdirSync(assetDir)) {
    const match = /^scene-(\d+)\.mp4$/i.exec(entry);
    if (!match) continue;
    const sceneNumber = normalizePositiveInt(match[1]);
    if (!sceneNumber) continue;
    const scenePath = path.join(assetDir, entry);
    if (isReadySceneClipForJob(scenePath, jobOrSlug)) sceneNumbers.add(sceneNumber);
  }
  return sceneNumbers;
};

export const getSceneCompletionStats = (jobOrSlug) => {
  const slug = typeof jobOrSlug === "string" ? jobOrSlug : String(jobOrSlug?.slug || "").trim();
  const storyboardPath = resolveOperationalStoryboardPath(jobOrSlug);
  const storyboard = readJsonSyncIfExists(storyboardPath);
  const sceneCount = Array.isArray(storyboard?.scenes) ? storyboard.scenes.length : 0;
  const freshSceneNumbers = getFreshSceneNumbers(jobOrSlug);
  let existingSceneCount = 0;
  let firstMissingSceneNumber = null;

  for (let index = 0; index < sceneCount; index += 1) {
    const sceneNumber = index + 1;
    if (freshSceneNumbers.has(sceneNumber)) { existingSceneCount += 1; continue; }
    if (firstMissingSceneNumber === null) firstMissingSceneNumber = sceneNumber;
  }

  return {
    storyboardPath, storyboard, sceneCount, existingSceneCount,
    missingSceneCount: Math.max(0, sceneCount - existingSceneCount),
    firstMissingSceneNumber: normalizePositiveInt(firstMissingSceneNumber),
    freshSceneNumbers: Array.from(freshSceneNumbers).sort((l, r) => l - r)
  };
};

export const getMissingSceneHintFromJob = (job) => {
  if (!job || String(job.status || "").trim().toLowerCase() !== "failed") return null;
  const haystack = []
    .concat(Array.isArray(job.logTail) ? job.logTail : [])
    .concat([job.error, job.failureSummary, job.rca?.summary])
    .filter(Boolean).join("\n");

  const incompleteMatch = /incompleta nas cenas:\s*([0-9,\s]+)/i.exec(haystack);
  if (incompleteMatch?.[1]) {
    const firstValue = incompleteMatch[1].split(",").map((v) => normalizePositiveInt(v)).find((v) => v !== null);
    if (firstValue !== undefined) return firstValue ?? null;
  }
  const singleMatch = /falta a cena\s+(\d+)/i.exec(haystack);
  if (singleMatch?.[1]) return normalizePositiveInt(singleMatch[1]);
  return null;
};

export const hasBasicResumeArtifacts = (job) => {
  if (job.type !== "generate" || job.status !== "failed" || job.input?.previewOnly) return false;
  const paths = _getRunPaths(job.slug);
  const sceneStats = getSceneCompletionStats(job);
  if (
    !existsSync(sceneStats.storyboardPath || paths.storyboardPath) ||
    !isFreshArtifactForJob(paths.voiceoverPath, job) ||
    !isFreshArtifactForJob(paths.publicAudioPath, job)
  ) return false;
  return sceneStats.sceneCount > 0 && sceneStats.missingSceneCount === 0;
};

export const getFirstMissingSceneNumber = (job) => {
  if (!job || job.input?.previewOnly) return null;
  return getSceneCompletionStats(job).firstMissingSceneNumber;
};

// ── Recovery helpers ─────────────────────────────────────────────────

export const getReferencedRecoveryJobIds = (job) =>
  [job?.input?.sourceJobId, job?.input?.resumeFromJobId, job?.input?.approvedFromJobId]
    .map((v) => String(v || "").trim()).filter(Boolean);

export const getLatestGenerateJobForSlug = ({slug, title = "", channel = "", maxCreatedAtMs = Number.POSITIVE_INFINITY} = {}) => {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return null;
  const normalizedTitle = String(title || "").trim();
  const normalizedChannel = String(channel || "").trim();

  return (
    Array.from(_getJobs().values())
      .filter((c) => {
        if (c.type !== "generate" || c.slug !== normalizedSlug) return false;
        if (normalizedChannel && String(c.input?.channel || "").trim() !== normalizedChannel) return false;
        if (normalizedTitle && String(c.title || "").trim() !== normalizedTitle) return false;
        return (toTimestampMs(c.createdAt) || 0) <= maxCreatedAtMs;
      })
      .sort((l, r) => (toTimestampMs(r.createdAt) || 0) - (toTimestampMs(l.createdAt) || 0))[0] || null
  );
};

export const getRecoverySourceJob = (job) => {
  if (!job) return null;
  if (job.type === "generate" && job.input?.previewOnly !== true) return job;

  const visited = new Set([String(job.id || "")]);
  const queue = [...getReferencedRecoveryJobIds(job)];
  const jobs = _getJobs();
  let previewFallback = null;

  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const referenced = jobs.get(id);
    if (!referenced) continue;
    if (referenced.type === "generate") {
      if (referenced.input?.previewOnly !== true) return referenced;
      previewFallback ||= referenced;
    }
    queue.push(...getReferencedRecoveryJobIds(referenced));
  }

  const latestGenerateJob = getLatestGenerateJobForSlug({
    slug: job.slug, title: job.title, channel: job.input?.channel,
    maxCreatedAtMs: toTimestampMs(job.createdAt) || Number.POSITIVE_INFINITY
  });

  if (latestGenerateJob?.input?.previewOnly !== true) return latestGenerateJob;
  return previewFallback || latestGenerateJob || job;
};

export const getRecoveryArtifactEpochAt = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  return (
    sourceJob?.artifactEpochAt || sourceJob?.startedAt || sourceJob?.createdAt ||
    (typeof job !== "string" ? (job?.artifactEpochAt || job?.startedAt || job?.createdAt) : null) ||
    toIsoNow()
  );
};

// ── QA report ────────────────────────────────────────────────────────

export const getQaReportForSlug = (slug) => {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return null;
  const latestGenerateJob = getLatestGenerateJobForSlug({slug: normalizedSlug});
  if (latestGenerateJob) return getQaReportForJob(latestGenerateJob);

  const paths = _getRunPaths(normalizedSlug);
  for (const reportPath of [paths.agentReportPath, paths.orchestrationReportPath]) {
    const report = readJsonSyncIfExists(reportPath);
    if (report && doesQaReportMatchOutputArtifact({report, slug: normalizedSlug, outPath: paths.outPath})) return report;
  }
  return null;
};

export const getQaReportForJob = (jobOrSlug) => {
  if (!jobOrSlug || typeof jobOrSlug === "string") return getQaReportForSlug(jobOrSlug);
  const slug = String(jobOrSlug.slug || "").trim();
  if (!slug) return null;
  const paths = _getRunPaths(slug);

  for (const reportPath of [paths.agentReportPath, paths.orchestrationReportPath]) {
    if (!isFreshArtifactForJob(reportPath, jobOrSlug)) continue;
    const report = readJsonSyncIfExists(reportPath);
    if (report && doesQaReportMatchOutputArtifact({report, slug, outPath: paths.outPath})) return report;
  }
  return null;
};

export const isQaPassedReport = (report) =>
  Boolean(report?.qa && typeof report.qa === "object" && report.qa.passed === true);

export const isQaPassedForSlug = (slug) => isQaPassedReport(getQaReportForSlug(slug));
export const isQaPassedForJob = (jobOrSlug) => isQaPassedReport(getQaReportForJob(jobOrSlug));

// ── Capability checks ────────────────────────────────────────────────

export const canPrepareAudioForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) return false;
  const paths = _getRunPaths(sourceJob.slug);
  const sceneStats = getSceneCompletionStats(sourceJob);
  const audioAlreadyReady =
    isFreshArtifactForJob(paths.voiceoverPath, sourceJob) &&
    isFreshArtifactForJob(paths.publicAudioPath, sourceJob);
  return (
    sceneStats.sceneCount > 0 && sceneStats.missingSceneCount === 0 &&
    existsSync(sceneStats.storyboardPath || paths.storyboardPath) && !audioAlreadyReady
  );
};

export const canRenderOnlyForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) return false;
  const paths = _getRunPaths(sourceJob.slug);
  const sceneStats = getSceneCompletionStats(sourceJob);
  return (
    sceneStats.sceneCount > 0 && sceneStats.missingSceneCount === 0 &&
    existsSync(sceneStats.storyboardPath || paths.storyboardPath) &&
    isFreshArtifactForJob(paths.renderPropsPath, sourceJob) &&
    isFreshArtifactForJob(paths.publicAudioPath, sourceJob)
  );
};

export const canValidateOnlyForJob = (job) => {
  const sourceJob = getRecoverySourceJob(job);
  if (!sourceJob?.slug || sourceJob.input?.previewOnly) return false;
  const freshnessReference = job && typeof job !== "string" ? job : sourceJob;
  return isFreshArtifactForJob(_getRunPaths(sourceJob.slug).outPath, freshnessReference);
};

// ── Failure analysis ─────────────────────────────────────────────────

export const getFailureStage = (job) => {
  const tail = Array.isArray(job?.logTail) ? job.logTail : [];
  const joined = tail.join("\n").toLowerCase();
  if (joined.includes("timestamps palavra-a-palavra") || joined.includes("stt part offset") || joined.includes("karaoke")) return "timestamp-extraction";
  if (joined.includes("a renderizar no remotion") || joined.includes("remotion")) return "render";
  if (joined.includes("a validar o render") || joined.includes("[qa]")) return "qa";
  if (joined.includes("gera voz") || joined.includes("voiceover")) return "audio";
  return null;
};

export const getFailureSummary = (job) => {
  const error = String(job?.error || "").trim();
  const stage = getFailureStage(job);
  if (!error && !stage) return "";
  const hints = [];
  if (stage) hints.push(`etapa=${stage}`);
  if (error) hints.push(`erro=${error}`);
  return hints.join(" | ");
};

const FAILURE_LOW_SIGNAL_PATTERNS = [
  /^[\[\]{}(),:]+$/,
  /^"[^"]+":\s*(?:true|false|null|-?\d+(?:\.\d+)?|".*")[,]?$/i,
  /^bundling \d+%$/i,
  /^copying public dir /i,
  /^rendered \d+\/\d+/i,
  /^composition\s+/i,
  /^codec\s+/i,
  /^output\s+/i,
  /^concurrency\s+/i,
  /^getting composition$/i,
  /^frame=\s*\d+/i,
  /^\[vertex-image\] waiting /i,
  /^\[vertex-assets\] done:/i,
  /^peak mlx memory:/i
];

const FAILURE_HIGH_SIGNAL_PATTERNS = [
  /\berro\b/i, /\berror\b/i, /\benoent\b/i, /\bfailed\b/i, /\bfalhou\b/i,
  /\bexception\b/i, /\btraceback\b/i, /\breprovou\b/i, /\bnot found\b/i,
  /\bno such file\b/i, /\bcannot\b/i, /\binvalid\b/i, /\bmissing\b/i, /\bunhandled\b/i
];

export const normalizeFailureLine = (line) => String(line || "").replace(/^\[stderr\]\s*/, "").trim();

export const isLowSignalFailureLine = (line) => {
  const normalized = normalizeFailureLine(line);
  return !normalized || FAILURE_LOW_SIGNAL_PATTERNS.some((p) => p.test(normalized));
};

export const getMostRelevantFailureLogLine = (job) => {
  const lines = Array.isArray(job?.logTail) ? [...job.logTail].reverse() : [];
  const stderrLines = lines.filter((l) => String(l || "").startsWith("[stderr]"));

  for (const pool of [stderrLines, lines]) {
    const highSignal = pool.find((l) => {
      const n = normalizeFailureLine(l);
      return n && !isLowSignalFailureLine(n) && FAILURE_HIGH_SIGNAL_PATTERNS.some((p) => p.test(n));
    });
    if (highSignal) return highSignal;
  }
  for (const pool of [stderrLines, lines]) {
    const fallback = pool.find((l) => !isLowSignalFailureLine(l));
    if (fallback) return fallback;
  }
  return "";
};

export const getProcessFailureMessage = (job, fallbackMessage) =>
  normalizeFailureLine(job?.terminationReason) ||
  normalizeFailureLine(getMostRelevantFailureLogLine(job)) ||
  fallbackMessage;

// ── State & stage ────────────────────────────────────────────────────

const JOB_STATE_META = {
  queued: {label: "Na fila", severity: "neutral", terminal: false},
  running: {label: "Em execucao", severity: "info", terminal: false},
  completed: {label: "Concluido", severity: "success", terminal: true},
  failed: {label: "Falhou", severity: "danger", terminal: true}
};

const JOB_STAGE_LABELS = {
  queue: "Fila", preview: "Preview", storyboard: "Storyboard",
  audio: "Audio", "timestamp-extraction": "Timestamps",
  render: "Render", qa: "QA", resume: "Retomada", pipeline: "Pipeline",
  completed: "Concluido", "video-published": "Publicado",
  "video-draft": "Rascunho", "video-ready": "Pronto"
};

export const normalizeSignalText = (job) =>
  [job?.error || "", Array.isArray(job?.logTail) ? job.logTail.slice(-12).join("\n") : "", job?.status || "", job?.type || ""]
    .join("\n").toLowerCase();

export const inferJobStageValue = (job) => {
  const status = String(job?.status || "").trim().toLowerCase();
  const signal = normalizeSignalText(job);
  if (status === "queued") return "queue";
  if (status === "completed") return job?.input?.previewOnly ? "preview" : "completed";
  if (status === "failed") return getFailureStage(job) || "pipeline";
  if (signal.includes("[resume]") || signal.includes("retomando")) return "resume";
  if (signal.includes("preview-only") || signal.includes("storyboard preview")) return "preview";
  if (signal.includes("timestamps palavra-a-palavra") || signal.includes("stt part offset") || signal.includes("karaoke")) return "timestamp-extraction";
  if (signal.includes("a validar o render") || signal.includes("[qa]")) return "qa";
  if (signal.includes("a renderizar no remotion") || signal.includes("remotion")) return "render";
  if (signal.includes("gera voz") || signal.includes("voiceover") || signal.includes("tts")) return "audio";
  if (signal.includes("storyboard") || signal.includes("roteiro")) return "storyboard";
  return "pipeline";
};

export const getStageLabel = (value, fallback = "Pipeline") => JOB_STAGE_LABELS[value] || fallback;

/** @param {object} job */
export const getJobStateInfo = (job) => {
  const status = String(job?.status || "queued").trim().toLowerCase();
  const meta = JOB_STATE_META[status] || {label: status || "desconhecido", severity: "neutral", terminal: false};
  return {value: status, label: meta.label, severity: meta.severity, terminal: Boolean(meta.terminal)};
};

/** @param {object} job */
export const getJobStageInfo = (job) => {
  if (job?.stageValue) {
    return {
      value: job.stageValue, label: getStageLabel(job.stageValue),
      source: job.stageSource || "system", confidence: job.stageConfidence || "high"
    };
  }
  const value = inferJobStageValue(job);
  const status = String(job?.status || "").trim().toLowerCase();
  const source = status === "failed" ? "failure-log"
    : status === "completed" ? "status"
    : Array.isArray(job?.logTail) && job.logTail.length > 0 ? "log" : "status";
  return {value, label: getStageLabel(value), source, confidence: source === "log" || source === "failure-log" ? "medium" : "low"};
};

// ── RCA & taxonomy ───────────────────────────────────────────────────

/** @param {object} job */
export const getJobRca = (job, stageInfo = getJobStageInfo(job)) => {
  const error = String(job?.error || "").trim();
  const signal = normalizeSignalText(job);
  const causes = [];
  const evidence = [];
  if (error) evidence.push(error);
  const latestLog = Array.isArray(job?.logTail) ? job.logTail.at(-1) || "" : "";
  if (latestLog) evidence.push(latestLog);

  if (signal.includes("timeout") || signal.includes("etimedout")) causes.push("timeout");
  if (signal.includes("enoent") || signal.includes("no such file") || signal.includes("falta o clip") || signal.includes("ausente")) causes.push("missing-artifact");
  if (signal.includes("ffmpeg") || signal.includes("ffprobe")) causes.push("media-tooling");
  if (signal.includes("gemini") || signal.includes("openrouter") || signal.includes("google api") || signal.includes("llm")) causes.push("provider");

  if (stageInfo.value === "audio") causes.push("audio-generation");
  else if (stageInfo.value === "render") causes.push("rendering");
  else if (stageInfo.value === "timestamp-extraction") causes.push("timestamp-alignment");
  else if (stageInfo.value === "qa") causes.push("quality-gate");
  else if (stageInfo.value === "resume") causes.push("resume-rebuild");
  else if (stageInfo.value === "storyboard") causes.push("storyboard-generation");

  return {
    summary: error || getFailureSummary(job) || stageInfo.label || "Sem detalhe disponivel",
    causes: [...new Set(causes)], evidence: evidence.slice(0, 3),
    confidence: error || causes.length > 0 ? "medium" : "low"
  };
};

/** @param {object} job */
export const getJobFailureTaxonomy = (job) => {
  const input = [job?.error, job?.failureSummary, job?.rca?.summary]
    .filter((v) => String(v || "").trim()).join("\n");
  if (!input) return null;
  const analysis = analyzeFailureText(input);
  return {
    primaryCategory: analysis.primaryCategory, label: analysis.label,
    confidence: analysis.confidence,
    repairMode: analysis.repairStrategy?.mode || null,
    scope: analysis.repairStrategy?.scope || null,
    categories: Array.isArray(analysis.secondaryCategories) ? analysis.secondaryCategories.map((i) => i.category) : [],
    evidence: Array.isArray(analysis.evidence) ? analysis.evidence.slice(0, 3) : []
  };
};

// ── Recommended action ───────────────────────────────────────────────

/** @param {object} job */
export const getJobRecommendedAction = (job, stageInfo = getJobStageInfo(job), rca = getJobRca(job, stageInfo)) => {
  const stepChecklist = getJobStepChecklist(job);
  const firstMissingSceneNumber = normalizePositiveInt(stepChecklist.firstMissingSceneNumber);
  const stepMap = Object.fromEntries(
    (Array.isArray(stepChecklist.steps) ? stepChecklist.steps : []).map((s) => [s.key, s])
  );
  const sourceJob = getRecoverySourceJob(job);
  const isPreview = Boolean(sourceJob?.input?.previewOnly || job?.input?.previewOnly);

  if (job?.status === "completed") return {value: "review-output", label: "Revisar saida", details: "Abrir o arquivo final e validar se o resultado esta pronto para uso.", urgency: "low"};
  if (job?.status === "queued") return {value: "wait-in-queue", label: "Aguardar fila", details: "O job ainda nao iniciou.", urgency: "low"};
  if (job?.status === "running") return {value: "wait-for-current-step", label: "Acompanhar etapa atual", details: "O job ainda esta em execucao; acompanhe o log antes de disparar qualquer reparo.", urgency: "low"};

  if (job?.status === "failed" && !isPreview && firstMissingSceneNumber !== null) {
    return {value: "regenerate-missing-scene", label: `Regenerar cena ${firstMissingSceneNumber}`, details: `A primeira cena faltante detectada e a ${firstMissingSceneNumber}; reparar essa cena e mais seguro do que refazer tudo.`, urgency: "high"};
  }
  if (!isPreview && stepMap.assets?.status === "completed" && canPrepareAudioForJob(job) && stepMap.audio?.status !== "completed") {
    return {value: "generate-audio", label: "Gerar audio", details: "As cenas ja existem; o proximo passo correto e reconstruir voz, timings e props sem refazer imagens.", urgency: "high"};
  }
  if (!isPreview && stepMap.assets?.status === "completed" && stepMap.audio?.status === "completed" && canRenderOnlyForJob(job) && stepMap.render?.status !== "completed") {
    return {value: "render-only", label: "Renderizar video", details: "Storyboard, cenas e audio ja existem; vale renderizar sem repetir etapas anteriores.", urgency: "high"};
  }
  if (!isPreview && canValidateOnlyForJob(job) && stepMap.qa?.status !== "completed") {
    return {value: "validate-only", label: "Validar video", details: "O MP4 ja existe; rode a QA final sem reenfileirar a pipeline inteira.", urgency: "medium"};
  }
  if (job?.type === "generate" && job?.status === "failed" && hasBasicResumeArtifacts(job)) {
    return {value: "resume-rebuild", label: "Retomar com artefatos", details: "Storyboard, audio e cenas ja existem; a retomada e mais eficiente do que gerar do zero.", urgency: "high"};
  }
  if (job?.type === "generate" && job?.status === "failed" && _canRetryFailedJobFromStoryboard(job)) {
    return {value: "retry-from-storyboard", label: "Refazer a partir do storyboard", details: "Existe storyboard reaproveitavel para reenfileirar sem perder o contexto.", urgency: "high"};
  }
  if (stageInfo.value === "audio") return {value: "inspect-audio", label: "Revisar voz e TTS", details: "Conferir credenciais, voz selecionada e o passo de voiceover antes de reenfileirar.", urgency: "high"};
  if (stageInfo.value === "render") return {value: "inspect-render", label: "Revisar render", details: "Abrir o log do Remotion e validar assets, bitrate e timeout.", urgency: "high"};
  if (stageInfo.value === "timestamp-extraction") return {value: "inspect-timestamps", label: "Rever alinhamento de falas", details: "O problema parece estar nos timestamps ou no karaoke; vale inspecionar o texto-base e a segmentacao.", urgency: "medium"};
  if (stageInfo.value === "qa") return {value: "inspect-quality", label: "Revisar QA", details: "A etapa final de validacao sinalizou problema; revisar storyboard e saida final.", urgency: "medium"};
  if (stageInfo.value === "resume") return {value: "resume-rebuild", label: "Retomar com artefatos", details: "Os artefatos reaproveitaveis parecem presentes; vale retomar em vez de gerar do zero.", urgency: "medium"};

  const primaryCause = rca.causes[0] || "pipeline";
  return {
    value: primaryCause === "missing-artifact" ? "inspect-artifacts" : "inspect-log",
    label: primaryCause === "missing-artifact" ? "Revisar artefatos ausentes" : "Revisar log e reenfileirar",
    details: "O RCA sugere que o log ou os artefatos do run precisam ser inspecionados antes de nova tentativa.",
    urgency: "medium"
  };
};

// ── Checklist ────────────────────────────────────────────────────────

/** @param {object} job */
export const getJobStepChecklist = (job) => {
  const sourceJob = getRecoverySourceJob(job) || job;
  const freshnessReference = job && typeof job !== "string" ? job : sourceJob;
  const slug = String(sourceJob?.slug || job?.slug || "").trim();
  const paths = _getRunPaths(slug);
  const sceneStats = getSceneCompletionStats(sourceJob);
  const effectiveStoryboardPath = sceneStats.storyboardPath || resolveEffectiveStoryboardPath(sourceJob);
  const storyboardExists = existsSync(effectiveStoryboardPath);
  const sceneCount = sceneStats.sceneCount;
  const firstMissingSceneNumber =
    normalizePositiveInt(sceneStats.firstMissingSceneNumber) || getMissingSceneHintFromJob(job);
  const allSceneClipsExist = sceneCount > 0 && sceneStats.missingSceneCount === 0;
  let qaPassed = isQaPassedForJob(freshnessReference);
  const trustCompletedArtifacts =
    sourceJob?.type === "generate" && sourceJob?.status === "completed" && sourceJob?.id === job?.id;
  const voiceoverJsonExists = trustCompletedArtifacts
    ? existsSync(paths.voiceoverPath) : isFreshArtifactForJob(paths.voiceoverPath, freshnessReference);
  const voiceoverMp3Exists = trustCompletedArtifacts
    ? existsSync(paths.publicAudioPath) : isFreshArtifactForJob(paths.publicAudioPath, freshnessReference);
  const renderPropsExists = trustCompletedArtifacts
    ? existsSync(paths.renderPropsPath) : isFreshArtifactForJob(paths.renderPropsPath, freshnessReference);
  const outputExists = trustCompletedArtifacts
    ? existsSync(paths.outPath) : isFreshArtifactForJob(paths.outPath, freshnessReference);
  let timedWordsReady = false;

  if (voiceoverJsonExists && isFreshArtifactForJob(paths.voiceoverPath, freshnessReference)) {
    try {
      const voiceover = JSON.parse(readFileSync(paths.voiceoverPath, "utf8"));
      timedWordsReady = Array.isArray(voiceover?.timedWords) && voiceover.timedWords.length > 0;
    } catch {}
  }

  let effectiveRenderPropsExists = renderPropsExists;
  let effectiveOutputExists = outputExists;
  if (!allSceneClipsExist && !trustCompletedArtifacts) {
    qaPassed = false;
    effectiveRenderPropsExists = false;
    effectiveOutputExists = false;
  }

  return {
    firstMissingSceneNumber, allSceneClipsExist,
    steps: [
      {
        key: "storyboard", label: "Storyboard",
        status: storyboardExists ? "completed" : "missing",
        detail: storyboardExists ? `${sceneCount || 0} cenas no storyboard` : "Storyboard ainda ausente"
      },
      {
        key: "assets", label: "Imagens e cenas",
        status: !storyboardExists ? "blocked" : allSceneClipsExist ? "completed" : "blocked",
        detail: !storyboardExists ? "Sem storyboard não há geração visual"
          : allSceneClipsExist ? `Todos os ${sceneCount} clips de cena existem`
          : `Falta a cena ${firstMissingSceneNumber || "?"}`
      },
      {
        key: "audio", label: "Voz",
        status: voiceoverJsonExists && voiceoverMp3Exists ? "completed" : voiceoverJsonExists ? "partial" : "missing",
        detail: voiceoverJsonExists && voiceoverMp3Exists ? "voiceover.json e voiceover.mp3 prontos"
          : voiceoverJsonExists ? "voiceover.json existe, mas o mp3 final não" : "A voz ainda não foi gerada"
      },
      {
        key: "timestamps", label: "Timestamps",
        status: qaPassed || effectiveOutputExists ? "completed" : timedWordsReady ? "completed" : voiceoverJsonExists ? "partial" : "missing",
        detail: qaPassed || effectiveOutputExists ? "Timestamps resolvidos no vídeo final"
          : timedWordsReady ? "timedWords prontos para karaokê e legendas"
          : voiceoverJsonExists ? "Há voz base, mas faltam timestamps sólidos" : "Aguardando voz para extrair timestamps"
      },
      {
        key: "render", label: "Render",
        status: effectiveOutputExists ? "completed" : effectiveRenderPropsExists ? "ready" : "missing",
        detail: effectiveOutputExists ? "MP4 final já existe"
          : effectiveRenderPropsExists ? "render-props prontos; pode renderizar" : "Ainda faltam props de render"
      },
      {
        key: "qa", label: "QA final",
        status: qaPassed ? "completed" : effectiveOutputExists ? "ready" : "missing",
        detail: qaPassed ? "QA final validada"
          : effectiveOutputExists ? "Video existe; pode validar" : "Aguardando video final para validar"
      }
    ]
  };
};

/** @param {object} job */
export const buildJobStepChecklist = (job) => {
  const normalized = getJobStepChecklist(job);
  return (normalized?.steps || []).map((step) => ({
    id: step.key, label: step.label, status: step.status, summary: step.detail, counts: {}
  }));
};

// ── Summary builders ─────────────────────────────────────────────────

export const buildCaseSummary = ({id, kind, title, slug, state, stage, rca, recommendedAction, updatedAt, channel = null, extra = {}}) => ({
  id, kind, title, slug, channel, state, stage, rca, recommendedAction, updatedAt, extra
});

export const buildJobsSummary = (jobsList) => {
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
    queued: byState.queued || 0, running: byState.running || 0,
    completed: byState.completed || 0, failed: byState.failed || 0,
    byState, byStage, byType
  };
};
