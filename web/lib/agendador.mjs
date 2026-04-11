/**
 * @module agendador
 * Integração com o Agendador Online — autenticação, upload de mídia e publicação.
 *
 * Requer chamada a {@link init} antes de usar qualquer função que dependa
 * de estado do servidor (credenciais, perfis de canal, paths).
 */

import path from "node:path";
import {existsSync} from "node:fs";
import {readFile, stat, unlink} from "node:fs/promises";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_AGENDADOR_SITE_URL = "https://agendador.online";
const AGENDADOR_DEFAULT_PLATFORMS = ["FB", "IG", "YT"];
const AGENDADOR_MAX_UPLOAD_MB = 24;

/** @type {string} */
let AGENDADOR_API_BASE = `${DEFAULT_AGENDADOR_SITE_URL}/api`;

// ── Injected dependencies (set via init()) ───────────────────────────────────

/** @type {Record<string, string>} */
let _baseChildEnv = {};
/** @type {string} */
let _configuredVideoEngineRoot = "";
/** @type {string} */
let _videoLibraryDir = "";
/** @type {(value: string) => import('./presets.mjs').ChannelOption} */
let _getChannelConfig = () => { throw new Error("agendador.init() not called"); };
/** @type {Record<string, any>} */
let _channelPublishProfiles = {};
/** @type {(dir: string) => Promise<void>} */
let _ensureManagedDir = async () => {};
/** @type {(p: string) => Promise<{uid:number,gid:number}|null>} */
let _getDesiredOwnerForPath = async () => null;
/** @type {(p: string, owner: any) => Promise<void>} */
let _syncPathOwnership = async () => {};
/** @type {(p: string, mode: number) => Promise<void>} */
let _syncPathMode = async () => {};
/** @type {(args: string[]) => Promise<void>} */
let _runFfmpeg = async () => {};

// ── init ─────────────────────────────────────────────────────────────────────

/**
 * Inject server-scoped dependencies. Must be called once at startup.
 * @param {object} deps
 */
export const init = (deps) => {
  _baseChildEnv = deps.baseChildEnv;
  _configuredVideoEngineRoot = deps.configuredVideoEngineRoot;
  _videoLibraryDir = deps.videoLibraryDir;
  _getChannelConfig = deps.getChannelConfig;
  _channelPublishProfiles = deps.channelPublishProfiles;
  _ensureManagedDir = deps.ensureManagedDir;
  _getDesiredOwnerForPath = deps.getDesiredOwnerForPath;
  _syncPathOwnership = deps.syncPathOwnership;
  _syncPathMode = deps.syncPathMode;
  _runFfmpeg = deps.runFfmpeg;

  AGENDADOR_API_BASE = normalizeAgendadorApiBase(
    _baseChildEnv.AGENDADOR_ONLINE_URL ||
      _baseChildEnv.AGENDADOR_URL ||
      process.env.AGENDADOR_ONLINE_URL ||
      DEFAULT_AGENDADOR_SITE_URL
  );
};

// ── URL helpers ──────────────────────────────────────────────────────────────

/** @param {string} [value] */
export const normalizeAgendadorSiteUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return DEFAULT_AGENDADOR_SITE_URL;
  }
  return raw.endsWith("/api") ? raw.slice(0, -4) : raw;
};

/** @param {string} [value] */
export const normalizeAgendadorApiBase = (value) => {
  const siteUrl = normalizeAgendadorSiteUrl(value);
  return siteUrl.endsWith("/api") ? siteUrl : `${siteUrl}/api`;
};

/** Resolved site URL using current env. */
export const getAgendadorSiteUrl = () =>
  normalizeAgendadorSiteUrl(
    _baseChildEnv.AGENDADOR_ONLINE_URL || _baseChildEnv.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL
  );

/** Current API base URL. */
export const getAgendadorApiBase = () => AGENDADOR_API_BASE;

// ── Env resolution ───────────────────────────────────────────────────────────

/**
 * Return the first env key (from baseChildEnv or process.env) that has a non-empty value.
 * @param {...(string|string[])} keys
 */
const resolveFirstUsableEnvValue = (...keys) => {
  for (const key of keys.flat()) {
    const value = String(_baseChildEnv[key] || process.env[key] || "").trim();
    if (value) {
      return {key, value};
    }
  }
  return null;
};

// ── Channel profile ──────────────────────────────────────────────────────────

