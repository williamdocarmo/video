import {readFile, stat} from "node:fs/promises";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {analyzeSceneSpeechPacing} from "./lib/timings.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_FPS = 30;
const TRUSTED_TIMED_WORD_SOURCES = new Set(["gcloud-speech-stt", "azure-word-boundary"]);
const normalizeTimedWordsSource = (source) => String(source || "").trim().toLowerCase();
const isTrustedTimedWordsSource = (source) => {
  const normalized = normalizeTimedWordsSource(source);
  return (
    TRUSTED_TIMED_WORD_SOURCES.has(normalized) ||
    [...TRUSTED_TIMED_WORD_SOURCES].some((base) => normalized === `${base}-rebuilt-from-audio`)
  );
};

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--slug") {
      parsed.slug = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--target-seconds") {
      parsed.targetSeconds = Number(argv[index + 1]);
      index += 1;
    }
  }

  return parsed;
};

const ffprobeDuration = (targetPath) => {
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

  return Number.parseFloat(result.stdout.trim());
};

const isFiniteCharOffset = (value) => Number.isFinite(Number(value));

const buildSceneTimedSlicesByCharOffset = ({sceneSpans, timedWords}) => {
  if (!Array.isArray(sceneSpans) || !Array.isArray(timedWords)) {
    return [];
  }

  return sceneSpans.map((span) =>
    timedWords.filter(
      (word) =>
        isFiniteCharOffset(word?.startChar) &&
        isFiniteCharOffset(word?.endChar) &&
        Number(word.startChar) >= Number(span?.startChar) &&
        Number(word.startChar) <= Number(span?.endChar)
    )
  );
};

const percentile = (values, value) => {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * value));
  return sorted[index];
};

const getSceneStartAlignmentStats = ({scenes, timedWords, sceneSpans, fps = DEFAULT_FPS}) => {
  if (!Array.isArray(scenes) || !Array.isArray(timedWords) || !Array.isArray(sceneSpans) || sceneSpans.length === 0) {
    return {
      available: false,
      sceneCount: 0,
      maxStartLagSeconds: 0,
      p95StartLagSeconds: 0
    };
  }

  const timedSlices = buildSceneTimedSlicesByCharOffset({sceneSpans, timedWords});
  const startLags = [];

  for (let index = 0; index < Math.min(scenes.length, timedSlices.length); index += 1) {
    const scene = scenes[index];
    const words = timedSlices[index];

    if (!Array.isArray(words) || words.length === 0) {
      continue;
    }

    const sceneStartSeconds = Number(scene?.startFrame || 0) / fps;
    const firstWordStartSeconds = Number(words[0]?.startSeconds);

    if (!Number.isFinite(firstWordStartSeconds)) {
      continue;
    }

    startLags.push(Math.abs(firstWordStartSeconds - sceneStartSeconds));
  }

  return {
    available: startLags.length > 0,
    sceneCount: startLags.length,
    maxStartLagSeconds: startLags.length > 0 ? Math.max(...startLags) : 0,
    p95StartLagSeconds: percentile(startLags, 0.95)
  };
};

const getSceneBoundaryGapStats = ({timedWords, sceneSpans}) => {
  const slices = buildSceneTimedSlicesByCharOffset({sceneSpans, timedWords})
    .filter((slice) => Array.isArray(slice) && slice.length > 0);

  if (slices.length < 2) {
    return {
      available: false,
      gapCount: 0,
      maxGapSeconds: 0,
      p95GapSeconds: 0,
      longGapCount: 0
    };
  }

  const gaps = [];

  for (let index = 0; index < slices.length - 1; index += 1) {
    const current = slices[index];
    const next = slices[index + 1];
    const currentEnd = Number(current[current.length - 1]?.endSeconds);
    const nextStart = Number(next[0]?.startSeconds);

    if (!Number.isFinite(currentEnd) || !Number.isFinite(nextStart) || nextStart < currentEnd) {
      continue;
    }

    gaps.push(nextStart - currentEnd);
  }

  return {
    available: gaps.length > 0,
    gapCount: gaps.length,
    maxGapSeconds: gaps.length > 0 ? Math.max(...gaps) : 0,
    p95GapSeconds: percentile(gaps, 0.95),
    longGapCount: gaps.filter((gap) => gap > 0.8).length
  };
};

const getCaptionTimelineStats = (captions) => {
  if (captions.length === 0) {
    return {
      maxGap: Number.POSITIVE_INFINITY,
      overlapCount: 0
    };
  }

  let maxGap = 0;
  let overlapCount = 0;

  for (let index = 1; index < captions.length; index += 1) {
    const delta = captions[index].startFrame - captions[index - 1].endFrame - 1;
    if (delta >= 0) {
      maxGap = Math.max(maxGap, delta);
    } else {
      overlapCount += 1;
    }
  }

  return {maxGap, overlapCount};
};

