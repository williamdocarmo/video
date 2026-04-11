import {sanitizeTimedWordsForAudio} from "./alignment-utils.mjs";

const countWords = (text) => {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
};

/**
 * Redistribute frame counts so they sum to totalFrames (min 45 per scene).
 * @param {number[]} frames - Raw frame counts per scene.
 * @param {number} totalFrames - Desired total.
 * @returns {number[]} Normalized frame counts.
 */
const normalizeFrames = (frames, totalFrames) => {
  const safeFrames = frames.map((frame) => Math.max(45, frame));
  const currentTotal = safeFrames.reduce((sum, value) => sum + value, 0);
  const factor = totalFrames / currentTotal;
  const normalized = safeFrames.map((value) => Math.max(45, Math.round(value * factor)));
  const delta = totalFrames - normalized.reduce((sum, value) => sum + value, 0);

  normalized[normalized.length - 1] += delta;

  return normalized;
};

const secondsToFrame = (seconds, fps) => Math.max(0, Math.round(Number(seconds || 0) * fps));

const tokenizeWords = (text) =>
  String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const ptBrDisplayMap = new Map([
  ["voce", "você"],
  ["voces", "vocês"],
  ["numero", "número"],
  ["nao", "não"],
  ["ate", "até"],
  ["tambem", "também"],
  ["rapido", "rápido"],
  ["bussola", "bússola"],
  ["tres", "três"],
  ["portatil", "portátil"],
  ["impossivel", "impossível"],
  ["lingua", "língua"],
  ["familia", "família"],
  ["musica", "música"],
  ["historias", "histórias"],
  ["historia", "história"],
  ["facil", "fácil"],
  ["dificeis", "difíceis"]
]);

const preserveCase = (source, replacement) => {
  if (source.toUpperCase() === source) {
    return replacement.toUpperCase();
  }

  if (source[0] && source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }

  return replacement;
};

const normalizePortugueseForDisplay = (text) => {
  let output = String(text ?? "");

  for (const [rawWord, accentedWord] of ptBrDisplayMap.entries()) {
    const pattern = new RegExp(`\\b${rawWord}\\b`, "giu");
    output = output.replace(pattern, (match) => preserveCase(match, accentedWord));
  }

  return output.normalize("NFC");
};

const EVEN_WORD_SPAN_SECONDS = 0.22;
const MIN_WORD_SPAN_SECONDS = 0.04;

