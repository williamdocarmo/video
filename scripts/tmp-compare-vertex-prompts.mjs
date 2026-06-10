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
  model = "imagen-4.0-fast-generate-001",
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
      sampleImageSize: "2K",
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

  const payload = await response.json().catch(() => ({})); /* expected: response may not be JSON */
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

const outDir = path.join(projectRoot, "tmp", "vertex-prompt-compare");
await mkdir(outDir, {recursive: true});

const scene7Bad = `Create a high-end flat vector illustration, stick figure art, corporate memphis style, minimalist line art, solid flat colors, clean black outlines, white background, 2d vector art, simple geometric shapes, editorial illustration, no gradients, no shadows, no photorealism, high contrast, explanatory diagram style scene with one clear focal subject and clean anatomy. simple stick figure character with thin black lines, one large round head with minimal facial expression, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, no detailed features, clean outline drawing style, expressive body posture, no extra limbs, no duplicate hands, no duplicate arms Show A character holding a smartphone near a contactless payment terminal at a checkout, making a quick secure payment with a tap, in a modern store. with hands typing on a laptop keyboard. Add focused late-night computer workspace, close-up desk scene with glowing laptop through visible body language, clear props, and readable action. Set the scene in late-night desk workspace with laptop and abstract soft abstract glow panel glow. Frame it as vertical portrait composition, full stick figure and all required objects fully visible, comfortable margins, no cropped head or limbs, no extreme close-up, with vertical 9:16 medium-wide illustration. The visible action is character typing intensely on a laptop keyboard. Lighting should feel clean high-contrast lighting on a white background. Keep the subject fully readable in a vertical 9:16 layout with subtle safe margins for captions and UI. No text, no watermark, no logo, no interface chrome, no letter-like marks, no distorted anatomy, no extra fingers, no cropped head, and no cropped limbs.`;

const scene7Fixed = `Create a high-end flat vector illustration, stick figure art, corporate memphis style, minimalist line art, solid flat colors, clean black outlines, white background, 2d vector art, simple geometric shapes, editorial illustration, no gradients, no shadows, no photorealism, high contrast, explanatory diagram style scene with one clear focal subject and clean anatomy. simple stick figure character with thin black lines, one large round head with minimal facial expression, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, no detailed features, clean outline drawing style, expressive body posture, no extra limbs, no duplicate hands, no duplicate arms. Show a stick figure customer holding a smartphone near a contactless payment terminal at a checkout, making a quick secure payment with a tap, in a modern store. Must clearly show: smartphone, payment terminal, checkout counter, tap-to-pay action. Add a cashier counter and a subtle shopping bag as supporting props. Set the scene in a bright modern retail checkout. Frame it as a vertical portrait medium-wide composition with the full stick figure, phone, and terminal clearly visible. The visible action is tapping the phone against the payment terminal. Lighting should feel clean high-contrast lighting on a white background. No laptop, no desk workspace, no keyboard, no office scene, no text, no watermark, no logo, no interface chrome, no letter-like marks, no distorted anatomy, no extra fingers, no cropped head, and no cropped limbs.`;

const scene8Bad = `Create a high-end flat vector illustration, stick figure art, corporate memphis style, minimalist line art, solid flat colors, clean black outlines, white background, 2d vector art, simple geometric shapes, editorial illustration, no gradients, no shadows, no photorealism, high contrast, explanatory diagram style scene with one clear focal subject and clean anatomy. simple stick figure character with thin black lines, one large round head with minimal facial expression, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, no detailed features, clean outline drawing style, expressive body posture, no extra limbs, no duplicate hands, no duplicate arms Show A character holding a compact portable SSD or USB drive, then placing it into a small travel bag, implying easy transport of data. with A character holding a compact portable SSD or USB drive then placing it into a small travel bag implying easy transport of data. Add A character holding a compact portable SSD or USB drive, then placing it into a small travel bag, implying easy transport of data. through visible body language, clear props, and readable action. Set the scene in A character holding a compact portable SSD or USB drive, then placing it into a small travel bag, implying easy transport of data. Frame it as vertical portrait composition, full stick figure and all required objects fully visible, comfortable margins, no cropped head or limbs, no extreme close-up, with vertical 9:16 medium-wide illustration. The visible action is character interacting with the required objects. Lighting should feel clean high-contrast lighting on a white background. No text, no watermark, no logo, no interface chrome, no letter-like marks, no distorted anatomy, no extra fingers, no cropped head, and no cropped limbs.`;

const scene8Fixed = `Create a high-end flat vector illustration, stick figure art, corporate memphis style, minimalist line art, solid flat colors, clean black outlines, white background, 2d vector art, simple geometric shapes, editorial illustration, no gradients, no shadows, no photorealism, high contrast, explanatory diagram style scene with one clear focal subject and clean anatomy. simple stick figure character with thin black lines, one large round head with minimal facial expression, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, no detailed features, clean outline drawing style, expressive body posture, no extra limbs, no duplicate hands, no duplicate arms. Show a stick figure holding a small plain portable storage device and placing it into a travel bag to imply easy transport of files. Must clearly show: a small unbranded storage device, a hand, and a compact travel bag. The storage device must be blank with no letters, no numbers, no label, and no logo. Set the scene in a simple travel preparation context with minimal props. Frame it as a vertical portrait medium-wide composition with the device large enough to read clearly. The visible action is placing the device into the bag. Lighting should feel clean high-contrast lighting on a white background. No text, no watermark, no logo, no interface chrome, no letter-like marks, no engraved letters, no printed labels, no distorted anatomy, no extra fingers, no cropped head, and no cropped limbs.`;

const cases = [
  {name: "scene7-bad-flash", provider: "flash", prompt: scene7Bad},
  {name: "scene7-fixed-flash", provider: "flash", prompt: scene7Fixed},
  {name: "scene7-bad-imagen", provider: "imagen", prompt: scene7Bad},
  {name: "scene7-fixed-imagen", provider: "imagen", prompt: scene7Fixed},
  {name: "scene8-bad-flash", provider: "flash", prompt: scene8Bad},
  {name: "scene8-fixed-flash", provider: "flash", prompt: scene8Fixed},
  {name: "scene8-bad-imagen", provider: "imagen", prompt: scene8Bad},
  {name: "scene8-fixed-imagen", provider: "imagen", prompt: scene8Fixed}
];

const results = [];

for (const testCase of cases) {
  try {
    const outputPath = path.join(outDir, `${testCase.name}.png`);
    if (testCase.provider === "flash") {
      const result = await generateVertexImage({
        model: "gemini-2.5-flash-image",
        prompt: testCase.prompt,
        aspectRatio: "9:16",
        numberOfImages: 1
      });
      await writeFile(outputPath, result.bytes);
      results.push({name: testCase.name, provider: testCase.provider, ok: true, outputPath, bytes: result.bytes.length});
      await sleep(35_000);
    } else {
      const result = await generateImagenImage({
        model: "imagen-4.0-fast-generate-001",
        prompt: testCase.prompt,
        aspectRatio: "9:16"
      });
      await writeFile(outputPath, result.imageBytes);
      results.push({name: testCase.name, provider: testCase.provider, ok: true, outputPath, bytes: result.imageBytes.length});
      await sleep(2_000);
    }
  } catch (error) {
    results.push({name: testCase.name, provider: testCase.provider, ok: false, error: error instanceof Error ? error.message : String(error)});
  }
}

await writeFile(path.join(outDir, "results.json"), JSON.stringify(results, null, 2), "utf8");
console.log(JSON.stringify(results, null, 2));