const CAPTION_WORD_FRAME_TOLERANCE = 1;

const getCaptionWordBoundsStats = (captions) => {
  let outOfBoundsWords = 0;

  for (const caption of captions) {
    for (const word of caption.words || []) {
      if (
        word.startFrame < caption.startFrame - CAPTION_WORD_FRAME_TOLERANCE ||
        word.endFrame > caption.endFrame + CAPTION_WORD_FRAME_TOLERANCE
      ) {
        outOfBoundsWords += 1;
      }
    }
  }

  return {
    outOfBoundsWords
  };
};

const narrationFlowsNaturally = (scenes) => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return false;
  }

  return scenes.every((scene) => {
    const narration = String(scene?.narration || "").trim();
    return narration.length >= 12 && /[.!?…]$/.test(narration);
  });
};

const countCrossSceneCaptions = (captions, scenes) => {
  if (!Array.isArray(captions) || !Array.isArray(scenes)) {
    return Number.POSITIVE_INFINITY;
  }

  return captions.reduce((count, caption) => {
    const owners = scenes.filter((scene) => {
      const sceneStart = Number(scene?.startFrame);
      const sceneEnd = sceneStart + Number(scene?.durationInFrames) - 1;

      return caption.startFrame <= sceneEnd && caption.endFrame >= sceneStart;
    });

    return owners.length === 1 ? count : count + 1;
  }, 0);
};

const hasCoherentSceneTimeline = (scenes, totalFrames) => {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return false;
  }

  for (let index = 0; index < scenes.length; index += 1) {
    const scene = scenes[index];
    const startFrame = Number(scene?.startFrame);
    const durationInFrames = Number(scene?.durationInFrames);

    if (!Number.isFinite(startFrame) || !Number.isFinite(durationInFrames) || durationInFrames < 1) {
      return false;
    }

    const endFrame = startFrame + durationInFrames - 1;

    if (startFrame < 0 || endFrame >= totalFrames) {
      return false;
    }

    if (index === 0) {
      if (startFrame !== 0) {
        return false;
      }

      continue;
    }

    const previous = scenes[index - 1];
    const previousExpectedNextStart = Number(previous.startFrame) + Number(previous.durationInFrames);

    if (Math.abs(startFrame - previousExpectedNextStart) > 1) {
      return false;
    }
  }

  return true;
};

const minClipCoverage = Math.min(
  1,
  Math.max(0, Number.parseFloat(process.env.MIN_CLIP_COVERAGE || "1") || 1)
);
const getTargetDurationToleranceSeconds = (targetSeconds) =>
  Math.max(6, Math.round(targetSeconds * 0.1));
