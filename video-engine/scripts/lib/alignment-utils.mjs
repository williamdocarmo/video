const roundSeconds = (value, digits = 4) => {
  if (!Number.isFinite(Number(value))) {
    return 0;
  }

  return Number(Number(value).toFixed(digits));
};

export const sanitizeTimedWordsForAudio = ({
  timedWords = [],
  audioDurationSeconds = 0,
  overshootToleranceRatio = 1.02,
  minWordSpanSeconds = 0.04
} = {}) => {
  const sortedWords = Array.isArray(timedWords)
    ? timedWords
        .filter((word) => Number.isFinite(Number(word?.startSeconds)) && Number.isFinite(Number(word?.endSeconds)))
        .map((word) => ({
          ...word,
          startSeconds: Number(word.startSeconds),
          endSeconds: Number(word.endSeconds)
        }))
        .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds)
    : [];

  const safeAudioDuration = Number(audioDurationSeconds);
  const originalMaxEnd = sortedWords.reduce(
    (maxEnd, word) => Math.max(maxEnd, Number(word.endSeconds) || 0),
    0
  );

  if (!Number.isFinite(safeAudioDuration) || safeAudioDuration <= 0 || sortedWords.length === 0) {
    return {
      timedWords: sortedWords,
      metadata: {
        scaled: false,
        scale: 1,
        droppedCount: 0,
        clampedCount: 0,
        originalMaxEndSeconds: roundSeconds(originalMaxEnd),
        finalMaxEndSeconds: roundSeconds(originalMaxEnd)
      }
    };
  }

  const scale =
    originalMaxEnd > safeAudioDuration * overshootToleranceRatio
      ? safeAudioDuration / originalMaxEnd
      : 1;
  const maxStartSeconds = Math.max(0, safeAudioDuration - minWordSpanSeconds);
  const sanitizedWords = [];
  let droppedCount = 0;
  let clampedCount = 0;
  let previousStart = 0;

  for (const word of sortedWords) {
    let startSeconds = Math.max(0, word.startSeconds * scale);
    let endSeconds = Math.max(startSeconds + minWordSpanSeconds, word.endSeconds * scale);

    if (startSeconds > safeAudioDuration + 0.001) {
      droppedCount += 1;
      continue;
    }

    if (startSeconds > maxStartSeconds) {
      startSeconds = maxStartSeconds;
      clampedCount += 1;
    }

    if (endSeconds > safeAudioDuration) {
      endSeconds = safeAudioDuration;
      clampedCount += 1;
    }

    startSeconds = Math.max(previousStart, startSeconds);

    if (startSeconds > maxStartSeconds) {
      startSeconds = maxStartSeconds;
      clampedCount += 1;
    }

    if (endSeconds <= startSeconds) {
      if (startSeconds >= safeAudioDuration - 0.001) {
        droppedCount += 1;
        continue;
      }

      endSeconds = Math.min(safeAudioDuration, startSeconds + minWordSpanSeconds);
      clampedCount += 1;

      if (endSeconds <= startSeconds) {
        droppedCount += 1;
        continue;
      }
    }

    sanitizedWords.push({
      ...word,
      startSeconds: roundSeconds(startSeconds),
      endSeconds: roundSeconds(endSeconds)
    });
    previousStart = startSeconds;
  }

  const finalMaxEnd = sanitizedWords.reduce(
    (maxEnd, word) => Math.max(maxEnd, Number(word.endSeconds) || 0),
    0
  );

  return {
    timedWords: sanitizedWords,
    metadata: {
      scaled: scale !== 1,
      scale: roundSeconds(scale, 6),
      droppedCount,
      clampedCount,
      originalMaxEndSeconds: roundSeconds(originalMaxEnd),
      finalMaxEndSeconds: roundSeconds(finalMaxEnd)
    }
  };
};
