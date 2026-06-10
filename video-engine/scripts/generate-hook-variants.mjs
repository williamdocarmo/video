#!/usr/bin/env node
// Generate A/B hook variants (SPEC v2) for an existing run, and optionally
// render each variant as a full video that reuses the same body.
//
// Usage:
//   node video-engine/scripts/generate-hook-variants.mjs --slug SLUG [--count 3] [--language pt-BR]
//   node video-engine/scripts/generate-hook-variants.mjs --slug SLUG --render --channel foiumaideia
//
// Without --render it only writes runs/SLUG/hook-variants.json and prints them.
// With --render it submits one full generate job per variant (same body, swapped
// opening hook) to the local API so you can A/B the 3s retention curve.

import "dotenv/config";
import {readFile, writeFile} from "node:fs/promises";
import {existsSync, readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {generateHookVariants, buildVariantStoryboard, resolveLlmProvider} from "./lib/llm-provider.mjs";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const parseArgs = (argv) => {
  const args = {render: false};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--render") {
      args.render = true;
    } else if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
};

const resolveModel = (provider) => {
  if (provider === "openrouter") return process.env.STORY_MODEL || process.env.OPENROUTER_MODEL || "";
  if (provider === "vertex") return process.env.STORY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (provider === "gemini") return process.env.STORY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-pro";
  return process.env.STORY_MODEL || "";
};

const resolveBasicAuthPassword = () => {
  if (process.env.VIDEO_STUDIO_PASSWORD) return process.env.VIDEO_STUDIO_PASSWORD;
  const authPath = path.resolve(projectRoot, "..", ".web-ui", "runtime-auth.json");
  if (existsSync(authPath)) {
    try {
      return JSON.parse(readFileSync(authPath, "utf8")).basicAuthPassword || "";
    } catch {
      return "";
    }
  }
  return "";
};

const main = async () => {
  const args = parseArgs(process.argv);
  const slug = String(args.slug || "").trim();
  if (!slug) {
    console.error("Erro: informe --slug SLUG");
    process.exit(1);
  }

  try {
    loadSecretsIntoEnv(["GOOGLE_API_KEY", "OPENROUTER_API_KEY"]);
  } catch {
    // secrets are optional for the LLM-only hook step (vertex uses GCP auth)
  }

  const storyboardPath = path.join(projectRoot, "runs", slug, "storyboard.json");
  if (!existsSync(storyboardPath)) {
    console.error(`Erro: storyboard nao encontrado em ${storyboardPath}`);
    process.exit(1);
  }

  const storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
  const language = String(args.language || "pt-BR").trim();
  const count = Number(args.count || 3);
  const provider = resolveLlmProvider(process.env.LLM_PROVIDER || process.env.STORY_PROVIDER || "vertex");
  const model = resolveModel(provider);

  console.log(`\n🎬 Gerando variantes de hook para: ${slug}`);
  console.log(`   provider=${provider} model=${model} language=${language} count=${count}`);
  console.log(`   hook atual: "${storyboard.hook || storyboard?.scenes?.[0]?.narration || ""}"\n`);

  const variants = await generateHookVariants({
    storyboard,
    language,
    count,
    provider,
    apiKey: process.env.OPENROUTER_API_KEY || "",
    model,
    cwd: projectRoot
  });

  variants.forEach((variant, index) => {
    console.log(`  ${index + 1}. [${variant.angle}]`);
    console.log(`     narração : ${variant.narration}`);
    console.log(`     overlay  : ${variant.overlay}`);
    console.log(`     legenda  : ${variant.firstCaption}\n`);
  });

  const outPath = path.join(projectRoot, "runs", slug, "hook-variants.json");
  await writeFile(outPath, `${JSON.stringify({slug, language, generatedAt: new Date().toISOString(), variants}, null, 2)}\n`);
  console.log(`💾 Salvo em ${outPath}`);

  if (!args.render) {
    console.log("\nℹ️  Para renderizar os vídeos A/B (1 por variante, reusando o mesmo corpo):");
    console.log(`   node video-engine/scripts/generate-hook-variants.mjs --slug ${slug} --render --channel <canal>`);
    return;
  }

  const channel = String(args.channel || "").trim();
  if (!channel) {
    console.error("\nErro: --render exige --channel <foiumaideia|ate2min|quiet2min>");
    process.exit(1);
  }
  const port = process.env.WEB_PORT || "3210";
  const password = resolveBasicAuthPassword();
  const authHeader = "Basic " + Buffer.from(`x:${password}`).toString("base64");

  console.log(`\n🚀 Enfileirando ${variants.length} renders A/B no canal @${channel}...`);
  const jobs = [];
  for (let i = 0; i < variants.length; i += 1) {
    const variantStoryboard = buildVariantStoryboard(storyboard, variants[i]);
    const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
      method: "POST",
      headers: {"Content-Type": "application/json", Authorization: authHeader},
      body: JSON.stringify({
        title: `${storyboard.videoTitle || slug} — hook ${String.fromCharCode(65 + i)} (${variants[i].angle})`,
        channel,
        language,
        audioProvider: "elevenlabs",
        voice: "TX3LPaxmHKxFdv7VOQHJ",
        imageModel: "gemini-3.1-flash-image-preview",
        storyboard: variantStoryboard
      })
    });
    const data = await res.json().catch(() => ({}));
    const jobId = data?.job?.id || null;
    jobs.push({variant: variants[i].angle, jobId, slug: data?.job?.slug, error: data?.error});
    console.log(`   variante ${String.fromCharCode(65 + i)} [${variants[i].angle}] -> job=${jobId || "FALHOU"} ${data?.error ? "(" + data.error + ")" : ""}`);
  }
  console.log("\n✅ Renders A/B enfileirados. Compare a curva de retenção dos 3s entre eles.");
  console.log(JSON.stringify(jobs, null, 2));
};

main().catch((error) => {
  console.error(`\n❌ Falha: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
