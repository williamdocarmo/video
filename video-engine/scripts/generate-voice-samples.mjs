import "dotenv/config";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {getAudioDurationSeconds, synthesizeVoiceover} from "./lib/tts.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

const presets = [
  {
    id: "george",
    label: "George",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    settings: {
      stability: 0.24,
      similarity_boost: 0.84,
      style: 0.58,
      use_speaker_boost: true,
      speed: 0.98
    }
  },
  {
    id: "eric",
    label: "Eric",
    voiceId: "cjVigY5qzO86Huf0OWal",
    settings: {
      stability: 0.2,
      similarity_boost: 0.9,
      style: 0.42,
      use_speaker_boost: true,
      speed: 1
    }
  },
  {
    id: "bella",
    label: "Bella",
    voiceId: "hpp4J3VqNfWAUOO0d1Us",
    settings: {
      stability: 0.18,
      similarity_boost: 0.88,
      style: 0.8,
      use_speaker_boost: true,
      speed: 1
    }
  }
];

const parseArgs = (argv) => {
  const parsed = {
    text:
      "Em 2026, a tecnologia deixou de ser so novidade. Agora ela entra no trabalho, no bolso e nas pequenas decisoes do dia a dia."
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--text") {
      parsed.text = argv[index + 1];
      index += 1;
    }
  }

  return parsed;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.join(projectRoot, "out", "voice-samples");

  await mkdir(outDir, {recursive: true});

  const report = [];

  for (const preset of presets) {
    const samplePath = path.join(outDir, `${preset.id}.mp3`);
    const aiffPath = path.join(outDir, `${preset.id}.aiff`);
    const result = await synthesizeVoiceover({
      text: args.text,
      voice: process.env.MACOS_VOICE || "Luciana",
      rate: process.env.TTS_RATE || 175,
      aiffPath,
      mp3Path: samplePath,
      elevenlabs: {
        apiKey: process.env.ELEVENLABS_API_KEY || "",
        voiceId: preset.voiceId,
        modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        languageCode: process.env.ELEVENLABS_LANGUAGE_CODE || "pt",
        voiceSettings: preset.settings
      }
    });

    report.push({
      id: preset.id,
      label: preset.label,
      voiceId: preset.voiceId,
      path: samplePath,
      durationSeconds: getAudioDurationSeconds(samplePath),
      provider: result.provider,
      timedWords: result.timedWords.length
    });
  }

  const reportPath = path.join(outDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${reportPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`Erro: ${error.message}\n`);
  process.exit(1);
});
