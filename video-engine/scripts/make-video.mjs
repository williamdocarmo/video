import "dotenv/config";
import {spawnSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {resolveOutputProfileConfig} from "../../config/output-profiles.mjs";
import {resolveLlmProvider} from "./lib/llm-provider.mjs";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";
import {
  cleanupEnvatoArtifactsForSlug,
  cleanupEnvatoAssetDirs,
  cleanupStaleEnvatoChromeProfiles
} from "./lib/storage-cleanup.mjs";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);

const parseArgs = (argv) => {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

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

    if (item === "--source-text-file") {
      parsed.sourceTextFile = argv[index + 1];
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

    if (item === "--no-open") {
      parsed.noOpen = true;
      continue;
    }

    if (item === "--reuse-preview") {
      parsed.reusePreview = true;
      continue;
    }

    if (item === "--continue-run") {
      parsed.continueRun = true;
      continue;
    }

    if (item === "--asset-mode") {
      parsed.assetMode = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--local-assets-dir") {
      parsed.localAssetsDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--envato-max-scenes") {
      parsed.envatoMaxScenes = Number(argv[index + 1]);
      index += 1;
    }
  }

  return parsed;
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

const logAgent = (agent, message) => {
  process.stdout.write(`[${agent}] ${message}\n`);
};

const getMinSceneCount = () => Math.max(14, Number.parseInt(process.env.MIN_SCENE_COUNT || "14", 10) || 14);
const isPexelsAllowed = () => String(process.env.ALLOW_PEXELS || "false").trim().toLowerCase() === "true";
const requireEnvatoAllScenes = () =>
  String(process.env.REQUIRE_ENVATO_ALL_SCENES || "true").trim().toLowerCase() === "true";

const readStoryboardSceneCount = async (targetPath) => {
  try {
    const raw = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.scenes) ? parsed.scenes.length : 0;
  } catch {
    return 0;
  }
};

const runNode = (args, options = {}) => {
  const result = spawnSync("node", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: {...process.env, ...(options.env ?? {})}
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "node falhou");
  }

  return result.stdout?.trim() ?? "";
};

