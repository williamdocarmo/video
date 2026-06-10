import {spawn, spawnSync} from "node:child_process";
import path from "node:path";
import {logJsonLine, serializeError} from "./logger.mjs";

/** @type {Map<string, import("node:child_process").ChildProcess>} */
const jobProcesses = new Map();

/* ── Dependencies injected via init() ─────────────────────────────────────── */

let deps = /** @type {Record<string, any>} */ ({});

/**
 * Initialise the module with runtime dependencies from server.mjs.
 * Must be called once before any other export is used.
 * @param {object} o
 */
export function init(o) {
  deps = o;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const isPidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PREVIEW_TIMEOUT_MS = 5 * 60_000;
const VALIDATE_ONLY_TIMEOUT_MS = 15 * 60_000;
const AUDIO_PREP_TIMEOUT_MS = 20 * 60_000;
const SCENE_REGENERATE_TIMEOUT_MS = 45 * 60_000;
const RENDER_ONLY_TIMEOUT_MS = 60 * 60_000;
const RERENDER_TIMEOUT_MS = 45 * 60_000;
const GENERATE_TIMEOUT_MS = 180 * 60_000;

const PREVIEW_IDLE_TIMEOUT_MS = 5 * 60_000;
const VALIDATE_ONLY_IDLE_TIMEOUT_MS = 10 * 60_000;
const AUDIO_PREP_IDLE_TIMEOUT_MS = 10 * 60_000;
const SCENE_REGENERATE_IDLE_TIMEOUT_MS = 20 * 60_000;
const RENDER_ONLY_IDLE_TIMEOUT_MS = 25 * 60_000;
const RERENDER_IDLE_TIMEOUT_MS = 25 * 60_000;
const GENERATE_IDLE_TIMEOUT_MS = 25 * 60_000;

export const getJobTimeoutMs = (job) => {
  if (job?.input?.previewOnly === true) {
    return PREVIEW_TIMEOUT_MS;
  }

  switch (String(job?.type || "").trim()) {
    case "validate-only":
      return VALIDATE_ONLY_TIMEOUT_MS;
    case "audio-prep":
      return AUDIO_PREP_TIMEOUT_MS;
    case "scene-regenerate":
      return SCENE_REGENERATE_TIMEOUT_MS;
    case "render-only":
      return RENDER_ONLY_TIMEOUT_MS;
    case "generate":
      return GENERATE_TIMEOUT_MS;
    default:
      return RERENDER_TIMEOUT_MS;
  }
};

export const getJobIdleTimeoutMs = (job) => {
  if (job?.input?.previewOnly === true) {
    return PREVIEW_IDLE_TIMEOUT_MS;
  }

  switch (String(job?.type || "").trim()) {
    case "validate-only":
      return VALIDATE_ONLY_IDLE_TIMEOUT_MS;
    case "audio-prep":
      return AUDIO_PREP_IDLE_TIMEOUT_MS;
    case "scene-regenerate":
      return SCENE_REGENERATE_IDLE_TIMEOUT_MS;
    case "render-only":
      return RENDER_ONLY_IDLE_TIMEOUT_MS;
    case "generate":
      return GENERATE_IDLE_TIMEOUT_MS;
    default:
      return RERENDER_IDLE_TIMEOUT_MS;
  }
};

const formatTimeoutLabel = (timeoutMs) => {
  const totalMinutes = Math.max(1, Math.round(timeoutMs / 60_000));

  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60}h`;
  }

  return `${totalMinutes}min`;
};

/* ── Process lifecycle ────────────────────────────────────────────────────── */

/**
 * Register a spawned child process for a job.
 * @param {object} job
 * @param {import("node:child_process").ChildProcess} child
 */
export const registerJobProcess = (job, child) => {
  if (!child?.pid) return;
  jobProcesses.set(job.id, child);
  job.processId = child.pid;
  job.processStartedAt = deps.toIsoNow();
  deps.updateJobHeartbeat(job);
};

/**
 * Remove the process reference for a job.
 * @param {object} job
 */
export const clearJobProcess = (job) => {
  jobProcesses.delete(job.id);
  job.processId = null;
};

/**
 * Authoritative liveness check for a job's child process. Unlike job.processId
 * (which the disk-sync loop can clobber to null), this reads the live child
 * reference this server actually owns, so the orphan detector never kills a
 * job whose process is genuinely alive but quiet (slow LLM/render phase).
 * @param {string} jobId
 * @returns {boolean}
 */
export const isJobProcessAlive = (jobId) => {
  const child = jobProcesses.get(jobId);
  if (!child || !child.pid || child.killed) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * PID of the live child this server owns for a job, or null. Lets callers
 * restore job.processId after the disk-sync loop clobbers it.
 * @param {string} jobId
 * @returns {number | null}
 */
export const getJobProcessPid = (jobId) => {
  const child = jobProcesses.get(jobId);
  return child?.pid && !child.killed ? child.pid : null;
};

/**
 * Collect all descendant PIDs of a given PID (recursive).
 * @param {number} pid
 * @param {Set<number>} [seen]
 * @returns {number[]}
 */
export const collectDescendantPids = (pid, seen = new Set()) => {
  if (!pid || seen.has(pid)) return [];
  seen.add(pid);

  const result = spawnSync("pgrep", ["-P", String(pid)], {encoding: "utf8"});
  const childPids = String(result.stdout || "")
    .split(/\s+/)
    .map((v) => Number.parseInt(v, 10))
    .filter((v) => Number.isInteger(v) && v > 0);

  const descendants = [];
  for (const childPid of childPids) {
    descendants.push(childPid, ...collectDescendantPids(childPid, seen));
  }
  return descendants;
};

/**
 * Terminate the full process tree of a job (SIGTERM then SIGKILL).
 * @param {object} job
 * @returns {Promise<boolean>}
 */
export const terminateJobProcessTree = async (job) => {
  const pid = Number(job?.processId || 0);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const pids = [...new Set([...collectDescendantPids(pid), pid])]
    .filter((v) => v > 0)
    .reverse();
  if (pids.length === 0) return false;

  for (const targetPid of pids) {
    try { process.kill(targetPid, "SIGTERM"); } catch {}
  }

  await wait(800);

  for (const targetPid of pids) {
    if (!isPidAlive(targetPid)) continue;
    try { process.kill(targetPid, "SIGKILL"); } catch {}
  }

  clearJobProcess(job);
  return true;
};

/* ── Command builders ─────────────────────────────────────────────────────── */

/**
 * Build the spawn config for a full generate job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createGenerateJobCommand = (job) => {
  const {projectRoot, configuredVideoEngineRoot, baseChildEnv, resolveOutputProfileConfig, buildProfileRuntimeEnv, getChannelExportDir, DEFAULT_IMAGE_MODEL, DEFAULT_GENERATION_MODE} = deps;
  const profile = resolveOutputProfileConfig(job.input.outputProfile);
  const exportDir = getChannelExportDir(job.input.channel);
  const args = [
    path.join(projectRoot, "scripts", "foiumaideia.mjs"),
    "--title", job.title,
    "--slug", job.slug,
    "--output-profile", profile.id,
    "--target-seconds", String(job.input.targetSeconds),
    "--project-root", configuredVideoEngineRoot,
    "--export-dir", exportDir,
    "--language", job.input.language,
    "--voice", job.input.voice,
    "--generation-mode", job.input.generationMode || DEFAULT_GENERATION_MODE,
    "--image-style", job.input.imageStyle,
    "--style-prompt", job.input.stylePrompt,
    "--script-guidance", job.input.scriptGuidance,
    "--no-open"
  ];

  if (job.input.previewOnly) args.push("--preview-only");
  if (job.input.force) args.push("--force");
  if (job.input.channelHandle) args.push("--channel-handle", job.input.channelHandle);
  if (job.input.sourceTextFile) args.push("--source-text-file", job.input.sourceTextFile);
  if (job.input.storyboardFile) args.push("--storyboard-file", job.input.storyboardFile);
  if (job.input.reuseAssetsFromSlug) args.push("--reuse-assets-from-slug", job.input.reuseAssetsFromSlug);
  if (job.input.noMusic) args.push("--no-music");

  return {
    command: "node",
    args,
    cwd: projectRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds),
      IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GOOGLE_IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GENERATION_MODE: job.input.generationMode || DEFAULT_GENERATION_MODE,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      REMOTION_TIMEOUT_MS: String(getJobTimeoutMs(job)),
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
      ELEVENLABS_MODEL_ID: job.input.audioProvider === "elevenlabs" && job.input.audioModelId
        ? job.input.audioModelId
        : (baseChildEnv.ELEVENLABS_MODEL_ID || ""),
      DEFAULT_OPEN: "false"
    }
  };
};

/**
 * Build the spawn config for a rerender (voice) job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createRerenderJobCommand = (job) => {
  const {configuredVideoEngineRoot, baseChildEnv, resolveOutputProfileConfig, buildProfileRuntimeEnv} = deps;
  const profile = resolveOutputProfileConfig(job.input.outputProfile);

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug", job.slug,
      "--output-profile", profile.id,
      "--voice", job.input.voice,
      "--style-prompt", job.input.stylePrompt
    ],
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      REMOTION_TIMEOUT_MS: String(getJobTimeoutMs(job)),
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
      ELEVENLABS_MODEL_ID: job.input.audioProvider === "elevenlabs" && job.input.audioModelId
        ? job.input.audioModelId
        : (baseChildEnv.ELEVENLABS_MODEL_ID || ""),
      DEFAULT_OPEN: "false"
    }
  };
};

/**
 * Build the spawn config for an audio-prep job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createAudioPrepJobCommand = (job) => {
  const {configuredVideoEngineRoot, baseChildEnv, resolveOutputProfileConfig, buildProfileRuntimeEnv, DEFAULT_OUTPUT_PROFILE} = deps;
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);
  const args = [
    path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
    "--slug", job.slug,
    "--output-profile", profile.id,
    "--voice", job.input.voice,
    "--style-prompt", job.input.stylePrompt,
    "--no-render"
  ];

  if (job.input.storyboardFile) {
    args.push("--storyboard-file", job.input.storyboardFile);
  }

  return {
    command: "node",
    args,
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds || profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
      ELEVENLABS_MODEL_ID: job.input.audioProvider === "elevenlabs" && job.input.audioModelId
        ? job.input.audioModelId
        : (baseChildEnv.ELEVENLABS_MODEL_ID || ""),
      DEFAULT_OPEN: "false"
    }
  };
};

/**
 * Build the spawn config for a render-only job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createRenderOnlyJobCommand = (job) => {
  const {configuredVideoEngineRoot, baseChildEnv, resolveOutputProfileConfig, buildProfileRuntimeEnv, DEFAULT_OUTPUT_PROFILE} = deps;
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);
  const args = [
    path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
    "--slug", job.slug,
    "--output-profile", profile.id,
    "--voice", job.input.voice,
    "--style-prompt", job.input.stylePrompt,
    "--reuse-existing-audio"
  ];

  if (job.input.storyboardFile) {
    args.push("--storyboard-file", job.input.storyboardFile);
  }

  return {
    command: "node",
    args,
    cwd: configuredVideoEngineRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds || profile.defaultTargetSeconds),
      VIDEO_LANGUAGE: job.input.language,
      AZURE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_VOICE: job.input.voice,
      GOOGLE_TTS_STYLE_PROMPT: job.input.stylePrompt,
      REMOTION_TIMEOUT_MS: String(getJobTimeoutMs(job)),
      DEFAULT_OPEN: "false"
    }
  };
};

/**
 * Build the spawn config for a validate-only job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createValidateOnlyJobCommand = (job) => {
  const {configuredVideoEngineRoot, baseChildEnv} = deps;
  const args = [
    path.join(configuredVideoEngineRoot, "scripts", "validate-run.mjs"),
    "--slug", job.slug,
    "--write-reports",
    "--fail-on-qa"
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

/**
 * Build the spawn config for a scene-regenerate job.
 * @param {object} job
 * @returns {{command: string, args: string[], cwd: string, env: object}}
 */
export const createSceneRegenerateJobCommand = (job) => {
  const {
    projectRoot,
    configuredVideoEngineRoot,
    baseChildEnv,
    resolveOutputProfileConfig,
    buildProfileRuntimeEnv,
    DEFAULT_OUTPUT_PROFILE,
    DEFAULT_IMAGE_MODEL,
    DEFAULT_VISUAL_STYLE_PRESET,
    DEFAULT_GENERATION_MODE
  } = deps;
  const profile = resolveOutputProfileConfig(job.input.outputProfile || DEFAULT_OUTPUT_PROFILE);
  const sceneNumber = Number(job.input.sceneNumber);
  const generationMode = job.input.generationMode || DEFAULT_GENERATION_MODE;
  const assetScript = generationMode === "text-to-video"
    ? path.join(projectRoot, "scripts", "generate-text-to-video-assets.mjs")
    : path.join(projectRoot, "scripts", "generate-google-assets.mjs");
  const args = generationMode === "text-to-video"
    ? [
        assetScript,
        "--storyboard-file", job.input.storyboardFile,
        "--slug", job.slug,
        "--asset-dir", path.join(configuredVideoEngineRoot, "assets", "envato", job.slug),
        "--scene-number", String(sceneNumber)
      ]
    : [
        assetScript,
        "--storyboard-file", job.input.storyboardFile,
        "--slug", job.slug,
        "--style-preset", job.input.imageStyle || DEFAULT_VISUAL_STYLE_PRESET,
        "--scene-number", String(sceneNumber)
      ];

  return {
    command: "node",
    args,
    cwd: projectRoot,
    env: {
      ...baseChildEnv,
      ...buildProfileRuntimeEnv(profile.id, job.input.targetSeconds),
      IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GOOGLE_IMAGE_MODEL: job.input.imageModel || DEFAULT_IMAGE_MODEL,
      GENERATION_MODE: generationMode,
      VIDEO_ENGINE_ROOT: configuredVideoEngineRoot,
      VIDEOS_ENVATO_ROOT: configuredVideoEngineRoot,
      OUTPUT_PROFILE: profile.id,
      DEFAULT_OPEN: "false"
    }
  };
};

/* ── Main executor ────────────────────────────────────────────────────────── */

/**
 * Spawn a child process for a job, stream logs, and handle completion.
 * @param {object} job
 * @param {{command: string, args: string[], cwd: string, env: object}} processConfig
 * @returns {Promise<void>}
 */
export const executeChildProcess = async (job, processConfig) => {
  const {updateJob, setJobStage, appendLog, getProcessFailureMessage, finalizeJob, handleAutoContinue} = deps;

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
          : "pipeline"
  );

  return new Promise((resolve) => {
    logJsonLine("info", "job_process_starting", {
      jobId: job.id,
      type: job.type,
      slug: job.slug,
      cwd: processConfig.cwd,
      command: processConfig.command,
      args: processConfig.args
    });

    const child = spawn(processConfig.command, processConfig.args, {
      cwd: processConfig.cwd,
      env: processConfig.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    registerJobProcess(job, child);

    const timeoutMs = getJobTimeoutMs(job);
    const timeoutLabel = formatTimeoutLabel(timeoutMs);
    const idleTimeoutMs = getJobIdleTimeoutMs(job);
    const idleTimeoutLabel = formatTimeoutLabel(idleTimeoutMs);
    let terminationReason = "";
    let idleTimer = null;

    const terminateChild = (reason, signal = "SIGTERM") => {
      if (terminationReason) {
        return;
      }

      terminationReason = reason;
      appendLog(job, `${reason}\n`, "stderr");
      updateJob(job, {
        terminationReason: reason
      });
      try { child.kill(signal); } catch {}
      void terminateJobProcessTree(job);
    };

    const timeoutTimer = setTimeout(() => {
      logJsonLine("warn", "job_process_timeout", {
        jobId: job.id,
        type: job.type,
        slug: job.slug,
        timeoutMs
      });
      terminateChild(`[timeout] Job excedeu ${timeoutLabel} de runtime total — matando processo.`);
    }, timeoutMs);

    const refreshIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        logJsonLine("warn", "job_process_idle_timeout", {
          jobId: job.id,
          type: job.type,
          slug: job.slug,
          idleTimeoutMs
        });
        terminateChild(`[timeout] Job ficou ${idleTimeoutLabel} sem atividade no processo — matando processo.`);
      }, idleTimeoutMs);
    };

    refreshIdleTimer();

    child.on("close", () => {
      clearTimeout(timeoutTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
    });

    child.stdout.on("data", (chunk) => {
      refreshIdleTimer();
      appendLog(job, chunk, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      refreshIdleTimer();
      appendLog(job, chunk, "stderr");
    });

    child.on("error", (error) => {
      clearJobProcess(job);
      clearTimeout(timeoutTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      logJsonLine("error", "job_process_spawn_failed", {
        jobId: job.id,
        type: job.type,
        slug: job.slug,
        error: serializeError(error)
      });
      updateJob(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message,
        terminationReason: error.message
      });
      resolve();
    });

    child.on("close", async (code) => {
      job.exitCode = typeof code === "number" ? code : null;
      job.completedAt = new Date().toISOString();
      clearJobProcess(job);

      if (code === 0) {
        try {
          await finalizeJob(job);
          updateJob(job, {status: "completed"});
          setJobStage(job, "completed");
          logJsonLine("info", "job_process_completed", {
            jobId: job.id,
            type: job.type,
            slug: job.slug,
            exitCode: code
          });
          await handleAutoContinue(job);
        } catch (error) {
          logJsonLine("error", "job_finalize_failed", {
            jobId: job.id,
            type: job.type,
            slug: job.slug,
            exitCode: code,
            error: serializeError(error)
          });
          updateJob(job, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        logJsonLine("warn", "job_process_failed", {
          jobId: job.id,
          type: job.type,
          slug: job.slug,
          exitCode: code
        });
        updateJob(job, {
          status: "failed",
          error: terminationReason || getProcessFailureMessage(job, `Processo terminou com codigo ${code}`),
          terminationReason: terminationReason || ""
        });
      }

      resolve();
    });
  });
};
