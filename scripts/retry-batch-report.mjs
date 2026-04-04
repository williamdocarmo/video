#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {readFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const wrapperRoot = path.resolve(path.dirname(scriptPath), "..");

const parseArgs = (argv) => {
  const parsed = {
    skipSlugs: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--report") {
      parsed.report = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--only-failed") {
      parsed.onlyFailed = true;
      continue;
    }

    if (item === "--skip-slug") {
      parsed.skipSlugs.push(argv[index + 1]);
      index += 1;
      continue;
    }
  }

  return parsed;
};

const inferSlug = (result) => {
  const outputPath = String(result.outputPath || "");

  if (!outputPath) {
    throw new Error(`Nao consegui inferir o slug para "${result.title}"`);
  }

  if (outputPath.endsWith(".mp4")) {
    return path.basename(outputPath, ".mp4");
  }

  if (outputPath.endsWith("/manifest.json")) {
    return path.basename(path.dirname(outputPath));
  }

  throw new Error(`Formato de outputPath nao suportado: ${outputPath}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.report) {
    throw new Error('Usa: node scripts/retry-batch-report.mjs --report reports/batch-xxxx.json [--only-failed]');
  }

  const reportPath = path.resolve(wrapperRoot, args.report);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const results = args.onlyFailed ? report.results.filter((item) => item.status === "failed") : report.results;

  if (results.length === 0) {
    process.stdout.write("Nada para relancar.\n");
    return;
  }

  const failures = [];

  for (let index = 0; index < results.length; index += 1) {
    const item = results[index];
    const slug = inferSlug(item);
    const exportPath = path.join(wrapperRoot, `${slug}.mp4`);

    if (args.skipSlugs.includes(slug)) {
      process.stdout.write(`[retry] ${index + 1}/${results.length}: ${item.title} (slug excluido, a saltar)\n`);
      continue;
    }

    if (existsSync(exportPath)) {
      process.stdout.write(`[retry] ${index + 1}/${results.length}: ${item.title} (ja recuperado, a saltar)\n`);
      continue;
    }

    process.stdout.write(`[retry] ${index + 1}/${results.length}: ${item.title}\n`);

    const child = spawnSync(
      "node",
      [path.join(wrapperRoot, "scripts", "foiumaideia.mjs"), "--title", item.title, "--slug", slug],
      {
        cwd: wrapperRoot,
        encoding: "utf8",
        stdio: "pipe"
      }
    );

    const stdout = child.stdout?.trim() ?? "";
    const stderr = child.stderr?.trim() ?? "";

    if (child.status !== 0) {
      process.stderr.write(`${stdout}\n${stderr}\n`);
      failures.push({
        title: item.title,
        slug,
        error: stderr || stdout || "falhou sem detalhe"
      });
      continue;
    }

    process.stdout.write(`${stdout}\n`);
  }

  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify({failed: failures}, null, 2)}\n`);
    process.exit(1);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
