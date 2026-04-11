#!/usr/bin/env node
// Re-renders a video with a new TTS voice, reusing existing scene clips.
// Usage: node scripts/rerender-voice.mjs --slug <slug> [--voice <name>] [--style-prompt <prompt>]
import "dotenv/config";
import {spawnSync} from "node:child_process";
import {access, copyFile, mkdir, readFile, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inferOutputProfileFromDimensions, resolveOutputProfileConfig} from "../../config/output-profiles.mjs";
import {fileExists, loadJsonIfExists, runLoggedCommand as runLoggedCommandBase} from "../../shared/utils.mjs";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";
import {extractTimedWordsFromAudio, synthesizeVoiceover, getAudioDurationSeconds, normalizePortugueseForTts} from "./lib/tts.mjs";
import {analyzeSceneSpeechPacing, buildTimeline} from "./lib/timings.mjs";
import {sanitizeTimedWordsForAudio} from "./lib/alignment-utils.mjs";
import {runStreamingCommand} from "./lib/clean-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const MIN_RENDERED_VIDEO_BYTES = Math.max(
  1024,
  Number.parseInt(process.env.MIN_OUTPUT_VIDEO_BYTES || "131072", 10) || 131072
);

const parseArgs = (argv) => {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") { parsed.slug = argv[++i]; continue; }
    if (argv[i] === "--voice") { parsed.voice = argv[++i]; continue; }
    if (argv[i] === "--style-prompt") { parsed.stylePrompt = argv[++i]; continue; }
    if (argv[i] === "--output-profile") { parsed.outputProfile = argv[++i]; continue; }
    if (argv[i] === "--caption-shift-frames") { parsed.captionShiftFrames = Number.parseInt(argv[++i], 10) || 0; continue; }
    if (argv[i] === "--no-render") { parsed.noRender = true; continue; }
    if (argv[i] === "--reuse-existing-audio") { parsed.reuseExistingAudio = true; continue; }
  }
  return parsed;
};

const TRUSTED_TIMED_WORD_SOURCES = new Set(["gcloud-speech-stt", "azure-word-boundary"]);

const normalizeTimedWordsSource = (source) => String(source || "").trim().toLowerCase();

const isTrustedTimedWordsSource = (source) => {
  const normalized = normalizeTimedWordsSource(source);
  return (
    TRUSTED_TIMED_WORD_SOURCES.has(normalized) ||
    [...TRUSTED_TIMED_WORD_SOURCES].some((base) => normalized === `${base}-rebuilt-from-audio`)
  );
};

const didQaPassChecks = (checks) =>
  Object.entries(checks || {})
    .filter(([, value]) => typeof value === "boolean")
    .every(([, value]) => value === true);

const timedWordsLookPlausible = (timedWords) => {
  if (!Array.isArray(timedWords) || timedWords.length === 0) {
    return false;
  }

  let previousStart = -Infinity;
  let previousEnd = -Infinity;

  for (const word of timedWords) {
    const startSeconds = Number(word?.startSeconds);
    const endSeconds = Number(word?.endSeconds);

    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
      return false;
    }

    if (startSeconds < 0 || endSeconds <= startSeconds) {
      return false;
    }

    if (startSeconds + 0.01 < previousStart || endSeconds + 0.01 < previousEnd) {
      return false;
    }

    previousStart = startSeconds;
    previousEnd = endSeconds;
  }

  return true;
};

