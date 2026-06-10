/**
 * Job queue management — two independent lanes (preview / heavy).
 * Preview runs one job at a time; heavy runs up to HEAVY_LANE_CONCURRENCY
 * jobs (default 1, so the historical single-slot behavior is preserved
 * unless the env var raises it).
 *
 * Extracted from web/server.mjs. Pure queue state; execution logic stays in server.
 */

const PREVIEW_QUEUE_LANE = "preview";
const HEAVY_QUEUE_LANE = "heavy";

const HEAVY_LANE_CONCURRENCY = Math.max(1, Number.parseInt(process.env.HEAVY_LANE_CONCURRENCY || "1", 10) || 1);

const previewQueue = [];
const heavyQueue = [];
const activeJobIdsByLane = {
  [PREVIEW_QUEUE_LANE]: new Set(),
  [HEAVY_QUEUE_LANE]: new Set()
};
const laneRunnerCounts = {
  [PREVIEW_QUEUE_LANE]: 0,
  [HEAVY_QUEUE_LANE]: 0
};

/* ── injected deps (set via init()) ─────────────────────────── */
let _jobs = null;          // Map<id, job>
let _broadcastJob = null;  // (job) => void
let _schedulePersist = null;
let _sanitizeJob = null;   // (job) => sanitized
let _toIsoNow = null;
let _appendLog = null;
let _getFailureStage = null;
let _clearJobProcess = null;

/**
 * Inject external dependencies that live in server.mjs.
 * Must be called once before any queue operation.
 * @param {object} deps
 */
export const init = (deps) => {
  _jobs = deps.jobs;
  _broadcastJob = deps.broadcastJob;
  _schedulePersist = deps.schedulePersist;
  _sanitizeJob = deps.sanitizeJob;
  _toIsoNow = deps.toIsoNow;
  _appendLog = deps.appendLog;
  _getFailureStage = deps.getFailureStage;
  _clearJobProcess = deps.clearJobProcess;
};

/* ── lane helpers ───────────────────────────────────────────── */

/** Determine which lane a job belongs to. */
export const getJobQueueLane = (job) =>
  job?.type === "generate" && job?.input?.previewOnly ? PREVIEW_QUEUE_LANE : HEAVY_QUEUE_LANE;

/** Return the underlying array for a lane. */
export const getQueueForLane = (lane) => (lane === PREVIEW_QUEUE_LANE ? previewQueue : heavyQueue);

/** Max simultaneous jobs allowed for a lane. */
export const getLaneConcurrency = (lane) => (lane === HEAVY_QUEUE_LANE ? HEAVY_LANE_CONCURRENCY : 1);

/** First active job id for a lane (legacy single-slot view), or null. */
export const getActiveJobIdForLane = (lane) => {
  for (const jobId of activeJobIdsByLane[lane] || []) return jobId;
  return null;
};

/** Number of jobs currently marked active in a lane. */
export const countActiveJobsForLane = (lane) => (activeJobIdsByLane[lane] || new Set()).size;

/** Whether the lane still has a free slot. */
export const laneHasCapacity = (lane) => countActiveJobsForLane(lane) < getLaneConcurrency(lane);

/** Mark a job active in its lane. */
export const addActiveJobForLane = (lane, jobId) => {
  if (jobId) activeJobIdsByLane[lane]?.add(jobId);
};

/** Release a job slot in its lane. */
export const removeActiveJobForLane = (lane, jobId) => {
  activeJobIdsByLane[lane]?.delete(jobId);
};

/** Legacy setter kept for compatibility: null clears the lane, otherwise adds. */
export const setActiveJobIdForLane = (lane, jobId) => {
  if (jobId === null || jobId === undefined) {
    activeJobIdsByLane[lane]?.clear();
    return;
  }
  addActiveJobForLane(lane, jobId);
};

/** Snapshot of both active ids (for API responses). */
export const getActiveJobIds = () => ({
  activeJobId: getActiveJobIdForLane(HEAVY_QUEUE_LANE) || getActiveJobIdForLane(PREVIEW_QUEUE_LANE) || null,
  activePreviewJobId: getActiveJobIdForLane(PREVIEW_QUEUE_LANE),
  activeHeavyJobId: getActiveJobIdForLane(HEAVY_QUEUE_LANE),
  activeHeavyJobIds: Array.from(activeJobIdsByLane[HEAVY_QUEUE_LANE])
});

/** Queue length summary. */
export const getQueueLengths = () => ({
  previewQueueLength: previewQueue.length,
  heavyQueueLength: heavyQueue.length,
  queueLength: previewQueue.length + heavyQueue.length
});

/** Whether a lane has at least one worker-runner loop active. */
export const isLaneProcessing = (lane) => (laneRunnerCounts[lane] || 0) > 0;

/** Number of worker-runner loops currently executing for a lane. */
export const countLaneRunners = (lane) => laneRunnerCounts[lane] || 0;

/** Track entry/exit of a worker-runner loop. */
export const incrementLaneRunners = (lane) => {
  laneRunnerCounts[lane] = (laneRunnerCounts[lane] || 0) + 1;
};

export const decrementLaneRunners = (lane) => {
  laneRunnerCounts[lane] = Math.max(0, (laneRunnerCounts[lane] || 0) - 1);
};