const sanitizeCaptionToken = (text) => {
  const raw = normalizePortugueseForDisplay(String(text ?? "").trim());

  if (!raw) {
    return raw;
  }

  let sanitized = raw
    .replace(/^[`"'‘’“”]+(?=[\p{L}\p{N}])/u, "")
    .replace(/(?<=[\p{L}\p{N}%.,;:?!…])[`"'‘’“”]+$/u, "");

  if (!sanitized) {
    sanitized = raw;
  }

  return sanitized;
};

const normalizeWordForLogic = (text) =>
  String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

const weakCaptionStarters = new Set([
  "mas",
  "e",
  "ou",
  "porque",
  "que",
  "entao",
  "então",
  "so",
  "só",
  "pra",
  "para"
]);

const rankWords = new Set([
  "um",
  "dois",
  "tres",
  "três",
  "quatro",
  "cinco",
  "seis",
  "sete",
  "oito",
  "nove",
  "dez",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10"
]);

const isRankLeadStart = (words) => {
  if (words.length < 2) {
    return false;
  }

  const first = normalizeWordForLogic(words[0]?.text);
  const second = normalizeWordForLogic(words[1]?.text);
  return first === "numero" && rankWords.has(second);
};

const shouldFlushChunk = ({currentChunk, nextWord, chunkSize, chunkTooLong, sourceTokens = [], sourceTokenCursor = 0}) => {
  if (currentChunk.length === 0) {
    return false;
  }

  if (chunkTooLong) {
    return true;
  }

  const sourceLastWord = sourceTokens[sourceTokenCursor + currentChunk.length - 1];
  const lastWord = String(sourceLastWord || (currentChunk[currentChunk.length - 1]?.text ?? ""));
  const nextToken = normalizeWordForLogic(nextWord?.text);
  const rankRestart = nextWord && normalizeWordForLogic(nextWord.text) === "numero";

  if (rankRestart) {
    return true;
  }

  if (/[.!?…:]+["'”’)]*$/u.test(lastWord)) {
    if (currentChunk.length >= 3) {
      return true;
    }

    return !weakCaptionStarters.has(nextToken);
  }

  if (currentChunk.length >= chunkSize) {
    return !weakCaptionStarters.has(nextToken);
  }

  return false;
};

const isFiniteCharOffset = (value) => Number.isFinite(Number(value));

const isEmptySceneSpan = (span) =>
  Boolean(span?.empty === true) ||
  !isFiniteCharOffset(span?.startChar) ||
  !isFiniteCharOffset(span?.endChar) ||
  Number(span.endChar) < Number(span.startChar);

const buildSceneTimedSlicesByCharOffset = ({sceneSpans, timedWords}) => {
  return sceneSpans.map((span) => {
    if (isEmptySceneSpan(span)) {
      return [];
    }

    return timedWords.filter(
      (word) =>
        isFiniteCharOffset(word.startChar) &&
        isFiniteCharOffset(word.endChar) &&
        Number(word.startChar) >= Number(span.startChar) &&
        Number(word.startChar) <= Number(span.endChar)
    );
  });
};

const charOffsetAlignmentLooksPlausible = ({scenes, timedWords, sceneSpans}) => {
  if (!Array.isArray(sceneSpans) || sceneSpans.length === 0 || timedWords.length === 0) {
    return false;
  }

  const usableSceneSpans = sceneSpans.filter((span) => !isEmptySceneSpan(span));
  if (usableSceneSpans.length === 0) {
    return false;
  }

  const firstSceneStart = Math.min(...usableSceneSpans.map((span) => Number(span.startChar)));
  const lastSceneEnd = Math.max(...usableSceneSpans.map((span) => Number(span.endChar)));
  const inRangeWords = timedWords.filter(
    (word) =>
      isFiniteCharOffset(word.startChar) &&
      isFiniteCharOffset(word.endChar) &&
      Number(word.startChar) >= firstSceneStart &&
      Number(word.endChar) <= lastSceneEnd
  );
  const inRangeRatio = inRangeWords.length / Math.max(1, timedWords.length);

  if (inRangeRatio < 0.8) {
    return false;
  }

  const slices = buildSceneTimedSlicesByCharOffset({sceneSpans, timedWords: inRangeWords});
  const assignedWords = slices.reduce((sum, slice) => sum + slice.length, 0);
  const assignedRatio = assignedWords / Math.max(1, inRangeWords.length);

  if (assignedRatio < 0.85) {
    return false;
  }

  const sparseMappedScenes = slices.filter((slice, index) => {
    const sourceWordCount = tokenizeWords(scenes[index]?.narration).length;

    return (
      sourceWordCount >= 6 &&
      slice.length > 0 &&
      slice.length / Math.max(1, sourceWordCount) < 0.6
    );
  }).length;

  if (sparseMappedScenes > Math.max(2, Math.floor(scenes.length * 0.2))) {
    return false;
  }

  const emptyMappedScenes = slices.filter((slice, index) => {
    const sourceWordCount = tokenizeWords(scenes[index]?.narration).length;
    return sourceWordCount >= 6 && slice.length === 0;
  }).length;

  if (emptyMappedScenes > Math.max(2, Math.floor(scenes.length * 0.15))) {
    return false;
  }

  return true;
};

const normalizeBucketCounts = (weights, totalCount) => {
  if (totalCount <= 0 || weights.length === 0) {
    return weights.map(() => 0);
  }

  const safeWeights = weights.map((weight) => Math.max(1, Number(weight) || 1));
  const totalWeight = safeWeights.reduce((sum, value) => sum + value, 0);
  const rawBuckets = safeWeights.map((weight) => (weight / totalWeight) * totalCount);
  const buckets = rawBuckets.map((value) => Math.floor(value));
  let assigned = buckets.reduce((sum, value) => sum + value, 0);
  const rankedRemainders = rawBuckets
    .map((value, index) => ({
      index,
      remainder: value - buckets[index]
    }))
    .sort((a, b) => b.remainder - a.remainder);

  let rankedIndex = 0;
  while (assigned < totalCount) {
    buckets[rankedRemainders[rankedIndex % rankedRemainders.length].index] += 1;
    assigned += 1;
    rankedIndex += 1;
  }

  if (totalCount >= buckets.length) {
    for (let index = 0; index < buckets.length; index += 1) {
      if (buckets[index] > 0) {
        continue;
      }

      const donorIndex = buckets.findIndex((value) => value > 1);

      if (donorIndex === -1) {
        break;
      }

      buckets[donorIndex] -= 1;
      buckets[index] += 1;
    }
  }

  return buckets;
};

const clampFrameRange = (startFrame, endFrame, fallbackEndFrame) => {
  const safeStart = Math.max(0, startFrame);
  const safeEnd = Math.max(safeStart, endFrame);

  return {
    startFrame: safeStart,
    endFrame: Math.max(safeEnd, fallbackEndFrame ?? safeEnd)
  };
};

const normalizeCaptionRanges = (captions, finalFrame) => {
  if (captions.length === 0) {
    return captions;
  }

  const normalized = [];

  for (let index = 0; index < captions.length; index += 1) {
    let current = {
      ...captions[index],
      words: Array.isArray(captions[index].words) ? [...captions[index].words] : []
    };

    while (index < captions.length - 1) {
      const next = captions[index + 1];
      const desiredEnd = Math.max(current.startFrame, next.startFrame - 1);

      if (desiredEnd > current.startFrame) {
        current.endFrame = desiredEnd;
        break;
      }

      current = {
        text: `${current.text} ${next.text}`.trim(),
        startFrame: current.startFrame,
        endFrame: Math.max(current.endFrame, next.endFrame),
        words: [
          ...current.words,
          ...(Array.isArray(next.words) ? next.words : [])
        ]
      };
      index += 1;
    }

    normalized.push(current);
  }

  normalized[normalized.length - 1].endFrame = Math.max(
    normalized[normalized.length - 1].endFrame,
    finalFrame
  );

  for (const caption of normalized) {
    if (!Array.isArray(caption.words)) {
      continue;
    }

    for (const word of caption.words) {
      word.startFrame = Math.max(caption.startFrame, word.startFrame);
      word.endFrame = Math.max(
        word.startFrame,
        Math.min(caption.endFrame, word.endFrame)
      );
    }
  }

  return normalized;
};

const rebuildCaptionFromWords = (caption) => {
  const words = Array.isArray(caption.words) ? caption.words.filter((word) => Boolean(word?.text)) : [];

  if (words.length === 0) {
    return caption;
  }

  return {
    ...caption,
    text: words.map((word) => word.text).join(" ").trim(),
    startFrame: words[0].startFrame,
    endFrame: words[words.length - 1].endFrame,
    highlightLeadWords: isRankLeadStart(words) ? 2 : 0,
    words
  };
};

const rebalanceWeakStarterCaptions = (captions) => {
  if (!Array.isArray(captions) || captions.length < 3) {
    return captions;
  }

  const rebalanced = captions.map((caption) => ({
    ...caption,
    words: Array.isArray(caption.words) ? [...caption.words] : []
  }));

  for (let index = 1; index < rebalanced.length - 1; index += 1) {
    const current = rebalanced[index];
    const previous = rebalanced[index - 1];
    const next = rebalanced[index + 1];

    if ((current.words?.length || 0) !== 2 || !previous || !next) {
      continue;
    }

    const [firstWord, secondWord] = current.words;
    const secondToken = normalizeWordForLogic(secondWord?.text);

    if (!/[.!?…:]+["'”’)]*$/u.test(String(firstWord?.text ?? "")) || !weakCaptionStarters.has(secondToken)) {
      continue;
    }

    previous.words.push(firstWord);
    next.words.unshift(secondWord);
    current.words = [];

    rebalanced[index - 1] = rebuildCaptionFromWords(previous);
    rebalanced[index + 1] = rebuildCaptionFromWords(next);
  }

  return rebalanced
    .filter((caption) => (caption.words?.length || 0) > 0)
    .map((caption) => rebuildCaptionFromWords(caption));
};

const buildEvenWordTimings = ({sourceWords, fallbackStartSeconds, fallbackEndSeconds}) => {
  if (sourceWords.length === 0) {
    return [];
  }

  const safeStart = Number.isFinite(fallbackStartSeconds) ? Number(fallbackStartSeconds) : 0;
  const safeEnd = Math.max(
    safeStart + MIN_WORD_SPAN_SECONDS,
    Number.isFinite(fallbackEndSeconds) ? Number(fallbackEndSeconds) : safeStart + sourceWords.length * EVEN_WORD_SPAN_SECONDS
  );
  const totalDuration = safeEnd - safeStart;

  return sourceWords.map((word, index) => {
    const startSeconds = safeStart + (totalDuration * index) / sourceWords.length;
    const endSeconds = Math.max(
      startSeconds + MIN_WORD_SPAN_SECONDS,
      safeStart + (totalDuration * (index + 1)) / sourceWords.length
    );

    return {text: word, startSeconds, endSeconds};
  });
};

const isSparseSceneSlice = ({sourceWords, timedSlice}) => {
  if (timedSlice.length === 0) {
    return true;
  }

  const sliceDurationSeconds =
    timedSlice.length >= 2
      ? Number(timedSlice[timedSlice.length - 1]?.endSeconds ?? 0) - Number(timedSlice[0]?.startSeconds ?? 0)
      : 0;
  const sliceCoverage = timedSlice.length / Math.max(1, sourceWords.length);

  return (
    (sourceWords.length >= 6 && sliceCoverage < 0.6) ||
    (timedSlice.length >= 3 && sliceDurationSeconds > 0 && sliceDurationSeconds / timedSlice.length < 0.08)
  );
};

const buildSourceWordTimings = ({sourceWords, timedSlice, fallbackStartSeconds, fallbackEndSeconds}) => {
  if (sourceWords.length === 0) {
    return [];
  }

  const safeStart = Number.isFinite(fallbackStartSeconds) ? Number(fallbackStartSeconds) : 0;
  const safeEnd = Math.max(
    safeStart + MIN_WORD_SPAN_SECONDS,
    Number.isFinite(fallbackEndSeconds) ? Number(fallbackEndSeconds) : safeStart + sourceWords.length * EVEN_WORD_SPAN_SECONDS
  );

  if (isSparseSceneSlice({sourceWords, timedSlice})) {
    return buildEvenWordTimings({
      sourceWords,
      fallbackStartSeconds: safeStart,
      fallbackEndSeconds: safeEnd
    });
  }

  if (timedSlice.length === sourceWords.length) {
    return sourceWords.map((word, index) => ({
      text: word,
      startSeconds: timedSlice[index].startSeconds,
      endSeconds: Math.max(timedSlice[index].endSeconds, timedSlice[index].startSeconds + MIN_WORD_SPAN_SECONDS)
    }));
  }

  return sourceWords.map((word, index) => {
    const startIndex = Math.min(
      timedSlice.length - 1,
      Math.floor((index * timedSlice.length) / sourceWords.length)
    );
    const endExclusive = Math.max(
      startIndex + 1,
      Math.ceil(((index + 1) * timedSlice.length) / sourceWords.length)
    );
    const endIndex = Math.min(timedSlice.length - 1, endExclusive - 1);
    const startSeconds = timedSlice[startIndex].startSeconds;
    const endSeconds = Math.max(timedSlice[endIndex].endSeconds, startSeconds + MIN_WORD_SPAN_SECONDS);

    return {
      text: word,
      startSeconds,
      endSeconds
    };
  });
};

const assignTimedWordsToScenesByCharOffset = ({scenes, timedWords, sceneSpans, audioDurationSeconds}) => {
  const sceneSourceWords = scenes.map((scene) => tokenizeWords(scene.narration));
  const timedWordsInRange = timedWords.filter(
    (word) => isFiniteCharOffset(word.startChar) && isFiniteCharOffset(word.endChar)
  );
  const timedSlices = buildSceneTimedSlicesByCharOffset({sceneSpans, timedWords: timedWordsInRange});
  const sceneWordTimings = [];
  let previousEndSeconds = 0;

  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const sourceWords = sceneSourceWords[sceneIndex];
    const span = sceneSpans.find((s) => s.sceneIndex === sceneIndex);

    let timedSlice = [];
    if (span) {
      timedSlice = timedSlices[sceneIndex] ?? [];
    }

    const nextSpan = sceneSpans.find((s) => s.sceneIndex === sceneIndex + 1);
    const nextFirstWord = nextSpan
      ? timedWordsInRange.find((w) => w.startChar !== undefined && w.startChar >= nextSpan.startChar)
      : undefined;
    const sparseSlice = isSparseSceneSlice({sourceWords, timedSlice});
    const fallbackStartSeconds = sparseSlice ? previousEndSeconds : timedSlice[0]?.startSeconds ?? previousEndSeconds;
    const fallbackEndSeconds = sparseSlice
      ? nextFirstWord?.startSeconds ?? audioDurationSeconds
      : timedSlice[timedSlice.length - 1]?.endSeconds ?? nextFirstWord?.startSeconds ?? audioDurationSeconds;
    const mappedWords = buildSourceWordTimings({
      sourceWords,
      timedSlice,
      fallbackStartSeconds,
      fallbackEndSeconds
    });

    previousEndSeconds = mappedWords[mappedWords.length - 1]?.endSeconds ?? Math.max(fallbackEndSeconds, fallbackStartSeconds + 0.04);
    sceneWordTimings.push(mappedWords);
  }

  return sceneWordTimings;
};

const assignTimedWordsToScenes = ({scenes, timedWords, audioDurationSeconds, sceneSpans = []}) => {
  const normalizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords,
    audioDurationSeconds
  }).timedWords;
  // Use char-offset alignment when sceneSpans and word char offsets are available
  const hasCharOffsets = normalizedTimedWords.length > 0 && normalizedTimedWords[0].startChar !== undefined;
  const hasSceneSpans =
    Array.isArray(sceneSpans) &&
    sceneSpans.some(
      (span) =>
        Number.isInteger(span?.sceneIndex) &&
        Number.isFinite(Number(span?.startChar)) &&
        Number.isFinite(Number(span?.endChar)) &&
        !isEmptySceneSpan(span)
    );

  if (hasCharOffsets && hasSceneSpans && charOffsetAlignmentLooksPlausible({scenes, timedWords: normalizedTimedWords, sceneSpans})) {
    return assignTimedWordsToScenesByCharOffset({
      scenes,
      timedWords: normalizedTimedWords,
      sceneSpans,
      audioDurationSeconds
    });
  }

  // Fallback: proportional word count distribution
  const sceneSourceWords = scenes.map((scene) => tokenizeWords(scene.narration));
  const sceneWordCounts = sceneSourceWords.map((words) => words.length);
  const totalSourceWords = sceneWordCounts.reduce((sum, value) => sum + value, 0);
  const bucketCounts =
    totalSourceWords === normalizedTimedWords.length
      ? sceneWordCounts
      : normalizeBucketCounts(sceneWordCounts, normalizedTimedWords.length);
  const sceneWordTimings = [];
  let cursor = 0;
  let previousEndSeconds = 0;

  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const sourceWords = sceneSourceWords[sceneIndex];
    const sliceCount = bucketCounts[sceneIndex] ?? 0;
    const timedSlice = normalizedTimedWords.slice(cursor, cursor + sliceCount);
    cursor += sliceCount;
    const nextStartSeconds = normalizedTimedWords[cursor]?.startSeconds;
    const sparseSlice = isSparseSceneSlice({sourceWords, timedSlice});
    const fallbackStartSeconds = sparseSlice ? previousEndSeconds : timedSlice[0]?.startSeconds ?? previousEndSeconds;
    const fallbackEndSeconds = sparseSlice
      ? nextStartSeconds ?? audioDurationSeconds
      : timedSlice[timedSlice.length - 1]?.endSeconds ?? nextStartSeconds ?? audioDurationSeconds;
    const mappedWords = buildSourceWordTimings({
      sourceWords,
      timedSlice,
      fallbackStartSeconds,
      fallbackEndSeconds
    });

    previousEndSeconds = mappedWords[mappedWords.length - 1]?.endSeconds ?? Math.max(fallbackEndSeconds, fallbackStartSeconds + 0.04);
    sceneWordTimings.push(mappedWords);
  }

  return sceneWordTimings;
};