const ensureVoiceEnding = (text) => {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (/[.!?…]$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
};

const buildVoiceText = (scenes) => {
  let text = "";
  const sceneSpans = [];
  scenes.forEach((scene, index) => {
    const narration = ensureVoiceEnding(normalizePortugueseForTts(scene.narration));
    if (!narration) {
      sceneSpans.push({sceneIndex: index, startChar: text.length, endChar: text.length, empty: true});
      return;
    }
    if (text.length > 0) text += " ";
    const startChar = text.length;
    text += narration;
    sceneSpans.push({sceneIndex: index, startChar, endChar: text.length - 1});
  });
  return {text, sceneSpans};
};

const roundMetric = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

const formatRushedSceneSummary = (scene) =>
  `cena ${scene.sceneIndex + 1} (${scene.timedWordCount} palavras em ${scene.durationSeconds}s, ${scene.wordsPerSecond} palavras/s)`;

const resolveStoryboardPath = async ({runsDir, slug}) => {
  const candidates = [
    path.join(runsDir, "storyboard.json"),
    path.join(projectRoot, "runs", `${slug}-preview`, "storyboard.json")
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Nao encontrei storyboard para ${slug}.`);
};

const resolveSceneClipCandidates = ({slug, sceneNumber, existingClipPath}) => {
  const fileName = `scene-${sceneNumber}.mp4`;
  const candidates = [];

  if (existingClipPath) {
    if (path.isAbsolute(existingClipPath)) {
      candidates.push(existingClipPath);
    } else {
      candidates.push(path.join(projectRoot, "public", existingClipPath));
    }
  }

  candidates.push(path.join(projectRoot, "assets", "envato", slug, fileName));
  return {
    fileName,
    candidates
  };
};

const inferAttributionFromClipPath = ({slug, clipPath}) => {
  const normalized = String(clipPath || "").replace(/\\/g, "/");
  const runPrefix = `runs/${slug}/video/`;
  if (normalized.includes(runPrefix) || /\/scene-\d{2}\.mp4$/i.test(normalized)) {
    return {source: "envato-local"};
  }

  return {source: "local-file"};
};

const publishSceneClip = async ({slug, sceneNumber, existingClipPath}) => {
  const {fileName, candidates} = resolveSceneClipCandidates({slug, sceneNumber, existingClipPath});
  const publicRelativePath = path.posix.join("runs", slug, "video", fileName);
  const publicAbsolutePath = path.join(projectRoot, "public", "runs", slug, "video", fileName);
  await mkdir(path.dirname(publicAbsolutePath), {recursive: true});

  let sourceClipPath = null;
  for (const candidate of candidates) {
    if (candidate && await fileExists(candidate)) {
      sourceClipPath = candidate;
      break;
    }
  }

  if (!sourceClipPath) {
    if (await fileExists(publicAbsolutePath)) {
      sourceClipPath = publicAbsolutePath;
    } else {
      throw new Error(`Falta o clip ${fileName} para montar o render.`);
    }
  }

  const publicExists = await fileExists(publicAbsolutePath);
  if (sourceClipPath !== publicAbsolutePath) {
    let shouldCopy = !publicExists;

    if (!shouldCopy) {
      const [sourceStat, publicStat] = await Promise.all([
        stat(sourceClipPath),
        stat(publicAbsolutePath)
      ]);
      shouldCopy =
        sourceStat.size !== publicStat.size ||
        sourceStat.mtimeMs > publicStat.mtimeMs + 1;
    }

    if (shouldCopy) {
      await copyFile(sourceClipPath, publicAbsolutePath);
    }
  }

  return publicRelativePath;
};

const tryPublishSceneClip = async ({slug, sceneNumber, existingClipPath}) => {
  try {
    return await publishSceneClip({slug, sceneNumber, existingClipPath});
  } catch (error) {
    if (String(error?.message || "").startsWith("Falta o clip ")) {
      return null;
    }
    throw error;
  }
};

const normalizeRenderScenesForRemotion = async ({slug, scenes, storyboardScenes}) => {
  const normalizedScenes = [];

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index] || {};
    const storyboardScene = storyboardScenes[index] || {};
    const sceneNumber = String(index + 1).padStart(2, "0");
    const normalizedScene = {
      ...scene,
      id: scene.id || `scene-${sceneNumber}`,
      title: storyboardScene.title || scene.title || `Cena ${sceneNumber}`,
      narration: storyboardScene.narration || scene.narration || "",
      overlay: storyboardScene.overlay || scene.overlay || "",
      searchQuery: storyboardScene.searchQuery || scene.searchQuery || "",
      sceneType: scene.sceneType || storyboardScene.sceneType || "stock",
      attribution: scene.attribution || storyboardScene.attribution || null
    };

    const publishedClipPath = await tryPublishSceneClip({
      slug,
      sceneNumber,
      existingClipPath: scene.clipPath
    });

    if (publishedClipPath) {
      normalizedScene.clipPath = publishedClipPath;
      normalizedScene.sceneType = "stock";
      const inferredAttribution = inferAttributionFromClipPath({
        slug,
        clipPath: publishedClipPath
      });
      if (!normalizedScene.attribution || normalizedScene.attribution?.source === "text-only-fallback") {
        normalizedScene.attribution = inferredAttribution;
      }
    }

    normalizedScenes.push(normalizedScene);
  }

  return normalizedScenes;
};

const buildFallbackRenderProps = async ({slug, storyboard, outputProfile, existingRenderProps}) => {
  const scenes = [];

  for (let index = 0; index < storyboard.scenes.length; index += 1) {
    const storyboardScene = storyboard.scenes[index];
    const sceneNumber = String(index + 1).padStart(2, "0");

    scenes.push({
      id: `scene-${sceneNumber}`,
      title: storyboardScene?.title || `Cena ${sceneNumber}`,
      narration: storyboardScene?.narration || "",
      overlay: storyboardScene?.overlay || "",
      searchQuery: storyboardScene?.searchQuery || "",
      clipPath: await publishSceneClip({slug, sceneNumber}),
      attribution: storyboardScene?.attribution || null,
      sceneType: storyboardScene?.sceneType || "stock"
    });
  }

  return {
    title: existingRenderProps?.title || storyboard.videoTitle || slug,
    hook: existingRenderProps?.hook || storyboard.hook || "",
    cta: existingRenderProps?.cta || storyboard.cta || "",
    channelHandle: existingRenderProps?.channelHandle || "@teucanal",
    musicPath: existingRenderProps?.musicPath || null,
    outputProfile: outputProfile.id,
    compositionId: outputProfile.compositionId,
    videoWidth: outputProfile.width,
    videoHeight: outputProfile.height,
    scenes
  };
};

const runJsonCommand = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} falhou`);
  }

  return JSON.parse(result.stdout || "{}");
};