/**
 * Build the agendador credential/profile object for a given channel.
 * @param {string} channelValue
 */
export const resolveAgendadorChannelProfile = (channelValue) => {
  const channel = _getChannelConfig(channelValue);
  const channelKey = channel.value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const specificProfile = _channelPublishProfiles[channel.value] || _channelPublishProfiles.foiumaideia;
  const identifier = resolveFirstUsableEnvValue(
    specificProfile.identifierKeys,
    `AGENDADOR_ONLINE_${channelKey}_EMAIL`,
    `AGENDADOR_ONLINE_${channelKey}_USERNAME`,
    `AGENDADOR_${channelKey}_EMAIL`,
    `AGENDADOR_${channelKey}_USERNAME`
  );
  const password = resolveFirstUsableEnvValue(
    specificProfile.passwordKeys,
    `AGENDADOR_ONLINE_${channelKey}_PASSWORD`,
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD"
  );
  const publicUrl = resolveFirstUsableEnvValue(
    specificProfile.publicUrlKeys || [],
    `AGENDADOR_ONLINE_${channelKey}_URL`,
    `${channelKey}_URL`
  );

  return {
    channel: channel.value,
    label: channel.label,
    handle: channel.handle,
    identifier: identifier?.value || "",
    identifierSource: identifier?.key || "",
    password: password?.value || "",
    passwordSource: password?.key || "",
    publicUrl: publicUrl?.value || "",
    profileUrlSource: publicUrl?.key || "",
    apiBase: AGENDADOR_API_BASE,
    siteUrl: getAgendadorSiteUrl()
  };
};

/**
 * Check if a channel has agendador credentials configured.
 * @param {string} channelValue
 */
export const hasAgendadorCredentialsForChannel = (channelValue) => {
  const profile = resolveAgendadorChannelProfile(channelValue);
  return Boolean(profile.identifier && profile.password);
};

// ── Platforms ─────────────────────────────────────────────────────────────────

/**
 * Normalize a platform list, falling back to the default set.
 * @param {string|string[]} value
 */
export const normalizePlatforms = (value) => {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const normalized = list
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item) => AGENDADOR_DEFAULT_PLATFORMS.includes(item));
  return normalized.length > 0 ? [...new Set(normalized)] : [...AGENDADOR_DEFAULT_PLATFORMS];
};

// ── Secrets ──────────────────────────────────────────────────────────────────

/** Load agendador-related secrets into process.env via the secrets module. */
export const ensureAgendadorSecrets = async () => {
  const secretsModulePath = path.join(_configuredVideoEngineRoot, "scripts", "lib", "secrets.mjs");
  const {loadSecretsIntoEnv} = await import(secretsModulePath);
  loadSecretsIntoEnv([
    "AGENDADOR_ONLINE_URL",
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD",
    "AGENDADOR_EMAIL",
    "AGENDADOR_USERNAME",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME",
    "AGENDADOR_ONLINE_QUIET2MIN_EMAIL",
    "AGENDADOR_ONLINE_QUIET2MIN_USERNAME",
    "AGENDADOR_ONLINE_ATE2MIN_EMAIL",
    "AGENDADOR_ONLINE_ATE2MIN_USERNAME",
    "FOIUMAIDEIA_URL",
    "FOIUMAIDEIA_USER"
  ]);
};

// ── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch wrapper for the Agendador API.
 * @param {string} endpoint - e.g. "/auth/login"
 * @param {object} [opts]
 * @param {string} [opts.method]
 * @param {string} [opts.token]
 * @param {object} [opts.body] - JSON body
 * @param {FormData} [opts.form] - multipart form (takes precedence over body)
 */
