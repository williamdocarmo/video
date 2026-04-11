/**
 * @module video-library
 * Video library management — records, metadata, listing, export helpers.
 * Extracted from server.mjs; all public functions preserve original behaviour.
 */

import {existsSync, statSync} from "node:fs";
import {mkdir, readdir, stat} from "node:fs/promises";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {
  slugify,
  readJsonFile,
  writeJsonFile,
  readTextFile,
  ensureManagedDir,
  fileExists,
  createFileUrl,
  roundSeconds
} from "./utils.mjs";
import {normalizePlatforms} from "./agendador.mjs";

/* ------------------------------------------------------------------ */
/*  Injected dependencies — set once via init()                       */
/* ------------------------------------------------------------------ */

/** @type {function} */ let _getRunPaths;
/** @type {function} */ let _findExistingStoryboardPath;
/** @type {function} */ let _getChannelConfig;
/** @type {function} */ let _getChannelExportDir;
/** @type {function} */ let _isQaPassedForSlug;
/** @type {function} */ let _getJobStateInfo;
/** @type {function} */ let _getJobStageInfo;
/** @type {function} */ let _getJobRca;
/** @type {function} */ let _getJobRecommendedAction;
/** @type {function} */ let _buildCaseSummary;
/** @type {function} */ let _getStageLabel;
/** @type {function} */ let _getFailureStage;
/** @type {function} */ let _getFailureSummary;
/** @type {function} */ let _ensureAllowedFilePath;
/** @type {function} */ let _resolveStoredThumbnailArtifacts;
/** @type {function} */ let _resolveChannelValue;
/** @type {function} */ let _getJobs;
/** @type {function} */ let _getVideoMetadata;
/** @type {function} */ let _setVideoMetadata;
/** @type {function} */ let _getChannelOptions;
/** @type {string}   */ let _projectRoot;
/** @type {string}   */ let _dataDir;
/** @type {string}   */ let _videoLibraryDir;
/** @type {string}   */ let _videosFile;

/**
 * Initialise the module with runtime dependencies from server.mjs.
 * Must be called once before any other export is used.
 * @param {object} deps
 */
export const init = (deps) => {
  _getRunPaths = deps.getRunPaths;
  _findExistingStoryboardPath = deps.findExistingStoryboardPath;
  _getChannelConfig = deps.getChannelConfig;
  _getChannelExportDir = deps.getChannelExportDir;
  _isQaPassedForSlug = deps.isQaPassedForSlug;
  _getJobStateInfo = deps.getJobStateInfo;
  _getJobStageInfo = deps.getJobStageInfo;
  _getJobRca = deps.getJobRca;
  _getJobRecommendedAction = deps.getJobRecommendedAction;
  _buildCaseSummary = deps.buildCaseSummary;
  _getStageLabel = deps.getStageLabel;
  _getFailureStage = deps.getFailureStage;
  _getFailureSummary = deps.getFailureSummary;
  _ensureAllowedFilePath = deps.ensureAllowedFilePath;
  _resolveStoredThumbnailArtifacts = deps.resolveStoredThumbnailArtifacts;
  _resolveChannelValue = deps.resolveChannelValue;
  _getJobs = deps.getJobs;
  _getVideoMetadata = deps.getVideoMetadata;
  _setVideoMetadata = deps.setVideoMetadata;
  _getChannelOptions = deps.getChannelOptions;
  _projectRoot = deps.projectRoot;
  _dataDir = deps.dataDir;
  _videoLibraryDir = deps.videoLibraryDir;
  _videosFile = deps.videosFile;
};

/* ------------------------------------------------------------------ */
/*  Pure helpers (no injected deps)                                   */
/* ------------------------------------------------------------------ */

/** @param {string} slug */
const formatFallbackTitleFromSlug = (slug) =>
  String(slug || "")
    .replace(/^\d{4}-\d{2}-\d{2}-/, "")
    .replace(/-/g, " ")
    .trim();