const ffprobeDurationSeconds = (targetPath) => {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetPath],
    {
      cwd: projectRoot,
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error(`ffprobe falhou para ${targetPath}`);
  }

  return Number.parseFloat(String(result.stdout || "").trim());
};

const mediaDecodesCleanly = (targetPath) => {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", targetPath, "-f", "null", "-"],
    {
      cwd: projectRoot,
      encoding: "utf8"
    }
  );

  return result.status === 0;
};

const assertRenderedVideoHealthy = async ({slug, outPath, audioDurationSeconds}) => {
  const outputStat = await stat(outPath);
  if (!outputStat.isFile() || outputStat.size < MIN_RENDERED_VIDEO_BYTES) {
    throw new Error(
      `Render produziu MP4 invalido para ${slug} (tamanho=${outputStat.size} bytes, minimo=${MIN_RENDERED_VIDEO_BYTES}).`
    );
  }

  const videoDurationSeconds = ffprobeDurationSeconds(outPath);
  if (!Number.isFinite(videoDurationSeconds) || videoDurationSeconds < 1) {
    throw new Error(`Render produziu MP4 sem duracao valida para ${slug}.`);
  }

  if (!mediaDecodesCleanly(outPath)) {
    throw new Error(`Render produziu MP4 corrompido ou nao-decodificavel para ${slug}.`);
  }

  if (
    Number.isFinite(audioDurationSeconds) &&
    audioDurationSeconds > 0 &&
    Math.abs(videoDurationSeconds - audioDurationSeconds) > 5
  ) {
    throw new Error(
      `Render produziu MP4 com drift excessivo (${videoDurationSeconds.toFixed(2)}s vs audio ${audioDurationSeconds.toFixed(2)}s).`
    );
  }
};

