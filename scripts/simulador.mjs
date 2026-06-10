#!/usr/bin/env node
/**
 * Simulador — Gerador de vídeos de questões para certificações de TI.
 *
 * Recebe texto Q&A, divide em batches de ~50 perguntas, gera áudio Azure TTS
 * por pergunta, renderiza cards com ffmpeg e concatena em vídeo final.
 */

import {execFileSync} from "node:child_process";
import {existsSync, writeFileSync} from "node:fs";
import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const require = createRequire(path.join(PROJECT_ROOT, "video-engine", "package.json"));
const speechSdk = require("microsoft-cognitiveservices-speech-sdk");
const DATA_DIR = path.join(PROJECT_ROOT, ".simulador");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/* ── Load env from video-engine/.env ───────────────────────────────────── */
const envPath = path.join(PROJECT_ROOT, "video-engine", ".env");
if (existsSync(envPath)) {
  for (const line of String(await readFile(envPath, "utf8")).split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const AZURE_KEY = process.env.AZURE_SPEECH_KEY || "";
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || "eastus";
const AZURE_VOICE = process.env.AZURE_TTS_VOICE || "pt-BR-AntonioNeural";

/* ── Helpers ───────────────────────────────────────────────────────────── */
const ffmpeg = (args) => execFileSync("ffmpeg", args, {stdio: "pipe"});
const slugify = (t) =>
  t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ── Parse Q&A ─────────────────────────────────────────────────────────── */
export function parseQA(raw) {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const numbered = text.split(/\n(?=\d+[\.\)]\s)/);
  if (numbered.length > 1 && /^\d+[\.\)]\s/.test(numbered[0])) {
    return numbered.map(parseBlock).filter(Boolean);
  }

  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  return blocks.map(parseBlock).filter(Boolean);
}

function parseBlock(block) {
  const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  let question = "";
  const options = [];
  let answer = "";
  let explanation = "";

  for (const line of lines) {
    if (/^(?:Resposta|Answer|Correct|Gabarito)\s*[:=]\s*/i.test(line)) {
      answer = line.replace(/^[^:=]+[:=]\s*/, "").trim();
    } else if (/^(?:Explicação|Explicacao|Explanation|Justificativa)\s*[:=]\s*/i.test(line)) {
      explanation = line.replace(/^[^:=]+[:=]\s*/, "").trim();
    } else if (/^[a-eA-E][\.\)]\s/.test(line)) {
      const m = line.match(/^([a-eA-E])[\.\)]\s*(.+)/);
      if (m) options.push({letter: m[1].toUpperCase(), text: m[2].trim()});
    } else if (!question) {
      question = line.replace(/^\d+[\.\)]\s*/, "").replace(/^(?:Pergunta|Question)\s*[:=]\s*/i, "");
    } else if (!answer && !explanation && options.length === 0) {
      question += " " + line;
    }
  }

  return question ? {question, options, answer, explanation} : null;
}

/* ── Split batches (~50 per video) ─────────────────────────────────────── */
export function splitIntoBatches(items, target = 50) {
  const n = items.length;
  if (n <= target + 10) return [items];
  const batches = Math.ceil(n / target);
  const base = Math.floor(n / batches);
  const extra = n % batches;
  const result = [];
  let off = 0;
  for (let i = 0; i < batches; i++) {
    const sz = base + (i < extra ? 1 : 0);
    result.push(items.slice(off, off + sz));
    off += sz;
  }
  return result;
}

/* ── Azure TTS ─────────────────────────────────────────────────────────── */
async function synthesizeTTS(text, outputPath) {
  if (!AZURE_KEY) throw new Error("AZURE_SPEECH_KEY não configurada.");
  const cfg = speechSdk.SpeechConfig.fromSubscription(AZURE_KEY, AZURE_REGION);
  cfg.speechSynthesisVoiceName = AZURE_VOICE;
  cfg.speechSynthesisOutputFormat = speechSdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;
  const audio = speechSdk.AudioConfig.fromAudioFileOutput(outputPath);
  const synth = new speechSdk.SpeechSynthesizer(cfg, audio);

  await new Promise((resolve, reject) => {
    synth.speakTextAsync(text,
      (r) => { synth.close(); r?.reason === speechSdk.ResultReason.SynthesizingAudioCompleted ? resolve() : reject(new Error(r?.errorDetails || "Azure TTS falhou.")); },
      (e) => { synth.close(); reject(new Error(String(e))); }
    );
  });
}

/* ── Audio duration ────────────────────────────────────────────────────── */
function audioDuration(fp) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", fp], {stdio: "pipe"});
  return parseFloat(String(out).trim()) || 5;
}

/* ── Wrap text ─────────────────────────────────────────────────────────── */
function wrap(text, max) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (cur.length + w.length + 1 > max && cur) { lines.push(cur); cur = w; }
    else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/* ── Render question card video ────────────────────────────────────────── */