const buildAlignedSceneFrameRanges = ({sceneWords, fps, totalFrames}) => {
  if (!Array.isArray(sceneWords) || sceneWords.length === 0) {
    return [];
  }

  const sceneCount = sceneWords.length;
  const configuredMinSceneFrames = Math.max(
    12,
    secondsToFrame(Number.parseFloat(process.env.MIN_SCENE_SECONDS || "1.0") || 1.0, fps)
  );
  const minSceneFrames = Math.max(
    1,
    Math.min(
      configuredMinSceneFrames,
      Math.max(1, Math.floor(totalFrames / Math.max(1, sceneCount)))
    )
  );
  let rawStarts = sceneWords.map((words, index) => {
    if (index === 0) {
      return 0;
    }

    const firstWord = words.find((word) => Number.isFinite(Number(word?.startSeconds)));
    return firstWord ? secondsToFrame(firstWord.startSeconds, fps) : null;
  });
  const finiteRawStarts = rawStarts.filter((value) => Number.isFinite(Number(value)));
  const maxAllowedStart = Math.max(0, totalFrames - minSceneFrames);
  const maxRawStart =
    finiteRawStarts.length > 0 ? Math.max(...finiteRawStarts.map((value) => Number(value))) : 0;

  if (maxRawStart > maxAllowedStart && maxAllowedStart > 0) {
    const scale = maxAllowedStart / maxRawStart;
    rawStarts = rawStarts.map((value, index) =>
      index === 0 || !Number.isFinite(Number(value)) ? value : Math.round(Number(value) * scale)
    );
  }
  const starts = new Array(sceneCount).fill(0);
  starts[0] = 0;

  for (let index = 1; index < sceneCount; index += 1) {
    const remainingScenes = sceneCount - index;
    const minStart = starts[index - 1] + minSceneFrames;
    const maxStart = Math.max(minStart, totalFrames - remainingScenes * minSceneFrames);
    const desiredStart = Number.isFinite(Number(rawStarts[index])) ? Number(rawStarts[index]) : minStart;
    starts[index] = Math.max(minStart, Math.min(maxStart, desiredStart));
  }

  return starts.map((startFrame, index) => ({
    startFrame,
    endFrame: index === sceneCount - 1 ? totalFrames - 1 : starts[index + 1] - 1
  }));
};

