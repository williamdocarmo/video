import {spawnSync} from "node:child_process";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as speechSdk from "microsoft-cognitiveservices-speech-sdk";
import {sleep} from "../../../shared/utils.mjs";
import {sanitizeTimedWordsForAudio} from "./alignment-utils.mjs";
import {getGcpAccessToken, resolveGcpConfig} from "./gcp-config.mjs";

const ptBrPronunciationMap = new Map([
  ["voce", "você"],
  ["voces", "vocês"],
  ["sabado", "sábado"],
  ["tambem", "também"],
  ["cafe", "café"],
  ["pratica", "prática"],
  ["pratico", "prático"],
  ["musica", "música"],
  ["tecnologia", "tecnologia"],
  ["lingua", "língua"],
  ["familia", "família"],
  ["numero", "número"],
  ["negocio", "negócio"],
  ["historias", "histórias"],
  ["historia", "história"],
  ["dificeis", "difíceis"],
  ["facil", "fácil"],
  ["volei", "vôlei"]
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

const isWordChar = (char) => /[\p{L}\p{M}\p{N}]/u.test(String(char ?? ""));
const isJoinerChar = (char) => /['’\-‐‑–_]/u.test(String(char ?? ""));
const normalizeAlignmentToken = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

const withThinkingDisabled = (config = {}) => ({
  ...config,
  thinkingConfig: {
    thinkingBudget: 0
  }
});

const buildSourceWordTokens = (text) => {
  const sourceText = String(text ?? "");
  const tokens = [];
  let index = 0;

  while (index < sourceText.length) {
    while (index < sourceText.length && !isWordChar(sourceText[index])) {
      index += 1;
    }

    if (index >= sourceText.length) {
      break;
    }

    const startChar = index;
    let endChar = index;

    while (endChar < sourceText.length) {
      const char = sourceText[endChar];

      if (isWordChar(char)) {
        endChar += 1;
        continue;
      }

      if (isJoinerChar(char) && endChar + 1 < sourceText.length && isWordChar(sourceText[endChar + 1])) {
        endChar += 1;
        continue;
      }

      break;
    }

    const rawText = sourceText.slice(startChar, endChar);
    const normalized = normalizeAlignmentToken(rawText);

    if (normalized) {
      tokens.push({
        rawText,
        normalized,
        startChar,
        endChar: endChar - 1
      });
    }

    index = endChar;
  }

  return tokens;
};

const expandWordBounds = (text, startChar, endChar) => {
  const sourceText = String(text ?? "");
  let start = Math.max(0, Number(startChar) || 0);
  let end = Math.max(start, Number(endChar) || start);

  while (start < sourceText.length && /\s/u.test(sourceText[start])) {
    start += 1;
  }

  while (start > 0 && /["'‘’“”«»(\[\{<]/u.test(sourceText[start - 1])) {
    start -= 1;
  }

  while (end + 1 < sourceText.length) {
    const nextChar = sourceText[end + 1];

    if (/[\s"'\u2018\u2019\u201c\u201d\u00ab\u00bb)\]\}>,.;:?!…]/u.test(nextChar)) {
      end += 1;
      continue;
    }

    break;
  }

  return {startChar: start, endChar: end};
};

export const normalizePortugueseForTts = (text) => {
  let output = String(text ?? "");

  for (const [rawWord, accentedWord] of ptBrPronunciationMap.entries()) {
    const pattern = new RegExp(`\\b${rawWord}\\b`, "giu");
    output = output.replace(pattern, (match) => preserveCase(match, accentedWord));
  }

  return output
    .replace(/\bpra\b/giu, "pra")
    .replace(/\bpro\b/giu, "pro");
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe"
  });

  if (result.status !== 0) {
    throw new Error(`${command} falhou: ${result.stderr || result.stdout || "sem detalhes"}`);
  }

  return result.stdout?.trim() ?? "";
};

const splitIntoChunks = (text, maxCharacters = 4500) => {
  const normalized = text.trim();

  if (normalized.length <= maxCharacters) {
    return [normalized];
  }

  const chunks = [];
  let current = "";
  const sentences = normalized.match(/[^.!?]+[.!?]?\s*/g) ?? [normalized];

  for (const sentence of sentences) {
    const candidate = current ? `${current}${sentence}` : sentence;

    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (sentence.length <= maxCharacters) {
      current = sentence;
      continue;
    }

    let cursor = sentence;

    while (cursor.length > maxCharacters) {
      chunks.push(cursor.slice(0, maxCharacters));
      cursor = cursor.slice(maxCharacters);
    }

    current = cursor;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
};

const splitIntoChunkEntries = (text, maxCharacters = 4500) => {
  const sourceText = String(text ?? "");
  const chunks = splitIntoChunks(sourceText, maxCharacters);
  const entries = [];
  let searchCursor = 0;

  for (const chunkText of chunks) {
    const normalizedChunk = String(chunkText ?? "");
    const startChar = sourceText.indexOf(normalizedChunk, searchCursor);
    const safeStart = startChar >= 0 ? startChar : searchCursor;
    const endChar = safeStart + Math.max(0, normalizedChunk.length - 1);

    entries.push({
      text: normalizedChunk,
      startChar: safeStart,
      endChar
    });

    searchCursor = endChar + 1;
  }

  return entries;
};

const buildTimedWordsFromAlignment = ({text, alignment, timeOffsetSeconds = 0, charOffset = 0}) => {
  const characters = Array.isArray(alignment?.characters) ? alignment.characters : [];
  const startTimes = Array.isArray(alignment?.character_start_times_seconds)
    ? alignment.character_start_times_seconds
    : [];
  const endTimes = Array.isArray(alignment?.character_end_times_seconds) ? alignment.character_end_times_seconds : [];
  const timedWords = [];
  const wordPattern = /\S+/g;

  for (const match of text.matchAll(wordPattern)) {
    const rawToken = match[0];
    const leadingTrimmed = rawToken.replace(/^[^\p{L}\p{N}@#]+/u, "");
    const trailingTrimmed = leadingTrimmed.replace(/[^\p{L}\p{N}%.,;:?!…]+$/u, "");
    const wordText = trailingTrimmed || leadingTrimmed || rawToken;

    if (!normalizeAlignmentToken(wordText)) {
      continue;
    }

    const tokenStart = match.index ?? 0;
    const leadingChars = rawToken.indexOf(wordText);
    const tokenCharStart = tokenStart + Math.max(0, leadingChars);
    const tokenCharEnd = tokenCharStart + Math.max(1, wordText.length) - 1;

    if (tokenCharStart >= characters.length || tokenCharEnd >= endTimes.length) {
      continue;
    }

    const startSeconds = Number(startTimes[tokenCharStart] ?? 0) + timeOffsetSeconds;
    const endSeconds = Number(endTimes[tokenCharEnd] ?? startSeconds + 0.06) + timeOffsetSeconds;

    timedWords.push({
      text: wordText,
      rawText: rawToken,
      startSeconds,
      endSeconds: Math.max(endSeconds, startSeconds + 0.04),
      startChar: charOffset + tokenCharStart,
      endChar: charOffset + tokenCharEnd
    });
  }

  return timedWords;
};

const synthesizeWithElevenLabs = async ({
  text,
  mp3Path,
  apiKey,
  voiceId,
  modelId,
  languageCode,
  voiceSettings
}) => {
  const outputDir = path.dirname(mp3Path);
  const tempDir = path.join(outputDir, ".elevenlabs");
  const chunks = splitIntoChunks(text);

  await mkdir(tempDir, {recursive: true});

  const partPaths = [];
  const timedWords = [];
  let timeOffsetSeconds = 0;
  let charOffset = 0;

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const payload = {
        text: chunks[index],
        model_id: modelId,
        voice_settings: voiceSettings
      };

      if (languageCode) {
        payload.language_code = languageCode;
      }

      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "xi-api-key": apiKey
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`ElevenLabs respondeu ${response.status}`);
      }

      const responseBody = await response.json();
      const partPath = path.join(tempDir, `part-${String(index).padStart(2, "0")}.mp3`);
      partPaths.push(partPath);
      await writeFile(partPath, Buffer.from(String(responseBody.audio_base64 || ""), "base64"));

      timedWords.push(
        ...buildTimedWordsFromAlignment({
          text: chunks[index],
          alignment: responseBody.alignment,
          timeOffsetSeconds,
          charOffset
        })
      );

      timeOffsetSeconds += getAudioDurationSeconds(partPath);
      charOffset += chunks[index].length;
    }

    if (partPaths.length === 1) {
      await writeFile(mp3Path, await readFile(partPaths[0]));
    } else {
      const concatFile = path.join(tempDir, "concat.txt");
      const concatBody = partPaths.map((partPath) => `file '${partPath.replace(/'/g, "'\\''")}'`).join("\n");

      await writeFile(concatFile, `${concatBody}\n`);
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
      await rm(concatFile);
    }
  } finally {
    await Promise.all(partPaths.map((partPath) => rm(partPath, {force: true}))).catch(() => {}); /* best-effort temp cleanup */
    await rm(tempDir, {recursive: true, force: true}).catch(() => {}); /* best-effort temp cleanup */
  }

  return {
    provider: "elevenlabs",
    timedWords
  };
};

const ticksToSeconds = (ticks) => Number(ticks || 0) / 10000000;

const buildTimedWordsFromAzureBoundaries = ({
  text,
  boundaries,
  timeOffsetSeconds = 0,
  charOffset = 0
}) => {
  const sortedBoundaries = [...boundaries]
    .filter((boundary) => Number.isFinite(Number(boundary?.audioOffset)))
    .sort((left, right) => Number(left.audioOffset) - Number(right.audioOffset));
  const timedWords = [];

  for (let index = 0; index < sortedBoundaries.length; index += 1) {
    const boundary = sortedBoundaries[index];
    const startSeconds = ticksToSeconds(boundary.audioOffset) + timeOffsetSeconds;
    const nextStartSeconds =
      index + 1 < sortedBoundaries.length
        ? ticksToSeconds(sortedBoundaries[index + 1].audioOffset) + timeOffsetSeconds
        : null;
    const textOffset = Math.max(0, Number(boundary.textOffset) || 0);
    const wordLength = Math.max(
      1,
      Number(boundary.wordLength) || String(boundary.text || "").trim().length || 1
    );
    const rawText = String(
      text.slice(textOffset, textOffset + wordLength) || boundary.text || ""
    ).trim();

    if (!normalizeAlignmentToken(rawText)) {
      continue;
    }

    const durationSeconds =
      Number.isFinite(Number(boundary.duration)) && Number(boundary.duration) > 0
        ? ticksToSeconds(boundary.duration)
        : 0;

    timedWords.push({
      text: rawText,
      rawText,
      startSeconds,
      endSeconds: Math.max(
        startSeconds + 0.04,
        durationSeconds > 0
          ? startSeconds + durationSeconds
          : nextStartSeconds && nextStartSeconds > startSeconds
            ? nextStartSeconds
            : startSeconds + 0.18
      ),
      startChar: charOffset + textOffset,
      endChar: charOffset + textOffset + wordLength - 1
    });
  }

  return timedWords;
};

const countAlignmentWords = (text) =>
  String(text || "")
    .split(/\s+/)
    .filter((token) => normalizeAlignmentToken(token)).length;

const sceneSlicesLookCompressed = ({timedWords, text = "", sceneSpans = []}) => {
  if (!Array.isArray(sceneSpans) || sceneSpans.length === 0 || !Array.isArray(timedWords) || timedWords.length === 0) {
    return false;
  }

  return sceneSpans.some((span) => {
    const sourceText = String(text || "").slice(Number(span?.startChar) || 0, (Number(span?.endChar) || -1) + 1);
    const sourceWordCount = countAlignmentWords(sourceText);
    const slice = timedWords.filter(
      (word) =>
        Number.isFinite(Number(word?.startChar)) &&
        Number.isFinite(Number(word?.endChar)) &&
        Number(word.startChar) >= Number(span?.startChar) &&
        Number(word.startChar) <= Number(span?.endChar)
    );

    if (sourceWordCount === 0 || slice.length === 0) {
      return false;
    }

    const sliceCoverage = slice.length / Math.max(1, sourceWordCount);
    const sliceDurationSeconds =
      slice.length >= 2
        ? Number(slice[slice.length - 1]?.endSeconds ?? 0) - Number(slice[0]?.startSeconds ?? 0)
        : 0;

    return (
      (sourceWordCount >= 6 && sliceCoverage < 0.6) ||
      (slice.length >= 3 && sliceDurationSeconds > 0 && sliceDurationSeconds / slice.length < 0.08)
    );
  });
};

const getTimedWordsTailGapChars = ({timedWords, text = "", sceneSpans = []}) => {
  const lastEndChar = Array.isArray(timedWords) && timedWords.length > 0
    ? Math.max(...timedWords.map((word) => Number.isFinite(Number(word?.endChar)) ? Number(word.endChar) : -1))
    : -1;
  const tailTargetChar = Array.isArray(sceneSpans) && sceneSpans.length > 0
    ? Number(sceneSpans[sceneSpans.length - 1]?.endChar)
    : String(text || "").length - 1;

  if (!Number.isFinite(tailTargetChar) || tailTargetChar < 0) {
    return 0;
  }

  return Math.max(0, tailTargetChar - lastEndChar);
};

const timedWordsNeedCoverageRecovery = ({timedWords, text = "", sceneSpans = []}) => {
  const expectedWordCount = countAlignmentWords(text);
  const actualWordCount = Array.isArray(timedWords)
    ? timedWords.filter((word) => normalizeAlignmentToken(word?.rawText || word?.text)).length
    : 0;
  const tailGapChars = getTimedWordsTailGapChars({timedWords, text, sceneSpans});

  return (
    actualWordCount < Math.max(1, expectedWordCount - 2) ||
    tailGapChars > 6 ||
    sceneSlicesLookCompressed({timedWords, text, sceneSpans})
  );
};

const synthesizeAzureChunkToFile = async ({
  text,
  outputPath,
  apiKey,
  region,
  endpoint,
  voiceName,
  languageCode
}) => {
  if (!String(apiKey || "").trim()) {
    throw new Error("Azure Speech requer AZURE_SPEECH_KEY.");
  }

  if (!String(region || "").trim() && !String(endpoint || "").trim()) {
    throw new Error("Azure Speech requer AZURE_SPEECH_REGION ou AZURE_SPEECH_ENDPOINT.");
  }

  const speechConfig = region
    ? speechSdk.SpeechConfig.fromSubscription(apiKey, region)
    : speechSdk.SpeechConfig.fromEndpoint(new URL(endpoint), apiKey);

  speechConfig.speechSynthesisLanguage = languageCode;
  speechConfig.speechSynthesisVoiceName = voiceName;
  speechConfig.speechSynthesisOutputFormat =
    speechSdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechServiceResponse_RequestWordBoundary,
    "true"
  );
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechServiceResponse_RequestPunctuationBoundary,
    "false"
  );
  speechConfig.setProperty(
    speechSdk.PropertyId.SpeechServiceResponse_RequestSentenceBoundary,
    "false"
  );

  const audioConfig = speechSdk.AudioConfig.fromAudioFileOutput(outputPath);
  const synthesizer = new speechSdk.SpeechSynthesizer(speechConfig, audioConfig);
  const boundaries = [];

  synthesizer.wordBoundary = (_, event) => {
    if (
      event?.boundaryType &&
      event.boundaryType !== speechSdk.SpeechSynthesisBoundaryType.Word
    ) {
      return;
    }

    boundaries.push({
      text: String(event?.text || "").trim(),
      textOffset: Number(event?.textOffset ?? 0),
      wordLength: Number(event?.wordLength ?? 0),
      audioOffset: Number(event?.audioOffset ?? 0),
      duration: Number(event?.duration ?? 0)
    });
  };

  await new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();

        if (
          result?.reason === speechSdk.ResultReason.SynthesizingAudioCompleted
        ) {
          resolve(result);
          return;
        }

        reject(
          new Error(
            result?.errorDetails ||
              `Azure Speech falhou ao sintetizar o audio (reason=${result?.reason ?? "desconhecido"}).`
          )
        );
      },
      (error) => {
        synthesizer.close();
        reject(new Error(String(error || "Azure Speech falhou sem detalhes.")));
      }
    );
  });

  return {boundaries};
};

