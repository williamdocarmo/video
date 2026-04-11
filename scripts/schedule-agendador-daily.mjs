#!/usr/bin/env node
import {spawn} from "node:child_process";
import {mkdir, readdir, readFile, stat, unlink, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {existsSync} from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const resolvePathFromProjectRoot = (value, fallback = "") => {
  const raw = String(value || fallback || "").trim();
  if (!raw) {
    return "";
  }
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
};

const resolveEnvatoRoot = async () => {
  const envPath = path.join(projectRoot, ".env");
  if (existsSync(envPath)) {
    const content = await readFile(envPath, "utf8");
    const match = content.match(/^VIDEOS_ENVATO_ROOT=(.+)$/m);
    if (match) return resolvePathFromProjectRoot(match[1].trim());
  }
  return resolvePathFromProjectRoot(process.env.VIDEOS_ENVATO_ROOT, path.join(projectRoot, "video-engine"));
};

const envatoRoot = await resolveEnvatoRoot();
const {loadSecretsIntoEnv} = await import(path.join(envatoRoot, "scripts", "lib", "secrets.mjs"));

const defaultSourceDir = projectRoot;
const defaultCompressedDir = path.join(projectRoot, "_agendador-daily");
const reportDir = path.join(projectRoot, "reports");
const DEFAULT_AGENDADOR_SITE_URL = "https://agendador.online";

const normalizeAgendadorSiteUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return DEFAULT_AGENDADOR_SITE_URL;
  }

  return raw.endsWith("/api") ? raw.slice(0, -4) : raw;
};

const apiBase = `${normalizeAgendadorSiteUrl(
  process.env.AGENDADOR_ONLINE_URL || process.env.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL
)}/api`;

const resolveAgendadorIdentity = () =>
  String(
    process.env.AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL ||
      process.env.AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME ||
      process.env.AGENDADOR_EMAIL ||
      process.env.AGENDADOR_USERNAME ||
      ""
  ).trim();

const resolveAgendadorPassword = () =>
  String(process.env.AGENDADOR_ONLINE_PASSWORD || process.env.AGENDADOR_PASSWORD || "").trim();

const parseArgs = (argv) => {
  const parsed = {
    sourceDir: defaultSourceDir,
    compressedDir: defaultCompressedDir,
    listFile: "",
    start: null,
    time: "16:30",
    limit: 40,
    excludePrefix: "",
    firstFile: "",
    deletePendingIds: [],
    dryRun: false,
    maxUploadMb: 24
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--source-dir") {
      parsed.sourceDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--compressed-dir") {
      parsed.compressedDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--list-file") {
      parsed.listFile = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--start") {
      parsed.start = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--time") {
      parsed.time = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--limit") {
      parsed.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--exclude-prefix") {
      parsed.excludePrefix = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--first-file") {
      parsed.firstFile = argv[index + 1];
      index += 1;
      continue;
    }

    if (item === "--delete-pending-id") {
      parsed.deletePendingIds.push(Number(argv[index + 1]));
      index += 1;
      continue;
    }

    if (item === "--max-upload-mb") {
      parsed.maxUploadMb = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (item === "--dry-run") {
      parsed.dryRun = true;
    }
  }

  return parsed;
};

const apiFetch = async (endpoint, {method = "GET", token, body, form} = {}) => {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
      ...(body ? {"Content-Type": "application/json"} : {})
    },
    body: form ?? (body ? JSON.stringify(body) : undefined)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(payload?.error || `${method} ${endpoint} falhou com ${response.status}.`);
  }

  return payload;
};