const roundMetric = (value, digits = 3) => {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
};

const median = (values) => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[midpoint];
  }

  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
};

/**
 * Analyze speech pacing per scene and flag rushed scenes.
 * @param {object} params
 * @param {{narration: string, id?: string, title?: string}[]} params.scenes
 * @param {{startSeconds: number, endSeconds: number, startChar?: number, endChar?: number}[]} [params.timedWords=[]]
 * @param {number} [params.audioDurationSeconds=0]
 * @param {{sceneIndex: number, startChar: number, endChar: number}[]} [params.sceneSpans=[]]
 * @returns {{sceneStats: object[], medianWordsPerSecond: number|null, maxWordsPerSecond: number, rushedScenes: object[]}}
 */
export const analyzeSceneSpeechPacing = ({scenes, timedWords = [], audioDurationSeconds = 0, sceneSpans = []}) => {
  if (!Array.isArray(scenes) || scenes.length === 0 || timedWords.length === 0) {
    return {
      sceneStats: [],
      medianWordsPerSecond: 0,
      maxWordsPerSecond: 0,
      rushedScenes: []
    };
  }

  const sceneWords = assignTimedWordsToScenes({
    scenes,
    timedWords,
    audioDurationSeconds,
    sceneSpans
  });
  const sceneStats = scenes.map((scene, sceneIndex) => {
    const words = sceneWords[sceneIndex] ?? [];
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    const durationSeconds =
      firstWord && lastWord
        ? Math.max(0, Number(lastWord.endSeconds) - Number(firstWord.startSeconds))
        : 0;
    const timedWordCount = words.length;
    const sourceWordCount = tokenizeWords(scene?.narration).length;
    const wordsPerSecond = durationSeconds > 0 ? timedWordCount / durationSeconds : null;

    return {
      sceneIndex,
      sceneId: scene?.id ?? null,
      title: scene?.title ?? `Scene ${sceneIndex + 1}`,
      sourceWordCount,
      timedWordCount,
      startSeconds: roundMetric(firstWord?.startSeconds),
      endSeconds: roundMetric(lastWord?.endSeconds),
      durationSeconds: roundMetric(durationSeconds),
      wordsPerSecond: roundMetric(wordsPerSecond)
    };
  });

  const validRates = sceneStats
    .filter((scene) => scene.timedWordCount >= 6 && Number.isFinite(scene.wordsPerSecond))
    .map((scene) => scene.wordsPerSecond);
  const medianWordsPerSecond = median(validRates);
  const maxWordsPerSecond = validRates.length > 0 ? Math.max(...validRates) : 0;
  const absoluteLimit = Math.max(
    5.5,
    Number.parseFloat(process.env.MAX_SCENE_WORDS_PER_SECOND || "7") || 7
  );
  const relativeLimit = Math.max(
    1.2,
    Number.parseFloat(process.env.MAX_SCENE_WORDS_PER_SECOND_RATIO || "1.8") || 1.8
  );
  const rushedScenes = sceneStats.filter(
    (scene) =>
      scene.timedWordCount >= 6 &&
      Number.isFinite(scene.wordsPerSecond) &&
      (
        scene.wordsPerSecond > absoluteLimit ||
        scene.wordsPerSecond > Math.max(absoluteLimit, medianWordsPerSecond * relativeLimit)
      )
  );

  return {
    sceneStats,
    medianWordsPerSecond: roundMetric(medianWordsPerSecond),
    maxWordsPerSecond: roundMetric(maxWordsPerSecond),
    rushedScenes
  };
};