/** @param {string} source */
export const slugToCaption = (source) => {
  const base = path.basename(String(source || ""), path.extname(String(source || "")));
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const text = withoutDate.replace(/-/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : base;
};

/** @param {string} rawText */
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

/** @param {string} targetPath */
const ffprobeDurationSeconds = (targetPath) => {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetPath],
    {encoding: "utf8"}
  );
  if (result.status !== 0) {
    throw new Error(`ffprobe falhou para ${targetPath}`);
  }
  return Number.parseFloat(String(result.stdout || "0").trim()) || 0;
};

/** @param {string} targetPath */
const getVideoDurationSeconds = (targetPath) => {
  try {
    return roundSeconds(ffprobeDurationSeconds(targetPath));
  } catch {
    return null;
  }
};

/** @param {*} value */
const normalizePublishAt = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

/* ------------------------------------------------------------------ */
/*  Video state / stage / RCA / recommended action                    */
/* ------------------------------------------------------------------ */

/** @param {object} video */
export const getVideoStateInfo = (video) => {
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
  return {value: status, label: meta.label, severity: meta.severity, terminal: status === "published"};
};

/** @param {object} video */
export const getVideoStageInfo = (video) => {
  const value = video?.publishStatus === "published"
    || Boolean(video?.publishedAt)
    ? "video-published"
    : video?.isDraft
      ? "video-draft"
      : "video-ready";
  return {value, label: _getStageLabel(value), source: "video-metadata", confidence: "medium"};
};

/** @param {object} video */
export const getVideoRca = (video, stateInfo = getVideoStateInfo(video)) => {
  if (stateInfo.value === "published") {
    return {summary: "Video publicado com sucesso.", causes: [], evidence: [video.publishedAt || video.updatedAt || ""].filter(Boolean), confidence: "high"};
  }
  if (stateInfo.value === "scheduled") {
    return {summary: "Video agendado aguardando janela de publicacao.", causes: ["scheduled"], evidence: [video.publishAt || ""].filter(Boolean), confidence: "high"};
  }
  if (stateInfo.value === "draft") {
    return {summary: "Video mantido como rascunho antes da publicacao.", causes: ["draft"], evidence: [video.storyboardUrl || "", video.thumbnailUrl || ""].filter(Boolean), confidence: "medium"};
  }
  return {summary: "Video pronto para revisão ou publicacao.", causes: ["ready"], evidence: [video.storyboardUrl || "", video.thumbnailUrl || ""].filter(Boolean), confidence: "medium"};
};

/** @param {object} video */
export const getVideoRecommendedAction = (video, stateInfo = getVideoStateInfo(video)) => {
  if (stateInfo.value === "published") {
    return {value: "monitor-performance", label: "Acompanhar performance", details: "O item ja foi publicado; a proxima acao e observar resultados e reaproveitar aprendizados.", urgency: "low"};
  }
  if (stateInfo.value === "scheduled") {
    return {value: "wait-for-publish", label: "Aguardar publicacao", details: "O video ja esta agendado.", urgency: "low"};
  }
  if (stateInfo.value === "draft") {
    return {value: "publish-or-edit", label: "Revisar e publicar", details: "O rascunho ainda pode receber ajustes antes de ser enviado para publicacao.", urgency: "medium"};
  }
  return {value: "publish", label: "Publicar", details: "O video parece pronto para a proxima etapa de publicacao.", urgency: "medium"};
};

/** @param {object} video */
export const buildVideoCaseSummary = (video) => {
  const state = getVideoStateInfo(video);
  const stage = getVideoStageInfo(video);
  const rca = getVideoRca(video, state);
  const recommendedAction = getVideoRecommendedAction(video, state);
  return _buildCaseSummary({
    id: video.id, kind: "video", title: video.title, slug: video.slug,
    state, stage, rca, recommendedAction, updatedAt: video.updatedAt, channel: video.channel,
    extra: {
      publishStatus: video.publishStatus || "",
      publishedAt: video.publishedAt || null,
      storyboardUrl: video.storyboardUrl || null,
      thumbnailUrl: video.thumbnailUrl || null
    }
  });
};