const slugToCaption = (filePath) => {
  const base = path.basename(filePath, path.extname(filePath));
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const text = withoutDate.replace(/-/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : base;
};

const parseStartDate = (rawDate, rawTime) => {
  const datePart = rawDate || new Date().toISOString().slice(0, 10);
  return new Date(`${datePart}T${rawTime}:00`);
};

const listQueueFiles = async ({sourceDir, excludePrefix, firstFile, limit}) => {
  const entries = await readdir(sourceDir, {withFileTypes: true});
  const mp4s = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mp4"))
    .map((entry) => entry.name)
    .filter((name) => (excludePrefix ? !name.startsWith(excludePrefix) : true))
    .sort();

  const queue = [];
  const seen = new Set();

  if (firstFile) {
    const exact = mp4s.find((name) => name === firstFile);
    if (!exact) {
      throw new Error(`Nao achei o first-file ${firstFile}.`);
    }
    queue.push(path.join(sourceDir, exact));
    seen.add(exact);
  }

  for (const name of mp4s) {
    if (seen.has(name)) {
      continue;
    }
    queue.push(path.join(sourceDir, name));
    if (queue.length >= limit) {
      break;
    }
  }

  return queue.slice(0, limit);
};

const listQueueFilesFromList = async (listFile, limit) => {
  const raw = await readFile(listFile, "utf8");
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
};

const runFfmpeg = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg falhou com code ${code}`));
    });
  });

const ensureUploadable = async (inputPath, {compressedDir, maxUploadMb, dryRun}) => {
  const maxBytes = maxUploadMb * 1024 * 1024;
  const current = await stat(inputPath);

  if (current.size <= maxBytes) {
    return {
      filePath: inputPath,
      compressed: false,
      size: current.size
    };
  }

  if (dryRun) {
    return {
      filePath: path.join(compressedDir, path.basename(inputPath)),
      compressed: true,
      size: current.size
    };
  }

  await mkdir(compressedDir, {recursive: true});
  const outputPath = path.join(compressedDir, path.basename(inputPath));
  const attempts = [
    {videoBitrate: "1000k", audioBitrate: "96k"},
    {videoBitrate: "800k", audioBitrate: "80k"},
    {videoBitrate: "650k", audioBitrate: "64k"}
  ];

  for (const attempt of attempts) {
    try {
      await unlink(outputPath);
    } catch {}

    await runFfmpeg([
      "-i",
      inputPath,
      "-vf",
      "scale='min(720,iw)':-2:force_original_aspect_ratio=decrease",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      attempt.videoBitrate,
      "-maxrate",
      attempt.videoBitrate,
      "-bufsize",
      "2M",
      "-c:a",
      "aac",
      "-b:a",
      attempt.audioBitrate,
      "-movflags",
      "+faststart",
      outputPath
    ]);

    const compressed = await stat(outputPath);
    if (compressed.size <= maxBytes) {
      return {
        filePath: outputPath,
        compressed: true,
        size: compressed.size
      };
    }
  }

  throw new Error(`Nao consegui comprimir ${path.basename(inputPath)} abaixo de ${maxUploadMb} MB.`);
};

const uploadMedia = async (token, filePath) => {
  const buffer = await readFile(filePath);
  const form = new FormData();
  const blob = new Blob([buffer], {type: "video/mp4"});
  form.set("file", blob, path.basename(filePath));
  const payload = await apiFetch("/upload", {
    method: "POST",
    token,
    form
  });
  return payload.url;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  loadSecretsIntoEnv([
    "AGENDADOR_ONLINE_URL",
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD",
    "AGENDADOR_EMAIL",
    "AGENDADOR_USERNAME",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME"
  ]);

  const identity = resolveAgendadorIdentity();
  const password = resolveAgendadorPassword();

  if (!identity || !password) {
    throw new Error("Faltam AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL/USERNAME e AGENDADOR_ONLINE_PASSWORD.");
  }

  const startAt = parseStartDate(args.start, args.time);
  if (Number.isNaN(startAt.getTime())) {
    throw new Error("Data inicial invalida.");
  }

  const queue = args.listFile
    ? await listQueueFilesFromList(args.listFile, args.limit)
    : await listQueueFiles(args);
  if (queue.length === 0) {
    throw new Error("Nao achei videos para agendar.");
  }

  const auth = await apiFetch("/auth/login", {
    method: "POST",
    body: {
      identifier: identity,
      email: identity,
      password
    }
  });
  const token = auth?.token;
  if (!token) {
    throw new Error("A autenticacao do agendador nao devolveu token.");
  }

  const accountsPayload = await apiFetch("/social-accounts", {token});
  const accounts = accountsPayload?.accounts || [];
  const requiredProviders = ["FB", "IG", "YT"];
  const missingProviders = requiredProviders.filter((provider) => {
    const account = accounts.find((item) => item.provider === provider);
    return !account?.connected;
  });
  if (missingProviders.length > 0) {
    throw new Error(`Conecte as redes: ${missingProviders.join(", ")}`);
  }

  for (const postId of args.deletePendingIds) {
    if (!Number.isInteger(postId)) {
      continue;
    }
    if (!args.dryRun) {
      await apiFetch(`/posts/${postId}`, {
        method: "DELETE",
        token
      });
    }
  }

  const results = [];

  for (let index = 0; index < queue.length; index += 1) {
    const sourcePath = queue[index];
    const scheduledAt = new Date(startAt.getTime() + index * 24 * 60 * 60 * 1000);
    const prepared = await ensureUploadable(sourcePath, args);
    const caption = slugToCaption(sourcePath);

    if (args.dryRun) {
      results.push({
        sourcePath,
        preparedPath: prepared.filePath,
        compressed: prepared.compressed,
        scheduledAt: scheduledAt.toISOString(),
        caption,
        status: "dry-run"
      });
      continue;
    }

    const mediaUrl = await uploadMedia(token, prepared.filePath);
    const created = await apiFetch("/posts", {
      method: "POST",
      token,
      body: {
        date: scheduledAt.toISOString(),
        mediaUrl,
        caption,
        platforms: ["FB", "IG", "YT"],
        isDraft: false
      }
    });

    results.push({
      sourcePath,
      preparedPath: prepared.filePath,
      compressed: prepared.compressed,
      scheduledAt: scheduledAt.toISOString(),
      caption,
      mediaUrl,
      postId: created?.post?.id ?? null
    });
  }

  await mkdir(reportDir, {recursive: true});
  const reportPath = path.join(
    reportDir,
    `agendador-daily-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        startAt: startAt.toISOString(),
        queue,
        results
      },
      null,
      2
    )
  );

  process.stdout.write(`${reportPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