/**
 * Build karaoke caption chunks for a single scene from timed words.
 * Groups words into display chunks with per-word highlight frame ranges.
 * @param {object} params
 * @param {{text: string, startSeconds: number, endSeconds: number}[]} params.sceneWords - Timed words for this scene.
 * @param {number} params.fps - Frames per second.
 * @param {number} params.chunkSize - Target words per caption chunk.
 * @param {number} params.sceneStartFrame
 * @param {number} params.sceneEndFrame
 * @param {string} [params.sourceText=""] - Original narration text (for display normalization).
 * @returns {{text: string, startFrame: number, endFrame: number, words: {text: string, startFrame: number, endFrame: number}[]}[]}
 */
const buildTimedCaptions = ({sceneWords, fps, chunkSize, sceneStartFrame, sceneEndFrame, sourceText = ""}) => {
  const captions = [];
  const minCaptionFrames = Math.max(
    6,
    secondsToFrame(Number.parseFloat(process.env.CAPTION_MIN_SECONDS || "0.45") || 0.45, fps)
  );
  const sourceTokens = tokenizeWords(normalizePortugueseForDisplay(sourceText));

  if (sceneWords.length === 0) {
    return captions;
  }

  let currentChunk = [];
  let sourceTokenCursor = 0;

  const buildChunkCaption = () => {
    if (currentChunk.length === 0) {
      return null;
    }

    const words = currentChunk.map((word, index) => {
      const displayText = sanitizeCaptionToken(sourceTokens[sourceTokenCursor + index] || word.text);
      const wordStartFrame = Math.max(
        sceneStartFrame,
        Math.min(sceneEndFrame, secondsToFrame(word.startSeconds, fps))
      );
      const wordEndFrame = Math.max(
        wordStartFrame,
        Math.min(
          sceneEndFrame,
          Math.max(secondsToFrame(word.endSeconds, fps), wordStartFrame + 1)
        )
      );

      return {
        text: displayText,
        startFrame: wordStartFrame,
        endFrame: wordEndFrame
      };
    }).filter((word) => Boolean(word.text));

    if (words.length === 0) {
      return null;
    }

    for (let index = 0; index < words.length - 1; index += 1) {
      words[index].endFrame = Math.max(words[index].startFrame, words[index + 1].startFrame - 1);
    }

    const startFrame = Math.max(sceneStartFrame, words[0].startFrame);
    const endFrame = Math.max(
      startFrame,
      Math.min(sceneEndFrame, Math.max(startFrame + 1, words[words.length - 1].endFrame))
    );

    return {
      text: words.map((word) => word.text).join(" "),
      startFrame,
      endFrame,
      highlightLeadWords: isRankLeadStart(words) ? 2 : 0,
      words
    };
  };

  const flushChunk = ({force = false} = {}) => {
    const caption = buildChunkCaption();

    if (!caption) {
      currentChunk = [];
      return;
    }

    const durationFrames = caption.endFrame - caption.startFrame + 1;

    if (!force && durationFrames < minCaptionFrames) {
      return;
    }

    if (force && durationFrames < minCaptionFrames && captions.length > 0) {
      const previousCaption = captions[captions.length - 1];
      previousCaption.text = `${previousCaption.text} ${caption.text}`.trim();
      previousCaption.endFrame = Math.max(previousCaption.endFrame, caption.endFrame);
      previousCaption.words = [...previousCaption.words, ...caption.words];
      currentChunk = [];
      return;
    }

    captions.push(caption);
    sourceTokenCursor += currentChunk.length;

    currentChunk = [];
  };

  for (let index = 0; index < sceneWords.length; index += 1) {
    const word = sceneWords[index];

    currentChunk.push(word);

    const nextWord = sceneWords[index + 1] ?? null;
    const chunkTooLong =
      nextWord &&
      currentChunk.length > 0 &&
      Number(nextWord.endSeconds) - Number(currentChunk[0].startSeconds) >= Number(process.env.CAPTION_MAX_SECONDS || 2.4);

    if (shouldFlushChunk({currentChunk, nextWord, chunkSize, chunkTooLong, sourceTokens, sourceTokenCursor})) {
      flushChunk();
    }
  }

  flushChunk({force: true});

  const normalizedCaptions = [];

  for (let index = 0; index < captions.length; index += 1) {
    const caption = {
      ...captions[index],
      words: [...captions[index].words]
    };
    const durationFrames = caption.endFrame - caption.startFrame + 1;

    if (durationFrames < minCaptionFrames && index + 1 < captions.length) {
      const nextCaption = captions[index + 1];
      normalizedCaptions.push({
        text: `${caption.text} ${nextCaption.text}`.trim(),
        startFrame: caption.startFrame,
        endFrame: nextCaption.endFrame,
        words: [...caption.words, ...nextCaption.words]
      });
      index += 1;
      continue;
    }

    if (durationFrames < minCaptionFrames && normalizedCaptions.length > 0) {
      const previousCaption = normalizedCaptions[normalizedCaptions.length - 1];
      previousCaption.text = `${previousCaption.text} ${caption.text}`.trim();
      previousCaption.endFrame = Math.max(previousCaption.endFrame, caption.endFrame);
      previousCaption.words = [...previousCaption.words, ...caption.words];
      continue;
    }

    normalizedCaptions.push(caption);
  }

  return rebalanceWeakStarterCaptions(normalizedCaptions);
};