/**
 * @param {object[]} videos
 * @param {object[]} failedJobs
 */
export const buildVideosSummary = (videos, failedJobs) => {
  const published = videos.filter((v) => v.publishStatus === "published" || Boolean(v.publishedAt)).length;
  const scheduled = videos.filter((v) => v.publishStatus === "scheduled").length;
  const drafts = videos.filter((v) => v.isDraft === true).length;
  return {
    total: videos.length, published, scheduled, drafts,
    failedJobs: failedJobs.length,
    retryableFailedJobs: failedJobs.filter((j) => j.retryFromStoryboardAvailable).length,
    readyCases: videos.filter((v) => v.publishStatus !== "published").length + failedJobs.length
  };
};

/* ------------------------------------------------------------------ */
/*  Metadata persistence                                              */
/* ------------------------------------------------------------------ */

/** @param {{channel:string, slug:string}} id */
export const getVideoMetadataKey = ({channel, slug}) =>
  `${String(channel || "foiumaideia").trim()}:${slugify(slug)}`;

/** Flush videoMetadata to disk. */
export const persistVideoMetadata = async () => {
  await mkdir(_dataDir, {recursive: true});
  await writeJsonFile(_videosFile, _getVideoMetadata());
};

/** @param {{channel:string, slug:string}} id */
export const getVideoMetadataEntry = ({channel, slug}) => {
  const key = getVideoMetadataKey({channel, slug});
  return _getVideoMetadata()[key] || {};
};

/**
 * Merge updates into a metadata entry and persist.
 * @param {{channel:string, slug:string}} id
 * @param {object} updates
 */
export const saveVideoMetadataEntry = async ({channel, slug}, updates) => {
  const key = getVideoMetadataKey({channel, slug});
  const current = _getVideoMetadata()[key] || {};
  _setVideoMetadata({
    ..._getVideoMetadata(),
    [key]: {...current, ...updates, channel, slug: slugify(slug), updatedAt: new Date().toISOString()}
  });
  await persistVideoMetadata();
  return _getVideoMetadata()[key];
};

/**
 * Remove a metadata entry and persist.
 * @param {{channel:string, slug:string}} id
 */
export const removeVideoMetadataEntry = async ({channel, slug}) => {
  const key = getVideoMetadataKey({channel, slug});
  const md = _getVideoMetadata();
  if (!(key in md)) return;
  const next = {...md};
  delete next[key];
  _setVideoMetadata(next);
  await persistVideoMetadata();
};

/** @param {string} slug */
export const getVideoMetaPath = (slug) =>
  path.join(_videoLibraryDir, `${slugify(slug) || "video"}.json`);

/** @param {string} slug */
export const readVideoMeta = async (slug) => readJsonFile(getVideoMetaPath(slug));

/**
 * Write per-slug metadata JSON and update in-memory map.
 * @param {string} slug
 * @param {object} payload
 */
export const writeVideoMeta = async (slug, payload) => {
  await ensureManagedDir(_videoLibraryDir);
  const normalizedSlug = slugify(slug);
  const channel = String(payload?.channel || "foiumaideia").trim() || "foiumaideia";
  const key = getVideoMetadataKey({channel, slug: normalizedSlug});
  const nextPayload = {
    ...(_getVideoMetadata()[key] || {}),
    ...payload,
    channel,
    slug: normalizedSlug,
    updatedAt: String(payload?.updatedAt || new Date().toISOString())
  };
  _setVideoMetadata({..._getVideoMetadata(), [key]: nextPayload});
  await writeJsonFile(getVideoMetaPath(normalizedSlug), nextPayload);
};

/* ------------------------------------------------------------------ */
/*  Job lookup helpers                                                */
/* ------------------------------------------------------------------ */

