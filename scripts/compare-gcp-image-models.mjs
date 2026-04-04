#!/usr/bin/env node

import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {generateVertexImage} from "../video-engine/scripts/lib/gcp-media.mjs";
import {getGcpAccessToken, resolveGcpConfig} from "../video-engine/scripts/lib/gcp-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

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

loadSimpleEnvFile(path.join(projectRoot, "video-engine", ".env"));
loadSimpleEnvFile(path.join(projectRoot, ".env"));

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const generateImagenImage = async ({
  prompt,
  model,
  aspectRatio = "9:16",
  outputMimeType = "image/png"
}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}` +
    `/locations/${config.location}/publishers/google/models/${model}:predict`;

  const body = {
    instances: [
      {
        prompt: normalizeText(prompt)
      }
    ],
    parameters: {
      sampleCount: 1,
      aspectRatio,
      sampleImageSize: "1K",
      personGeneration: "allow_all",
      safetySetting: "block_medium_and_above",
      enhancePrompt: false,
      addWatermark: false,
      outputOptions: {
        mimeType: outputMimeType
      }
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

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Imagen failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const prediction = Array.isArray(payload?.predictions) ? payload.predictions[0] : null;
  const bytesBase64Encoded = prediction?.bytesBase64Encoded;
  const mimeType = prediction?.mimeType || outputMimeType;

  if (!bytesBase64Encoded) {
    throw new Error("Imagen response did not include image bytes.");
  }

  return {
    mimeType,
    imageBytes: Buffer.from(bytesBase64Encoded, "base64"),
    payload
  };
};

const prompt = "A black and white line art illustration with subtle green accents. It shows a young man with curly hair lying in bed, looking exhausted. He is reaching out his hand to turn off an alarm clock on a nightstand. Next to the bed, there is a very cluttered study area with a desk overflowing with stacks of books, a laptop, and a lamp. The wall behind the desk is covered with two large calendars and dozens of sticky notes. The room feels cramped and busy, suggesting the character is an overworked student or professional.";

const outDir = path.join(projectRoot, "tmp", "compare-gcp-image-models");
await mkdir(outDir, {recursive: true});

const jobs = [
  {
    name: "gemini-2.5-flash-image",
    run: async () => {
      const result = await generateVertexImage({
        model: "gemini-2.5-flash-image",
        prompt,
        aspectRatio: "9:16",
        numberOfImages: 1
      });
      return {bytes: result.bytes, payload: result.payload};
    }
  },
  {
    name: "imagen-3.0-fast-generate-001",
    run: async () => {
      const result = await generateImagenImage({
        model: "imagen-3.0-fast-generate-001",
        prompt,
        aspectRatio: "9:16"
      });
      return {bytes: result.imageBytes, payload: result.payload};
    }
  },
  {
    name: "imagen-4.0-fast-generate-001",
    run: async () => {
      const result = await generateImagenImage({
        model: "imagen-4.0-fast-generate-001",
        prompt,
        aspectRatio: "9:16"
      });
      return {bytes: result.imageBytes, payload: result.payload};
    }
  }
];

const summary = [];

for (const job of jobs) {
  try {
    const {bytes} = await job.run();
    const outPath = path.join(outDir, `${job.name}.png`);
    await writeFile(outPath, bytes);
    summary.push({model: job.name, ok: true, outputPath: outPath, bytes: bytes.length});
    if (job.name.includes("gemini")) {
      await sleep(35_000);
    }
  } catch (error) {
    summary.push({model: job.name, ok: false, error: error instanceof Error ? error.message : String(error)});
  }
}

await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
console.log(JSON.stringify(summary, null, 2));