const runLoggedCommand = async (command, args, options = {}) => {
  if (options.compactProgress) {
    const result = await runStreamingCommand(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: {...process.env, ...(options.env ?? {})},
      compactProgress: true
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `${command} falhou`);
    }
    return;
  }
  const result = await runLoggedCommandBase(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} falhou`);
  }
};

const applyValidationSummary = (report, validation, qaPass, outPath) => {
  const outputMtimeMs = Number(validation?.metrics?.outputMtimeMs || 0) || 0;
  const outputSizeBytes = Number(validation?.checks?.outputSizeBytes || 0) || 0;

  report.status = qaPass ? "completed" : "failed";
  report.finalVideo = outPath;
  report.sceneCount = Number(validation.checks?.sceneCount || 0);
  report.durationSec = roundMetric(validation.metrics?.videoSeconds);
  report.audioDurationSec = roundMetric(validation.metrics?.audioSeconds);
  report.validation = validation;
  report.validationMeta = {
    slug: validation?.slug || "",
    outputPath: outPath,
    outputMtimeMs,
    outputSizeBytes,
    validatedAt: new Date().toISOString()
  };
  report.qa = {
    passed: qaPass,
    slug: validation?.slug || "",
    outputPath: outPath,
    outputMtimeMs,
    outputSizeBytes,
    validation,
    checks: validation.checks,
    metrics: validation.metrics
  };
  report.completedAt = new Date().toISOString();
};

const updateQaAgent = (report, validation, qaPass) => {
  if (!report?.agents?.qa) {
    return;
  }

  report.agents.qa.status = qaPass ? "completed" : "failed";
  report.agents.qa.validation = validation;
  if (!Array.isArray(report.agents.qa.notes)) {
    report.agents.qa.notes = [];
  }

  report.agents.qa.notes = report.agents.qa.notes.filter(
    (note) => !String(note).startsWith("Validacao pos-rerender")
  );
  report.agents.qa.notes.push(qaPass ? "Validacao pos-rerender passou." : "Validacao pos-rerender falhou.");
};

const persistValidationReports = async ({slug, runsDir, outPath, validation}) => {
  const qaPass = validation?.qaPass === true || didQaPassChecks(validation?.checks);
  const reportPaths = [
    path.join(runsDir, "agent-report.json"),
    path.join(runsDir, "orchestration-report.json")
  ];

  for (const reportPath of reportPaths) {
    const report = await loadJsonIfExists(reportPath);
    if (!report) {
      continue;
    }

    applyValidationSummary(report, validation, qaPass, outPath);
    updateQaAgent(report, validation, qaPass);
    if (report?.agents?.editor) {
      report.agents.editor.audioDurationSeconds = roundMetric(validation.metrics?.audioSeconds);
    }
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }

  process.stderr.write(
    `[qa] resumo: status=${qaPass ? "ok" : "fail"} scenes=${validation.checks.sceneCount} ` +
    `audio=${roundMetric(validation.metrics.audioSeconds, 2)}s ` +
    `video=${roundMetric(validation.metrics.videoSeconds, 2)}s ` +
    `envatoOnly=${validation.checks.envatoOnly} ` +
    `linkedNarration=${validation.checks.linkedNarration} ` +
    `sync=${validation.checks.audioVideoSyncOk}\n`
  );

  if (!qaPass) {
    throw new Error(`QA reprovou a run ${slug} apos o rerender.`);
  }
};

const resolveExistingAudioPath = async (projectRootPath, slug, preferredPath) => {
  const candidates = [
    preferredPath,
    path.join(projectRootPath, "public", "runs", slug, "audio", "voiceover.mp3")
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep trying
    }
  }

  return preferredPath;
};

const copyFileIfNeeded = async (sourcePath, targetPath) => {
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    return;
  }

  await copyFile(sourcePath, targetPath);
};

const buildVoiceoverPayload = ({
  voiceResult,
  existingVoiceover,
  reuseExistingAudio,
  selectedProvider,
  voiceName,
  voicePlan,
  alignedTimedWords,
  sceneSpeechPacing
}) => ({
  provider:
    voiceResult.provider ||
    existingVoiceover.provider ||
    (reuseExistingAudio ? "existing-audio" : selectedProvider || "auto"),
  usageMetadata: voiceResult.usageMetadata ?? null,
  modelVersion: voiceResult.modelVersion ?? null,
  voiceName: voiceResult.voiceName || existingVoiceover.voiceName || voiceName || null,
  timedWordsSource: voiceResult.timedWordsSource ?? "unknown",
  text: voicePlan.text,
  sceneSpans: voicePlan.sceneSpans,
  timedWords: alignedTimedWords,
  sceneTimingAnalysis: sceneSpeechPacing
});

const clampFrame = (value, min, max) => Math.min(max, Math.max(min, value));

const resolveCaptionSceneBounds = ({caption, scenes, lastFrame}) => {
  const matchingScene = Array.isArray(scenes)
    ? scenes.find((scene) => {
        const sceneStart = Math.round(Number(scene?.startFrame || 0));
        const sceneEnd = sceneStart + Math.max(1, Math.round(Number(scene?.durationInFrames || 1))) - 1;
        return (
          Math.round(Number(caption?.startFrame || 0)) >= sceneStart &&
          Math.round(Number(caption?.endFrame || 0)) <= sceneEnd
        );
      })
    : null;
  const minFrame = matchingScene ? Math.round(Number(matchingScene.startFrame || 0)) : 0;
  const maxFrame = matchingScene
    ? minFrame + Math.max(1, Math.round(Number(matchingScene.durationInFrames || 1))) - 1
    : lastFrame;

  return {matchingScene, minFrame, maxFrame};
};

const shiftCaptionFrames = ({captions, shiftFrames, totalFrames, scenes = []}) => {
  if (!Array.isArray(captions) || captions.length === 0 || !Number.isFinite(shiftFrames) || shiftFrames === 0) {
    return captions;
  }

  const lastFrame = Math.max(0, Math.round(Number(totalFrames || 0)) - 1);
  const shiftedCaptions = captions.map((caption) => {
    const {minFrame, maxFrame} = resolveCaptionSceneBounds({caption, scenes, lastFrame});
    const startFrame = clampFrame(Math.round(Number(caption.startFrame || 0)) + shiftFrames, minFrame, maxFrame);
    const endFrame = clampFrame(
      Math.round(Number(caption.endFrame || 0)) + shiftFrames,
      startFrame,
      maxFrame
    );
    const words = Array.isArray(caption.words)
      ? caption.words.map((word) => {
          const wordStartFrame = clampFrame(Math.round(Number(word.startFrame || 0)) + shiftFrames, startFrame, endFrame);
          const wordEndFrame = clampFrame(
            Math.round(Number(word.endFrame || 0)) + shiftFrames,
            wordStartFrame,
            endFrame
          );

          return {
            ...word,
            startFrame: wordStartFrame,
            endFrame: wordEndFrame
          };
        })
      : [];

    return {
      ...caption,
      startFrame,
      endFrame,
      words
    };
  });

  for (let index = 0; index < shiftedCaptions.length; index += 1) {
    const current = shiftedCaptions[index];
    const {minFrame, maxFrame} = resolveCaptionSceneBounds({caption: current, scenes, lastFrame});
    const next = shiftedCaptions[index + 1] ?? null;
    const nextBounds = next ? resolveCaptionSceneBounds({caption: next, scenes, lastFrame}) : null;
    const sameScene = Boolean(next) && minFrame === nextBounds?.minFrame && maxFrame === nextBounds?.maxFrame;
    const desiredEndFrame = sameScene
      ? Math.min(maxFrame, Math.max(current.startFrame, Math.round(Number(next.startFrame || current.endFrame + 1)) - 1))
      : Math.max(current.endFrame, Math.min(maxFrame, lastFrame));

    if (desiredEndFrame > current.endFrame) {
      current.endFrame = desiredEndFrame;

      if (Array.isArray(current.words) && current.words.length > 0) {
        current.words[current.words.length - 1].endFrame = Math.max(
          current.words[current.words.length - 1].startFrame,
          desiredEndFrame
        );
      }
    }
  }

  return shiftedCaptions;
};

const persistCanonicalArtifacts = async ({
  runsDir,
  slug,
  storyboard,
  assetPlan,
  renderProps,
  voiceoverPayload,
  audioSourcePath
}) => {
  const audioDir = path.join(runsDir, "audio");
  const canonicalRunAudioPath = path.join(audioDir, "voiceover.mp3");
  const publicAudioDir = path.join(projectRoot, "public", "runs", slug, "audio");
  const canonicalPublicAudioPath = path.join(publicAudioDir, "voiceover.mp3");

  await mkdir(runsDir, {recursive: true});
  await mkdir(audioDir, {recursive: true});
  await mkdir(publicAudioDir, {recursive: true});

  await writeFile(path.join(runsDir, "storyboard.json"), JSON.stringify(storyboard, null, 2));
  await writeFile(path.join(runsDir, "asset-plan.json"), JSON.stringify(assetPlan, null, 2));
  await writeFile(path.join(runsDir, "render-props.json"), JSON.stringify(renderProps, null, 2));
  await writeFile(path.join(runsDir, "voiceover.json"), JSON.stringify(voiceoverPayload, null, 2));
  await copyFileIfNeeded(audioSourcePath, canonicalRunAudioPath);
  await copyFileIfNeeded(audioSourcePath, canonicalPublicAudioPath);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  loadSecretsIntoEnv(["GOOGLE_API_KEY", "AZURE_SPEECH_KEY"]);

  if (!args.slug) {
    process.stderr.write("Uso: node scripts/rerender-voice.mjs --slug <slug> [--voice pt-BR-AntonioNeural] [--style-prompt '...']\n");
    process.exit(1);
  }

  const slug = args.slug;
  const voiceName = args.voice || process.env.AZURE_TTS_VOICE || process.env.GOOGLE_TTS_VOICE || "pt-BR-AntonioNeural";
  const stylePrompt = args.stylePrompt || process.env.GOOGLE_TTS_STYLE_PROMPT || "com voz masculina natural, segura e calorosa";
  const captionShiftFrames = Number.isFinite(args.captionShiftFrames) ? args.captionShiftFrames : 0;
  const runsDir = path.join(projectRoot, "runs", slug);
  const storyboardPath = await resolveStoryboardPath({runsDir, slug});
  const storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
  const existingRenderProps = await loadJsonIfExists(path.join(runsDir, "render-props.json"));
  const existingVoiceover = (await loadJsonIfExists(path.join(runsDir, "voiceover.json"))) || {};
  const inferredProfile = resolveOutputProfileConfig(
    args.outputProfile ||
    existingRenderProps?.outputProfile ||
    existingRenderProps?.compositionId ||
    inferOutputProfileFromDimensions(existingRenderProps?.videoWidth || existingRenderProps?.width, existingRenderProps?.videoHeight || existingRenderProps?.height).id
  );
  const oldRenderProps = existingRenderProps || await buildFallbackRenderProps({
    slug,
    storyboard,
    outputProfile: inferredProfile,
    existingRenderProps
  });
  const normalizedRenderScenes = await normalizeRenderScenesForRemotion({
    slug,
    scenes: Array.isArray(oldRenderProps?.scenes) ? oldRenderProps.scenes : [],
    storyboardScenes: Array.isArray(storyboard?.scenes) ? storyboard.scenes : []
  });

  process.stderr.write(`Re-render: ${slug}\n`);
  process.stderr.write(`Voz: ${voiceName} | Style: ${stylePrompt}\n`);
  process.stderr.write(`Perfil: ${inferredProfile.id}\n`);
  process.stderr.write(`Cenas: ${normalizedRenderScenes.length} (reutilizadas)\n\n`);
  if (captionShiftFrames !== 0) {
    process.stderr.write(`Legenda: shift global de ${captionShiftFrames} frame(s).\n\n`);
  }

  // 1. Generate new voiceover with the requested voice
  const audioDir = path.join(runsDir, "audio");
  await mkdir(audioDir, {recursive: true});
  const canonicalRunAudioPath = path.join(audioDir, "voiceover.mp3");
  const stagedRunAudioPath = path.join(audioDir, "voiceover.next.mp3");
  const aiffPath = path.join(audioDir, "voiceover.next.aiff");
  const existingAudioPath = await resolveExistingAudioPath(projectRoot, slug, canonicalRunAudioPath);
  let audioSourcePath = existingAudioPath;

  const selectedProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
  const voicePlan = buildVoiceText(storyboard.scenes);
  let voiceResult;
  let audioDurationSeconds;

  if (args.reuseExistingAudio) {
    process.stderr.write("Reutilizando voiceover.mp3 e reextraindo timedWords reais.\n");
    let extractedTiming = null;

    try {
      extractedTiming = await extractTimedWordsFromAudio({
        mp3Path: existingAudioPath,
        text: voicePlan.text,
        languageCode: process.env.VIDEO_LANGUAGE || "pt-BR",
        sceneSpans: voicePlan.sceneSpans,
        allowEstimated: false
      });
    } catch (error) {
      process.stderr.write(`Reextracao falhou: ${error instanceof Error ? error.message : String(error)}\n`);
    }

    const canUseExtractedTiming =
      extractedTiming &&
      isTrustedTimedWordsSource(extractedTiming.timedWordsSource) &&
      timedWordsLookPlausible(extractedTiming.timedWords);
    const canUseStoredTiming =
      isTrustedTimedWordsSource(existingVoiceover.timedWordsSource) &&
      timedWordsLookPlausible(existingVoiceover.timedWords);

    if (!canUseExtractedTiming && !canUseStoredTiming) {
      throw new Error("Nao consegui timedWords confiaveis para --reuse-existing-audio.");
    }

    if (!canUseExtractedTiming && canUseStoredTiming) {
      process.stderr.write(
        `Reutilizando timedWords salvos da run (${existingVoiceover.timedWordsSource}).\n`
      );
    }

    voiceResult = {
      provider: existingVoiceover.provider || "existing-audio",
      usageMetadata: existingVoiceover.usageMetadata ?? null,
      modelVersion: existingVoiceover.modelVersion ?? null,
      voiceName: existingVoiceover.voiceName ?? voiceName,
      timedWords: canUseExtractedTiming ? extractedTiming.timedWords : existingVoiceover.timedWords,
      timedWordsSource: canUseExtractedTiming ? extractedTiming.timedWordsSource : existingVoiceover.timedWordsSource
    };
    audioDurationSeconds = getAudioDurationSeconds(existingAudioPath);
    audioSourcePath = existingAudioPath;
  } else {
    process.stderr.write(`Gerando TTS (${voicePlan.text.length} chars)...\n`);
    voiceResult = await synthesizeVoiceover({
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      voice: process.env.MACOS_VOICE || "Luciana",
      rate: process.env.TTS_RATE || 175,
      aiffPath,
      mp3Path: stagedRunAudioPath,
      provider: selectedProvider,
      elevenlabs: {},
      google: {
        model: process.env.GOOGLE_TTS_MODEL || "gemini-2.5-flash-preview-tts",
        voiceName: voiceName || process.env.TTS_VOICE || "pt-BR-Chirp3-HD-Achernar",
        languageCode: process.env.VIDEO_LANGUAGE || "pt-BR",
        stylePrompt
      },
      azure: {
        apiKey: process.env.AZURE_SPEECH_KEY || "",
        region: process.env.AZURE_SPEECH_REGION || "",
        endpoint: process.env.AZURE_SPEECH_ENDPOINT || "",
        voiceName: voiceName || process.env.AZURE_TTS_VOICE || "pt-BR-AntonioNeural",
        languageCode: process.env.VIDEO_LANGUAGE || "pt-BR"
      }
    });

    audioDurationSeconds = getAudioDurationSeconds(stagedRunAudioPath);
    audioSourcePath = stagedRunAudioPath;
  }

  let alignedTimedWords = Array.isArray(voiceResult.timedWords) ? voiceResult.timedWords : [];
  const normalizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords: alignedTimedWords,
    audioDurationSeconds
  });
  alignedTimedWords = normalizedTimedWords.timedWords;
  if (
    normalizedTimedWords.metadata.scaled ||
    normalizedTimedWords.metadata.clampedCount > 0 ||
    normalizedTimedWords.metadata.droppedCount > 0
  ) {
    process.stderr.write(
      `TimedWords ajustados para o audio real ` +
      `(max ${normalizedTimedWords.metadata.originalMaxEndSeconds}s -> ${normalizedTimedWords.metadata.finalMaxEndSeconds}s).\n`
    );
  }
  process.stderr.write(`Audio: ${audioDurationSeconds.toFixed(1)}s, ${alignedTimedWords.length} palavras com timestamps.\n`);

  if (alignedTimedWords.length === 0) {
    throw new Error("Nao encontrei timedWords suficientes para manter karaoke e sync confiavel.");
  }

  const sceneSpeechPacing = analyzeSceneSpeechPacing({
    scenes: storyboard.scenes,
    timedWords: alignedTimedWords,
    audioDurationSeconds,
    sceneSpans: voicePlan.sceneSpans
  });

  if (sceneSpeechPacing.rushedScenes.length > 0) {
    throw new Error(
      `TTS gerou pacing incoerente no rerender: ${sceneSpeechPacing.rushedScenes
        .slice(0, 3)
        .map(formatRushedSceneSummary)
        .join("; ")}.`
    );
  }

  // 2. Rebuild timeline and captions using OLD scene clips + NEW audio timing
  const scenesForTimeline = normalizedRenderScenes.map((scene, index) => ({
    id: scene.id,
    title: storyboard.scenes[index]?.title || scene.title,
    narration: storyboard.scenes[index]?.narration || scene.narration,
    overlay: storyboard.scenes[index]?.overlay || scene.overlay,
    searchQuery: scene.searchQuery || "",
    clipPath: scene.clipPath,
    attribution: scene.attribution || null,
    sceneType: scene.sceneType || "stock"
  }));

  const timeline = buildTimeline({
    scenes: scenesForTimeline,
    audioDurationSeconds,
    fps: 30,
    timedWords: alignedTimedWords,
    sceneSpans: voicePlan.sceneSpans
  });
  const shiftedCaptions = shiftCaptionFrames({
    captions: timeline.captions,
    shiftFrames: captionShiftFrames,
    totalFrames: timeline.durationInFrames,
    scenes: timeline.scenes
  });

  const canonicalNarrationPath = path.posix.join("runs", slug, "audio", "voiceover.mp3");
  const stagedNarrationPath = path.posix.join("runs", slug, "audio", "voiceover.next.mp3");
  const renderProps = {
    title: oldRenderProps.title,
    hook: oldRenderProps.hook,
    cta: oldRenderProps.cta,
    channelHandle: oldRenderProps.channelHandle || "@teucanal",
    outputProfile: inferredProfile.id,
    compositionId: inferredProfile.compositionId,
    videoWidth: inferredProfile.width,
    videoHeight: inferredProfile.height,
    durationInFrames: timeline.durationInFrames,
    narrationPath: canonicalNarrationPath,
    musicPath: oldRenderProps.musicPath || null,
    scenes: timeline.scenes,
    captions: shiftedCaptions
  };
  const assetPlan = scenesForTimeline.map((scene) => {
    const hasClip = Boolean(scene.clipPath);
    const inferredAttribution = hasClip
      ? (
          scene.attribution ||
          inferAttributionFromClipPath({
            slug,
            clipPath: scene.clipPath
          })
        )
      : null;

    return {
      id: scene.id,
      title: scene.title,
      narration: scene.narration,
      overlay: scene.overlay,
      searchQuery: scene.searchQuery || "",
      sceneType: scene.sceneType || (hasClip ? "stock" : "text-only"),
      clipPath: scene.clipPath || null,
      attribution: inferredAttribution,
      queryUsed: scene.searchQuery || null,
      failureReason: null
    };
  });

  const voiceoverPayload = buildVoiceoverPayload({
    voiceResult,
    existingVoiceover,
    reuseExistingAudio: args.reuseExistingAudio,
    selectedProvider,
    voiceName,
    voicePlan,
    alignedTimedWords,
    sceneSpeechPacing
  });

  const publicAudioDir = path.join(projectRoot, "public", "runs", slug, "audio");
  const stagedPublicAudioPath = path.join(publicAudioDir, "voiceover.next.mp3");
  const renderPropsForRemotion = args.noRender
    ? renderProps
    : {
        ...renderProps,
        narrationPath: stagedNarrationPath
      };

  if (args.noRender) {
    await persistCanonicalArtifacts({
      runsDir,
      slug,
      storyboard,
      assetPlan,
      renderProps,
      voiceoverPayload,
      audioSourcePath
    });
    process.stderr.write(`Render-props e audio atualizados.\n`);
    process.stderr.write(`Duracao: ${(timeline.durationInFrames / 30).toFixed(1)}s (${timeline.durationInFrames} frames), ${renderProps.captions.length} legendas.\n\n`);
    process.stderr.write("--no-render: render Remotion pulado.\n");
    return;
  }

  // 4. Render with Remotion
  await mkdir(publicAudioDir, {recursive: true});
  await copyFileIfNeeded(audioSourcePath, stagedPublicAudioPath);
  const outDir = path.join(projectRoot, "out");
  await mkdir(outDir, {recursive: true});
  const outPath = path.join(outDir, `${slug}.mp4`);
  process.stderr.write(`Renderizando: ${outPath}\n`);

  await runLoggedCommand("npx", [
    "remotion", "render",
    "src/index.ts", inferredProfile.compositionId, outPath,
    `--props=${JSON.stringify(renderPropsForRemotion)}`,
    `--timeout=${process.env.REMOTION_TIMEOUT_MS || "1800000"}`,
    `--concurrency=${process.env.REMOTION_CONCURRENCY || "2"}`,
    `--scale=${process.env.REMOTION_SCALE || "1"}`,
    `--video-bitrate=${process.env.REMOTION_VIDEO_BITRATE || "9M"}`,
    `--audio-bitrate=${process.env.REMOTION_AUDIO_BITRATE || "96k"}`,
    `--x264-preset=${process.env.REMOTION_X264_PRESET || "veryfast"}`
  ], {
    compactProgress: true,
    env: {
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0"
    }
  });
  await assertRenderedVideoHealthy({slug, outPath, audioDurationSeconds});

  await persistCanonicalArtifacts({
    runsDir,
    slug,
    storyboard,
    assetPlan,
    renderProps,
    voiceoverPayload,
    audioSourcePath
  });
  process.stderr.write(`Render-props e audio atualizados.\n`);
  process.stderr.write(`Duracao: ${(timeline.durationInFrames / 30).toFixed(1)}s (${timeline.durationInFrames} frames), ${renderProps.captions.length} legendas.\n\n`);

  const validation = runJsonCommand("node", [path.join(projectRoot, "scripts", "validate-run.mjs"), "--slug", slug]);
  await persistValidationReports({slug, runsDir, outPath, validation});

  process.stderr.write(`\nPronto! Video: ${outPath}\n`);
  process.stdout.write(`${outPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
