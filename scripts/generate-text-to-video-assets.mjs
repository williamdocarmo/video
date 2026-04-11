#!/usr/bin/env node

import path from "node:path";
import {fileURLToPath} from "node:url";
import {existsSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {DEFAULT_VISUAL_STYLE_PRESET, VISUAL_STYLE_PRESETS} from "../config/visual-style-presets.mjs";
import {normalizeText, parseEnvFile, sleep} from "../shared/utils.mjs";
import {getGcpAccessToken, resolveGcpConfig} from "../video-engine/scripts/lib/gcp-config.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const wrapperRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultVideoEngineRoot = path.join(wrapperRoot, "video-engine");

const resolvePathFrom = (baseDir, value, fallback = "") => {
  const raw = String(value || fallback || "").trim();

  if (!raw) {
    return "";
  }

  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--storyboard-file") {
      parsed.storyboardFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--slug") {
      parsed.slug = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--asset-dir") {
      parsed.assetDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--scene-number") {
      parsed.sceneNumber = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--help") {
      parsed.help = true;
    }
  }

  return parsed;
};

const printHelp = () => {
  process.stdout.write(
    [
      "Uso:",
      "  node scripts/generate-text-to-video-assets.mjs --storyboard-file runs/<slug>/storyboard.json --slug <slug>",
      "",
      "Opcoes:",
      "  --storyboard-file <path>",
      "  --slug <slug>",
      "  --asset-dir <path>",
      "  --scene-number <numero>",
      "  --help"
    ].join("\n") + "\n"
  );
};

const loadEnv = async (projectRoot) => {
  const rootEnv = await parseEnvFile(path.join(wrapperRoot, ".env"));
  const videoEnv = await parseEnvFile(path.join(projectRoot, ".env"));

  for (const [key, value] of Object.entries({...rootEnv, ...videoEnv})) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
};

const normalizeClipDurationSeconds = (value) => {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 4;
  }

  if (numeric <= 5) {
    return 4;
  }

  if (numeric <= 7) {
    return 6;
  }

  return 8;
};

const countNarrationWords = (value) =>
  String(normalizeText(value || ""))
    .split(/\s+/)
    .filter(Boolean).length;

const getSceneTimingWeight = (scene) => Math.max(6, countNarrationWords(scene?.narration));