const runCommand = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: {...process.env, ...(options.env ?? {})}
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} falhou`);
  }

  return result.stdout?.trim() ?? "";
};

const makeReport = ({title, slug, targetSeconds}) => ({
  title,
  slug,
  targetSeconds,
  startedAt: new Date().toISOString(),
  status: "running",
  finalVideo: null,
  sceneCount: 0,
  durationSec: 0,
  audioDurationSec: 0,
  qa: null,
  agents: {
    sysadmin: {status: "pending", notes: []},
    dev: {status: "pending", notes: []},
    editor: {status: "pending", notes: []},
    qa: {status: "pending", notes: []}
  }
});

const makeProfileEnv = (profile, targetSeconds) => ({
  OUTPUT_PROFILE: profile.id,
  RENDER_COMPOSITION_ID: profile.compositionId,
  OUTPUT_WIDTH: String(profile.width),
  OUTPUT_HEIGHT: String(profile.height),
  MIN_SCENE_COUNT: String(profile.minScenes),
  MAX_SCENE_COUNT: String(profile.maxScenes),
  TARGET_DURATION_SECONDS: String(targetSeconds)
});

const appendNote = (report, agent, note) => {
  report.agents[agent].notes.push(note);
};

const roundMetric = (value, digits = 3) => Number(Number(value || 0).toFixed(digits));

const applyValidationSummary = (report, validation, qaPass, outPath) => {
  report.status = qaPass ? "completed" : "failed";
  report.finalVideo = outPath;
  report.sceneCount = Number(validation.checks?.sceneCount || 0);
  report.durationSec = roundMetric(validation.metrics?.videoSeconds);
  report.audioDurationSec = roundMetric(validation.metrics?.audioSeconds);
  report.qa = {
    passed: qaPass,
    outputPath: outPath,
    checks: validation.checks,
    metrics: validation.metrics
  };
};

const printQaSummary = (validation, qaPass, outPath) => {
  process.stdout.write(
    `[qa] resumo final: status=${qaPass ? "ok" : "fail"} scenes=${validation.checks.sceneCount} ` +
    `audio=${roundMetric(validation.metrics.audioSeconds, 2)}s ` +
    `video=${roundMetric(validation.metrics.videoSeconds, 2)}s ` +
    `envatoOnly=${validation.checks.envatoOnly} ` +
    `linkedNarration=${validation.checks.linkedNarration} ` +
    `sync=${validation.checks.audioVideoSyncOk} ` +
    `output=${outPath}\n`
  );
};

const resolveAssetMode = (value) => {
  const normalized = String(value || process.env.ASSET_MODE || "auto")
    .trim()
    .toLowerCase();

  if (normalized === "no-browser" || normalized === "nobrowser") {
    return "no-browser";
  }

  if (normalized === "pexels-only" || normalized === "pexels") {
    if (isPexelsAllowed()) {
      return "pexels-only";
    }

    throw new Error("O modo pexels-only esta desativado neste projeto.");
  }

  return "auto";
};

const requireEnv = (...keys) => {
  const missing = keys.filter((key) => !String(process.env[key] || "").trim());

  if (missing.length > 0) {
    throw new Error(`Faltam variaveis no .env: ${missing.join(", ")}`);
  }
};

const hasEnvValue = (value) => String(value || "").trim().length > 0;

const hasAzureSpeechConfig = () =>
  hasEnvValue(process.env.AZURE_SPEECH_KEY) &&
  (hasEnvValue(process.env.AZURE_SPEECH_REGION) || hasEnvValue(process.env.AZURE_SPEECH_ENDPOINT));

const resolveEffectiveTtsProvider = (provider) => {
  const normalized = String(provider || "auto").trim().toLowerCase();

  if (normalized !== "auto") {
    return normalized;
  }

  if (hasAzureSpeechConfig()) {
    return "azure";
  }

  if (hasEnvValue(process.env.GOOGLE_APPLICATION_CREDENTIALS) && hasEnvValue(process.env.GOOGLE_CLOUD_PROJECT)) {
    return "gcloud";
  }

  if (hasEnvValue(process.env.ELEVENLABS_API_KEY)) {
    return "elevenlabs";
  }

  return null;
};

const validateTtsProvider = async (provider) => {
  if (provider === "azure") {
    requireEnv("AZURE_SPEECH_KEY");

    if (!hasEnvValue(process.env.AZURE_SPEECH_REGION) && !hasEnvValue(process.env.AZURE_SPEECH_ENDPOINT)) {
      throw new Error("Azure Speech requer AZURE_SPEECH_REGION ou AZURE_SPEECH_ENDPOINT.");
    }

    return {
      provider: "azure",
      region: process.env.AZURE_SPEECH_REGION || null,
      endpointConfigured: hasEnvValue(process.env.AZURE_SPEECH_ENDPOINT)
    };
  }

  if (
    provider === "google" ||
    provider === "gcloud" ||
    provider === "google-cloud" ||
    provider === "google-gemini-tts" ||
    provider === "gemini-tts" ||
    provider === "gemini"
  ) {
    requireEnv("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT");
    return {
      provider: "gcloud",
      credentialsConfigured: true,
      projectId: process.env.GOOGLE_CLOUD_PROJECT || null
    };
  }

  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY
    }
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs respondeu ${response.status}`);
  }

  const payload = await response.json();
  const voices = Array.isArray(payload?.voices) ? payload.voices : [];
  const selectedVoice = voices.find((voice) => voice.voice_id === process.env.ELEVENLABS_VOICE_ID) ?? null;

  return {
    provider: "elevenlabs",
    voiceCount: voices.length,
    selectedVoiceName: selectedVoice?.name ?? null
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.title) {
    throw new Error('Usa: npm run make -- --title "o teu titulo aqui"');
  }

  const assetMode = resolveAssetMode(args.assetMode);
  const envatoMaxScenes = Number.isFinite(args.envatoMaxScenes)
    ? args.envatoMaxScenes
    : Number(process.env.ENVATO_MAX_SCENES_PER_VIDEO || 0);
  const envatoStrictMode = requireEnvatoAllScenes();
  const secretKeys = ["OPENROUTER_API_KEY", "ELEVENLABS_API_KEY", "GOOGLE_API_KEY", "AZURE_SPEECH_KEY"];

  if (assetMode === "auto") {
    secretKeys.push("ENVATO_EMAIL", "ENVATO_PASSWORD");
  }

  loadSecretsIntoEnv(secretKeys);
  const llmProvider = resolveLlmProvider(process.env.LLM_PROVIDER || process.env.STORY_PROVIDER || "codex");
  const ttsProvider = String(process.env.TTS_PROVIDER || "auto").trim().toLowerCase();
  const effectiveTtsProvider = resolveEffectiveTtsProvider(ttsProvider);
  const requiredKeys = [];

  if (llmProvider === "openrouter") {
    requiredKeys.unshift("OPENROUTER_API_KEY");
  }

  if (
    ttsProvider === "google" ||
    ttsProvider === "gcloud" ||
    ttsProvider === "google-cloud" ||
    ttsProvider === "google-gemini-tts" ||
    ttsProvider === "gemini-tts" ||
    ttsProvider === "gemini"
  ) {
    requiredKeys.push("GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT");
  } else if (ttsProvider === "azure") {
    requiredKeys.push("AZURE_SPEECH_KEY");
  } else if (ttsProvider === "elevenlabs") {
    requiredKeys.push("ELEVENLABS_API_KEY");
  }

  if (assetMode === "auto") {
    requiredKeys.push("ENVATO_EMAIL", "ENVATO_PASSWORD");
  }

  requireEnv(...requiredKeys);

  if (ttsProvider === "azure" && !hasAzureSpeechConfig()) {
    throw new Error("Azure Speech requer AZURE_SPEECH_KEY e AZURE_SPEECH_REGION ou AZURE_SPEECH_ENDPOINT.");
  }

  if (ttsProvider === "auto" && !effectiveTtsProvider) {
    throw new Error("TTS_PROVIDER=auto, mas nao encontrei Azure Speech nem Google Cloud TTS configurados.");
  }

  if (envatoStrictMode && assetMode !== "auto" && !args.localAssetsDir) {
    throw new Error("Modo estrito do Envato ativo: usa --asset-mode auto ou fornece --local-assets-dir com clips do Envato.");
  }

  if (envatoStrictMode && envatoMaxScenes > 0) {
    throw new Error("Modo estrito do Envato ativo: nao podes limitar --envato-max-scenes.");
  }

  const title = args.title.trim();
  const slug = args.slug || `${new Date().toISOString().slice(0, 10)}-${slugify(title)}`;
  const previewSlug = `${slug}-preview`;
  const outputProfile = resolveOutputProfileConfig(args.outputProfile || process.env.OUTPUT_PROFILE || "vertical-short");
  const requestedTargetSeconds = Number.isFinite(args.targetSeconds)
    ? args.targetSeconds
    : Number(process.env.TARGET_DURATION_SECONDS || outputProfile.defaultTargetSeconds);
  const targetSeconds =
    Number.isFinite(requestedTargetSeconds) && requestedTargetSeconds > 0
      ? requestedTargetSeconds
      : outputProfile.defaultTargetSeconds;
  Object.assign(process.env, makeProfileEnv(outputProfile, targetSeconds));
  const minSceneCount = getMinSceneCount();
  const runDir = path.join(projectRoot, "runs", slug);
  const previewStoryboardPath = path.join(projectRoot, "runs", previewSlug, "storyboard.json");
  const outPath = path.join(projectRoot, "out", `${slug}.mp4`);
  const report = makeReport({title, slug, targetSeconds});
  report.outputProfile = outputProfile.id;
  report.outputDimensions = {width: outputProfile.width, height: outputProfile.height};
  const previewSceneCount = existsSync(previewStoryboardPath) ? await readStoryboardSceneCount(previewStoryboardPath) : 0;

  await mkdir(runDir, {recursive: true});

  logAgent("sysadmin", "a validar chaves e preparar a sessao do projeto");
  if (assetMode === "auto") {
    const removedStaleProfiles = await cleanupStaleEnvatoChromeProfiles();
    const removedOldAssetDirs = await cleanupEnvatoAssetDirs({preserveSlugs: [slug]});
    appendNote(
      report,
      "sysadmin",
      `Limpeza previa: ${removedStaleProfiles} perfis temporarios do Chrome e ${removedOldAssetDirs} pastas antigas de assets do Envato removidos.`
    );
  }
  const ttsInfo = await validateTtsProvider(effectiveTtsProvider);
  report.agents.sysadmin.status = "completed";
  report.agents.sysadmin.tts = ttsInfo;
  report.agents.sysadmin.llmProvider = llmProvider;
  report.agents.sysadmin.assetMode = assetMode;
  report.agents.sysadmin.envatoMaxScenes = envatoMaxScenes > 0 ? envatoMaxScenes : null;
  report.agents.sysadmin.requestedTtsProvider = ttsProvider;
  report.agents.sysadmin.effectiveTtsProvider = effectiveTtsProvider;
  appendNote(
    report,
    "sysadmin",
    ttsInfo.provider === "gcloud"
      ? `Google TTS validado; modelo alvo ${process.env.GOOGLE_TTS_MODEL || "gemini-2.5-flash-preview-tts"}.`
      : ttsInfo.provider === "azure"
        ? `Azure Speech validado${ttsInfo.region ? ` na regiao ${ttsInfo.region}` : ""}.`
        : `ElevenLabs validado com ${ttsInfo.voiceCount} vozes.`
  );
  appendNote(report, "sysadmin", `Provider de roteiro ativo: ${llmProvider}.`);
  appendNote(report, "sysadmin", `Modo de assets ativo: ${assetMode}.`);
  appendNote(report, "sysadmin", envatoStrictMode ? "Envato obrigatorio em todas as cenas." : "Envato preferencial.");
  if (assetMode === "auto") {
    appendNote(report, "sysadmin", "Sessao do Envato sera validada no primeiro download real.");
  } else {
    appendNote(report, "sysadmin", "Sem browser: o pipeline vai usar apenas assets locais e falhar se faltar clip.");
  }

  logAgent("dev", "a gerar storyboard e plano visual a partir do titulo");
  const storyboardFile = args.storyboardFile
    ? path.relative(projectRoot, path.resolve(projectRoot, args.storyboardFile))
    : `runs/${previewSlug}/storyboard.json`;
  const shouldReuseExistingPreview =
    !args.storyboardFile &&
    args.reusePreview &&
    existsSync(previewStoryboardPath) &&
    previewSceneCount >= minSceneCount;

  if (!args.storyboardFile && !shouldReuseExistingPreview) {
    const previewArgs = [
      path.join(projectRoot, "scripts", "make-plan1-video.mjs"),
      "--title",
      title,
      "--slug",
      previewSlug,
      "--output-profile",
      outputProfile.id,
      "--target-seconds",
      String(targetSeconds),
      "--preview-only"
    ];

    if (args.sourceTextFile) {
      previewArgs.push("--source-text-file", args.sourceTextFile);
    }

    runNode(previewArgs, {stdio: "inherit"});
  }
  report.agents.dev.status = "completed";
  appendNote(
    report,
    "dev",
    args.storyboardFile
      ? `Storyboard travado em ${storyboardFile}.`
      : shouldReuseExistingPreview
        ? `Preview reutilizado em runs/${previewSlug}.`
        : previewSceneCount > 0 && previewSceneCount < minSceneCount
          ? `Preview antigo ignorado por ter ${previewSceneCount} cenas; preview novo criado em runs/${previewSlug}.`
          : `Preview criado em runs/${previewSlug}.`
  );

  logAgent("editor", "a resolver assets e montar o video final");
  const manifestPath = path.join(projectRoot, "assets", "envato", slug, "manifest.json");

  if (assetMode === "auto" || assetMode === "no-browser") {
    const fetchArgs = [
      path.join(projectRoot, "scripts", "fetch-envato-overrides.mjs"),
      "--storyboard-file",
      storyboardFile,
      "--slug",
      slug
    ];

    if (assetMode === "no-browser") {
      fetchArgs.push("--no-browser");
    }

    if (args.localAssetsDir) {
      fetchArgs.push("--source-dir", args.localAssetsDir);
    }

    if (envatoMaxScenes > 0) {
      fetchArgs.push("--max-scenes", String(envatoMaxScenes));
    }

    runNode(fetchArgs, {stdio: "inherit"});
  } else {
    await mkdir(path.dirname(manifestPath), {recursive: true});
    await writeFile(manifestPath, JSON.stringify([], null, 2));
    appendNote(report, "editor", "Manifesto vazio criado sem usar Envato nem Pexels.");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const failedDownloads = manifest.filter((entry) => entry.status === "failed");
  const unresolvedScenes = manifest.filter(
    (entry) => !["downloaded", "copied-local", "skipped-existing"].includes(entry.status)
  );
  report.agents.editor.envatoFailedScenes = failedDownloads.length;
  if (failedDownloads.length > 0) {
    appendNote(
      report,
      "editor",
      `Envato falhou em ${failedDownloads.length} cenas.`
    );
  }

  if (envatoStrictMode && unresolvedScenes.length > 0) {
    report.agents.editor.status = "failed";
    report.status = "failed";
    appendNote(
      report,
      "editor",
      `Envato nao entregou clips para ${unresolvedScenes.length} cenas. A run foi bloqueada antes do render.`
    );
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(runDir, "orchestration-report.json"), JSON.stringify(report, null, 2));
    await cleanupEnvatoArtifactsForSlug(slug);
    throw new Error(`Envato nao entregou clips para todas as cenas da run ${slug}.`);
  }

  const renderArgs = [
    path.join(projectRoot, "scripts", "make-plan1-video.mjs"),
    "--title",
    title,
    "--slug",
    slug,
    "--output-profile",
    outputProfile.id,
    "--storyboard-file",
    storyboardFile,
    "--target-seconds",
    String(targetSeconds)
  ];

  if (args.continueRun) {
    renderArgs.push("--continue-run");
  }

  if (args.sourceTextFile) {
    renderArgs.push("--source-text-file", args.sourceTextFile);
  }

  runNode(renderArgs, {stdio: "inherit"});

  report.agents.editor.status = "completed";
  report.agents.editor.downloadedAssets = manifest.filter((entry) =>
    ["downloaded", "copied-local", "skipped-existing"].includes(entry.status)
  ).length;
  appendNote(report, "editor", `Manifesto do Envato gerado em ${manifestPath}.`);

  logAgent("qa", "a validar o render final e o modo envato-only");
  const validationRaw = runNode([
    path.join(projectRoot, "scripts", "validate-run.mjs"),
    "--slug",
    slug,
    "--target-seconds",
    String(targetSeconds)
  ]);
  const validation = JSON.parse(validationRaw);
  const qaPass =
    validation.checks.outputExists &&
    validation.checks.sceneCountOk &&
    validation.checks.captionsHaveCoverage &&
    validation.checks.captionTimelineMonotonic &&
    validation.checks.captionWordBoundsOk &&
    validation.checks.captionsBoundedToSingleScene &&
    validation.checks.karaokeReady &&
    validation.checks.wordTimedCaptions &&
    validation.checks.alignmentAvailable &&
    validation.checks.timedWordsSourceTrusted &&
    validation.checks.sceneTimelineMonotonic &&
    validation.checks.sceneSpeechPacingOk &&
    validation.checks.sceneStartWordSyncOk &&
    validation.checks.transitionsOk &&
    validation.checks.linkedNarration &&
    validation.checks.audioVideoSyncOk &&
    validation.checks.sttAudioSyncOk &&
    validation.checks.sceneResolutionOk &&
    validation.checks.envatoOnly &&
    validation.checks.visualAuditOk &&
    validation.checks.noTextFallback &&
    validation.checks.clipCoverageOk &&
    validation.checks.voiceProviderOk;

  report.agents.qa.status = qaPass ? "completed" : "failed";
  report.agents.qa.validation = validation;
  appendNote(report, "qa", qaPass ? "Validacao E2E passou." : "Validacao E2E falhou.");
  applyValidationSummary(report, validation, qaPass, outPath);
  report.completedAt = new Date().toISOString();

  await writeFile(path.join(runDir, "orchestration-report.json"), JSON.stringify(report, null, 2));

  if (!qaPass) {
    await cleanupEnvatoArtifactsForSlug(slug);
    throw new Error(`QA reprovou a run ${slug}. Vê runs/${slug}/orchestration-report.json`);
  }

  printQaSummary(validation, qaPass, outPath);

  if (assetMode === "auto") {
    await cleanupEnvatoArtifactsForSlug(slug);
    const removedStaleProfiles = await cleanupStaleEnvatoChromeProfiles();
    appendNote(
      report,
      "sysadmin",
      `Limpeza final: assets da run removidos e ${removedStaleProfiles} perfis temporarios do Chrome apagados.`
    );
    await writeFile(path.join(runDir, "orchestration-report.json"), JSON.stringify(report, null, 2));
  }

  if (!args.noOpen) {
    runCommand("open", [outPath]);
  }

  process.stdout.write(`${outPath}\n`);
};

main().catch(async (error) => {
  process.stderr.write(`Erro: ${error.message}\n`);
  process.exit(1);
});