export const agendadorFetch = async (endpoint, {method = "GET", token = "", body, form} = {}) => {
  const response = await fetch(`${AGENDADOR_API_BASE}${endpoint}`, {
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
    const error = new Error(payload?.error || `${method} ${endpoint} falhou com ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
};

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Authenticate with the Agendador and return a bearer token.
 * @param {string} channelValue
 */
export const getAgendadorToken = async (channelValue) => {
  await ensureAgendadorSecrets();
  const profile = resolveAgendadorChannelProfile(channelValue);

  if (!profile.identifier || !profile.password) {
    throw new Error(`Faltam credenciais do agendador para ${profile.label}.`);
  }

  const auth = await agendadorFetch("/auth/login", {
    method: "POST",
    body: {
      identifier: profile.identifier,
      email: profile.identifier,
      password: profile.password
    }
  });
  const token = auth?.token;

  if (!token) {
    throw new Error("A autenticacao do agendador nao devolveu token.");
  }

  return token;
};

// ── Upload helpers ───────────────────────────────────────────────────────────

/**
 * Ensure a video file is within the upload size limit, compressing if needed.
 * @param {string} inputPath
 */
export const ensureUploadableForAgendador = async (inputPath) => {
  const maxBytes = AGENDADOR_MAX_UPLOAD_MB * 1024 * 1024;
  const current = await stat(inputPath);

  if (current.size <= maxBytes) {
    return {
      filePath: inputPath,
      compressed: false,
      size: current.size
    };
  }

  await _ensureManagedDir(_videoLibraryDir);
  const outputPath = path.join(_videoLibraryDir, `compressed-${path.basename(inputPath)}`);
  const desiredOutputOwner = await _getDesiredOwnerForPath(outputPath);
  const attempts = [
    {videoBitrate: "1000k", audioBitrate: "96k"},
    {videoBitrate: "800k", audioBitrate: "80k"},
    {videoBitrate: "650k", audioBitrate: "64k"}
  ];

  for (const attempt of attempts) {
    await unlink(outputPath).catch(() => {}); /* best-effort cleanup: file may not exist */

    await _runFfmpeg([
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
    await _syncPathOwnership(outputPath, desiredOutputOwner);
    await _syncPathMode(outputPath, 0o644);

    const compressed = await stat(outputPath);
    if (compressed.size <= maxBytes) {
      return {
        filePath: outputPath,
        compressed: true,
        size: compressed.size
      };
    }
  }

  throw new Error(`Nao consegui comprimir o video abaixo de ${AGENDADOR_MAX_UPLOAD_MB} MB para publicar.`);
};

/**
 * Upload a file to the Agendador, compressing if needed.
 * @param {string} token
 * @param {string} filePath
 * @param {string} mimeType
 */
const uploadMediaToAgendador = async (token, filePath, mimeType) => {
  const prepared = await ensureUploadableForAgendador(filePath);
  const buffer = await readFile(prepared.filePath);
  const form = new FormData();
  form.set("file", new Blob([buffer], {type: mimeType}), path.basename(prepared.filePath));
  const payload = await agendadorFetch("/upload", {
    method: "POST",
    token,
    form
  });
  return payload?.url || "";
};

/**
 * Upload a video MP4 to the Agendador.
 * @param {string} token
 * @param {string} filePath
 */
export const uploadVideoToAgendador = async (token, filePath) =>
  uploadMediaToAgendador(token, filePath, "video/mp4");

/**
 * Resolve MIME type for a thumbnail image.
 * @param {string} filePath
 */
export const getThumbnailMimeType = (filePath) => {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/jpeg";
};

/**
 * Upload a thumbnail image to the Agendador.
 * @param {string} token
 * @param {string} filePath
 */
export const uploadThumbnailToAgendador = async (token, filePath) => {
  if (!existsSync(filePath)) {
    return "";
  }
  return uploadMediaToAgendador(token, filePath, getThumbnailMimeType(filePath));
};

// ── Account status helpers ───────────────────────────────────────────────────

/**
 * Check if a social account object is ready to publish.
 * @param {object} account
 */
export const isAccountPublishReady = (account) => {
  if (!account?.connected) {
    return false;
  }
  if (account?.publish_ready === false) {
    return false;
  }
  const status = String(account?.status || "").trim().toUpperCase();
  return !["NEEDS_RECONNECT", "RECONNECT", "DISCONNECTED", "FAILED"].includes(status);
};

/**
 * Describe why a social account is not ready to publish.
 * @param {object} account
 * @param {string} provider
 */
export const describeAccountPublishIssue = (account, provider) => {
  if (!account) {
    return `${provider} sem vinculo no agendador`;
  }
  if (!account.connected) {
    return `${provider} nao esta conectada`;
  }
  if (account.publish_ready === false) {
    return account.last_refresh_error || `${provider} nao esta pronta para publicar`;
  }
  const status = String(account.status || "").trim();
  if (status && !["CONNECTED", "READY", "PUBLISH_READY"].includes(status.toUpperCase())) {
    return account.last_refresh_error || `${provider} com status ${status}`;
  }
  return `${provider} nao esta pronta para publicar`;
};
