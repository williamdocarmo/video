#!/usr/bin/env node
// Re-renders a video with a new TTS voice, reusing existing scene clips.
// Usage: node scripts/rerender-voice.mjs --slug <slug> [--voice <name>] [--style-prompt <prompt>]
import "dotenv/config";
import {spawnSync} from "node:child_process";
import {access, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inferOutputProfileFromDimensions, resolveOutputProfileConfig} from "../../config/output-profiles.mjs";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";
import {extractTimedWordsFromAudio, synthesizeVoiceover, getAudioDurationSeconds, normalizePortugueseForTts} from "./lib/tts.mjs";
import {analyzeSceneSpeechPacing, buildTimeline} from "./lib/timings.mjs";
import {sanitizeTimedWordsForAudio} from "./lib/alignment-utils.mjs";
import {runStreamingCommand} from "./lib/clean-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const parseArgs = (argv) => {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slug") { parsed.slug = argv[++i]; continue; }
    if (argv[i] === "--voice") { parsed.voice = argv[++i]; continue; }
    if (argv[i] === "--style-prompt") { parsed.stylePrompt = argv[++i]; continue; }
    if (argv[i] === "--output-profile") { parsed.outputProfile = argv[++i]; continue; }
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
      sceneSpans.push({sceneIndex: index, startChar: text.length, endChar: text.length - 1});
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

