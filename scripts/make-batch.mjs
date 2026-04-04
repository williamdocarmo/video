#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const wrapperRoot = path.resolve(path.dirname(scriptPath), "..");

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--file") {
      parsed.file = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--target-seconds") {
      parsed.targetSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--open-last") {
      parsed.openLast = true;
      continue;
    }

    if (item === "--worker-index") {
      parsed.workerIndex = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--workers") {
      parsed.workers = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--asset-mode") {
      parsed.assetMode = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--envato-max-scenes") {
      parsed.envatoMaxScenes = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--reuse-preview") {
      parsed.reusePreview = true;
      continue;
    }

    if (item === "--force") {
      parsed.force = true;
      continue;
    }
  }

  return parsed;
};

const persistReport = async (reportPath, report) => {
  await writeFile(reportPath, JSON.stringify(report, null, 2));
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.file) {
    throw new Error('Usa: npm run make:batch -- --file "batches/exemplo.txt"');
  }

  const filePath = path.resolve(wrapperRoot, args.file);

  if (!existsSync(filePath)) {
    throw new Error(`Nao encontrei o ficheiro ${filePath}`);
  }

  const titles = (await readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const workerCount = Number.isFinite(args.workers) && args.workers > 0 ? args.workers : 1;
  const workerIndex = Number.isFinite(args.workerIndex) && args.workerIndex >= 0 ? args.workerIndex : 0;

  if (titles.length === 0) {
    throw new Error(`Nao encontrei titulos em ${filePath}`);
  }

  if (workerIndex >= workerCount) {
    throw new Error(`worker-index ${workerIndex} tem de ser menor que workers ${workerCount}`);
  }

  const assignedTitles = titles.filter((_, index) => index % workerCount === workerIndex);

  const report = {
    file: filePath,
    startedAt: new Date().toISOString(),
    total: assignedTitles.length,
    sourceTotal: titles.length,
    workerIndex,
    workers: workerCount,
    results: []
  };

  await mkdir(path.join(wrapperRoot, "reports"), {recursive: true});
  const reportPath = path.join(
    wrapperRoot,
    "reports",
    `batch-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-w${workerIndex + 1}-pid${process.pid}.json`
  );
  await persistReport(reportPath, report);

  for (let index = 0; index < assignedTitles.length; index += 1) {
    const title = assignedTitles[index];
    process.stdout.write(`[batch] worker ${workerIndex + 1}/${workerCount} | ${index + 1}/${assignedTitles.length}: ${title}\n`);

    const commandArgs = [path.join(wrapperRoot, "scripts", "foiumaideia.mjs"), "--title", title];

    if (Number.isFinite(args.targetSeconds)) {
      commandArgs.push("--target-seconds", String(args.targetSeconds));
    }

    if (args.openLast && index === assignedTitles.length - 1) {
      commandArgs.push("--open");
    }

    if (args.assetMode) {
      commandArgs.push("--asset-mode", args.assetMode);
    }

    if (Number.isFinite(args.envatoMaxScenes) && args.envatoMaxScenes > 0) {
      commandArgs.push("--envato-max-scenes", String(args.envatoMaxScenes));
    }

    if (args.reusePreview) {
      commandArgs.push("--reuse-preview");
    }

    if (args.force) {
      commandArgs.push("--force");
    }

    const child = spawnSync("node", commandArgs, {
      cwd: wrapperRoot,
      encoding: "utf8",
      stdio: "pipe"
    });

    const stdout = child.stdout?.trim() ?? "";
    const stderr = child.stderr?.trim() ?? "";
    const outputLines = stdout.split(/\r?\n/).filter(Boolean);
    const outputPath = outputLines[outputLines.length - 1] ?? null;

    if (child.status === 0) {
      process.stdout.write(`${stdout}\n`);
      report.results.push({
        title,
        status: "completed",
        outputPath
      });
      await persistReport(reportPath, report);
      continue;
    }

    process.stderr.write(`${stdout}\n${stderr}\n`);
    report.results.push({
      title,
      status: "failed",
      outputPath,
      error: stderr || stdout || "falhou sem detalhe"
    });
    await persistReport(reportPath, report);
  }

  report.finishedAt = new Date().toISOString();
  report.failed = report.results.filter((item) => item.status === "failed").length;
  await persistReport(reportPath, report);
  process.stdout.write(`${reportPath}\n`);

  if (report.failed > 0) {
    process.exit(1);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