/** @param {string} targetPath */
export const findJobForVideoPath = (targetPath) =>
  Array.from(_getJobs().values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .find((job) => {
      if (!job.outputPath) return false;
      const normalizedOutput = path.resolve(job.outputPath);
      const normalizedTarget = path.resolve(targetPath);
      return normalizedOutput === normalizedTarget || path.basename(normalizedOutput) === path.basename(normalizedTarget);
    }) || null;

/** @param {string} targetPath */
export const inferChannelValueFromPath = (targetPath) =>
  _getChannelOptions().find((ch) => path.dirname(targetPath) === _getChannelExportDir(ch.value))?.value || "";

/** @param {string} targetPath */
export const inferVideoSlug = (targetPath) => {
  const matchedJob = findJobForVideoPath(targetPath);
  if (matchedJob?.slug) return matchedJob.slug;
  return slugify(path.basename(targetPath, path.extname(targetPath)));
};

/** @param {{slug:string, channel?:string}} opts */
export const findLatestJobForSlug = ({slug, channel}) =>
  Array.from(_getJobs().values())
    .filter((j) => j.slug === slug && (!channel || j.input?.channel === channel))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;

/** @param {{slug:string, channel?:string}} opts */
export const findLatestCompletedJobForSlug = ({slug, channel}) =>
  Array.from(_getJobs().values())
    .filter((j) => j.slug === slug && j.status === "completed" && (!channel || j.input?.channel === channel))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;

/** @param {{slug:string, channel?:string}} opts */
export const hasRecoveredSuccessfulArtifactsForSlug = ({slug, channel}) => {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return false;
  const outPath = _getRunPaths(normalizedSlug).outPath;
  const exportPath = channel ? path.join(_getChannelExportDir(channel), `${normalizedSlug}.mp4`) : "";
  return _isQaPassedForSlug(normalizedSlug) && (existsSync(outPath) || (exportPath && existsSync(exportPath)));
};

/** @param {{slug:string, channel?:string}} opts */
export const findLatestDisplayJobForSlug = ({slug, channel}) => {
  const latestJob = findLatestJobForSlug({slug, channel});
  if (!latestJob) return null;
  if (!hasRecoveredSuccessfulArtifactsForSlug({slug, channel})) return latestJob;
  return findLatestCompletedJobForSlug({slug, channel}) || latestJob;
};

/* ------------------------------------------------------------------ */
/*  Retry helpers                                                     */
/* ------------------------------------------------------------------ */

/** @param {object} job */
export const getRetryStoryboardPathForJob = (job) => _findExistingStoryboardPath(job);

/** @param {object} job */
export const canRetryFailedJobFromStoryboard = (job) =>
  job?.type === "generate" &&
  job?.status === "failed" &&
  job?.input?.previewOnly !== true &&
  Boolean(getRetryStoryboardPathForJob(job));

/* Re-export for server.mjs convenience */
export {getVideoDurationSeconds};

/* ------------------------------------------------------------------ */
/*  Record builders                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build a video record from an export file inside a channel directory.
 * Used by listAllExports.
 * @param {{channel:object, fileName:string, filePath:string}} opts
 */
export const createVideoRecord = async ({channel, fileName, filePath}) => {
  const details = await stat(filePath);
  const slug = path.basename(fileName, path.extname(fileName));
  const runPaths = _getRunPaths(slug);
  const matchedJob = findJobForVideoPath(filePath);
  const storyboard = await readJsonFile(runPaths.storyboardPath);
  const latestJob = findLatestDisplayJobForSlug({slug, channel: channel.value}) || matchedJob;
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
  const caption = String(metadata.caption ?? storyboard?.postCaption ?? "").trim();
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
    url: createFileUrl(filePath, Math.trunc(details.mtimeMs)),
    storyboardPath: (await fileExists(runPaths.storyboardPath)) ? runPaths.storyboardPath : "",
    storyboardUrl: (await fileExists(runPaths.storyboardPath)) ? createFileUrl(runPaths.storyboardPath, Math.trunc(details.mtimeMs)) : "",
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
    jobStatus: latestJob?.status || null,
    creationParams,
    canRedo: Boolean(latestJob || existsSync(runPaths.storyboardPath)),
    canDelete: true,
    canPublish: true
  };
};

/**
 * Build a full video record from a file path (used by listExportVideos and route handlers).
 * @param {{targetPath:string, channelValue?:string}} opts
 */