const buildAlignedTimeline = ({scenes, audioDurationSeconds, fps, timedWords, sceneSpans = []}) => {
  const transitionInFrames = 12;
  const captionChunkSize = Math.max(1, Number(process.env.CAPTION_WORDS_PER_CHUNK || 3));
  const totalFrames = Math.max(Math.round(audioDurationSeconds * fps), scenes.length * 60);
  const normalizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords,
    audioDurationSeconds
  }).timedWords;
  const sceneWords = assignTimedWordsToScenes({
    scenes,
    timedWords: normalizedTimedWords,
    audioDurationSeconds,
    sceneSpans
  });
  const sceneFrameRanges = buildAlignedSceneFrameRanges({
    sceneWords,
    fps,
    totalFrames
  });
  const captions = [];
  const timelineScenes = scenes.map((scene, sceneIndex) => {
    const words = sceneWords[sceneIndex];
    const sceneRange = sceneFrameRanges[sceneIndex] ?? {
      startFrame: sceneIndex === 0 ? 0 : sceneFrameRanges[sceneIndex - 1]?.endFrame + 1 ?? 0,
      endFrame: sceneIndex === scenes.length - 1
        ? totalFrames - 1
        : Math.max(
            sceneIndex === 0 ? 0 : sceneFrameRanges[sceneIndex - 1]?.endFrame + 1 ?? 0,
            totalFrames - 1
          )
    };
    const {startFrame: safeStart, endFrame: safeEnd} = clampFrameRange(
      sceneRange.startFrame,
      sceneRange.endFrame
    );
    const sceneCaptions = buildTimedCaptions({
      sceneWords: words,
      fps,
      chunkSize: captionChunkSize,
      sceneStartFrame: safeStart,
      sceneEndFrame: safeEnd,
      sourceText: scene.narration
    });

    captions.push(...sceneCaptions);

    return {
      ...scene,
      startFrame: safeStart,
      durationInFrames: safeEnd - safeStart + 1,
      transitionInFrames
    };
  });

  if (captions.length > 0 && captions[captions.length - 1].endFrame < totalFrames - 1) {
    captions[captions.length - 1].endFrame = totalFrames - 1;
  }

  return {
    durationInFrames: totalFrames,
    scenes: timelineScenes,
    captions: normalizeCaptionRanges(captions, totalFrames - 1)
  };
};