const synthesizeWithAzureSpeech = async ({
  text,
  mp3Path,
  apiKey,
  region,
  endpoint,
  voiceName = "pt-BR-AntonioNeural",
  languageCode = "pt-BR",
  sceneSpans = []
}) => {
  const outputDir = path.dirname(mp3Path);
  const tempDir = path.join(outputDir, ".azure-tts");
  const chunkEntries = splitIntoChunkEntries(
    text,
    Number.parseInt(process.env.AZURE_TTS_CHUNK_MAX_CHARACTERS || "3500", 10) || 3500
  );
  const partPaths = [];
  const timedWords = [];
  let timeOffsetSeconds = 0;

  await mkdir(tempDir, {recursive: true});

  try {
    for (let index = 0; index < chunkEntries.length; index += 1) {
      const chunk = chunkEntries[index];
      const partPath = path.join(tempDir, `part-${String(index).padStart(2, "0")}.mp3`);
      partPaths.push(partPath);

      const {boundaries} = await synthesizeAzureChunkToFile({
        text: chunk.text,
        outputPath: partPath,
        apiKey,
        region,
        endpoint,
        voiceName,
        languageCode
      });

      timedWords.push(
        ...buildTimedWordsFromAzureBoundaries({
          text: chunk.text,
          boundaries,
          timeOffsetSeconds,
          charOffset: chunk.startChar
        })
      );

      timeOffsetSeconds += getAudioDurationSeconds(partPath);
    }

    if (partPaths.length === 1) {
      run("ffmpeg", ["-y", "-i", partPaths[0], "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
    } else {
      const concatFile = path.join(tempDir, "concat.txt");
      const concatBody = partPaths.map((partPath) => `file '${partPath.replace(/'/g, "'\\''")}'`).join("\n");

      await writeFile(concatFile, `${concatBody}\n`);
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
      await rm(concatFile, {force: true});
    }

  let sanitizedTimedWords = reattachPunctuation(sanitizeCharOffsets(timedWords, text), text);
  const audioDurationSeconds = getAudioDurationSeconds(mp3Path);
  const lastWordEndSeconds =
    sanitizedTimedWords.length > 0
      ? Math.max(...sanitizedTimedWords.map((word) => Number(word?.endSeconds) || 0))
      : 0;
  const minTailPaddingSeconds = Math.max(
    0,
    Number.parseFloat(process.env.AZURE_TTS_END_PADDING_SECONDS || "0.12") || 0.12
  );
  const requiredTailPaddingSeconds = Math.min(
    0.8,
    Math.max(
      minTailPaddingSeconds,
      Number((lastWordEndSeconds - audioDurationSeconds + 0.04).toFixed(3))
    )
  );

  if (requiredTailPaddingSeconds > 0.02) {
    const paddedPath = path.join(tempDir, "voiceover-padded.mp3");
    run("ffmpeg", [
      "-y",
      "-i",
      mp3Path,
      "-af",
      `apad=pad_dur=${requiredTailPaddingSeconds.toFixed(3)}`,
      "-t",
      (audioDurationSeconds + requiredTailPaddingSeconds).toFixed(3),
      "-ar",
      "44100",
      "-ac",
      "2",
      "-b:a",
      "192k",
      paddedPath
    ]);
    await rm(mp3Path, {force: true});
    await writeFile(mp3Path, await readFile(paddedPath));
    await rm(paddedPath, {force: true});
  }

  let finalAudioDurationSeconds = getAudioDurationSeconds(mp3Path);
  const normalizedAzureTimedWords = sanitizeTimedWordsForAudio({
    timedWords: sanitizedTimedWords,
    audioDurationSeconds: finalAudioDurationSeconds
  });
  sanitizedTimedWords = normalizedAzureTimedWords.timedWords;

  if (
    normalizedAzureTimedWords.metadata.scaled ||
    normalizedAzureTimedWords.metadata.clampedCount > 0 ||
    normalizedAzureTimedWords.metadata.droppedCount > 0
  ) {
    process.stderr.write(
      `Azure WordBoundary normalizado: max ${normalizedAzureTimedWords.metadata.originalMaxEndSeconds}s -> ` +
      `${normalizedAzureTimedWords.metadata.finalMaxEndSeconds}s ` +
      `(scale=${normalizedAzureTimedWords.metadata.scale}, clamped=${normalizedAzureTimedWords.metadata.clampedCount}, dropped=${normalizedAzureTimedWords.metadata.droppedCount})\n`
    );
  }

  anchorTimestampsToAudioSilences(
    sanitizedTimedWords,
    mp3Path,
    finalAudioDurationSeconds,
    sceneSpans
  );
  sanitizedTimedWords = sanitizeTimedWordsForAudio({
    timedWords: sanitizedTimedWords,
    audioDurationSeconds: finalAudioDurationSeconds
  }).timedWords;

  const azureMaxSceneGap = Number.parseFloat(process.env.AZURE_TTS_MAX_SCENE_GAP_SECONDS || "0.78");
  if (azureMaxSceneGap > 0) {
    const boundaryCompression = compressSceneBoundarySilences({
      mp3Path,
      timedWords: sanitizedTimedWords,
      sceneSpans,
      maxGapSeconds: azureMaxSceneGap
    });

    if (boundaryCompression.metadata.applied) {
      sanitizedTimedWords = boundaryCompression.timedWords;
      finalAudioDurationSeconds = getAudioDurationSeconds(mp3Path);
      sanitizedTimedWords = sanitizeTimedWordsForAudio({
        timedWords: sanitizedTimedWords,
        audioDurationSeconds: finalAudioDurationSeconds
      }).timedWords;
    }
  }

  let timedWordsSource = "azure-word-boundary";

  if (timedWordsNeedCoverageRecovery({timedWords: sanitizedTimedWords, text, sceneSpans})) {
    process.stderr.write(
      "Aviso: Azure WordBoundary veio com cobertura incompleta; reextraindo timestamps do MP3 final.\n"
    );

    const recovered = await extractTimedWords({
      mp3Path,
      apiKey: process.env.GOOGLE_API_KEY || "",
      text,
      languageCode,
      sceneSpans
    });

    const recoveredImprovesCoverage =
      recovered.words.length > 0 &&
      getTimedWordsTailGapChars({timedWords: recovered.words, text, sceneSpans}) <
        getTimedWordsTailGapChars({timedWords: sanitizedTimedWords, text, sceneSpans});

    if (recoveredImprovesCoverage) {
      sanitizedTimedWords = recovered.words;
      timedWordsSource = recovered.source;
      process.stderr.write(
        `Recuperacao de cobertura aplicada via ${recovered.source}.\n`
      );
    }
  }

  } finally {
    await Promise.all(partPaths.map((partPath) => rm(partPath, {force: true}))).catch(() => {}); /* best-effort temp cleanup */
    await rm(tempDir, {recursive: true, force: true}).catch(() => {}); /* best-effort temp cleanup */
  }

  return {
    provider: "azure-speech",
    timedWords: sanitizedTimedWords,
    timedWordsSource,
    voiceName
  };
};

const parsePcmRate = (mimeType) => {
  const match = String(mimeType || "").match(/rate=(\d+)/i);
  return Number.parseInt(match?.[1] || "24000", 10);
};

const ALLOW_ESTIMATED_TIMED_WORDS =
  String(process.env.ALLOW_ESTIMATED_TIMED_WORDS || "true").trim().toLowerCase() === "true";
let whisperAvailability;

const canUseWhisperLocal = () => {
  if (typeof whisperAvailability === "boolean") {
    return whisperAvailability;
  }

  const whisperPython = "/Applications/Xcode.app/Contents/Developer/usr/bin/python3";

  try {
    const result = spawnSync(whisperPython, ["-c", "import mlx_whisper"], {
      encoding: "utf8",
      stdio: "pipe"
    });
    whisperAvailability = result.status === 0;
  } catch {
    whisperAvailability = false;
  }

  return whisperAvailability;
};

const extractResponseErrorSnippet = async (response) => {
  try {
    return String(await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
  } catch {
    return "";
  }
};

const extractTimedWordsWithGeminiFlash = async ({mp3Path, apiKey, text, languageCode = "pt-BR"}) => {
  const audioBytes = await readFile(mp3Path);
  const audioBase64 = audioBytes.toString("base64");

  const model = process.env.GEMINI_STT_MODEL || "gemini-2.5-flash";
  const requestUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      contents: [{
        parts: [
          {inlineData: {mimeType: "audio/mp3", data: audioBase64}},
          {text: `Transcribe this ${languageCode === "pt-BR" ? "Portuguese Brazilian" : "English"} audio with precise word-level timestamps. The expected text is: "${text}"\n\nReturn ONLY a JSON array where each element has: {"word": "...", "start": <seconds>, "end": <seconds>}\nNo markdown, no explanation, just the raw JSON array.`}
        ]
      }],
      generationConfig: withThinkingDisabled({
        temperature: 0,
        responseMimeType: "application/json"
      })
    })
  });

  if (!response.ok) {
    const errorSnippet = await extractResponseErrorSnippet(response);
    process.stderr.write(
      `Aviso: Gemini Flash transcricao respondeu ${response.status}` +
      (errorSnippet ? ` (${errorSnippet})` : "") +
      ", karaoke desativado.\n"
    );
    return [];
  }

  const payload = await response.json();
  const textContent = payload?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!textContent) {
    return [];
  }

  try {
    const parsed = JSON.parse(textContent);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (entry) =>
          entry?.word &&
          typeof entry.start === "number" &&
          typeof entry.end === "number" &&
          normalizeAlignmentToken(entry.word)
      )
      .map((entry) => ({
        text: String(entry.word),
        rawText: String(entry.word),
        startSeconds: entry.start,
        endSeconds: Math.max(entry.end, entry.start + 0.04)
      }));
  } catch {
    return [];
  }
};