export const buildVideoRecord = async ({targetPath, channelValue}) => {
  const details = await stat(targetPath);
  const matchedJob = findJobForVideoPath(targetPath);
  const slug = inferVideoSlug(targetPath);
  const paths = _getRunPaths(slug);
  const storyboardPath = _findExistingStoryboardPath(matchedJob || slug) || (existsSync(paths.storyboardPath) ? paths.storyboardPath : "");
  const storyboard = storyboardPath ? await readJsonFile(storyboardPath) : null;
  const postText = existsSync(paths.postPath) ? await readTextFile(paths.postPath) : "";
  const postMeta = parsePostText(postText);
  const persistedMeta = await readVideoMeta(slug).catch(() => null);
  const channel = _getChannelConfig(
    _resolveChannelValue(persistedMeta?.channel || channelValue || matchedJob?.input?.channel || inferChannelValueFromPath(targetPath))
  );
  const linkedJob = findLatestDisplayJobForSlug({slug, channel: channel.value}) || matchedJob;
  const meta = {
    ...getVideoMetadataEntry({channel: channel.value, slug}),
    ...(persistedMeta || {})
  };
  const thumbnail = await _resolveStoredThumbnailArtifacts({slug, meta});
  const title =
    String(meta?.title || "").trim() ||
    String(storyboard?.videoTitle || "").trim() ||
    String(linkedJob?.title || "").trim() ||
    slugToCaption(targetPath);
  const caption = String(meta?.caption || "").trim() || String(postMeta.caption || "").trim() || "";
  const hashtags = Array.isArray(meta?.hashtags) && meta.hashtags.length > 0 ? meta.hashtags : postMeta.hashtags;
  const platforms = Array.isArray(meta?.platforms) && meta.platforms.length > 0 ? meta.platforms : ["FB", "IG", "YT"];
  const creationParams = linkedJob?.input
    ? {
        language: linkedJob.input.language || null,
        outputProfile: linkedJob.input.outputProfile || null,
        targetSeconds: Number(linkedJob.input.targetSeconds || 0) || null,
        imageModel: linkedJob.input.imageModel || null,
        imageStyle: linkedJob.input.imageStyle || null,
        tone: linkedJob.input.tone || null,
        voice: linkedJob.input.voice || null,
        channel: linkedJob.input.channel || channel.value,
        channelHandle: linkedJob.input.channelHandle || channel.handle,
        noMusic: linkedJob.input.noMusic === true,
        force: linkedJob.input.force === true,
        previewOnly: linkedJob.input.previewOnly === true
      }
    : null;

  return {
    id: `${slug}:${path.basename(targetPath)}`,
    name: path.basename(targetPath),
    path: targetPath,
    url: createFileUrl(targetPath, Math.trunc(details.mtimeMs)),
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
    storyboardUrl: storyboardPath ? createFileUrl(storyboardPath, Math.trunc(details.mtimeMs)) : null,
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
    jobId: linkedJob?.id || null,
    sourceJobId: linkedJob?.id || null,
    status: linkedJob?.status || null,
    jobStatus: linkedJob?.status || null,
    jobType: linkedJob?.type || null,
    creationParams,
    state: getVideoStateInfo({publishStatus: meta?.publishStatus || "", isDraft: meta?.isDraft === true, publishedAt: meta?.publishedAt || null}),
    stage: getVideoStageInfo({publishStatus: meta?.publishStatus || "", isDraft: meta?.isDraft === true, publishedAt: meta?.publishedAt || null}),
    rca: getVideoRca({publishStatus: meta?.publishStatus || "", isDraft: meta?.isDraft === true, publishedAt: meta?.publishedAt || null, updatedAt: details.mtime.toISOString(), scheduleAt: String(meta?.scheduleAt || "").trim()}),
    recommendedAction: getVideoRecommendedAction({publishStatus: meta?.publishStatus || "", isDraft: meta?.isDraft === true, publishedAt: meta?.publishedAt || null}),
    caseSummary: buildVideoCaseSummary({
      id: `${slug}:${path.basename(targetPath)}`, slug, title, channel: channel.value,
      updatedAt: details.mtime.toISOString(), publishStatus: meta?.publishStatus || "",
      isDraft: meta?.isDraft === true, publishedAt: meta?.publishedAt || null,
      storyboardUrl: storyboardPath ? createFileUrl(storyboardPath, Math.trunc(details.mtimeMs)) : null,
      thumbnailUrl: thumbnail.thumbnailUrl || null
    })
  };
};