const readJsonIfExists = async (filePath) => {
  if (!filePath || !existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
};

const sceneTimingMatchesStoryboard = ({sceneStats, storyboardScenes}) => {
  if (!Array.isArray(sceneStats) || sceneStats.length !== storyboardScenes.length) {
    return false;
  }

  let mismatches = 0;

  for (let index = 0; index < storyboardScenes.length; index += 1) {
    const scene = storyboardScenes[index];
    const stat = sceneStats[index] || {};
    const titleMatches =
      normalizeText(stat?.title || "").toLowerCase() === normalizeText(scene?.title || "").toLowerCase();
    const sourceWordCount = Number(stat?.sourceWordCount || 0);
    const currentWordCount = countNarrationWords(scene?.narration);

    if (!titleMatches && Math.abs(sourceWordCount - currentWordCount) > 2) {
      mismatches += 1;
    }
  }

  return mismatches <= Math.max(1, Math.floor(storyboardScenes.length * 0.15));
};

const loadExistingSceneTiming = async ({projectRoot, slug, storyboardScenes}) => {
  const voiceoverPath = path.join(projectRoot, "runs", slug, "voiceover.json");
  const payload = await readJsonIfExists(voiceoverPath);
  const sceneStats = Array.isArray(payload?.sceneTimingAnalysis?.sceneStats)
    ? payload.sceneTimingAnalysis.sceneStats
    : [];

  if (!sceneTimingMatchesStoryboard({sceneStats, storyboardScenes})) {
    return null;
  }

  return {
    voiceoverPath,
    sceneStats
  };
};

const buildSceneDurationPlan = ({
  storyboardScenes,
  targetSeconds,
  forcedClipDurationSeconds,
  existingSceneTiming
}) => {
  const wordsPerSecond = Math.max(
    1.2,
    Number.parseFloat(process.env.TEXT_TO_VIDEO_WORDS_PER_SECOND || "2.2") || 2.2
  );
  const weights = storyboardScenes.map((scene) => getSceneTimingWeight(scene));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  return storyboardScenes.map((scene, sceneIndex) => {
    const sceneNumber = sceneIndex + 1;
    const measuredDurationSeconds = Number(existingSceneTiming?.sceneStats?.[sceneIndex]?.durationSeconds || 0);
    let rawDurationSeconds = 0;
    let durationSource = "narration-words";

    if (Number.isFinite(forcedClipDurationSeconds) && forcedClipDurationSeconds > 0) {
      rawDurationSeconds = forcedClipDurationSeconds;
      durationSource = "fixed-env";
    } else if (Number.isFinite(measuredDurationSeconds) && measuredDurationSeconds > 0) {
      rawDurationSeconds = measuredDurationSeconds;
      durationSource = "voiceover-scene-timing";
    } else if (Number.isFinite(targetSeconds) && targetSeconds > 0 && totalWeight > 0) {
      rawDurationSeconds = (weights[sceneIndex] / totalWeight) * targetSeconds;
      durationSource = "storyboard-target-allocation";
    } else {
      rawDurationSeconds = weights[sceneIndex] / wordsPerSecond;
      durationSource = `narration-words@${wordsPerSecond.toFixed(2)}wps`;
    }

    return {
      sceneNumber,
      durationSeconds: normalizeClipDurationSeconds(rawDurationSeconds),
      rawDurationSeconds: Number(rawDurationSeconds.toFixed(2)),
      durationSource
    };
  });
};

const summarizeDurationPlan = (sceneDurations) => {
  const bucketCounts = new Map();

  for (const entry of sceneDurations) {
    const key = `${entry.durationSeconds}s`;
    bucketCounts.set(key, (bucketCounts.get(key) || 0) + 1);
  }

  return ["4s", "6s", "8s"]
    .map((bucket) => `${bucket}=${bucketCounts.get(bucket) || 0}`)
    .join(" ");
};

const getAspectRatio = ({width, height}) =>
  Number(width || 0) > Number(height || 0) ? "16:9" : "9:16";

const getResolution = ({width, height}) =>
  Math.max(Number(width || 0), Number(height || 0)) >= 1920 ? "1080p" : "720p";

const getStylePreset = (styleId) => {
  const normalized = String(styleId || "").trim();
  return VISUAL_STYLE_PRESETS[normalized] || VISUAL_STYLE_PRESETS[DEFAULT_VISUAL_STYLE_PRESET];
};

const sanitizeThirdPartyTerms = (value) =>
  String(value || "")
    .replace(/\bNapster\b/gi, "an early peer-to-peer music sharing service")
    .replace(/\bSpotify\b/gi, "a modern music streaming service")
    .replace(/\biTunes\b/gi, "a digital music store")
    .replace(/\bYouTube\b/gi, "a large online video platform")
    .replace(/\bMP3\b/gi, "digital music files")
    .replace(/\bCDs?\b/g, "compact discs")
    .replace(/\bgravadoras\b/gi, "record labels")
    .replace(/\blogos?\b/gi, "brand marks");

const buildPrompt = ({scene, sceneNumber, stylePreset}) => {
  const primaryVisual = sanitizeThirdPartyTerms(normalizeText(scene?.searchQuery || scene?.visualGoal || scene?.title));
  const visualGoal = sanitizeThirdPartyTerms(normalizeText(scene?.visualGoal));
  const sceneTitle = sanitizeThirdPartyTerms(normalizeText(scene?.title));
  const narration = sanitizeThirdPartyTerms(normalizeText(scene?.narration));
  const stylePrompt = normalizeText(stylePreset?.stylePrompt);
  const styleLockPrompt = normalizeText(stylePreset?.styleLockPrompt);
  const compositionRules = normalizeText(stylePreset?.compositionRules);
  const lighting = normalizeText(stylePreset?.defaultLighting);
  const backgroundDirectives = Array.isArray(stylePreset?.backgroundDirectives)
    ? stylePreset.backgroundDirectives.slice(0, 2).map((item) => normalizeText(item)).filter(Boolean)
    : [];

  const parts = [
    primaryVisual,
    visualGoal,
    sceneTitle ? `Scene ${sceneNumber}: ${sceneTitle}` : "",
    narration ? `Narration context: ${narration.slice(0, 220)}` : "",
    stylePrompt ? `Visual style: ${stylePrompt}` : "",
    styleLockPrompt ? `Keep continuity: ${styleLockPrompt}` : "",
    compositionRules ? `Composition: ${compositionRules}` : "",
    lighting ? `Lighting and mood: ${lighting}` : "",
    ...backgroundDirectives,
    "Create a single cohesive documentary-style video shot with natural motion and subtle camera movement.",
    "Maintain visible motion across the full shot and avoid static holds, freeze frames, or motion stopping before the cut.",
    "Keep one clear focal subject, one readable action, clean anatomy, and no visible text, subtitles, logos, or watermarks."
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\.\./g, ".")
    .trim();

  return parts.slice(0, 1800);
};

const buildRetryPrompt = ({scene, stylePreset}) => {
  const primaryVisual = sanitizeThirdPartyTerms(normalizeText(scene?.searchQuery || scene?.visualGoal || scene?.title));
  const visualGoal = sanitizeThirdPartyTerms(normalizeText(scene?.visualGoal));
  const stylePrompt = normalizeText(stylePreset?.stylePrompt);
  const compositionRules = normalizeText(stylePreset?.compositionRules);

  return [
    primaryVisual,
    visualGoal,
    stylePrompt ? `Visual style: ${stylePrompt}` : "",
    compositionRules ? `Composition: ${compositionRules}` : "",
    "Generic technology-history scene with no real brands, no recognizable user interfaces, no trademarked product design, and no visible text.",
    "Keep motion active from start to end of the shot and avoid static holds or freeze frames.",
    "Documentary realism, natural motion, subtle camera movement, one clear subject, one clear action."
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\.\./g, ".")
    .slice(0, 1400);
};

const buildMinimalRetryPrompt = ({scene}) => {
  const primaryVisual = sanitizeThirdPartyTerms(normalizeText(scene?.searchQuery || scene?.visualGoal || scene?.title));
  const visualGoal = sanitizeThirdPartyTerms(normalizeText(scene?.visualGoal));

  return [
    primaryVisual,
    visualGoal,
    "Neutral documentary-style technology scene with natural motion.",
    "Keep motion active across the full shot and avoid freeze frames or static holds.",
    "No visible text, no logos, no recognizable interface, no trademarked product design."
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\.\./g, ".")
    .slice(0, 900);
};

const buildNegativePrompt = () =>
  [
    "visible text",
    "subtitles",
    "captions",
    "watermark",
    "logo",
    "brand mark",
    "duplicate people",
    "extra limbs",
    "deformed hands",
    "blurry subject",
    "broken anatomy",
    "flicker",
    "glitch"
  ].join(", ");

const requestVideoOperation = async ({
  model,
  prompt,
  aspectRatio,
  durationSeconds,
  resolution,
  negativePrompt
}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}` +
    `/locations/${config.location}/publishers/google/models/${model}:predictLongRunning`;

  const body = {
    instances: [{prompt}],
    parameters: {
      sampleCount: 1,
      durationSeconds,
      aspectRatio,
      resolution,
      negativePrompt,
      personGeneration: "allow_adult"
    }
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({})); /* expected: Veo may return non-JSON on edge failures */

  if (!response.ok) {
    throw new Error(`Veo predictLongRunning falhou (${response.status}): ${normalizeText(JSON.stringify(payload)).slice(0, 400)}`);
  }

  const operationName = String(payload?.name || "").trim();

  if (!operationName) {
    throw new Error("Veo nao retornou o nome da operacao.");
  }

  return operationName;
};

const pollVideoOperation = async ({model, operationName, timeoutMs, pollIntervalMs}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}` +
    `/locations/${config.location}/publishers/google/models/${model}:fetchPredictOperation`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({operationName})
    });
    const payload = await response.json().catch(() => ({})); /* expected: response may not always parse cleanly */

    if (!response.ok) {
      throw new Error(`Veo fetchPredictOperation falhou (${response.status}): ${normalizeText(JSON.stringify(payload)).slice(0, 400)}`);
    }

    if (payload?.error) {
      throw new Error(`Operacao Veo falhou: ${normalizeText(JSON.stringify(payload.error)).slice(0, 400)}`);
    }

    if (payload?.done === true) {
      return payload?.response || payload;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timeout a aguardar Veo apos ${Math.round(timeoutMs / 1000)}s.`);
};

const extractVideoBuffer = (responsePayload) => {
  const videos = Array.isArray(responsePayload?.videos) ? responsePayload.videos : [];
  const filteredCount = Number(responsePayload?.raiMediaFilteredCount || 0);
  const filteredReasons = Array.isArray(responsePayload?.raiMediaFilteredReasons)
    ? responsePayload.raiMediaFilteredReasons.map((item) => normalizeText(item)).filter(Boolean)
    : [];

  for (const video of videos) {
    const encoded = String(video?.bytesBase64Encoded || "").trim();

    if (encoded) {
      return Buffer.from(encoded, "base64");
    }
  }

  if (filteredCount > 0) {
    throw new Error(`Veo filtrou o video gerado: ${filteredReasons.join(" ").slice(0, 500)}`);
  }

  throw new Error("Veo concluiu a operacao, mas nao devolveu bytesBase64Encoded do video.");
};

const isThirdPartyProviderError = (error) => {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return (
    message.includes("third-party content providers") ||
    message.includes("support codes: 35561574") ||
    message.includes("usage guidelines") ||
    message.includes("filtered out") ||
    message.includes("support codes: 17301594") ||
    message.includes("veo filtrou o video gerado")
  );
};

const readStoryboard = async (storyboardPath) => {
  const raw = await readFile(storyboardPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed?.scenes) || parsed.scenes.length === 0) {
    throw new Error(`Storyboard invalido em ${storyboardPath}: cenas ausentes.`);
  }

  return parsed;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const projectRoot = resolvePathFrom(
    wrapperRoot,
    process.env.VIDEO_ENGINE_ROOT || process.env.VIDEOS_ENVATO_ROOT,
    defaultVideoEngineRoot
  );

  await loadEnv(projectRoot);

  const storyboardPath = args.storyboardFile
    ? resolvePathFrom(projectRoot, args.storyboardFile)
    : "";
  const slug = String(args.slug || "").trim();

  if (!storyboardPath || !slug) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (!existsSync(storyboardPath)) {
    throw new Error(`Storyboard nao encontrado: ${storyboardPath}`);
  }

  const storyboard = await readStoryboard(storyboardPath);
  const assetDir = resolvePathFrom(
    projectRoot,
    args.assetDir,
    path.join(projectRoot, "assets", "envato", slug)
  );
  const selectedSceneNumber = Number.isInteger(args.sceneNumber) && args.sceneNumber > 0
    ? args.sceneNumber
    : null;
  const scenes = storyboard.scenes
    .map((scene, index) => ({scene, sceneNumber: index + 1}))
    .filter(({sceneNumber}) => selectedSceneNumber == null || sceneNumber === selectedSceneNumber);

  if (scenes.length === 0) {
    throw new Error(`Nenhuma cena valida encontrada para gerar em ${storyboardPath}.`);
  }

  await mkdir(assetDir, {recursive: true});

  const model = String(process.env.GOOGLE_VIDEO_MODEL || process.env.VIDEO_MODEL || "veo-3.0-fast-generate-001").trim();
  const targetSeconds = Number(process.env.TARGET_DURATION_SECONDS || 0);
  const forcedClipDurationSeconds = Number(process.env.TEXT_TO_VIDEO_CLIP_SECONDS || 0);
  const width = Number(process.env.OUTPUT_WIDTH || 1080);
  const height = Number(process.env.OUTPUT_HEIGHT || 1920);
  const aspectRatio = getAspectRatio({width, height});
  const resolution = String(process.env.GOOGLE_VIDEO_RESOLUTION || getResolution({width, height})).trim();
  const timeoutMs = Math.max(
    60_000,
    Number.parseInt(process.env.GOOGLE_VIDEO_TIMEOUT_MS || "1800000", 10) || 1_800_000
  );
  const pollIntervalMs = Math.max(
    5_000,
    Number.parseInt(process.env.GOOGLE_VIDEO_POLL_INTERVAL_MS || "15000", 10) || 15_000
  );
  const stylePreset = getStylePreset(process.env.IMAGE_STYLE_PRESET || process.env.FLUX2_STYLE_PRESET);
  const negativePrompt = buildNegativePrompt();
  const manifestPath = path.join(assetDir, "text-to-video-manifest.json");
  const existingManifest = existsSync(manifestPath)
    ? JSON.parse(await readFile(manifestPath, "utf8"))
    : {slug, generationMode: "text-to-video", scenes: []};
  const manifestSceneMap = new Map(
    Array.isArray(existingManifest?.scenes)
      ? existingManifest.scenes.map((entry) => [Number(entry?.sceneNumber), entry])
      : []
  );
  const existingSceneTiming = await loadExistingSceneTiming({
    projectRoot,
    slug,
    storyboardScenes: storyboard.scenes
  });
  const sceneDurations = buildSceneDurationPlan({
    storyboardScenes: storyboard.scenes,
    targetSeconds,
    forcedClipDurationSeconds,
    existingSceneTiming
  });
  const sceneDurationMap = new Map(sceneDurations.map((entry) => [entry.sceneNumber, entry]));
  const durationStrategy = Number.isFinite(forcedClipDurationSeconds) && forcedClipDurationSeconds > 0
    ? "fixed-env"
    : existingSceneTiming
      ? "voiceover-scene-timing"
      : Number.isFinite(targetSeconds) && targetSeconds > 0
        ? "storyboard-target-allocation"
        : "narration-words";

  process.stdout.write(
    `[text-to-video] model=${model} aspect=${aspectRatio} resolution=${resolution} durationStrategy=${durationStrategy} scenes=${scenes.length}\n`
  );
  process.stdout.write(`[text-to-video] duration buckets ${summarizeDurationPlan(sceneDurations)}\n`);

  if (existingSceneTiming?.voiceoverPath) {
    process.stdout.write(`[text-to-video] usando timing existente de ${existingSceneTiming.voiceoverPath}\n`);
  }

  for (const {scene, sceneNumber} of scenes) {
    const sceneDuration = sceneDurationMap.get(sceneNumber) || {
      sceneNumber,
      durationSeconds: 4,
      rawDurationSeconds: 4,
      durationSource: "fallback"
    };
    const genericRetryPrompt = buildRetryPrompt({scene, stylePreset});
    const minimalRetryPrompt = buildMinimalRetryPrompt({scene});
    const promptVariants = [
      buildPrompt({scene, sceneNumber, stylePreset}),
      genericRetryPrompt,
      minimalRetryPrompt,
      minimalRetryPrompt
    ].filter(Boolean);
    const outputName = `scene-${String(sceneNumber).padStart(2, "0")}.mp4`;
    const outputPath = path.join(assetDir, outputName);
    let usedPrompt = "";
    let operationName = "";
    let videoBuffer = null;
    let lastError = null;

    for (let attemptIndex = 0; attemptIndex < promptVariants.length; attemptIndex += 1) {
      const prompt = promptVariants[attemptIndex];

      try {
        process.stdout.write(
          `[text-to-video] scene ${sceneNumber}/${storyboard.scenes.length}: solicitando Veo ${sceneDuration.durationSeconds}s (${sceneDuration.durationSource}, bruto ${sceneDuration.rawDurationSeconds}s, tentativa ${attemptIndex + 1}/${promptVariants.length})...\n`
        );
        operationName = await requestVideoOperation({
          model,
          prompt,
          aspectRatio,
          durationSeconds: sceneDuration.durationSeconds,
          resolution,
          negativePrompt
        });
        process.stdout.write(`[text-to-video] scene ${sceneNumber}: operacao ${operationName}\n`);

        const responsePayload = await pollVideoOperation({
          model,
          operationName,
          timeoutMs,
          pollIntervalMs
        });

        usedPrompt = prompt;
        videoBuffer = extractVideoBuffer(responsePayload);
        break;
      } catch (error) {
        lastError = error;

        if (!isThirdPartyProviderError(error) || attemptIndex === promptVariants.length - 1) {
          throw error;
        }

        process.stdout.write(
          `[text-to-video] scene ${sceneNumber}: prompt bloqueado por policy; tentando versao mais generica.\n`
        );
      }
    }

    if (!videoBuffer) {
      throw lastError || new Error(`Falha desconhecida ao gerar scene ${sceneNumber}.`);
    }

    await writeFile(outputPath, videoBuffer);
    manifestSceneMap.set(sceneNumber, {
      sceneNumber,
      fileName: outputName,
      path: outputPath,
      title: normalizeText(scene?.title),
      prompt: usedPrompt,
      operationName,
      model,
      aspectRatio,
      resolution,
      durationSeconds: sceneDuration.durationSeconds,
      rawDurationSeconds: sceneDuration.rawDurationSeconds,
      durationSource: sceneDuration.durationSource,
      generatedAt: new Date().toISOString()
    });

    process.stdout.write(`[text-to-video] scene ${sceneNumber}: clip salvo em ${outputPath}\n`);
  }

  const manifest = {
    slug,
    generationMode: "text-to-video",
    model,
    aspectRatio,
    resolution,
    durationStrategy,
    durationSeconds:
      Number.isFinite(forcedClipDurationSeconds) && forcedClipDurationSeconds > 0
        ? normalizeClipDurationSeconds(forcedClipDurationSeconds)
        : null,
    stylePreset: stylePreset?.id || DEFAULT_VISUAL_STYLE_PRESET,
    storyboardPath,
    scenes: Array.from(manifestSceneMap.values()).sort((left, right) => left.sceneNumber - right.sceneNumber)
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  process.stdout.write(`${manifestPath}\n`);
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
