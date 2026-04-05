#!/usr/bin/env node

import {mkdir, writeFile} from "node:fs/promises";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {generateVertexImage} from "../video-engine/scripts/lib/gcp-media.mjs";
import {resolveVisualStylePreset, VISUAL_STYLE_PRESETS} from "../config/visual-style-presets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "web", "public");
const galleryDir = path.join(publicDir, "style-gallery");
const outputDir = path.join(galleryDir, "images");

const loadSimpleEnvFile = (targetPath) => {
  if (!existsSync(targetPath)) {
    return;
  }

  const raw = readFileSync(targetPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
};

loadSimpleEnvFile(path.join(projectRoot, ".env"));
loadSimpleEnvFile(path.join(projectRoot, "video-engine", ".env"));

const model = String(process.env.GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image").trim();
const aspectRatio = "9:16";
const MAX_ATTEMPTS = 5;
const BASE_RETRY_MS = 12_000;
const cliArgs = new Set(process.argv.slice(2));
const forceRegenerate = cliArgs.has("--force");

const scenePrompt = String(
  process.env.STYLE_GALLERY_SCENE_PROMPT ||
    "Create a single strong frame for a short-form tech video. A person is about to clean a smartphone screen with toothpaste on a desk in a modern home office. The phone, the toothpaste smear, and the hand must be clearly visible. One main subject, no text, no logos, no watermark, mobile-first readability, high clarity, dramatic but believable proof visual."
).trim();

const composePrompt = (presetId) => {
  const preset = resolveVisualStylePreset(presetId);
  const backgroundRules = Array.isArray(preset.backgroundDirectives) ? preset.backgroundDirectives.join(" ") : "";
  return [
    scenePrompt,
    `Style preset: ${preset.label}.`,
    preset.plannerGuidance,
    preset.characterPrompt,
    preset.stylePrompt,
    preset.styleLockPrompt,
    preset.compositionRules,
    backgroundRules,
    `Lighting: ${preset.defaultLighting}.`,
    "Keep the same scene intent across styles so only the visual language changes."
  ]
    .filter(Boolean)
    .join(" ");
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

await mkdir(outputDir, {recursive: true});

const results = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const preset of Object.values(VISUAL_STYLE_PRESETS)) {
  const prompt = composePrompt(preset.id);
  const safeName = `${preset.id}.png`;
  const outputPath = path.join(outputDir, safeName);

  try {
    if (forceRegenerate || !existsSync(outputPath)) {
      process.stdout.write(`Generating ${preset.id}...\n`);
      let lastError = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
          const result = await generateVertexImage({
            model,
            prompt,
            aspectRatio,
            numberOfImages: 1
          });
          await writeFile(outputPath, result.bytes);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const message = String(error?.message || error);
          if (!message.includes("429") || attempt >= MAX_ATTEMPTS - 1) {
            throw error;
          }
          const waitMs = BASE_RETRY_MS * (attempt + 1);
          process.stderr.write(`Rate limit em ${preset.id}, retry em ${Math.round(waitMs / 1000)}s...\n`);
          await sleep(waitMs);
        }
      }
      if (lastError) {
        throw lastError;
      }
    }

    results.push({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      imagePath: `./images/${safeName}`,
      prompt
    });
  } catch (error) {
    results.push({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      imagePath: "",
      prompt,
      error: String(error?.message || error)
    });
  }
}

const cardsHtml = results.map((item) => {
  const imageHtml = item.imagePath
    ? `<a href="${escapeHtml(item.imagePath)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(item.imagePath)}" alt="${escapeHtml(item.label)}"></a>`
    : `<div class="error-box">${escapeHtml(item.error || "Falhou ao gerar.")}</div>`;

  return `
    <article class="card">
      <div class="card-copy">
        <p class="kicker">${escapeHtml(item.id)}</p>
        <h2>${escapeHtml(item.label)}</h2>
        <p>${escapeHtml(item.description || "")}</p>
        <a class="text-link" href="${item.imagePath ? escapeHtml(item.imagePath) : "#"}" target="_blank" rel="noreferrer">Abrir imagem</a>
      </div>
      ${imageHtml}
      <details>
        <summary>Prompt usado</summary>
        <pre>${escapeHtml(item.prompt)}</pre>
      </details>
    </article>
  `;
}).join("\n");

const html = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Galeria de estilos</title>
    <style>
      :root {
        --bg: #f4efe6;
        --card: #fffaf2;
        --ink: #14221e;
        --muted: #5e6d67;
        --line: rgba(20,34,30,.14);
        --accent: #0f7b6c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: radial-gradient(circle at top left, rgba(215,239,233,.9), transparent 38%), var(--bg);
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI Variable", sans-serif;
      }
      main { max-width: 1440px; margin: 0 auto; padding: 28px; }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 4vw, 3.4rem); line-height: .95; }
      .lede { margin: 0 0 26px; color: var(--muted); max-width: 820px; line-height: 1.6; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
      .card {
        background: rgba(255,252,246,.92);
        border: 1px solid var(--line);
        border-radius: 24px;
        padding: 16px;
        display: grid;
        gap: 14px;
        align-items: start;
        box-shadow: 0 18px 42px rgba(20,34,30,.08);
      }
      .card img {
        width: 100%;
        aspect-ratio: 9 / 16;
        object-fit: cover;
        border-radius: 18px;
        display: block;
        background: #e8e1d5;
      }
      .kicker {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: .8rem;
        font-weight: 800;
        letter-spacing: .14em;
        text-transform: uppercase;
      }
      h2 { margin: 0 0 8px; font-size: 1.08rem; }
      p { margin: 0; line-height: 1.5; }
      .text-link { color: var(--accent); text-decoration: none; font-weight: 700; }
      .error-box {
        border: 1px solid rgba(198,91,43,.2);
        background: rgba(198,91,43,.08);
        color: #8c3e1b;
        border-radius: 16px;
        padding: 14px;
      }
      details { border-top: 1px solid var(--line); padding-top: 10px; }
      summary { cursor: pointer; font-weight: 700; }
      pre {
        white-space: pre-wrap;
        font: .82rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Galeria de estilos reais</h1>
      <p class="lede">Cada imagem abaixo foi gerada com o próprio motor Vertex do app, usando a mesma cena-base e o prompt do preset correspondente. A ideia é comparar o comportamento real dos estilos, não mockups inventados.</p>
      <p class="lede"><strong>Cena-base:</strong> ${escapeHtml(scenePrompt)}</p>
      <section class="grid">
        ${cardsHtml}
      </section>
    </main>
  </body>
</html>`;

await writeFile(path.join(galleryDir, "index.html"), html);

const manifest = {
  model,
  aspectRatio,
  scenePrompt,
  generatedAt: new Date().toISOString(),
  items: results
};

await writeFile(path.join(galleryDir, "manifest.json"), JSON.stringify(manifest, null, 2));

process.stdout.write(`Gallery ready: ${path.join(galleryDir, "index.html")}\n`);