/** Legacy compatibility: treated as a hint only; runner counts are authoritative. */
export const setLaneProcessing = () => {};

/* ── queue mutations ────────────────────────────────────────── */

/** Remove a job id from both queues. */
export const removeJobFromQueues = (jobId) => {
  const pi = previewQueue.indexOf(jobId);
  if (pi >= 0) previewQueue.splice(pi, 1);

  const hi = heavyQueue.indexOf(jobId);
  if (hi >= 0) heavyQueue.splice(hi, 1);
};

/** Reset all in-memory queue state. Useful when rebuilding from persisted jobs. */
export const resetQueueState = () => {
  previewQueue.length = 0;
  heavyQueue.length = 0;
  activeJobIdsByLane[PREVIEW_QUEUE_LANE].clear();
  activeJobIdsByLane[HEAVY_QUEUE_LANE].clear();
  // Runner counts are intentionally NOT reset: they track live async loops in
  // server.mjs that this rebuild cannot stop.
};

/** Rebuild in-memory queues from the current jobs map snapshot. */
export const rebuildQueueStateFromJobs = () => {
  resetQueueState();

  const queuedJobs = [];

  for (const job of _jobs.values()) {
    const lane = job.queueLane || getJobQueueLane(job);
    job.queueLane = lane;

    if (job.status === "queued") {
      queuedJobs.push(job);
      continue;
    }

    if (job.status === "running") {
      addActiveJobForLane(lane, job.id);
    }
  }

  queuedJobs
    .sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime())
    .forEach((job) => {
      getQueueForLane(job.queueLane).push(job.id);
    });
};

/** Recalculate queuePosition for every job and broadcast updates. */
export const refreshQueuePositions = () => {
  const queuedPreviewIds = previewQueue.filter((id) => _jobs.get(id)?.status === "queued");
  const queuedHeavyIds = heavyQueue.filter((id) => _jobs.get(id)?.status === "queued");

  for (const job of _jobs.values()) {
    const lane = job.queueLane || getJobQueueLane(job);
    job.queueLane = lane;

    if (job.status !== "queued") {
      job.queuePosition = null;
      continue;
    }

    const queuedIds = lane === PREVIEW_QUEUE_LANE ? queuedPreviewIds : queuedHeavyIds;
    job.queuePosition = queuedIds.indexOf(job.id) + 1;
  }

  for (const job of _jobs.values()) {
    _broadcastJob(job);
  }
};

/**
 * Fail a job, release its lane, refresh positions and optionally kick the worker.
 * @param {object} job
 * @param {string} errorMessage
 * @param {(lane: string) => Promise<void>} startWorker — startQueueWorker from server.mjs
 * @param {{autoStartNext?: boolean}} [options]
 */
export const failJobAndReleaseQueue = (job, errorMessage, startWorker, options = {}) => {
  const {autoStartNext = true} = options;
  const lane = job.queueLane || getJobQueueLane(job);
  const nowIso = _toIsoNow();

  removeJobFromQueues(job.id);
  removeActiveJobForLane(lane, job.id);

  job.status = "failed";
  job.error = errorMessage;
  job.completedAt = nowIso;
  job.updatedAt = nowIso;
  job.heartbeatAt = nowIso;
  job.queuePosition = null;
  job.stageValue = _getFailureStage(job) || job.stageValue || "pipeline";
  job.stageSource = "system";
  job.stageConfidence = "high";
  job.stageUpdatedAt = nowIso;

  if (typeof job.exitCode !== "number") {
    job.exitCode = 1;
  }

  _clearJobProcess(job);
  _appendLog(job, errorMessage, "stderr");
  refreshQueuePositions();
  _schedulePersist({immediate: true});
  if (autoStartNext) {
    startWorker(lane).catch((error) => {
      process.stderr.write(`Falha ao reiniciar fila ${lane} apos liberar job ${job.id}: ${error.message}\n`);
    });
  }
};

/**
 * Enqueue a job: stamp timestamps, push to lane, persist, and optionally start worker.
 * @param {object} job
 * @param {(lane: string) => Promise<void>} startWorker — startQueueWorker from server.mjs
 * @param {{autoStart?: boolean}} [options]
 * @returns {object} sanitized job
 */
export const enqueueJob = (job, startWorker, options = {}) => {
  const {autoStart = true} = options;
  const nowIso = _toIsoNow();
  job.queueLane = getJobQueueLane(job);
  job.createdAt = job.createdAt || nowIso;
  job.updatedAt = nowIso;
  job.heartbeatAt = job.heartbeatAt || nowIso;
  job.artifactEpochAt = job.artifactEpochAt || job.createdAt || nowIso;
  job.stageValue = job.stageValue || "queue";
  job.stageSource = job.stageSource || "system";
  job.stageConfidence = job.stageConfidence || "high";
  job.stageUpdatedAt = job.stageUpdatedAt || nowIso;
  _jobs.set(job.id, job);
  getQueueForLane(job.queueLane).push(job.id);
  refreshQueuePositions();
  _schedulePersist({immediate: true});
  if (autoStart) {
    startWorker(job.queueLane).catch((error) => {
      process.stderr.write(`Falha ao iniciar job ${job.id}: ${error.message}\n`);
    });
  }
  return _sanitizeJob(job);
};

export {PREVIEW_QUEUE_LANE, HEAVY_QUEUE_LANE};
