import {spawn, spawnSync} from "node:child_process";
import path from "node:path";

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
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
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
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
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

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug", job.slug,
      "--output-profile", profile.id,
      "--voice", job.input.voice,
      "--style-prompt", job.input.stylePrompt,
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
      TTS_PROVIDER: job.input.audioProvider === "elevenlabs" ? "elevenlabs" : (baseChildEnv.TTS_PROVIDER || "auto"),
      ELEVENLABS_VOICE_ID: job.input.audioProvider === "elevenlabs" ? job.input.voice : "",
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

  return {
    command: "node",
    args: [
      path.join(configuredVideoEngineRoot, "scripts", "rerender-voice.mjs"),
      "--slug", job.slug,
      "--output-profile", profile.id,
      "--voice", job.input.voice,
      "--style-prompt", job.input.stylePrompt,
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
          await finalizeJob(job);
          updateJob(job, {status: "completed"});
          setJobStage(job, "completed");
          await handleAutoContinue(job);
        } catch (error) {
          updateJob(job, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error)
          });
        }
      } else {
        updateJob(job, {
          status: "failed",
          error: getProcessFailureMessage(job, `Processo terminou com codigo ${code}`)
        });
      }

      resolve();
    });
  });
};