function renderCard({index, total, question, options, answer, explanation, audioPath, outputPath}) {
  const dur = audioDuration(audioPath);
  const W = 1080, H = 1920;
  const esc = (s) => String(s).replace(/[\\':\\[\\]]/g, (c) => "\\" + c);

  const dt = [];
  // Header
  dt.push(`drawbox=x=0:y=0:w=${W}:h=120:c=#16213e:t=fill`);
  dt.push(`drawtext=fontfile=${FONT}:text='Questao ${index} de ${total}':fontcolor=#e94560:fontsize=42:x=(w-text_w)/2:y=40`);

  // Question
  let y = 180;
  for (const line of wrap(question, 38)) {
    dt.push(`drawtext=fontfile=${FONT}:text='${esc(line)}':fontcolor=white:fontsize=36:x=60:y=${y}`);
    y += 52;
  }

  // Options
  y += 20;
  for (const opt of options) {
    const correct = opt.letter === (answer || "").toUpperCase().charAt(0);
    const color = correct ? "#00ff88" : "#cccccc";
    const mark = correct ? ">" : " ";
    for (const line of wrap(`${mark} ${opt.letter}) ${opt.text}`, 36)) {
      dt.push(`drawtext=fontfile=${FONT_REG}:text='${esc(line)}':fontcolor=${color}:fontsize=32:x=80:y=${y}`);
      y += 44;
    }
    y += 8;
  }

  // Divider + answer
  y += 20;
  dt.push(`drawbox=x=40:y=${y}:w=${W - 80}:h=4:c=#e94560:t=fill`);
  y += 24;
  dt.push(`drawtext=fontfile=${FONT}:text='Resposta\\: ${esc(answer)}':fontcolor=#e94560:fontsize=34:x=60:y=${y}`);
  y += 50;

  // Explanation
  if (explanation) {
    for (const line of wrap(explanation, 40)) {
      if (y > H - 100) break;
      dt.push(`drawtext=fontfile=${FONT_REG}:text='${esc(line)}':fontcolor=#aaaaaa:fontsize=28:x=60:y=${y}`);
      y += 40;
    }
  }

  const vf = dt.join(",");

  ffmpeg([
    "-y", "-f", "lavfi", "-i", `color=c=#1a1a2e:s=${W}x${H}:d=${dur}`,
    "-i", audioPath,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-pix_fmt", "yuv420p", "-shortest",
    outputPath
  ]);
}

/* ── Concat cards ──────────────────────────────────────────────────────── */
function concatCards(cardPaths, outputPath, tempDir) {
  const listFile = path.join(tempDir, "concat.txt");
  writeFileSync(listFile, cardPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  ffmpeg([
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-c", "copy", "-movflags", "+faststart",
    outputPath
  ]);
}

/* ── Build narration text ──────────────────────────────────────────────── */
function buildNarration(q, num, total) {
  let t = `Questão ${num} de ${total}. ${q.question}`;
  for (const o of q.options) t += ` Alternativa ${o.letter}: ${o.text}.`;
  if (q.answer) t += ` A resposta correta é: ${q.answer}.`;
  if (q.explanation) t += ` ${q.explanation}`;
  return t;
}

/* ── Jobs persistence ──────────────────────────────────────────────────── */
export async function loadJobs() {
  try { return JSON.parse(await readFile(JOBS_FILE, "utf8")); }
  catch { return []; }
}

export async function saveJobs(jobs) {
  await mkdir(DATA_DIR, {recursive: true});
  await writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

/* ── Main pipeline ─────────────────────────────────────────────────────── */
export async function runSimulador({text, title = "Simulado"}) {
  const questions = parseQA(text);
  if (!questions.length) throw new Error("Nenhuma questão encontrada no texto.");

  const batches = splitIntoBatches(questions);
  const jobs = await loadJobs();
  const results = [];

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const label = batches.length > 1 ? ` (Parte ${bi + 1}/${batches.length})` : "";
    const jobId = uid();
    const jobDir = path.join(DATA_DIR, "runs", jobId);
    const audioDir = path.join(jobDir, "audio");
    const cardsDir = path.join(jobDir, "cards");
    await mkdir(audioDir, {recursive: true});
    await mkdir(cardsDir, {recursive: true});

    const job = {
      id: jobId, title: `${title}${label}`, slug: slugify(`${title}${label}`) || jobId,
      status: "processing", questionCount: batch.length,
      batchIndex: bi, totalBatches: batches.length,
      createdAt: new Date().toISOString(), videoPath: "", error: ""
    };
    jobs.push(job);
    await saveJobs(jobs);

    try {
      const cardPaths = [];
      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const num = i + 1;
        const ap = path.join(audioDir, `q${String(num).padStart(3, "0")}.mp3`);
        const cp = path.join(cardsDir, `card${String(num).padStart(3, "0")}.mp4`);

        process.stdout.write(`[${jobId}] TTS ${num}/${batch.length}...\n`);
        await synthesizeTTS(buildNarration(q, num, batch.length), ap);

        process.stdout.write(`[${jobId}] Card ${num}/${batch.length}...\n`);
        renderCard({index: num, total: batch.length, ...q, audioPath: ap, outputPath: cp});
        cardPaths.push(cp);
      }

      const videoDir = path.join(DATA_DIR, "videos");
      await mkdir(videoDir, {recursive: true});
      const outputPath = path.join(videoDir, `${jobId}.mp4`);

      process.stdout.write(`[${jobId}] Concat ${cardPaths.length} cards...\n`);
      concatCards(cardPaths, outputPath, jobDir);

      job.status = "done";
      job.videoPath = outputPath;
      job.completedAt = new Date().toISOString();

      await rm(cardsDir, {recursive: true, force: true});
      await rm(audioDir, {recursive: true, force: true});
    } catch (err) {
      job.status = "error";
      job.error = err.message;
      process.stderr.write(`[${jobId}] ERRO: ${err.message}\n`);
    }

    await saveJobs(jobs);
    results.push(job);
  }

  return results;
}

/* ── CLI ───────────────────────────────────────────────────────────────── */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const f = process.argv[2];
  if (!f) { console.error("Uso: node simulador.mjs <arquivo.txt> [titulo]"); process.exit(1); }
  const text = await readFile(f, "utf8");
  const title = process.argv[3] || path.basename(f, path.extname(f));
  const results = await runSimulador({text, title});
  console.log(JSON.stringify(results, null, 2));
}