/* ------------------------------------------------------------------ */
/*  Listing functions                                                 */
/* ------------------------------------------------------------------ */

/** List all exports across all channels (used by /api/videos legacy). */
export const listAllExports = async () => {
  const videos = [];
  for (const channel of _getChannelOptions()) {
    const exportDir = _getChannelExportDir(channel.value);
    const entries = await readdir(exportDir).catch(() => []);
    for (const entry of entries.filter((item) => item.endsWith(".mp4")).sort()) {
      const filePath = path.join(exportDir, entry);
      try { videos.push(await createVideoRecord({channel, fileName: entry, filePath})); } catch { continue; }
    }
  }
  return videos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

/**
 * List export videos with optional limit.
 * @param {{limit?:number}} opts
 */
export const listExportVideos = async ({limit = null} = {}) => {
  const videos = [];
  for (const channel of _getChannelOptions()) {
    const exportDir = _getChannelExportDir(channel.value);
    const entries = await readdir(exportDir).catch(() => []);
    for (const entry of entries.filter((item) => item.endsWith(".mp4"))) {
      const targetPath = path.join(exportDir, entry);
      try { videos.push(await buildVideoRecord({targetPath, channelValue: channel.value})); } catch { continue; }
    }
  }
  const sorted = videos.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return Number.isInteger(limit) ? sorted.slice(0, Math.max(0, limit)) : sorted;
};

/** List failed generate jobs that haven't been recovered. */
export const listFailedLibraryJobs = async () => {
  return Array.from(_getJobs().values())
    .filter((job) =>
      job.type === "generate" &&
      job.status === "failed" &&
      job.input?.previewOnly !== true &&
      !hasRecoveredSuccessfulArtifactsForSlug({slug: job.slug, channel: job.input?.channel})
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((job) => {
      const storyboardPath = getRetryStoryboardPathForJob(job);
      const channel = _getChannelConfig(job.input?.channel);
      const state = _getJobStateInfo(job);
      const stage = _getJobStageInfo(job);
      const rca = _getJobRca(job, stage);
      const recommendedAction = _getJobRecommendedAction(job, stage, rca);
      return {
        id: job.id,
        title: job.title,
        slug: job.slug,
        channel: channel.value,
        channelHandle: channel.handle,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        failureStage: _getFailureStage(job),
        failureSummary: _getFailureSummary(job),
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
        caseSummary: _buildCaseSummary({
          id: job.id, kind: "job", title: job.title, slug: job.slug,
          state, stage, rca, recommendedAction, updatedAt: job.updatedAt, channel: channel.value,
          extra: {
            retryFromStoryboardAvailable: canRetryFailedJobFromStoryboard(job),
            previewOnly: Boolean(job.input?.previewOnly),
            outputProfile: job.input?.outputProfile || null
          }
        })
      };
    });
};

/**
 * Resolve a video target by slug or file path.
 * @param {{slug?:string, filePath?:string}} opts
 */
export const resolveVideoTarget = async ({slug, filePath}) => {
  const resolvedPath = filePath ? _ensureAllowedFilePath(filePath) : "";
  if (resolvedPath) {
    return {slug: slugify(slug || inferVideoSlug(resolvedPath)), path: resolvedPath};
  }
  const normalizedSlug = slugify(slug);
  if (!normalizedSlug) throw new Error("Informe o slug ou o caminho do video.");
  const videos = await listExportVideos();
  const matched = videos.find((v) => v.slug === normalizedSlug);
  if (!matched) throw new Error("Video nao encontrado.");
  return {slug: normalizedSlug, path: matched.path};
};