const extractTimedWordsWithStt = async ({mp3Path, languageCode = "pt-BR"}) => {
  const audioDuration = getAudioDurationSeconds(mp3Path);
  const partDuration = 25;
  const parts = [];
  let offset = 0;

  while (offset < audioDuration) {
    const flacPath = mp3Path.replace(/\.mp3$/i, `.stt-${parts.length}.flac`);
    run("ffmpeg", ["-y", "-i", mp3Path, "-ss", String(offset), "-t", String(partDuration), "-ar", "16000", "-ac", "1", flacPath]);

    const partActualDuration = getAudioDurationSeconds(flacPath);
    parts.push({flacPath, offset, actualDuration: partActualDuration});
    offset += partDuration;
  }

  const timedWords = [];
  const accessToken = await getGcpAccessToken();

  for (const part of parts) {
    const audioBytes = await readFile(part.flacPath);
    const audioBase64 = audioBytes.toString("base64");
    await rm(part.flacPath, {force: true});

    const payloadJson = JSON.stringify({
      config: {encoding: "FLAC", sampleRateHertz: 16000, languageCode, enableWordTimeOffsets: true},
      audio: {content: audioBase64}
    });

    const tmpReqPath = part.flacPath.replace(".flac", ".req.json");
    await writeFile(tmpReqPath, payloadJson);

    const STT_MAX_ATTEMPTS = 4;
    const STT_BACKOFF_BASE_MS = 4000;
    const STT_BACKOFF_MAX_MS = 60000;
    let sttResponse = null;
    let sttLastError = null;

    try {
      for (let sttAttempt = 0; sttAttempt < STT_MAX_ATTEMPTS; sttAttempt += 1) {
        try {
          sttResponse = await fetch("https://speech.googleapis.com/v1/speech:recognize", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`
            },
            body: payloadJson
          });

          if (sttResponse.ok) {
            break;
          }

          const isRetryable = [429, 500, 502, 503, 504].includes(sttResponse.status);
          if (!isRetryable || sttAttempt >= STT_MAX_ATTEMPTS - 1) {
            break;
          }

          const backoffMs = Math.min(STT_BACKOFF_MAX_MS, STT_BACKOFF_BASE_MS * 2 ** sttAttempt + Math.floor(Math.random() * 2000));
          process.stderr.write(
            `STT part offset=${part.offset} respondeu ${sttResponse.status}; nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        } catch (fetchError) {
          sttLastError = fetchError;
          if (sttAttempt >= STT_MAX_ATTEMPTS - 1) {
            break;
          }
          const backoffMs = Math.min(STT_BACKOFF_MAX_MS, STT_BACKOFF_BASE_MS * 2 ** sttAttempt + Math.floor(Math.random() * 2000));
          process.stderr.write(
            `STT part offset=${part.offset} falhou (${String(fetchError?.message || fetchError)}); nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        }
      }

      if (!sttResponse?.ok) {
        const errorSnippet = sttResponse ? await extractResponseErrorSnippet(sttResponse) : "";
        const authHint =
          sttResponse && (sttResponse.status === 401 || sttResponse.status === 403)
            ? " Verifica se a service account tem acesso ao Google Cloud Speech-to-Text."
            : "";
        process.stderr.write(
          `STT part offset=${part.offset} falhou: ${sttResponse?.status ?? "network error"}` +
          (errorSnippet ? ` (${errorSnippet})` : "") +
          `${authHint}\n`
        );
        continue;
      }

      const payload = await sttResponse.json();

      for (const result of (payload?.results || [])) {
        for (const word of (result?.alternatives?.[0]?.words || [])) {
          const start = Number.parseFloat(String(word.startTime || "0s").replace("s", "")) + part.offset;
          const end = Number.parseFloat(String(word.endTime || "0s").replace("s", "")) + part.offset;
          timedWords.push({
            text: word.word,
            rawText: word.word,
            startSeconds: Math.round(start * 1000) / 1000,
            endSeconds: Math.round(Math.max(end, start + 0.04) * 1000) / 1000
          });
        }
      }
    } finally {
      await rm(tmpReqPath, {force: true});
    }
  }

  if (timedWords.length > 0) {
    const maxTimestamp = timedWords[timedWords.length - 1].endSeconds;

    if (maxTimestamp > audioDuration * 1.02) {
      const scale = audioDuration / maxTimestamp;
      process.stderr.write(`STT timestamps esticados (${maxTimestamp.toFixed(1)}s vs audio ${audioDuration.toFixed(1)}s), normalizando com fator ${scale.toFixed(3)}...\n`);

      for (const word of timedWords) {
        word.startSeconds = Math.round(word.startSeconds * scale * 1000) / 1000;
        word.endSeconds = Math.round(Math.max(word.endSeconds * scale, word.startSeconds + 0.04) * 1000) / 1000;
      }
    }
  }

  return timedWords;
};

const buildSilenceAnchoredSceneWindows = ({mp3Path, sceneWordCounts = [], audioDurationSeconds}) => {
  if (!mp3Path || sceneWordCounts.length < 2 || !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) {
    return [];
  }

  const silences = detectSilencePeriods(mp3Path, 0.25)
    .map((silence) => ({
      ...silence,
      duration: Math.max(0, silence.end - silence.start),
      center: silence.start + Math.max(0, silence.end - silence.start) / 2
    }))
    .filter(
      (silence) =>
        silence.duration >= 0.18 &&
        silence.center > 0.12 &&
        silence.center < audioDurationSeconds - 0.12
    );

  if (silences.length === 0) {
    return [];
  }

  const weights = sceneWordCounts.map((count) => Math.max(1, Number(count) || 1));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) {
    return [];
  }

  const boundaries = [];
  let assignedWeight = 0;
  let minimumBoundary = 0.12;

  for (let index = 0; index < weights.length - 1; index += 1) {
    assignedWeight += weights[index];
    const expectedBoundary = Math.min(
      audioDurationSeconds - 0.12,
      Math.max(minimumBoundary, (audioDurationSeconds * assignedWeight) / totalWeight)
    );
    let bestSilence = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const silence of silences) {
      if (silence.center <= minimumBoundary) {
        continue;
      }

      const distance = Math.abs(silence.center - expectedBoundary);
      const score = distance - Math.min(0.35, silence.duration) * 0.35;

      if (score < bestScore) {
        bestScore = score;
        bestSilence = silence;
      }
    }

    const snappedBoundary = bestSilence ? bestSilence.center : expectedBoundary;
    boundaries.push(snappedBoundary);
    minimumBoundary = snappedBoundary + 0.04;
  }

  const windows = [];
  let cursor = 0;

  for (const boundary of boundaries) {
    const clampedBoundary = Math.min(audioDurationSeconds, Math.max(cursor + 0.04, boundary));
    windows.push({start: cursor, end: clampedBoundary});
    cursor = clampedBoundary;
  }

  windows.push({start: cursor, end: Math.max(cursor + 0.04, audioDurationSeconds)});
  return windows;
};

export const buildEstimatedTimedWords = ({text, sceneSpans = [], audioDurationSeconds = 0, mp3Path = ""}) => {
  const sourceText = String(text ?? "");
  const matches = Array.from(sourceText.matchAll(/\S+/g));
  const safeAudioDuration = Number(audioDurationSeconds);

  if (matches.length === 0 || !Number.isFinite(safeAudioDuration) || safeAudioDuration <= 0) {
    return [];
  }

  const normalizedSpans = Array.isArray(sceneSpans)
    ? sceneSpans
        .map((span, sceneIndex) => ({
          sceneIndex: Number.isInteger(span?.sceneIndex) ? span.sceneIndex : sceneIndex,
          startChar: Number(span?.startChar),
          endChar: Number(span?.endChar)
        }))
        .filter(
          (span) =>
            Number.isFinite(span.startChar) &&
            Number.isFinite(span.endChar) &&
            span.endChar >= span.startChar
        )
        .sort((left, right) => left.sceneIndex - right.sceneIndex)
    : [];

  if (normalizedSpans.length === 0) {
    const perWordDuration = safeAudioDuration / matches.length;

    return matches.map((match, index) => {
      const rawText = match[0];
      const startChar = match.index ?? 0;
      const endChar = startChar + Math.max(1, rawText.length) - 1;
      const startSeconds = perWordDuration * index;
      const endSeconds =
        index === matches.length - 1
          ? safeAudioDuration
          : Math.max(startSeconds + 0.04, perWordDuration * (index + 1));

      return {
        text: rawText,
        rawText,
        startSeconds: Math.round(startSeconds * 1000) / 1000,
        endSeconds: Math.round(Math.max(endSeconds, startSeconds + 0.04) * 1000) / 1000,
        startChar,
        endChar
      };
    });
  }

  const sceneBuckets = normalizedSpans.map((span) => ({
    ...span,
    words: matches.filter((match) => {
      const startChar = match.index ?? 0;
      return startChar >= span.startChar && startChar <= span.endChar;
    })
  }));
  const weightedCounts = sceneBuckets.map((bucket) => Math.max(1, bucket.words.length));
  const silenceAnchoredWindows = buildSilenceAnchoredSceneWindows({
    mp3Path,
    sceneWordCounts: weightedCounts,
    audioDurationSeconds: safeAudioDuration
  });
  const totalWeight = weightedCounts.reduce((sum, value) => sum + value, 0);
  let cursorSeconds = 0;
  const estimatedWords = [];

  for (let index = 0; index < sceneBuckets.length; index += 1) {
    const bucket = sceneBuckets[index];
    const anchoredWindow = silenceAnchoredWindows[index] || null;
    const sceneStartSeconds = anchoredWindow ? anchoredWindow.start : cursorSeconds;
    const sceneDuration = anchoredWindow
      ? Math.max(0.04, anchoredWindow.end - anchoredWindow.start)
      : index === sceneBuckets.length - 1
        ? Math.max(0.04, safeAudioDuration - cursorSeconds)
        : (safeAudioDuration * weightedCounts[index]) / Math.max(1, totalWeight);
    const words = bucket.words;

    if (words.length === 0) {
      cursorSeconds = sceneStartSeconds + sceneDuration;
      continue;
    }

    const perWordDuration = sceneDuration / words.length;

    for (let wordIndex = 0; wordIndex < words.length; wordIndex += 1) {
      const match = words[wordIndex];
      const rawText = match[0];
      const startChar = match.index ?? 0;
      const endChar = startChar + Math.max(1, rawText.length) - 1;
      const startSeconds = sceneStartSeconds + perWordDuration * wordIndex;
      const endSeconds =
        index === sceneBuckets.length - 1 && wordIndex === words.length - 1
          ? safeAudioDuration
          : sceneStartSeconds + perWordDuration * (wordIndex + 1);

      estimatedWords.push({
        text: rawText,
        rawText,
        startSeconds: Math.round(startSeconds * 1000) / 1000,
        endSeconds: Math.round(Math.max(endSeconds, startSeconds + 0.04) * 1000) / 1000,
        startChar,
        endChar
      });
    }

    cursorSeconds = sceneStartSeconds + sceneDuration;
  }

  return estimatedWords;
};

const stripAccents = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const stripCharOffsets = (words) =>
  words.map((word) => {
    const clone = {...word};
    delete clone.startChar;
    delete clone.endChar;
    return clone;
  });

const sanitizeCharOffsets = (words, text) => {
  if (!text || words.length === 0) {
    return words;
  }

  const maxCharIndex = Math.max(0, text.length - 1);
  let invalidCount = 0;
  let previousEnd = -1;

  for (const word of words) {
    if (word.startChar === undefined || word.endChar === undefined) {
      invalidCount += 1;
      continue;
    }

    const startChar = Number(word.startChar);
    const endChar = Number(word.endChar);
    const invalid =
      !Number.isFinite(startChar) ||
      !Number.isFinite(endChar) ||
      startChar < 0 ||
      endChar < startChar ||
      startChar > maxCharIndex ||
      endChar > maxCharIndex ||
      startChar < previousEnd;

    if (invalid) {
      invalidCount += 1;
      continue;
    }

    previousEnd = endChar;
  }

  if (invalidCount > Math.max(2, Math.floor(words.length * 0.03))) {
    process.stderr.write(
      `Aviso: offsets de caracteres invalidos em ${invalidCount}/${words.length} palavras; ignorando char offsets e usando fallback proporcional.\n`
    );
    return stripCharOffsets(words);
  }

  return words;
};

const attachCharOffsets = (words, text) => {
  if (!text || words.length === 0) {
    return words;
  }

  if (words[0].startChar !== undefined) {
    return words;
  }

  const sourceText = String(text);
  const sourceTokens = buildSourceWordTokens(sourceText);
  let cursorTokenIndex = 0;

  for (const word of words) {
    const normalizedWord = normalizeAlignmentToken(word.text);

    if (!normalizedWord) {
      continue;
    }

    let bestMatchIndex = -1;

    for (let i = cursorTokenIndex; i < sourceTokens.length; i += 1) {
      if (sourceTokens[i].normalized === normalizedWord) {
        bestMatchIndex = i;
        break;
      }
    }

    if (bestMatchIndex >= 0) {
      const bounds = expandWordBounds(
        sourceText,
        sourceTokens[bestMatchIndex].startChar,
        sourceTokens[bestMatchIndex].endChar
      );
      word.startChar = bounds.startChar;
      word.endChar = bounds.endChar;
      cursorTokenIndex = bestMatchIndex + 1;
    } else {
      const fallbackToken = sourceTokens[cursorTokenIndex] || sourceTokens[sourceTokens.length - 1];

      if (fallbackToken) {
        const bounds = expandWordBounds(sourceText, fallbackToken.startChar, fallbackToken.endChar);
        word.startChar = bounds.startChar;
        word.endChar = bounds.endChar;
        cursorTokenIndex = Math.min(sourceTokens.length, cursorTokenIndex + 1);
      } else {
        word.startChar = cursorTokenIndex;
        word.endChar = cursorTokenIndex + Math.max(1, word.text.length) - 1;
      }
    }
  }

  return words;
};

const reattachPunctuation = (words, sourceText) => {
  if (!sourceText || words.length === 0) return words;

  for (const word of words) {
    if (word.startChar === undefined || word.endChar === undefined) continue;

    const bounds = expandWordBounds(sourceText, word.startChar, word.endChar);
    const fromSource = sourceText.slice(bounds.startChar, bounds.endChar + 1);

    if (fromSource && /\p{L}/u.test(fromSource)) {
      word.text = fromSource;
      word.startChar = bounds.startChar;
      word.endChar = bounds.endChar;
    }
  }

  return words;
};

const detectSilencePeriods = (mp3Path, minDurationSeconds = 0.35) => {
  try {
    const result = spawnSync("ffmpeg", [
      "-i", mp3Path,
      "-af", `silencedetect=noise=-35dB:d=${minDurationSeconds}`,
      "-f", "null", "-"
    ], {encoding: "utf8", stdio: "pipe"});
    const stderr = result.stderr || "";
    const periods = [];
    const regex = /silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) {
      periods.push({
        start: Number.parseFloat(match[1]),
        end: Number.parseFloat(match[2])
      });
    }
    return periods;
  } catch {
    return [];
  }
};

const mergeAudioDrops = (drops = []) => {
  if (!Array.isArray(drops) || drops.length === 0) {
    return [];
  }

  const sorted = drops
    .filter((drop) => Number.isFinite(drop?.start) && Number.isFinite(drop?.end) && drop.end > drop.start + 0.01)
    .sort((left, right) => left.start - right.start);

  if (sorted.length === 0) {
    return [];
  }

  const merged = [{...sorted[0]}];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];

    if (current.start <= previous.end + 0.01) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }

    merged.push({...current});
  }

  return merged;
};

const applyAudioDrops = (mp3Path, drops = [], logLabel = "Audio") => {
  const mergedDrops = mergeAudioDrops(drops);

  if (mergedDrops.length === 0) {
    return {
      applied: false,
      drops: [],
      savedSeconds: 0
    };
  }

  const tmpPath = mp3Path.replace(/\.mp3$/i, ".trimmed.mp3");
  const selectParts = mergedDrops.map((drop) => `between(t,${drop.start.toFixed(4)},${drop.end.toFixed(4)})`);
  const selectExpr = `not(${selectParts.join("+")})`;

  try {
    run("ffmpeg", [
      "-y", "-i", mp3Path,
      "-af", `aselect='${selectExpr}',asetpts=N/SR/TB`,
      "-ar", "44100", "-ac", "2", "-b:a", "192k",
      tmpPath
    ]);

    const trimmedDuration = getAudioDurationSeconds(tmpPath);
    const originalDuration = getAudioDurationSeconds(mp3Path);
    const savedSeconds = Number((originalDuration - trimmedDuration).toFixed(3));

    if (trimmedDuration > 0 && savedSeconds > 0.02) {
      spawnSync("mv", [tmpPath, mp3Path]);
      process.stderr.write(`${logLabel}: ${savedSeconds.toFixed(2)}s removidos (${mergedDrops.length} cortes).\n`);
      return {
        applied: true,
        drops: mergedDrops,
        savedSeconds
      };
    }

    spawnSync("rm", ["-f", tmpPath]);
  } catch (error) {
    process.stderr.write(`Aviso: ${logLabel.toLowerCase()} falhou (${error.message}), mantendo audio original.\n`);
    spawnSync("rm", ["-f", tmpPath]);
  }

  return {
    applied: false,
    drops: [],
    savedSeconds: 0
  };
};

const compressAudioSilences = (mp3Path, maxSilenceSeconds = 0.4) => {
  const silences = detectSilencePeriods(mp3Path, maxSilenceSeconds);
  if (silences.length === 0) return;

  // Build ffmpeg filter to trim excess silence from each period.
  // We keep maxSilenceSeconds of each silence and remove the rest.
  const drops = [];
  for (const sil of silences) {
    const excess = (sil.end - sil.start) - maxSilenceSeconds;
    if (excess <= 0.05) continue;
    // Keep half the allowed silence before the cut, half after
    const halfKeep = maxSilenceSeconds / 2;
    const cutStart = sil.start + halfKeep;
    const cutEnd = sil.end - halfKeep;
    if (cutEnd > cutStart + 0.02) {
      drops.push({start: cutStart, end: cutEnd});
    }
  }

  if (drops.length === 0) return;

  applyAudioDrops(mp3Path, drops, `Silencio comprimido (max ${maxSilenceSeconds}s)`);
};

const buildSegmentsFromSceneSpans = (words, sceneSpans = []) => {
  if (!Array.isArray(sceneSpans) || sceneSpans.length < 2 || words.length === 0) {
    return [];
  }

  const segments = [];

  for (const span of sceneSpans) {
    const startIdx = words.findIndex((word) => Number(word.endChar) >= Number(span.startChar));
    if (startIdx === -1) {
      continue;
    }

    let endIdx = startIdx;
    while (
      endIdx + 1 < words.length &&
      Number(words[endIdx + 1].startChar) <= Number(span.endChar)
    ) {
      endIdx += 1;
    }

    if (Number(words[endIdx].startChar) > Number(span.endChar)) {
      continue;
    }

    segments.push({startIdx, endIdx});
  }

  return segments;
};

const remapTimeThroughDrops = (seconds, drops = []) => {
  if (!Number.isFinite(seconds) || !Array.isArray(drops) || drops.length === 0) {
    return seconds;
  }

  let removedBefore = 0;

  for (const drop of drops) {
    const dropDuration = drop.end - drop.start;

    if (seconds >= drop.end) {
      removedBefore += dropDuration;
      continue;
    }

    if (seconds > drop.start) {
      return Math.max(0, drop.start - removedBefore);
    }

    break;
  }

  return Math.max(0, seconds - removedBefore);
};

const shiftTimedWordsForDrops = (timedWords = [], drops = []) =>
  timedWords.map((word) => {
    const startSeconds = remapTimeThroughDrops(Number(word?.startSeconds) || 0, drops);
    const endSeconds = remapTimeThroughDrops(Number(word?.endSeconds) || 0, drops);
    const originalDuration = Math.max(0.04, (Number(word?.endSeconds) || 0) - (Number(word?.startSeconds) || 0));

    return {
      ...word,
      startSeconds: Math.round(startSeconds * 1000) / 1000,
      endSeconds: Math.round(Math.max(endSeconds, startSeconds + originalDuration) * 1000) / 1000
    };
  });

const compressSceneBoundarySilences = ({
  mp3Path,
  timedWords = [],
  sceneSpans = [],
  maxGapSeconds = 0.22
}) => {
  if (!Array.isArray(timedWords) || timedWords.length < 2 || !Array.isArray(sceneSpans) || sceneSpans.length < 2) {
    return {
      timedWords,
      metadata: {
        applied: false,
        sceneBoundaryGapCount: 0,
        savedSeconds: 0
      }
    };
  }

  const sceneSegments = buildSegmentsFromSceneSpans(timedWords, sceneSpans);
  if (sceneSegments.length < 2) {
    return {
      timedWords,
      metadata: {
        applied: false,
        sceneBoundaryGapCount: 0,
        savedSeconds: 0
      }
    };
  }

  const silences = detectSilencePeriods(mp3Path, Math.min(0.2, Math.max(0.12, maxGapSeconds * 0.6)));
  if (silences.length === 0) {
    return {
      timedWords,
      metadata: {
        applied: false,
        sceneBoundaryGapCount: 0,
        savedSeconds: 0
      }
    };
  }

  const drops = [];

  for (let index = 0; index < sceneSegments.length - 1; index += 1) {
    const current = sceneSegments[index];
    const next = sceneSegments[index + 1];
    const currentEnd = Number(timedWords[current.endIdx]?.endSeconds);
    const nextStart = Number(timedWords[next.startIdx]?.startSeconds);

    if (!Number.isFinite(currentEnd) || !Number.isFinite(nextStart)) {
      continue;
    }

    const boundaryGapSeconds = nextStart - currentEnd;
    if (boundaryGapSeconds <= maxGapSeconds + 0.08) {
      continue;
    }

    const overlappingSilences = silences.filter((silence) => silence.end > currentEnd && silence.start < nextStart);
    if (overlappingSilences.length === 0) {
      continue;
    }

    const silenceStart = Math.max(
      currentEnd,
      Math.min(...overlappingSilences.map((silence) => silence.start))
    );
    const silenceEnd = Math.min(
      nextStart,
      Math.max(...overlappingSilences.map((silence) => silence.end))
    );
    const silenceDuration = silenceEnd - silenceStart;

    if (silenceDuration <= maxGapSeconds + 0.05) {
      continue;
    }

    const keepDuration = Math.min(maxGapSeconds, silenceDuration);
    const cutStart = silenceStart + keepDuration / 2;
    const cutEnd = silenceEnd - keepDuration / 2;

    if (cutEnd > cutStart + 0.02) {
      drops.push({start: cutStart, end: cutEnd});
    }
  }

  const applied = applyAudioDrops(
    mp3Path,
    drops,
    `Silencio entre cenas comprimido (max ${maxGapSeconds}s)`
  );

  if (!applied.applied) {
    return {
      timedWords,
      metadata: {
        applied: false,
        sceneBoundaryGapCount: drops.length,
        savedSeconds: 0
      }
    };
  }

  return {
    timedWords: shiftTimedWordsForDrops(timedWords, applied.drops),
    metadata: {
      applied: true,
      sceneBoundaryGapCount: applied.drops.length,
      savedSeconds: applied.savedSeconds
    }
  };
};

const anchorTimestampsToAudioSilences = (words, mp3Path, audioDuration, sceneSpans = []) => {
  if (words.length < 10) return;

  const silences = detectSilencePeriods(mp3Path, 0.4);
  if (silences.length === 0) return;

  let sttSegments = buildSegmentsFromSceneSpans(words, sceneSpans);
  let segmentsSource = "scene-spans";

  if (sttSegments.length < 2) {
    // Build STT speech segments: groups of words separated by pauses > 0.3s
    sttSegments = [];
    let segStart = 0;
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].startSeconds - words[i - 1].endSeconds;
      if (gap > 0.3) {
        sttSegments.push({startIdx: segStart, endIdx: i - 1});
        segStart = i;
      }
    }
    sttSegments.push({startIdx: segStart, endIdx: words.length - 1});
    segmentsSource = "stt-gaps";
  }

  if (sttSegments.length < 2) return;

  // Build audio speech windows from silence boundaries
  // Speech window 0: [0 .. first silence start]
  // Speech window 1: [first silence end .. second silence start]
  // etc.
  const audioWindows = [];
  audioWindows.push({start: 0, end: silences[0].start});
  for (let i = 0; i < silences.length; i++) {
    const windowEnd = i < silences.length - 1 ? silences[i + 1].start : audioDuration;
    audioWindows.push({start: silences[i].end, end: windowEnd});
  }

  // Match STT segments to audio windows
  // They should correspond 1:1 when counts match. When they don't, we only
  // apply anchoring if the count difference is small (±2), using a best-effort
  // greedy match by comparing segment midpoints.
  const countDiff = Math.abs(sttSegments.length - audioWindows.length);
  if (countDiff > Math.max(2, Math.floor(sttSegments.length * 0.15))) {
    process.stderr.write(
      `Ancoragem: segmentos ${segmentsSource} (${sttSegments.length}) vs janelas audio (${audioWindows.length}) muito diferentes, pulando.\n`
    );
    return;
  }

  // Greedy match: for each STT segment, find the closest audio window by midpoint
  const matchedPairs = [];
  const usedWindows = new Set();
  for (const seg of sttSegments) {
    const sttMid = (words[seg.startIdx].startSeconds + words[seg.endIdx].endSeconds) / 2;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let w = 0; w < audioWindows.length; w++) {
      if (usedWindows.has(w)) continue;
      const winMid = (audioWindows[w].start + audioWindows[w].end) / 2;
      const dist = Math.abs(sttMid - winMid);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = w;
      }
    }
    if (bestIdx >= 0) {
      usedWindows.add(bestIdx);
      matchedPairs.push({seg, window: audioWindows[bestIdx]});
    }
  }

  if (matchedPairs.length < 2) return;

  // Save original timestamps so we can revert if anchoring goes wrong
  const originals = words.map(w => ({startSeconds: w.startSeconds, endSeconds: w.endSeconds}));

  // Re-scale timestamps within each matched pair
  let totalShifted = 0;
  for (const {seg, window: win} of matchedPairs) {
    const sttStart = words[seg.startIdx].startSeconds;
    const sttEnd = words[seg.endIdx].endSeconds;
    const sttDuration = Math.max(0.04, sttEnd - sttStart);
    const winDuration = Math.max(0.04, win.end - win.start);
    const scale = winDuration / sttDuration;

    for (let i = seg.startIdx; i <= seg.endIdx; i++) {
      const relStart = words[i].startSeconds - sttStart;
      const relEnd = words[i].endSeconds - sttStart;
      const newStart = win.start + relStart * scale;
      const newEnd = win.start + relEnd * scale;
      const oldStart = words[i].startSeconds;
      words[i].startSeconds = Math.round(newStart * 1000) / 1000;
      words[i].endSeconds = Math.round(Math.max(newEnd, newStart + 0.04) * 1000) / 1000;
      totalShifted += Math.abs(words[i].startSeconds - oldStart);
    }
  }

  const avgShift = totalShifted / words.length;

  // Sanity check: revert if anchoring made things worse
  // Check monotonicity and average shift magnitude
  let monotonic = true;
  for (let i = 1; i < words.length; i++) {
    if (words[i].startSeconds < words[i - 1].startSeconds - 0.01) {
      monotonic = false;
      break;
    }
  }

  if (!monotonic || avgShift > 2.0) {
    process.stderr.write(
      `Ancoragem revertida: ${!monotonic ? "timestamps nao-monotonicos" : `shift medio ${avgShift.toFixed(3)}s muito alto`}.\n`
    );
    for (let i = 0; i < words.length; i++) {
      words[i].startSeconds = originals[i].startSeconds;
      words[i].endSeconds = originals[i].endSeconds;
    }
    return;
  }

  process.stderr.write(
    `Ancoragem silencio: ${matchedPairs.length} segmentos alinhados via ${segmentsSource}, shift medio ${avgShift.toFixed(3)}s/palavra.\n`
  );
};

const extractTimedWords = async ({mp3Path, apiKey, text, languageCode = "pt-BR", sceneSpans = []}) => {
  let words = [];
  let source = "none";

  try {
    process.stderr.write("Usando Google Cloud Speech-to-Text para timestamps...\n");
    const result = await extractTimedWordsWithStt({mp3Path, languageCode});
    if (result.length > 0) {
      words = reattachPunctuation(sanitizeCharOffsets(attachCharOffsets(result, text), text), text);
      source = "gcloud-speech-stt";
    }
  } catch (sttError) {
    process.stderr.write(`Google Cloud Speech-to-Text falhou: ${sttError.message}\n`);
  }

  // Normalize timestamps to actual audio duration (Gemini often hallucinates longer timestamps)
  if (words.length > 0) {
    const audioDuration = getAudioDurationSeconds(mp3Path);
    const normalizedSttTimedWords = sanitizeTimedWordsForAudio({
      timedWords: words,
      audioDurationSeconds: audioDuration
    });
    words = normalizedSttTimedWords.timedWords;

    if (
      normalizedSttTimedWords.metadata.scaled ||
      normalizedSttTimedWords.metadata.clampedCount > 0 ||
      normalizedSttTimedWords.metadata.droppedCount > 0
    ) {
      process.stderr.write(
        `Normalizando timestamps STT: max ${normalizedSttTimedWords.metadata.originalMaxEndSeconds}s -> ` +
        `${normalizedSttTimedWords.metadata.finalMaxEndSeconds}s ` +
        `(scale ${normalizedSttTimedWords.metadata.scale})\n`
      );
    }

    // Anchor STT timestamps to real audio silence boundaries.
    // Gemini Flash STT compresses inter-sentence pauses, causing a non-linear
    // drift that peaks in the middle of the audio (up to ~2-3s on long clips).
    // We detect the actual silence periods in the audio and re-scale timestamps
    // within each speech segment so they align with reality.
    anchorTimestampsToAudioSilences(words, mp3Path, audioDuration, sceneSpans);
    words = sanitizeTimedWordsForAudio({
      timedWords: words,
      audioDurationSeconds: audioDuration
    }).timedWords;
  }

  return {words, source};
};

export const extractTimedWordsFromAudio = async ({
  mp3Path,
  apiKey,
  text,
  languageCode = "pt-BR",
  sceneSpans = [],
  allowEstimated = ALLOW_ESTIMATED_TIMED_WORDS
}) => {
  process.stderr.write("Extraindo timestamps palavra-a-palavra para karaoke...\n");
  const {words: timedWords, source: twSource} = await extractTimedWords({
    mp3Path,
    apiKey,
    text,
    languageCode,
    sceneSpans
  });

  if (timedWords.length > 0) {
    process.stderr.write(`Karaoke: ${timedWords.length} palavras via ${twSource}.\n`);
    return {
      timedWords,
      timedWordsSource: twSource
    };
  }

  process.stderr.write("Aviso: nenhum timestamp extraido, karaoke desativado.\n");

  const fallbackTimedWords = allowEstimated
    ? buildEstimatedTimedWords({
        text,
        sceneSpans,
        audioDurationSeconds: getAudioDurationSeconds(mp3Path),
        mp3Path
      })
    : [];

  if (fallbackTimedWords.length > 0) {
    process.stderr.write(
      `Karaoke: usando ${fallbackTimedWords.length} timedWords estimados porque STT nao devolveu alinhamento confiavel.\n`
    );
  }

  return {
    timedWords: fallbackTimedWords,
    timedWordsSource: fallbackTimedWords.length > 0 ? "estimated" : "none"
  };
};

const GOOGLE_TTS_CHUNK_MAX_CHARACTERS = Number.parseInt(
  process.env.GOOGLE_TTS_CHUNK_MAX_CHARACTERS || "1800",
  10
);
const GOOGLE_TTS_MAX_ATTEMPTS = Number.parseInt(process.env.GOOGLE_TTS_MAX_ATTEMPTS || "12", 10);
const GOOGLE_TTS_MIN_RETRY_MS = Number.parseInt(process.env.GOOGLE_TTS_MIN_RETRY_MS || "12000", 10);
const GOOGLE_TTS_MAX_RETRY_MS = Number.parseInt(process.env.GOOGLE_TTS_MAX_RETRY_MS || "180000", 10);
const GOOGLE_TTS_INTER_REQUEST_MS = Number.parseInt(process.env.GOOGLE_TTS_INTER_REQUEST_MS || "6000", 10);
const CLOUD_GEMINI_TTS_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.CLOUD_GEMINI_TTS_MAX_ATTEMPTS || process.env.GOOGLE_TTS_MAX_ATTEMPTS || "6", 10) || 6
);
const CLOUD_GEMINI_TTS_MIN_RETRY_MS = Math.max(
  1000,
  Number.parseInt(process.env.CLOUD_GEMINI_TTS_MIN_RETRY_MS || process.env.GOOGLE_TTS_MIN_RETRY_MS || "15000", 10) || 15000
);
const CLOUD_GEMINI_TTS_MAX_RETRY_MS = Math.max(
  CLOUD_GEMINI_TTS_MIN_RETRY_MS,
  Number.parseInt(process.env.CLOUD_GEMINI_TTS_MAX_RETRY_MS || process.env.GOOGLE_TTS_MAX_RETRY_MS || "180000", 10) || 180000
);
const CLOUD_GEMINI_TTS_INTER_REQUEST_MS = Math.max(
  0,
  Number.parseInt(
    process.env.CLOUD_GEMINI_TTS_INTER_REQUEST_MS || process.env.GOOGLE_TTS_INTER_REQUEST_MS || "12000",
    10
  ) || 12000
);
const CLOUD_GEMINI_TTS_FALLBACK_ENABLED =
  String(process.env.CLOUD_GEMINI_TTS_FALLBACK_ENABLED || "true").trim().toLowerCase() !== "false";
const CLOUD_GEMINI_TTS_FALLBACK_VOICE = String(
  process.env.CLOUD_GEMINI_TTS_FALLBACK_VOICE ||
  process.env.TTS_FALLBACK_VOICE ||
  "pt-BR-Chirp3-HD-Achernar"
).trim();

const computeGoogleRetryDelayMs = (response, attempt) => {
  const retryAfterHeader = Number.parseInt(response?.headers?.get("retry-after") || "0", 10);

  if (retryAfterHeader > 0) {
    return Math.min(GOOGLE_TTS_MAX_RETRY_MS, retryAfterHeader * 1000);
  }

  const exponentialDelay = GOOGLE_TTS_MIN_RETRY_MS * 2 ** Math.max(0, attempt);
  return Math.min(GOOGLE_TTS_MAX_RETRY_MS, exponentialDelay);
};

const computeCloudGeminiRetryDelayMs = (response, attempt) => {
  const retryAfterHeader = Number.parseInt(response?.headers?.get("retry-after") || "0", 10);

  if (retryAfterHeader > 0) {
    return Math.min(CLOUD_GEMINI_TTS_MAX_RETRY_MS, retryAfterHeader * 1000);
  }

  const exponentialDelay = CLOUD_GEMINI_TTS_MIN_RETRY_MS * 2 ** Math.max(0, attempt);
  const jitterMs = Math.floor(Math.random() * 2500);
  return Math.min(CLOUD_GEMINI_TTS_MAX_RETRY_MS, exponentialDelay + jitterMs);
};

const isRetryableGoogleTtsStatus = (status) => [429, 500, 502, 503, 504].includes(Number(status));

const isRetryableCloudGeminiTtsError = (error) => {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "429",
    "500",
    "502",
    "503",
    "504",
    "timeout",
    "timed out",
    "temporarily unavailable",
    "fetch failed",
    "network",
    "connection"
  ].some((term) => message.includes(term));
};

const synthesizeWithGoogleGeminiTts = async ({
  text,
  mp3Path,
  apiKey,
  model,
  voiceName,
  languageCode,
  stylePrompt,
  sceneSpans = []
}) => {
  const outputDir = path.dirname(mp3Path);
  const tempDir = path.join(outputDir, ".google-tts");
  const chunks = splitIntoChunks(text, GOOGLE_TTS_CHUNK_MAX_CHARACTERS);
  const partPaths = [];
  let modelVersion = model;
  const usageMetadata = {
    promptTokenCount: 0,
    candidatesTokenCount: 0,
    totalTokenCount: 0
  };

  await mkdir(tempDir, {recursive: true});

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const promptText =
        languageCode === "pt-BR"
          ? `Fale em português do Brasil, ${stylePrompt || "com voz masculina natural, segura e calorosa"}, dizendo exatamente este texto: ${chunks[index]}`
          : `Speak naturally${stylePrompt ? `, ${stylePrompt}` : ""}, saying exactly this text: ${chunks[index]}`;

      const requestUrl =
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const requestBody = {
        contents: [
          {
            parts: [
              {
                text: promptText
              }
            ]
          }
        ],
        generationConfig: withThinkingDisabled({
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName
              }
            }
          }
        })
      };

      let response = null;
      let lastStatus = null;

      for (let attempt = 0; attempt < GOOGLE_TTS_MAX_ATTEMPTS; attempt += 1) {
        try {
          response = await fetch(requestUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody)
          });
          lastStatus = response.status;

          if (response.ok) {
            break;
          }

          if (!isRetryableGoogleTtsStatus(response.status) || attempt >= GOOGLE_TTS_MAX_ATTEMPTS - 1) {
            break;
          }

          const backoffMs = computeGoogleRetryDelayMs(response, attempt);
          process.stderr.write(
            `Aviso: Google Gemini TTS devolveu ${response.status} no chunk ${index + 1}/${chunks.length}; nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        } catch (error) {
          lastStatus = null;

          if (attempt >= GOOGLE_TTS_MAX_ATTEMPTS - 1 || !isRetryableCloudGeminiTtsError(error)) {
            throw error;
          }

          const backoffMs = computeGoogleRetryDelayMs(null, attempt);
          process.stderr.write(
            `Aviso: Google Gemini TTS falhou no chunk ${index + 1}/${chunks.length} (${String(error?.message || error)}); nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        }
      }

      if (!response?.ok) {
        throw new Error(`Google Gemini TTS respondeu ${lastStatus ?? response?.status ?? "erro desconhecido"}`);
      }

      const payload = await response.json();
      const audioPart = payload?.candidates?.[0]?.content?.parts?.find((part) => part?.inlineData?.data);

      if (!audioPart?.inlineData?.data) {
        throw new Error("Google Gemini TTS nao devolveu audio.");
      }

      const mimeType = String(audioPart.inlineData.mimeType || "audio/L16;codec=pcm;rate=24000");
      const sampleRate = parsePcmRate(mimeType);
      const tempRawPath = path.join(tempDir, `part-${String(index).padStart(2, "0")}.raw`);
      const partMp3Path = path.join(tempDir, `part-${String(index).padStart(2, "0")}.mp3`);
      partPaths.push(partMp3Path);
      modelVersion = payload?.modelVersion ?? modelVersion;

      usageMetadata.promptTokenCount += Number(payload?.usageMetadata?.promptTokenCount ?? 0);
      usageMetadata.candidatesTokenCount += Number(payload?.usageMetadata?.candidatesTokenCount ?? 0);
      usageMetadata.totalTokenCount += Number(payload?.usageMetadata?.totalTokenCount ?? 0);

      await writeFile(tempRawPath, Buffer.from(audioPart.inlineData.data, "base64"));
      run("ffmpeg", [
        "-y",
        "-f",
        "s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "1",
        "-i",
        tempRawPath,
        "-vn",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-b:a",
        "192k",
        partMp3Path
      ]);
      await rm(tempRawPath, {force: true});

      if (index < chunks.length - 1 && GOOGLE_TTS_INTER_REQUEST_MS > 0) {
        await sleep(GOOGLE_TTS_INTER_REQUEST_MS);
      }
    }

    if (partPaths.length === 1) {
      await writeFile(mp3Path, await readFile(partPaths[0]));
    } else {
      const concatFile = path.join(tempDir, "concat.txt");
      const concatBody = partPaths.map((partPath) => `file '${partPath.replace(/'/g, "'\\''")}'`).join("\n");
      await writeFile(concatFile, `${concatBody}\n`);
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
      await rm(concatFile, {force: true});
    }
  } finally {
    await Promise.all(partPaths.map((partPath) => rm(partPath, {force: true}))).catch(() => {}); /* best-effort temp cleanup */
    await rm(tempDir, {recursive: true, force: true}).catch(() => {}); /* best-effort temp cleanup */
  }

  // Compress long inter-sentence silences in the generated audio.
  // Gemini TTS often inserts ~0.9-1.0s pauses between sentences; we cap them
  // at a configurable maximum (default 0.4s) so the video feels tighter.
  const maxSilence = Number.parseFloat(process.env.TTS_MAX_SILENCE_SECONDS || "0.4");
  if (maxSilence > 0) {
    compressAudioSilences(mp3Path, maxSilence);
  }

  const {timedWords, timedWordsSource} = await extractTimedWordsFromAudio({
    mp3Path,
    apiKey,
    text,
    languageCode,
    sceneSpans,
    allowEstimated: ALLOW_ESTIMATED_TIMED_WORDS
  });

  return {
    provider: "google-gemini-tts",
    timedWords,
    timedWordsSource,
    usageMetadata,
    modelVersion,
    voiceName
  };
};

const synthesizeWithCloudTtsChirp3 = async ({
  text,
  mp3Path,
  voiceName = "pt-BR-Chirp3-HD-Achernar",
  languageCode = "pt-BR",
  sceneSpans = []
}) => {
  const chunks = splitIntoChunks(text, 4500);
  const outputDir = path.dirname(mp3Path);
  const tempDir = path.join(outputDir, ".cloud-tts");
  const partPaths = [];
  const accessToken = await getGcpAccessToken();
  const gcpConfig = resolveGcpConfig(process.env);

  await mkdir(tempDir, {recursive: true});

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "x-goog-user-project": gcpConfig.projectId
        },
        body: JSON.stringify({
          input: {text: chunks[index]},
          voice: {languageCode, name: voiceName},
          audioConfig: {audioEncoding: "MP3", sampleRateHertz: 44100}
        })
      });

      if (!response.ok) {
        const errorSnippet = await extractResponseErrorSnippet(response);
        throw new Error(`Cloud TTS respondeu ${response.status}${errorSnippet ? ` (${errorSnippet})` : ""}`);
      }

      const payload = await response.json();

      if (!payload?.audioContent) {
        throw new Error("Cloud TTS Chirp3 nao devolveu audio.");
      }

      const partPath = path.join(tempDir, `part-${String(index).padStart(2, "0")}.mp3`);
      partPaths.push(partPath);
      await writeFile(partPath, Buffer.from(payload.audioContent, "base64"));

      if (index < chunks.length - 1 && CLOUD_GEMINI_TTS_INTER_REQUEST_MS > 0) {
        await sleep(CLOUD_GEMINI_TTS_INTER_REQUEST_MS);
      }
    }

    if (partPaths.length === 1) {
      await writeFile(mp3Path, await readFile(partPaths[0]));
    } else {
      const concatFile = path.join(tempDir, "concat.txt");
      const concatBody = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      await writeFile(concatFile, `${concatBody}\n`);
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
      await rm(concatFile, {force: true});
    }
  } finally {
    await Promise.all(partPaths.map((p) => rm(p, {force: true}))).catch(() => {}); /* best-effort temp cleanup */
    await rm(tempDir, {recursive: true, force: true}).catch(() => {}); /* best-effort temp cleanup */
  }

  const maxSilence = Number.parseFloat(process.env.TTS_MAX_SILENCE_SECONDS || "0.4");
  if (maxSilence > 0) {
    compressAudioSilences(mp3Path, maxSilence);
  }

  const {timedWords, timedWordsSource} = await extractTimedWordsFromAudio({
    mp3Path,
    text,
    languageCode,
    sceneSpans,
    allowEstimated: ALLOW_ESTIMATED_TIMED_WORDS
  });

  return {
    provider: "cloud-tts-chirp3",
    timedWords,
    timedWordsSource,
    voiceName
  };
};