const loadJsonIfExists = async (targetPath) => {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
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

const runLoggedCommand = async (command, args, options = {}) => {
  const result = await runStreamingCommand(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: {...process.env, ...(options.env ?? {})},
    compactProgress: options.compactProgress
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} falhou`);
  }
};

const applyValidationSummary = (report, validation, qaPass, outPath) => {
  report.status = qaPass ? "completed" : "failed";
  report.finalVideo = outPath;
  report.sceneCount = Number(validation.checks?.sceneCount || 0);
  report.durationSec = roundMetric(validation.metrics?.videoSeconds);
  report.audioDurationSec = roundMetric(validation.metrics?.audioSeconds);
  report.qa = {
    passed: qaPass,
    outputPath: outPath,
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
  const qaPass = Object.values(validation.checks || {}).every((value) => value === true || typeof value === "number");
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
  const runsDir = path.join(projectRoot, "runs", slug);

  // Load existing render-props (has scenes with clipPaths)
  const oldRenderProps = JSON.parse(await readFile(path.join(runsDir, "render-props.json"), "utf8"));
  const storyboard = JSON.parse(await readFile(path.join(runsDir, "storyboard.json"), "utf8"));
  const existingVoiceover = JSON.parse(
    await readFile(path.join(runsDir, "voiceover.json"), "utf8").catch(() => "{}")
  );
  const inferredProfile =
    resolveOutputProfileConfig(
      args.outputProfile ||
      oldRenderProps.outputProfile ||
      oldRenderProps.compositionId ||
      inferOutputProfileFromDimensions(oldRenderProps.videoWidth || oldRenderProps.width, oldRenderProps.videoHeight || oldRenderProps.height).id
    );

  process.stderr.write(`Re-render: ${slug}\n`);
  process.stderr.write(`Voz: ${voiceName} | Style: ${stylePrompt}\n`);
  process.stderr.write(`Perfil: ${inferredProfile.id}\n`);
  process.stderr.write(`Cenas: ${oldRenderProps.scenes.length} (reutilizadas)\n\n`);

  // 1. Generate new voiceover with the requested voice
  const audioDir = path.join(runsDir, "audio");
  await mkdir(audioDir, {recursive: true});
  const mp3Path = path.join(audioDir, "voiceover.mp3");
  const aiffPath = path.join(audioDir, "voiceover.aiff");
  const existingAudioPath = await resolveExistingAudioPath(projectRoot, slug, mp3Path);

  const selectedProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
  const voicePlan = buildVoiceText(storyboard.scenes);
  let voiceResult;
  let audioDurationSeconds;

  if (args.reuseExistingAudio) {
    process.stderr.write("Reutilizando voiceover.mp3 e reextraindo timedWords reais.\n");
    const extractedTiming = await extractTimedWordsFromAudio({
      mp3Path: existingAudioPath,
      text: voicePlan.text,
      languageCode: process.env.VIDEO_LANGUAGE || "pt-BR",
      sceneSpans: voicePlan.sceneSpans,
      allowEstimated: false
    });

    if (
      !isTrustedTimedWordsSource(extractedTiming.timedWordsSource) ||
      !timedWordsLookPlausible(extractedTiming.timedWords)
    ) {
      throw new Error("Nao consegui reextrair timedWords reais para --reuse-existing-audio.");
    }

    voiceResult = {
      provider: existingVoiceover.provider || "existing-audio",
      usageMetadata: existingVoiceover.usageMetadata ?? null,
      modelVersion: existingVoiceover.modelVersion ?? null,
      voiceName: existingVoiceover.voiceName ?? voiceName,
      timedWords: extractedTiming.timedWords,
      timedWordsSource: extractedTiming.timedWordsSource
    };
    audioDurationSeconds = getAudioDurationSeconds(existingAudioPath);
  } else {
    process.stderr.write(`Gerando TTS (${voicePlan.text.length} chars)...\n`);

    const selectedProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
    voiceResult = await synthesizeVoiceover({
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      voice: process.env.MACOS_VOICE || "Luciana",
      rate: process.env.TTS_RATE || 175,
      aiffPath,
      mp3Path,
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

    audioDurationSeconds = getAudioDurationSeconds(mp3Path);
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
  const scenesForTimeline = oldRenderProps.scenes.map((scene, index) => ({
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
    narrationPath: path.posix.join("runs", slug, "audio", "voiceover.mp3"),
    musicPath: oldRenderProps.musicPath || null,
    scenes: timeline.scenes,
    captions: timeline.captions
  };

  // 3. Save updated files
  await writeFile(path.join(runsDir, "render-props.json"), JSON.stringify(renderProps, null, 2));
  await writeFile(
    path.join(runsDir, "voiceover.json"),
    JSON.stringify({
      provider: voiceResult.provider,
      usageMetadata: voiceResult.usageMetadata ?? null,
      modelVersion: voiceResult.modelVersion ?? null,
      voiceName: voiceResult.voiceName ?? null,
      timedWordsSource: voiceResult.timedWordsSource ?? "unknown",
      text: voicePlan.text,
      sceneSpans: voicePlan.sceneSpans,
      timedWords: alignedTimedWords,
      sceneTimingAnalysis: sceneSpeechPacing
    }, null, 2)
  );

  // Copy audio to public dir for Remotion
  const publicAudioDir = path.join(projectRoot, "public", "runs", slug, "audio");
  await mkdir(publicAudioDir, {recursive: true});
  await writeFile(path.join(publicAudioDir, "voiceover.mp3"), await readFile(existingAudioPath));

  process.stderr.write(`Render-props e audio atualizados.\n`);
  process.stderr.write(`Duracao: ${(timeline.durationInFrames / 30).toFixed(1)}s (${timeline.durationInFrames} frames), ${renderProps.captions.length} legendas.\n\n`);

  if (args.noRender) {
    process.stderr.write("--no-render: render Remotion pulado.\n");
    return;
  }

  // 4. Render with Remotion
  const outDir = path.join(projectRoot, "out");
  await mkdir(outDir, {recursive: true});
  const outPath = path.join(outDir, `${slug}.mp4`);
  process.stderr.write(`Renderizando: ${outPath}\n`);

  await runLoggedCommand("npx", [
    "remotion", "render",
    "src/index.ts", inferredProfile.compositionId, outPath,
    `--props=${JSON.stringify(renderProps)}`,
    `--timeout=${process.env.REMOTION_TIMEOUT_MS || "1800000"}`,
    `--concurrency=${process.env.REMOTION_CONCURRENCY || "2"}`,
    `--scale=${process.env.REMOTION_SCALE || "0.75"}`,
    `--video-bitrate=${process.env.REMOTION_VIDEO_BITRATE || "1400k"}`,
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

  const validation = runJsonCommand("node", [path.join(projectRoot, "scripts", "validate-run.mjs"), "--slug", slug]);
  await persistValidationReports({slug, runsDir, outPath, validation});

  process.stderr.write(`\nPronto! Video: ${outPath}\n`);
  process.stdout.write(`${outPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
