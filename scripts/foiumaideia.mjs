#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {copyFile, mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DEFAULT_OUTPUT_PROFILE, resolveOutputProfileConfig} from "../config/output-profiles.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const wrapperRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultConfigPath = path.join(wrapperRoot, ".env");

const parseEnvFile = async (envPath) => {
  if (!existsSync(envPath)) {
    return {};
  }

  const content = await readFile(envPath, "utf8");
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key) {
      result[key] = value;
    }
  }

  return result;
};

const resolvePathFrom = (baseDir, value, fallback = "") => {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return "";
  }
  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

const parseArgs = (argv) => {
  const parsed = {
    open: false,
    noOpen: false,
    dryRun: false,
    force: false,
    reusePreview: false,
    previewOnly: false,
    continueRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (!item.startsWith("--") && !parsed.title) {
      parsed.title = item;
      continue;
    }

    if (item === "--title") {
      parsed.title = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--slug") {
      parsed.slug = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--storyboard-file") {
      parsed.storyboardFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--target-seconds") {
      parsed.targetSeconds = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--output-profile") {
      parsed.outputProfile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--project-root") {
      parsed.projectRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--export-dir") {
      parsed.exportDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--open") {
      parsed.open = true;
      continue;
    }

    if (item === "--no-open") {
      parsed.noOpen = true;
      continue;
    }

    if (item === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (item === "--force") {
      parsed.force = true;
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

    if (item === "--preview-only") {
      parsed.previewOnly = true;
      continue;
    }

    if (item === "--continue-run") {
      parsed.continueRun = true;
      continue;
    }

    if (item === "--source-text-file") {
      parsed.sourceTextFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--language") {
      parsed.language = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--voice") {
      parsed.voice = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--image-style") {
      parsed.imageStyle = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--style-prompt") {
      parsed.stylePrompt = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--script-guidance") {
      parsed.scriptGuidance = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--channel-handle") {
      parsed.channelHandle = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--music-file") {
      parsed.musicFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--no-music") {
      parsed.noMusic = true;
      continue;
    }

    if (item === "--help") {
      parsed.help = true;
      continue;
    }
  }

  return parsed;
};

const removeArgPair = (args, flag) => {
  const index = args.indexOf(flag);

  if (index >= 0) {
    args.splice(index, 2);
  }
};

const usesVertexImagePipeline = () => true;

const getSceneRangeForProfile = (profile, targetSeconds) => {
  const numericTargetSeconds = Number(targetSeconds);
  let minScenes = profile.minScenes;
  let maxScenes = profile.maxScenes;

  if (profile.id === "vertical-short") {
    if (numericTargetSeconds <= 60) {
      minScenes = 10;
      maxScenes = 12;
    } else if (numericTargetSeconds <= 90) {
      minScenes = 12;
      maxScenes = 14;
    } else {
      minScenes = 14;
      maxScenes = 16;
    }
  }

  return {minScenes, maxScenes};
};

const slugify = (input) => {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
};

const deriveTitleFromText = (input) => {
  const text = String(input || "").trim();

  if (!text) {
    return "";
  }

  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || text;

  return line
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
};

const findExistingExportForTitle = async ({exportDir, title}) => {
  const titleSlug = slugify(title);
  const suffix = `-${titleSlug}.mp4`;
  const entries = await readdir(exportDir).catch(() => []);
  const matches = entries.filter((entry) => entry.endsWith(suffix)).sort();
  const latest = matches.at(-1);
  return latest ? path.join(exportDir, latest) : null;
};

const getDatePrefixFromSlug = (slug) => {
  const match = String(slug || "").match(/^(\d{4}-\d{2}-\d{2})-/);
  return match?.[1] || new Date().toISOString().slice(0, 10);
};

const resolveLocalizedExportOutput = async ({projectRoot, exportDir, slug, fallbackTitle}) => {
  const storyboardPath = path.join(projectRoot, "runs", slug, "storyboard.json");
  let localizedTitle = String(fallbackTitle || "").trim();

  try {
    const storyboard = JSON.parse(await readFile(storyboardPath, "utf8"));
    localizedTitle = String(storyboard?.videoTitle || localizedTitle).trim();
  } catch {
    // Keep fallback title when storyboard is not available.
  }

  const localizedSlug = slugify(localizedTitle);
  const basename = localizedSlug ? `${getDatePrefixFromSlug(slug)}-${localizedSlug}` : slug;
  return path.join(exportDir, `${basename}.mp4`);
};

const printHelp = () => {
  process.stdout.write(
    [
      "Uso:",
      '  ./foiumaideia --title "O teu titulo aqui"',
      "",
      "Opcoes:",
      "  --title <texto>",
      "  --slug <slug-manual>",
      "  --storyboard-file <path>",
      "  --target-seconds <numero>",
      "  --output-profile <vertical-short|horizontal-5m|horizontal-10m>",
      "  --project-root <path>",
      "  --export-dir <path>",
      "  --open",
      "  --no-open",
      "  --dry-run",
      "  --force",
      "  --envato-max-scenes <numero>",
      "  --reuse-preview",
      "  --preview-only",
      "  --continue-run",
      "  --source-text-file <path>",
      "  --language <pt-BR|en-US>",
      "  --voice <nome>",
      "  --image-style <claude|kiro|editorial_clean|realistic_film|cartoon_3d|urban_sketching|ink|editorial_line_green|time_split_bold|punk>",
      "  --style-prompt <texto>",
      "  --script-guidance <texto>",
      "  --channel-handle <@canal>",
      "  --music-file <path>",
      "  --no-music"
    ].join("\n") + "\n"
  );
};

const cleanupIntermediates = async ({projectRoot, slug, sourceOutput}) => {
  if (String(process.env.KEEP_INTERMEDIATES || "").trim().toLowerCase() === "true") {
    return;
  }

  const cleanupTargets = [
    sourceOutput,
    path.join(projectRoot, "runs", slug),
    path.join(projectRoot, "public", "runs", slug),
    path.join(projectRoot, "assets", "envato", slug)
  ];

  for (const targetPath of cleanupTargets) {
    await rm(targetPath, {recursive: true, force: true});
  }
};

const run = async () => {
  const fileConfig = await parseEnvFile(defaultConfigPath);
  const args = parseArgs(process.argv.slice(2));

  // Inject .env values into process.env (file < env < CLI)
  for (const [key, value] of Object.entries(fileConfig)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }

  if (args.help) {
    printHelp();
    return;
  }

  const sourceTextFile = args.sourceTextFile
    ? resolvePathFrom(wrapperRoot, args.sourceTextFile)
    : "";
  const storyboardFileArg = args.storyboardFile
    ? resolvePathFrom(wrapperRoot, args.storyboardFile)
    : "";
  const sourceText = sourceTextFile ? await readFile(sourceTextFile, "utf8") : "";
  const title = String(args.title || deriveTitleFromText(sourceText) || "").trim();

  if (!title) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const bundledProjectRoot = path.join(wrapperRoot, "video-engine");
  const projectRoot = resolvePathFrom(
    wrapperRoot,
    args.projectRoot || process.env.VIDEOS_ENVATO_ROOT || fileConfig.VIDEOS_ENVATO_ROOT,
    bundledProjectRoot
  );
  const outputProfile = resolveOutputProfileConfig(
    args.outputProfile || process.env.OUTPUT_PROFILE || fileConfig.OUTPUT_PROFILE || DEFAULT_OUTPUT_PROFILE
  );
  const exportDir = resolvePathFrom(
    wrapperRoot,
    args.exportDir || process.env.EXPORT_DIR || fileConfig.EXPORT_DIR,
    wrapperRoot
  );
  const requestedTargetSeconds = Number.isFinite(args.targetSeconds)
    ? args.targetSeconds
    : Number(process.env.DEFAULT_TARGET_SECONDS || fileConfig.DEFAULT_TARGET_SECONDS || outputProfile.defaultTargetSeconds);
  const targetSeconds =
    Number.isFinite(requestedTargetSeconds) && requestedTargetSeconds > 0
      ? requestedTargetSeconds
      : outputProfile.defaultTargetSeconds;
  const assetMode = "google-cloud";
  const openVideo = args.noOpen
    ? false
    : args.open || String(process.env.DEFAULT_OPEN || fileConfig.DEFAULT_OPEN || "").trim().toLowerCase() === "true";
  const slug = args.slug || `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const sourceOutput = path.join(projectRoot, "out", `${slug}.mp4`);
  let exportOutput = path.join(exportDir, `${slug}.mp4`);
  const previewOutput = path.join(projectRoot, "runs", slug, "storyboard.json");
  const previewSlug = `${slug}-preview`;
  const previewStoryboard = path.join(projectRoot, "runs", previewSlug, "storyboard.json");
  const sceneRange = getSceneRangeForProfile(outputProfile, targetSeconds);
  const runtimeEnv = {...process.env};

  if (args.language) {
    runtimeEnv.VIDEO_LANGUAGE = args.language;
  }

  if (args.voice) {
    runtimeEnv.GOOGLE_TTS_VOICE = args.voice;
    runtimeEnv.AZURE_TTS_VOICE = args.voice;
  }

  if (args.imageStyle) {
    runtimeEnv.IMAGE_STYLE_PRESET = args.imageStyle;
    runtimeEnv.FLUX2_STYLE_PRESET = args.imageStyle;
  }

  if (args.stylePrompt) {
    runtimeEnv.GOOGLE_TTS_STYLE_PROMPT = args.stylePrompt;
  }

  if (args.scriptGuidance) {
    runtimeEnv.VIDEO_SCRIPT_GUIDANCE = args.scriptGuidance;
  }

  if (typeof args.channelHandle === "string") {
    runtimeEnv.CHANNEL_HANDLE = args.channelHandle;
  }

  if (args.noMusic) {
    runtimeEnv.DEFAULT_MUSIC_FILE = "";
  } else if (args.musicFile) {
    runtimeEnv.DEFAULT_MUSIC_FILE = resolvePathFrom(wrapperRoot, args.musicFile);
  }

  Object.assign(runtimeEnv, {
    OUTPUT_PROFILE: outputProfile.id,
    RENDER_COMPOSITION_ID: outputProfile.compositionId,
    OUTPUT_WIDTH: String(outputProfile.width),
    OUTPUT_HEIGHT: String(outputProfile.height),
    MIN_SCENE_COUNT: String(sceneRange.minScenes),
    MAX_SCENE_COUNT: String(sceneRange.maxScenes),
    TARGET_DURATION_SECONDS: String(targetSeconds)
  });

  const commandArgs = [
    path.join(projectRoot, "scripts", "make-video.mjs"),
    "--title",
    title,
    "--slug",
    slug,
    "--output-profile",
    outputProfile.id,
    "--target-seconds",
    String(targetSeconds)
  ];

  if (sourceTextFile && !storyboardFileArg) {
    commandArgs.push("--source-text-file", sourceTextFile);
  }

  if (storyboardFileArg) {
    commandArgs.push("--storyboard-file", storyboardFileArg);
  }

  commandArgs.push("--asset-mode", "no-browser");

  if (usesVertexImagePipeline()) {
    const localAssetsDir = path.join(projectRoot, "assets", "envato", slug);
    commandArgs.push("--local-assets-dir", localAssetsDir);
  }

  if (Number.isFinite(args.envatoMaxScenes) && args.envatoMaxScenes > 0) {
    commandArgs.push("--envato-max-scenes", String(args.envatoMaxScenes));
  }

  if ((args.reusePreview || usesVertexImagePipeline()) && !args.force) {
    commandArgs.push("--reuse-preview");
  }

  if (!openVideo) {
    commandArgs.push("--no-open");
  }

  if (args.continueRun) {
    commandArgs.push("--continue-run");
  }

  if (args.dryRun) {
    const dryRunCommandArgs = [...commandArgs];
    const dryRunStoryboard = storyboardFileArg
      ? storyboardFileArg
      : usesVertexImagePipeline() && existsSync(previewStoryboard)
        ? `runs/${previewSlug}/storyboard.json`
        : "";

    if (dryRunStoryboard && !storyboardFileArg) {
      removeArgPair(dryRunCommandArgs, "--source-text-file");
      if (!dryRunCommandArgs.includes("--storyboard-file")) {
        dryRunCommandArgs.push("--storyboard-file", dryRunStoryboard);
      }
    }

    const previewArgs = [
      path.join(projectRoot, "scripts", "make-plan1-video.mjs"),
      "--title",
      title,
      "--slug",
      slug,
      "--output-profile",
      outputProfile.id,
      "--target-seconds",
      String(targetSeconds),
      "--preview-only"
    ];

    if (sourceTextFile) {
      previewArgs.push("--source-text-file", sourceTextFile);
    }

    if (storyboardFileArg) {
      previewArgs.push("--storyboard-file", storyboardFileArg);
    }

    process.stdout.write(
      JSON.stringify(
        {
          projectRoot,
          exportDir,
          title,
          slug,
          outputProfile: outputProfile.id,
          targetSeconds,
          sourceOutput,
          exportOutput,
          previewOutput,
          assetMode,
          runtimeEnv: {
            VIDEO_LANGUAGE: runtimeEnv.VIDEO_LANGUAGE || null,
            GOOGLE_TTS_VOICE: runtimeEnv.GOOGLE_TTS_VOICE || null,
            IMAGE_STYLE_PRESET: runtimeEnv.IMAGE_STYLE_PRESET || runtimeEnv.FLUX2_STYLE_PRESET || null,
            GOOGLE_TTS_STYLE_PROMPT: runtimeEnv.GOOGLE_TTS_STYLE_PROMPT || null,
            VIDEO_SCRIPT_GUIDANCE: runtimeEnv.VIDEO_SCRIPT_GUIDANCE || null,
            CHANNEL_HANDLE: runtimeEnv.CHANNEL_HANDLE || null,
            DEFAULT_MUSIC_FILE: runtimeEnv.DEFAULT_MUSIC_FILE || null,
            OUTPUT_PROFILE: runtimeEnv.OUTPUT_PROFILE || null,
            RENDER_COMPOSITION_ID: runtimeEnv.RENDER_COMPOSITION_ID || null,
            OUTPUT_WIDTH: runtimeEnv.OUTPUT_WIDTH || null,
            OUTPUT_HEIGHT: runtimeEnv.OUTPUT_HEIGHT || null,
            MIN_SCENE_COUNT: runtimeEnv.MIN_SCENE_COUNT || null,
            MAX_SCENE_COUNT: runtimeEnv.MAX_SCENE_COUNT || null
          },
          command: ["node", ...(args.previewOnly ? previewArgs : dryRunCommandArgs)]
        },
        null,
        2
      ) + "\n"
    );
    return;
  }

  if (args.previewOnly) {
    const previewArgs = [
      path.join(projectRoot, "scripts", "make-plan1-video.mjs"),
      "--title",
      title,
      "--slug",
      slug,
      "--output-profile",
      outputProfile.id,
      "--target-seconds",
      String(targetSeconds),
      "--preview-only"
    ];

    if (sourceTextFile) {
      previewArgs.push("--source-text-file", sourceTextFile);
    }

    if (storyboardFileArg) {
      previewArgs.push("--storyboard-file", storyboardFileArg);
    }

    const previewResult = spawnSync("node", previewArgs, {
      cwd: projectRoot,
      stdio: "inherit",
      env: runtimeEnv
    });

    if (previewResult.status !== 0) {
      process.exit(previewResult.status ?? 1);
    }

    await writeFile(
      path.join(wrapperRoot, "last-run.json"),
      JSON.stringify(
        {
          title,
          slug,
          targetSeconds,
          generatedAt: new Date().toISOString(),
          previewOnly: true,
          storyboardPath: previewOutput
        },
        null,
        2
      )
    );

    process.stdout.write(`${previewOutput}\n`);
    return;
  }

  await mkdir(exportDir, {recursive: true});

  // --- Vertex image generation step ---
  if (usesVertexImagePipeline()) {
    // Step 1: generate storyboard preview if it doesn't exist
    if (!storyboardFileArg && (!existsSync(previewStoryboard) || args.force)) {
      process.stdout.write("[vertex-assets] generating storyboard preview...\n");
      const previewArgs = [
        path.join(projectRoot, "scripts", "make-plan1-video.mjs"),
        "--title", title,
        "--slug", previewSlug,
        "--output-profile", outputProfile.id,
        "--target-seconds", String(targetSeconds),
        "--preview-only"
      ];

      if (sourceTextFile) {
        previewArgs.push("--source-text-file", sourceTextFile);
      }

      const previewResult = spawnSync("node", previewArgs, {
        cwd: projectRoot,
        stdio: "inherit",
        env: {
          ...runtimeEnv,
          REQUIRE_ENVATO_ALL_SCENES: "false",
          ALLOW_TEXT_ONLY_FALLBACK: "true"
        }
      });

      if (previewResult.status !== 0) {
        process.exit(previewResult.status ?? 1);
      }
      // The preview storyboard should now exist even if the full run fails
    }

    // Step 2: find the storyboard (preview or main)
    const storyboardFile = storyboardFileArg
      ? path.relative(projectRoot, storyboardFileArg)
      : existsSync(previewStoryboard)
      ? `runs/${previewSlug}/storyboard.json`
      : existsSync(path.join(projectRoot, "runs", slug, "storyboard.json"))
        ? `runs/${slug}/storyboard.json`
        : null;

    if (storyboardFile && !storyboardFileArg) {
      removeArgPair(commandArgs, "--source-text-file");
      if (!commandArgs.includes("--storyboard-file")) {
        commandArgs.push("--storyboard-file", storyboardFile);
      }
    }

    if (storyboardFile) {
      process.stdout.write(`[vertex-assets] generating scene assets from ${storyboardFile}...\n`);
      const assetArgs = [
        path.join(wrapperRoot, "scripts", "generate-flux2-assets.mjs"),
        "--storyboard-file", storyboardFile,
        "--slug", slug
      ];
      assetArgs.push("--provider", "google-cloud");

      const assetResult = spawnSync("node", assetArgs, {
        cwd: wrapperRoot,
        stdio: "inherit",
        env: {...runtimeEnv, VIDEOS_ENVATO_ROOT: projectRoot}
      });

      if (assetResult.status !== 0) {
        process.stderr.write("[vertex-assets] asset generation failed\n");
        process.exit(assetResult.status ?? 1);
      }
    } else {
      process.stderr.write("[vertex-assets] could not find storyboard to generate assets\n");
      process.exit(1);
    }
  }
  // --- end Vertex asset step ---
  const existingExport = await findExistingExportForTitle({
    exportDir,
    title
  });

  if ((existsSync(exportOutput) || existingExport) && !args.force) {
    const resolvedExport = existingExport || exportOutput;
    const lastRun = {
      title,
      slug,
      targetSeconds,
      generatedAt: new Date().toISOString(),
      sourceOutput: existsSync(sourceOutput) ? sourceOutput : null,
      exportOutput: resolvedExport,
      skipped: true
    };

    await writeFile(path.join(wrapperRoot, "last-run.json"), JSON.stringify(lastRun, null, 2));

    if (openVideo) {
      spawnSync("open", [resolvedExport], {stdio: "ignore"});
    }

    process.stdout.write(`${resolvedExport}\n`);
    return;
  }

  const result = spawnSync("node", commandArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    env: runtimeEnv
  });

  if (result.status !== 0) {
    await cleanupIntermediates({
      projectRoot,
      slug,
      sourceOutput
    });
    process.exit(result.status ?? 1);
  }

  if (!existsSync(sourceOutput)) {
    throw new Error(`Nao encontrei o MP4 esperado em ${sourceOutput}`);
  }

  exportOutput = await resolveLocalizedExportOutput({
    projectRoot,
    exportDir,
    slug,
    fallbackTitle: title
  });

  await copyFile(sourceOutput, exportOutput);
  await cleanupIntermediates({
    projectRoot,
    slug,
    sourceOutput
  });

  const lastRun = {
    title,
    slug,
    targetSeconds,
    generatedAt: new Date().toISOString(),
    sourceOutput,
    exportOutput
  };

  await writeFile(path.join(wrapperRoot, "last-run.json"), JSON.stringify(lastRun, null, 2));

  if (openVideo) {
    spawnSync("open", [exportOutput], {stdio: "ignore"});
  }

  process.stdout.write(`${exportOutput}\n`);
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