const getMinSceneCountForTarget = (targetSeconds) => {
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    return Math.max(10, Number.parseInt(process.env.MIN_SCENE_COUNT || "10", 10) || 10);
  }

  if (targetSeconds <= 60) {
    return 9;
  }

  if (targetSeconds <= 90) {
    return 12;
  }

  return 14;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.slug) {
    throw new Error("Usa: node scripts/validate-run.mjs --slug <slug>");
  }

  const runDir = path.join(projectRoot, "runs", args.slug);
  const renderPropsPath = path.join(runDir, "render-props.json");
  const storyboardPath = path.join(runDir, "storyboard.json");
  const assetPlanPath = path.join(runDir, "asset-plan.json");
  const voiceoverPath = path.join(runDir, "voiceover.json");
  const outPath = path.join(projectRoot, "out", `${args.slug}.mp4`);
  const voicePath = path.join(projectRoot, "public", "runs", args.slug, "audio", "voiceover.mp3");

  const [renderPropsRaw, storyboardRaw, assetPlanRaw, voiceoverRaw] = await Promise.all([
    readFile(renderPropsPath, "utf8"),
    readFile(storyboardPath, "utf8"),
    readFile(assetPlanPath, "utf8"),
    readFile(voiceoverPath, "utf8").catch(() => "{}")
  ]);

  const renderProps = JSON.parse(renderPropsRaw);
  const storyboard = JSON.parse(storyboardRaw);
  const assetPlan = JSON.parse(assetPlanRaw);
  const voiceover = JSON.parse(voiceoverRaw);
  const fps = Number.parseInt(process.env.VIDEO_FPS || String(renderProps.fps || DEFAULT_FPS), 10) || DEFAULT_FPS;
  const outputStat = await stat(outPath);
  const audioSeconds = ffprobeDuration(voicePath);
  const videoSeconds = ffprobeDuration(outPath);
  const requestedTargetSeconds = Number.isFinite(args.targetSeconds) && args.targetSeconds > 0 ? args.targetSeconds : null;
  const minSceneCount = getMinSceneCountForTarget(requestedTargetSeconds);
  const targetDurationToleranceSeconds = requestedTargetSeconds
    ? getTargetDurationToleranceSeconds(requestedTargetSeconds)
    : null;
  const durationTargetOk = !requestedTargetSeconds || Math.abs(videoSeconds - requestedTargetSeconds) <= targetDurationToleranceSeconds;
  const transitionsOk = renderProps.scenes.every((scene) => (scene.transitionInFrames ?? 0) >= 10);
  const captionTimelineStats = getCaptionTimelineStats(renderProps.captions);
  const captionWordBoundsStats = getCaptionWordBoundsStats(renderProps.captions);
  const captionsHaveCoverage = captionTimelineStats.maxGap <= 3 && captionTimelineStats.overlapCount === 0;
  const envatoSceneCount = assetPlan.filter((scene) => scene.attribution?.source === "envato-local").length;
  const pexelsSceneCount = assetPlan.filter((scene) => scene.attribution?.source === "pexels").length;
  const textFallbackSceneCount = assetPlan.filter((scene) => scene.sceneType === "text-only").length;
  const visualAuditRejectedCount = assetPlan.filter((scene) => scene?.visualAudit?.passed === false).length;
  const visualAuditSceneCount = assetPlan.filter((scene) => scene?.visualAudit && typeof scene.visualAudit.passed === "boolean").length;
  const resolvedSceneCount = assetPlan.filter((scene) => Boolean(scene.clipPath) || scene.sceneType === "text-only").length;
  const clipCoverage = assetPlan.filter((scene) => Boolean(scene.clipPath)).length / Math.max(1, assetPlan.length);
  const envatoOnly = assetPlan.every((scene) => scene.attribution?.source === "envato-local" && Boolean(scene.clipPath));
  const captionsHaveWordTiming = renderProps.captions.every(
    (caption) => Array.isArray(caption.words) && caption.words.length >= 1
  );
  const alignmentAvailable = Array.isArray(voiceover.timedWords) && voiceover.timedWords.length > 0;
  const timedWordsSource = normalizeTimedWordsSource(voiceover.timedWordsSource);
  const timedWordsSourceTrusted = !alignmentAvailable || isTrustedTimedWordsSource(timedWordsSource);
  const lastWordEnd = alignmentAvailable
    ? Math.max(...voiceover.timedWords.map((w) => w.endSeconds || 0))
    : 0;
  const lastCaption = Array.isArray(renderProps.captions) && renderProps.captions.length > 0
    ? renderProps.captions[renderProps.captions.length - 1]
    : null;
  const lastCaptionEndSeconds = Number.isFinite(Number(lastCaption?.endFrame))
    ? (Number(lastCaption.endFrame) + 1) / fps
    : 0;
  const sttAudioDrift = alignmentAvailable ? Math.abs(lastWordEnd - audioSeconds) : 0;
  const lastCaptionAudioDrift = lastCaptionEndSeconds > 0 ? Math.abs(lastCaptionEndSeconds - audioSeconds) : 0;
  const sttAudioSyncOk =
    !alignmentAvailable ||
    (
      lastWordEnd <= audioSeconds + 0.25 &&
      (sttAudioDrift <= 1.0 || lastCaptionAudioDrift <= 0.6)
    );
  const voiceProviderOk = String(voiceover.provider || "").trim().toLowerCase() !== "macos-say";
  const sceneTimelineMonotonic = hasCoherentSceneTimeline(renderProps.scenes, renderProps.durationInFrames);
  const crossSceneCaptionCount = countCrossSceneCaptions(renderProps.captions, renderProps.scenes);
  const sceneStartAlignment = getSceneStartAlignmentStats({
    scenes: renderProps.scenes,
    timedWords: Array.isArray(voiceover.timedWords) ? voiceover.timedWords : [],
    sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : [],
    fps
  });
  const sceneSpeechPacing = alignmentAvailable
    ? analyzeSceneSpeechPacing({
        scenes: renderProps.scenes,
        timedWords: voiceover.timedWords,
        audioDurationSeconds: audioSeconds,
        sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : []
      })
    : {
        sceneStats: [],
        medianWordsPerSecond: 0,
        maxWordsPerSecond: 0,
        rushedScenes: []
      };
  const sceneBoundaryGapStats = getSceneBoundaryGapStats({
    timedWords: Array.isArray(voiceover.timedWords) ? voiceover.timedWords : [],
    sceneSpans: Array.isArray(voiceover.sceneSpans) ? voiceover.sceneSpans : []
  });
  const linkedNarration = narrationFlowsNaturally(storyboard.scenes);

  const report = {
    slug: args.slug,
    sceneSpeechRushedScenes: sceneSpeechPacing.rushedScenes,
    checks: {
      outputExists: outputStat.size > 0,
      outputSizeBytes: outputStat.size,
      sceneCount: renderProps.scenes.length,
      sceneCountOk: renderProps.scenes.length >= minSceneCount,
      captionsCount: renderProps.captions.length,
      captionsHaveCoverage,
      envatoOnly,
      visualAuditOk: visualAuditRejectedCount === 0,
      noTextFallback: textFallbackSceneCount === 0,
      clipCoverageOk: clipCoverage >= minClipCoverage,
      voiceProviderOk,
      sceneResolutionOk: resolvedSceneCount === assetPlan.length && assetPlan.every((scene) => Boolean(scene.clipPath)),
      karaokeReady: renderProps.captions.every((caption) => caption.text.trim().split(/\s+/).length >= 1),
      wordTimedCaptions: captionsHaveWordTiming,
      alignmentAvailable,
      timedWordsSourceTrusted,
      captionTimelineMonotonic: captionTimelineStats.overlapCount === 0,
      captionWordBoundsOk: captionWordBoundsStats.outOfBoundsWords === 0,
      sceneTimelineMonotonic,
      sceneStartWordSyncOk: !sceneStartAlignment.available || sceneStartAlignment.maxStartLagSeconds <= 0.25,
      sceneBoundaryGapOk: !sceneBoundaryGapStats.available || sceneBoundaryGapStats.maxGapSeconds <= 1.2,
      sceneSpeechPacingOk: sceneSpeechPacing.rushedScenes.length === 0,
      captionsBoundedToSingleScene: crossSceneCaptionCount === 0,
      transitionsOk,
      linkedNarration,
      audioVideoSyncOk: Math.abs(audioSeconds - videoSeconds) <= 0.6,
      durationTargetOk,
      sttAudioSyncOk
    },
    metrics: {
      audioSeconds,
      videoSeconds,
      targetSeconds: requestedTargetSeconds,
      targetDurationToleranceSeconds,
      sttLastWordSeconds: lastWordEnd,
      sttAudioDriftSeconds: Math.round(sttAudioDrift * 1000) / 1000,
      lastCaptionAudioDriftSeconds: Math.round(lastCaptionAudioDrift * 1000) / 1000,
      sceneStartAlignmentSceneCount: sceneStartAlignment.sceneCount,
      sceneStartAlignmentMaxLagSeconds: Math.round(sceneStartAlignment.maxStartLagSeconds * 1000) / 1000,
      sceneStartAlignmentP95LagSeconds: Math.round(sceneStartAlignment.p95StartLagSeconds * 1000) / 1000,
      sceneBoundaryGapCount: sceneBoundaryGapStats.gapCount,
      sceneBoundaryMaxGapSeconds: Math.round(sceneBoundaryGapStats.maxGapSeconds * 1000) / 1000,
      sceneBoundaryP95GapSeconds: Math.round(sceneBoundaryGapStats.p95GapSeconds * 1000) / 1000,
      sceneBoundaryLongGapCount: sceneBoundaryGapStats.longGapCount,
      maxCaptionGapFrames: captionTimelineStats.maxGap,
      captionOverlapCount: captionTimelineStats.overlapCount,
      captionWordOutOfBoundsCount: captionWordBoundsStats.outOfBoundsWords,
      crossSceneCaptionCount,
      sceneSpeechMedianWordsPerSecond: sceneSpeechPacing.medianWordsPerSecond,
      sceneSpeechMaxWordsPerSecond: sceneSpeechPacing.maxWordsPerSecond,
      rushedSceneCount: sceneSpeechPacing.rushedScenes.length,
      envatoSceneCount,
      pexelsSceneCount,
      textFallbackSceneCount,
      visualAuditSceneCount,
      visualAuditRejectedCount,
      resolvedSceneCount,
      stockSceneCount: assetPlan.filter((scene) => scene.sceneType === "stock").length,
      clipCoverage,
      timedWordCount: Array.isArray(voiceover.timedWords) ? voiceover.timedWords.length : 0
    }
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(`Erro: ${error.message}\n`);
  process.exit(1);
});
