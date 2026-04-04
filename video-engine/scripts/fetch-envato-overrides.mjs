#!/usr/bin/env node
/**
 * fetch-envato-overrides.mjs
 *
 * When --source-dir is provided (FLUX2 mode), creates a manifest
 * from existing local scene-XX.mp4 files. No downloads needed.
 *
 * When no --source-dir, this is a no-op stub (Envato download not implemented).
 */

import {readFile, writeFile, mkdir} from "node:fs/promises";
import {readdirSync, existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const parseArgs = (argv) => {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--storyboard-file") { parsed.storyboardFile = argv[++i]; continue; }
    if (a === "--slug") { parsed.slug = argv[++i]; continue; }
    if (a === "--source-dir") { parsed.sourceDir = argv[++i]; continue; }
    if (a === "--no-browser") { parsed.noBrowser = true; continue; }
    if (a === "--max-scenes") { parsed.maxScenes = Number(argv[++i]); continue; }
  }
  return parsed;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const slug = args.slug;
  const assetDir = path.join(projectRoot, "assets", "envato", slug);
  const manifestPath = path.join(assetDir, "manifest.json");

  if (args.sourceDir && existsSync(args.sourceDir)) {
    // FLUX2 mode: scan local scene-XX.mp4 files and create manifest
    const files = readdirSync(args.sourceDir)
      .filter((f) => /^scene-\d+\.mp4$/i.test(f))
      .sort();

    const manifest = files.map((file) => {
      const match = file.match(/scene-(\d+)\.mp4/i);
      return {
        scene: match ? match[1] : "00",
        file,
        path: path.join(args.sourceDir, file),
        status: "copied-local",
        source: "flux2"
      };
    });

    await mkdir(assetDir, {recursive: true});
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    process.stdout.write(`[fetch-envato] FLUX2 mode: ${manifest.length} local scenes registered.\n`);
    return;
  }

  // No source dir: create empty manifest (no-op)
  await mkdir(assetDir, {recursive: true});
  if (!existsSync(manifestPath)) {
    await writeFile(manifestPath, JSON.stringify([], null, 2));
  }
  process.stdout.write("[fetch-envato] no source-dir provided, manifest empty.\n");
};

main().catch((err) => {
  process.stderr.write(`[fetch-envato] error: ${err.message}\n`);
  process.exit(1);
});