/**
 * Build the full video timeline: scene frame ranges and karaoke captions.
 * Uses timed-word alignment when available, otherwise falls back to proportional word-count distribution.
 * @param {object} params
 * @param {{narration: string, id?: string}[]} params.scenes - Storyboard scenes.
 * @param {number} params.audioDurationSeconds - Total voiceover duration.
 * @param {number} params.fps - Frames per second (typically 30).
 * @param {{startSeconds: number, endSeconds: number, startChar?: number, endChar?: number}[]} [params.timedWords=[]] - Word-level timestamps from STT.
 * @param {{sceneIndex: number, startChar: number, endChar: number}[]} [params.sceneSpans=[]] - Character-offset spans mapping narration to scenes.
 * @returns {{durationInFrames: number, scenes: object[], captions: {text: string, startFrame: number, endFrame: number, words: object[]}[]}}
 */
export const buildTimeline = ({scenes, audioDurationSeconds, fps, timedWords = [], sceneSpans = []}) => {
  const normalizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords,
    audioDurationSeconds
  }).timedWords;

  if (normalizedTimedWords.length > 0) {
    return buildAlignedTimeline({
      scenes,
      audioDurationSeconds,
      fps,
      timedWords: normalizedTimedWords,
      sceneSpans
    });
  }

  const transitionInFrames = 12;
  const captionChunkSize = Math.max(1, Number(process.env.CAPTION_WORDS_PER_CHUNK || 3));
  const totalFrames = Math.max(Math.round(audioDurationSeconds * fps), scenes.length * 60);
  const weights = scenes.map((scene) => Math.max(6, countWords(scene.narration)));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  const rawFrames = weights.map((weight) => Math.round((weight / weightTotal) * totalFrames));
  const sceneFrames = normalizeFrames(rawFrames, totalFrames);

  let frameCursor = 0;
  const captions = [];
  const timelineScenes = scenes.map((scene, sceneIndex) => {
    const durationInFrames = sceneFrames[sceneIndex];
    const startFrame = frameCursor;
    const textChunks = scene.narration
      .split(/\s+/)
      .filter(Boolean)
      .reduce((chunks, word, index) => {
        const chunkIndex = Math.floor(index / captionChunkSize);
        chunks[chunkIndex] = chunks[chunkIndex] ? `${chunks[chunkIndex]} ${word}` : word;
        return chunks;
      }, []);
    const chunkFrames = Math.max(12, Math.floor(durationInFrames / Math.max(1, textChunks.length)));

    textChunks.forEach((text, chunkIndex) => {
      const chunkStart = startFrame + chunkIndex * chunkFrames;
      const tentativeEnd = chunkIndex === textChunks.length - 1 ? startFrame + durationInFrames - 1 : chunkStart + chunkFrames - 1;

      captions.push({
        text,
        startFrame: chunkStart,
        endFrame: tentativeEnd,
        words: text.split(/\s+/).filter(Boolean).map((word) => ({
          text: word,
          startFrame: chunkStart,
          endFrame: tentativeEnd
        }))
      });
    });

    frameCursor += durationInFrames;

    return {
      ...scene,
      startFrame,
      durationInFrames,
      transitionInFrames
    };
  });

  return {
    durationInFrames: frameCursor,
    scenes: timelineScenes,
    captions: normalizeCaptionRanges(captions, frameCursor - 1)
  };
};
