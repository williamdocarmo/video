import "dotenv/config";
import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {getAudioDurationSeconds, synthesizeVoiceover} from "./lib/tts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const videoEngineRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(videoEngineRoot, "..");
const galleryRoot = path.join(repoRoot, "web", "public", "style-gallery");
const outputDir = path.join(galleryRoot, "audio", "voice-samples");
const reportPath = path.join(galleryRoot, "voice-samples-report.json");

const DEFAULT_TEXT =
  "No pitch da Netflix, tinha benchmark, bandwidth, binge-watching, late fee e checkout na mesma frase. Se a voz passa limpa por isso em portugues do Brasil, ela aguenta o ritmo rapido e ironico do canal Foi Uma Ideia. E o mais curioso: a Blockbuster ouviu tudo isso e mesmo assim riu.";

const GEMINI_STYLE_PROMPT = "com ritmo curto, visual e nativo de redes sociais";

const ELEVENLABS_SETTINGS = {
  stability: 0.26,
  similarity_boost: 0.84,
  style: 0.38,
  use_speaker_boost: true,
  speed: 1.03
};

const SAMPLE_LIBRARY = [
  {
    id: "gemini-kore",
    provider: "gemini",
    label: "Kore",
    providerLabel: "Gemini TTS",
    badge: "Hook firme",
    note: "Mais assertiva para hook, contraste e payoff.",
    voiceName: "Kore"
  },
  {
    id: "gemini-iapetus",
    provider: "gemini",
    label: "Iapetus",
    providerLabel: "Gemini TTS",
    badge: "Clareza geral",
    note: "A mais equilibrada para narrativa padrao do canal.",
    voiceName: "Iapetus"
  },
  {
    id: "gemini-puck",
    provider: "gemini",
    label: "Puck",
    providerLabel: "Gemini TTS",
    badge: "Mais energia",
    note: "Boa para shorts mais rapidos e provocativos.",
    voiceName: "Puck"
  },
  {
    id: "gemini-sulafat",
    provider: "gemini",
    label: "Sulafat",
    providerLabel: "Gemini TTS",
    badge: "Quente humana",
    note: "Mais calorosa sem perder a leitura do texto.",
    voiceName: "Sulafat"
  },
  {
    id: "gemini-charon",
    provider: "gemini",
    label: "Charon",
    providerLabel: "Gemini TTS",
    badge: "Mais informativa",
    note: "Tende a segurar melhor palavras em ingles e tom explicativo.",
    voiceName: "Charon"
  },
  {
    id: "eleven-ana-alice-br",
    provider: "elevenlabs",
    label: "Ana Alice BR",
    providerLabel: "ElevenLabs",
    badge: "Pt-BR nativo",
    note: "Melhor referencia de diccao brasileira no ElevenLabs da conta.",
    voiceId: "ORgG8rwdAiMYRug8RJwR"
  },
  {
    id: "eleven-george",
    provider: "elevenlabs",
    label: "George",
    providerLabel: "ElevenLabs",
    badge: "Storyteller",
    note: "Boa textura para historias ironicas com mais narrativa.",
    voiceId: "JBFqnCBsd6RMkjVDRZzb"
  },
  {
    id: "eleven-eric",
    provider: "elevenlabs",
    label: "Eric",
    providerLabel: "ElevenLabs",
    badge: "Limpo confiavel",
    note: "Entrega equilibrada e menos teatral para explicacoes.",
    voiceId: "cjVigY5qzO86Huf0OWal"
  },
  {
    id: "eleven-liam",
    provider: "elevenlabs",
    label: "Liam",
    providerLabel: "ElevenLabs",
    badge: "Creator",
    note: "Mais social, creator e curto para video nativo de rede.",
    voiceId: "TX3LPaxmHKxFdv7VOQHJ"
  },
  {
    id: "eleven-adam",
    provider: "elevenlabs",
    label: "Adam",
    providerLabel: "ElevenLabs",
    badge: "Dominante",
    note: "Mais seco e contundente para hooks agressivos.",
    voiceId: "pNInz6obpgDQGcFmaJgB"
  }
];

const parseArgs = (argv) => {
  const parsed = {
    text: DEFAULT_TEXT
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--text") {
      parsed.text = String(argv[index + 1] || "").trim() || DEFAULT_TEXT;
      index += 1;
    }
  }

  return parsed;
};

const toPublicAudioPath = (id) => `./audio/voice-samples/${id}.mp3`;

const buildSynthesisOptions = ({sample, text, mp3Path, aiffPath}) => {
  if (sample.provider === "elevenlabs") {
    return {
      text,
      provider: "elevenlabs",
      mp3Path,
      aiffPath,
      elevenlabs: {
        apiKey: process.env.ELEVENLABS_API_KEY || "",
        voiceId: sample.voiceId,
        modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        languageCode: process.env.ELEVENLABS_LANGUAGE_CODE || "pt",
        voiceSettings: ELEVENLABS_SETTINGS
      }
    };
  }

  return {
    text,
    provider: "gemini",
    mp3Path,
    aiffPath,
    google: {
      model: process.env.GOOGLE_TTS_MODEL || "gemini-2.5-flash-preview-tts",
      voiceName: sample.voiceName,
      languageCode: "pt-BR",
      stylePrompt: GEMINI_STYLE_PROMPT
    }
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(outputDir, {recursive: true});

  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    text: args.text,
    samples: []
  };
  const failures = [];

  for (const sample of SAMPLE_LIBRARY) {
    const mp3Path = path.join(outputDir, `${sample.id}.mp3`);
    const aiffPath = path.join(outputDir, `${sample.id}.aiff`);

    process.stdout.write(`[voice-samples] ${sample.providerLabel} :: ${sample.label}\n`);

    try {
      const result = await synthesizeVoiceover(
        buildSynthesisOptions({
          sample,
          text: args.text,
          mp3Path,
          aiffPath
        })
      );

      report.samples.push({
        ...sample,
        text: args.text,
        audioPath: toPublicAudioPath(sample.id),
        durationSeconds: Number(getAudioDurationSeconds(mp3Path).toFixed(2)),
        providerUsed: result.provider,
        voiceNameUsed: result.voiceName || sample.voiceName || sample.voiceId || "",
        timedWordsSource: result.timedWordsSource || ""
      });
    } catch (error) {
      failures.push({
        ...sample,
        error: error instanceof Error ? error.message : String(error)
      });
      report.samples.push({
        ...sample,
        text: args.text,
        audioPath: toPublicAudioPath(sample.id),
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      await rm(aiffPath, {force: true}).catch(() => {});
    }
  }

  await writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${reportPath}\n`);

  if (failures.length > 0) {
    const message = failures.map((item) => `${item.label}: ${item.error}`).join(" | ");
    throw new Error(message);
  }
};

main().catch((error) => {
  process.stderr.write(`Erro: ${error.message}\n`);
  process.exit(1);
});