const synthesizeWithCloudTtsGemini = async ({
  text,
  mp3Path,
  model = "gemini-2.5-flash-tts",
  voiceName = "Iapetus",
  languageCode = "pt-BR",
  stylePrompt = "",
  sceneSpans = []
}) => {
  const chunks = splitIntoChunks(text, 3900);
  const outputDir = path.dirname(mp3Path);
  const tempDir = path.join(outputDir, ".cloud-gemini-tts");
  const partPaths = [];
  const accessToken = await getGcpAccessToken();
  const gcpConfig = resolveGcpConfig(process.env);

  await mkdir(tempDir, {recursive: true});

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      let response = null;
      let lastError = null;

      for (let attempt = 0; attempt < CLOUD_GEMINI_TTS_MAX_ATTEMPTS; attempt += 1) {
        try {
          response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
              "x-goog-user-project": gcpConfig.projectId
            },
            body: JSON.stringify({
              input: {
                prompt:
                  stylePrompt ||
                  (languageCode === "pt-BR"
                    ? "Fale em português do Brasil com voz masculina firme, natural, segura e envolvente."
                    : "Speak with a natural, confident and engaging delivery."),
                text: chunks[index]
              },
              voice: {
                languageCode,
                name: voiceName,
                model_name: model
              },
              audioConfig: {
                audioEncoding: "MP3",
                sampleRateHertz: 44100
              }
            })
          });

          if (response.ok) {
            break;
          }

          const retryable = isRetryableGoogleTtsStatus(response.status);
          lastError = new Error(`Cloud Gemini TTS respondeu ${response.status}`);
          if (!retryable || attempt >= CLOUD_GEMINI_TTS_MAX_ATTEMPTS - 1) {
            break;
          }

          const backoffMs = computeCloudGeminiRetryDelayMs(response, attempt);
          process.stderr.write(
            `Aviso: Cloud Gemini TTS respondeu ${response.status} no chunk ${index + 1}/${chunks.length}; nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt >= CLOUD_GEMINI_TTS_MAX_ATTEMPTS - 1 || !isRetryableCloudGeminiTtsError(lastError)) {
            throw lastError;
          }

          const backoffMs = computeCloudGeminiRetryDelayMs(null, attempt);
          process.stderr.write(
            `Aviso: Cloud Gemini TTS falhou no chunk ${index + 1}/${chunks.length} (${lastError.message}); nova tentativa em ${Math.round(backoffMs / 1000)}s.\n`
          );
          await sleep(backoffMs);
        }
      }

      if (!response?.ok) {
        const errorSnippet = response ? await extractResponseErrorSnippet(response) : "";
        throw new Error(
          lastError?.message ||
            `Cloud Gemini TTS respondeu ${response?.status ?? "erro desconhecido"}${errorSnippet ? ` (${errorSnippet})` : ""}`
        );
      }

      const payload = await response.json();
      if (!payload?.audioContent) {
        throw new Error("Cloud Gemini TTS nao devolveu audio.");
      }

      const partPath = path.join(tempDir, `part-${String(index).padStart(2, "0")}.mp3`);
      partPaths.push(partPath);
      await writeFile(partPath, Buffer.from(payload.audioContent, "base64"));
    }

    if (partPaths.length === 1) {
      await writeFile(mp3Path, await readFile(partPaths[0]));
    } else {
      const concatFile = path.join(tempDir, "concat.txt");
      const concatBody = partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
      await writeFile(concatFile, `${concatBody}\n`);
      run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-ar", "44100", "-ac", "2", "-b:a", "192k", mp3Path]);
      await rm(concatFile, {force: true});
    }
  } finally {
    await Promise.all(partPaths.map((p) => rm(p, {force: true}))).catch(() => {}); /* best-effort temp cleanup */
    await rm(tempDir, {recursive: true, force: true}).catch(() => {}); /* best-effort temp cleanup */
  }

  const maxSilence = Number.parseFloat(process.env.TTS_MAX_SILENCE_SECONDS || "0.4");
  if (maxSilence > 0) {
    compressAudioSilences(mp3Path, maxSilence);
  }

  const {timedWords, timedWordsSource} = await extractTimedWordsFromAudio({
    mp3Path,
    text,
    languageCode,
    sceneSpans,
    allowEstimated: ALLOW_ESTIMATED_TIMED_WORDS
  });

  return {
    provider: "cloud-gemini-tts",
    timedWords,
    timedWordsSource,
    modelVersion: model,
    voiceName
  };
};

export const synthesizeVoiceover = async ({
  text,
  sceneSpans = [],
  voice,
  rate,
  aiffPath,
  mp3Path,
  provider = "gcloud",
  elevenlabs,
  google,
  azure
}) => {
  const normalizedProvider = String(provider || "gcloud").trim().toLowerCase();

  if (normalizedProvider === "elevenlabs") {
    const apiKey = String(elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("ElevenLabs requer ELEVENLABS_API_KEY.");
    }

    const voiceId = String(elevenlabs?.voiceId || process.env.ELEVENLABS_VOICE_ID || "").trim();
    if (!voiceId) {
      throw new Error("ElevenLabs requer ELEVENLABS_VOICE_ID.");
    }

    const result = await synthesizeWithElevenLabs({
      text,
      mp3Path,
      apiKey,
      voiceId,
      modelId: String(elevenlabs?.modelId || process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2").trim(),
      languageCode: String(elevenlabs?.languageCode || process.env.ELEVENLABS_LANGUAGE_CODE || "pt").trim(),
      voiceSettings: elevenlabs?.voiceSettings || {
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.22),
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.9),
        style: Number(process.env.ELEVENLABS_STYLE || 0.3),
        use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST !== "false",
        speed: Number(process.env.ELEVENLABS_SPEED || 1.05)
      }
    });

    const maxSilence = Number.parseFloat(process.env.TTS_MAX_SILENCE_SECONDS || "0.4");
    if (maxSilence > 0) {
      compressAudioSilences(mp3Path, maxSilence);
    }

    let timedWords = result.timedWords || [];
    const audioDurationSeconds = getAudioDurationSeconds(mp3Path);

    if (timedWords.length === 0) {
      const extracted = await extractTimedWordsFromAudio({
        mp3Path,
        apiKey: process.env.GOOGLE_API_KEY || "",
        text,
        languageCode: google?.languageCode || process.env.VIDEO_LANGUAGE || "pt-BR",
        sceneSpans,
        allowEstimated: ALLOW_ESTIMATED_TIMED_WORDS
      });
      timedWords = extracted.timedWords;
      return {
        provider: "elevenlabs",
        timedWords,
        timedWordsSource: extracted.timedWordsSource,
        voiceName: voiceId
      };
    }

    const normalized = sanitizeTimedWordsForAudio({timedWords, audioDurationSeconds});
    return {
      provider: "elevenlabs",
      timedWords: normalized.timedWords,
      timedWordsSource: "elevenlabs-alignment",
      voiceName: voiceId
    };
  }

  if (!["gcloud", "google-cloud", "google", "auto", "google-gemini-tts", "gemini-tts", "gemini"].includes(normalizedProvider)) {
    throw new Error(`Provider de voz nao suportado para a pipeline GCP: ${normalizedProvider}`);
  }

  if (["google-gemini-tts", "gemini-tts", "gemini"].includes(normalizedProvider)) {
    try {
      return await synthesizeWithCloudTtsGemini({
        text,
        mp3Path,
        model: google?.model || process.env.GOOGLE_TTS_MODEL || "gemini-2.5-flash-tts",
        voiceName: google?.voiceName || process.env.GOOGLE_TTS_VOICE || "Iapetus",
        languageCode: google?.languageCode || process.env.VIDEO_LANGUAGE || "pt-BR",
        stylePrompt: google?.stylePrompt || process.env.GOOGLE_TTS_STYLE_PROMPT || "",
        sceneSpans
      });
    } catch (error) {
      if (!CLOUD_GEMINI_TTS_FALLBACK_ENABLED || !isRetryableCloudGeminiTtsError(error)) {
        throw error;
      }

      process.stderr.write(
        `Aviso: Cloud Gemini TTS falhou com erro transiente (${String(error?.message || error)}); alternando para Chirp3.\n`
      );

      return await synthesizeWithCloudTtsChirp3({
        text,
        mp3Path,
        voiceName: CLOUD_GEMINI_TTS_FALLBACK_VOICE,
        languageCode: google?.languageCode || process.env.VIDEO_LANGUAGE || "pt-BR",
        sceneSpans
      });
    }
  }

  return await synthesizeWithCloudTtsChirp3({
    text,
    mp3Path,
    voiceName: google?.voiceName || process.env.TTS_VOICE || "pt-BR-Chirp3-HD-Achernar",
    languageCode: google?.languageCode || process.env.VIDEO_LANGUAGE || "pt-BR",
    sceneSpans
  });
};

export const getAudioDurationSeconds = (audioPath) => {
  const output = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    audioPath
  ]);

  return Number.parseFloat(output);
};
