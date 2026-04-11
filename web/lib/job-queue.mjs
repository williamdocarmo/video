/**
 * Job queue management — two independent lanes (preview / heavy),
 * each allowing one active job at a time.
 *
 * Extracted from web/server.mjs. Pure queue state; execution logic stays in server.
 */

const PREVIEW_QUEUE_LANE = "preview";
const HEAVY_QUEUE_LANE = "heavy";

const previewQueue = [];
const heavyQueue = [];
let activePreviewJobId = null;
let activeHeavyJobId = null;
let isProcessingPreviewQueue = false;
let isProcessingHeavyQueue = false;

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

/** Get the active job id for a lane. */
export const getActiveJobIdForLane = (lane) => (lane === PREVIEW_QUEUE_LANE ? activePreviewJobId : activeHeavyJobId);

/** Set the active job id for a lane. */
export const setActiveJobIdForLane = (lane, jobId) => {
  if (lane === PREVIEW_QUEUE_LANE) {
    activePreviewJobId = jobId;
    return;
  }
  activeHeavyJobId = jobId;
};

/** Snapshot of both active ids (for API responses). */
export const getActiveJobIds = () => ({
  activeJobId: activeHeavyJobId || activePreviewJobId || null,
  activePreviewJobId,
  activeHeavyJobId
});

/** Queue length summary. */
export const getQueueLengths = () => ({
  previewQueueLength: previewQueue.length,
  heavyQueueLength: heavyQueue.length,
  queueLength: previewQueue.length + heavyQueue.length
});

/** Whether a lane's worker loop is currently running. */
export const isLaneProcessing = (lane) => (lane === PREVIEW_QUEUE_LANE ? isProcessingPreviewQueue : isProcessingHeavyQueue);

/** Set the processing flag for a lane. */
export const setLaneProcessing = (lane, processing) => {
  if (lane === PREVIEW_QUEUE_LANE) {
    isProcessingPreviewQueue = processing;
    return;
  }
  isProcessingHeavyQueue = processing;
};

/* ── queue mutations ────────────────────────────────────────── */

/** Remove a job id from both queues. */
export const removeJobFromQueues = (jobId) => {
  const pi = previewQueue.indexOf(jobId);
  if (pi >= 0) previewQueue.splice(pi, 1);

  const hi = heavyQueue.indexOf(jobId);
  if (hi >= 0) heavyQueue.splice(hi, 1);
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
 * Fail a job, release its lane, refresh positions and kick the worker.
 * @param {object} job
 * @param {string} errorMessage
 * @param {(lane: string) => Promise<void>} startWorker — startQueueWorker from server.mjs
 */
export const failJobAndReleaseQueue = (job, errorMessage, startWorker) => {
  const lane = job.queueLane || getJobQueueLane(job);
  const nowIso = _toIsoNow();

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
  startWorker(lane).catch((error) => {
    process.stderr.write(`Falha ao reiniciar fila ${lane} apos liberar job ${job.id}: ${error.message}\n`);
  });
};

/**
 * Enqueue a job: stamp timestamps, push to lane, persist, start worker.
 * @param {object} job
 * @param {(lane: string) => Promise<void>} startWorker — startQueueWorker from server.mjs
 * @returns {object} sanitized job
 */
export const enqueueJob = (job, startWorker) => {
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
  startWorker(job.queueLane).catch((error) => {
    process.stderr.write(`Falha ao iniciar job ${job.id}: ${error.message}\n`);
  });
  return _sanitizeJob(job);
};

export {PREVIEW_QUEUE_LANE, HEAVY_QUEUE_LANE};
