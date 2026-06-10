// Pure utility functions extracted from server.mjs

import {chmod, chown, copyFile, mkdir, readFile, readdir, stat, unlink, writeFile} from "node:fs/promises";
import path from "node:path";

/**
 * Parse a .env file into a key-value object.
 * @param {string} envPath - Absolute path to the .env file.
 * @returns {Promise<Record<string, string>>} Parsed environment variables.
 */
export const parseEnvFile = async (envPath) => {
  let content;
  try {
    content = await readFile(envPath, "utf8");
  } catch {
    return {};
  }

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

/**
 * Resolve a path relative to a base directory, or return it as-is if absolute.
 * @param {string} baseDir - Base directory for relative resolution.
 * @param {string} value - Path value to resolve.
 * @param {string} [fallback=""] - Fallback if value is empty.
 * @returns {string} Resolved absolute path, or empty string.
 */
export const resolvePathFrom = (baseDir, value, fallback = "") => {
  const raw = String(value || fallback || "").trim();

  if (!raw) {
    return "";
  }

  return path.isAbsolute(raw) ? raw : path.resolve(baseDir, raw);
};

/**
 * Convert a string to a URL-safe slug (max 60 chars).
 * @param {string} input
 * @returns {string}
 */
export const slugify = (input) =>
  String(input || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/**
 * Extract a title (max 120 chars) from the first non-empty line of text.
 * @param {string} input - Raw text (may contain markdown headings).
 * @returns {string}
 */
export const deriveTitleFromText = (input) => {
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

/**
 * Generate a short unique ID (base36 timestamp + random suffix).
 * @returns {string}
 */
export const createId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Read and parse a JSON file, returning null on any error.
 * @param {string} targetPath
 * @returns {Promise<any|null>}
 */
export const readJsonFile = async (targetPath) => {
  try {
    return JSON.parse(await readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
};

export const PROCESS_UID = typeof process.getuid === "function" ? process.getuid() : null;

/**
 * Get fs.Stats for the target or its parent (used for ownership sync).
 * @param {string} targetPath
 * @returns {Promise<import("node:fs").Stats|null>}
 */
export const getDesiredOwnerForPath = async (targetPath) =>
  (await stat(targetPath).catch(() => null)) || /* expected: path may not exist yet */
  (await stat(path.dirname(targetPath)).catch(() => null)) || /* expected: parent may not exist */
  null;

/**
 * Chown a path to match the given stats (only when running as root).
 * @param {string} targetPath
 * @param {import("node:fs").Stats|null} ownerStats
 * @returns {Promise<void>}
 */
export const syncPathOwnership = async (targetPath, ownerStats) => {
  if (PROCESS_UID !== 0 || !ownerStats) {
    return;
  }

  await chown(targetPath, ownerStats.uid, ownerStats.gid).catch(() => {}); /* best-effort: chown may fail on non-root */
};

/**
 * Set file mode (chmod) if mode is a valid integer.
 * @param {string} targetPath
 * @param {number} mode
 * @returns {Promise<void>}
 */
export const syncPathMode = async (targetPath, mode) => {
  if (!Number.isInteger(mode)) {
    return;
  }

  await chmod(targetPath, mode).catch(() => {}); /* best-effort: chmod may fail on some filesystems */
};

/**
 * Create a directory (recursive) and sync ownership/mode.
 * @param {string} targetPath
 * @param {number} [mode=0o755]
 * @returns {Promise<void>}
 */
export const ensureManagedDir = async (targetPath, mode = 0o755) => {
  const desiredOwner = await getDesiredOwnerForPath(targetPath);
  await mkdir(targetPath, {recursive: true, mode});
  await syncPathOwnership(targetPath, desiredOwner);
  await syncPathMode(targetPath, mode);
};

/**
 * Write a file and sync ownership/mode.
 * @param {string} targetPath
 * @param {string|Buffer} content
 * @param {import("node:fs").WriteFileOptions} [options]
 * @param {number} [mode=0o644]
 * @returns {Promise<void>}
 */
export const writeManagedFile = async (targetPath, content, options = undefined, mode = 0o644) => {
  const desiredOwner = await getDesiredOwnerForPath(targetPath);
  await writeFile(targetPath, content, options);
  await syncPathOwnership(targetPath, desiredOwner);
  await syncPathMode(targetPath, mode);
};

/**
 * Copy a file and sync ownership/mode on the destination.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {number} [mode=0o644]
 * @returns {Promise<void>}
 */
export const copyManagedFile = async (sourcePath, targetPath, mode = 0o644) => {
  const desiredOwner = await getDesiredOwnerForPath(targetPath);
  await copyFile(sourcePath, targetPath);
  await syncPathOwnership(targetPath, desiredOwner);
  await syncPathMode(targetPath, mode);
};

/**
 * Recursively sync ownership and mode for a directory tree.
 * @param {string} rootPath
 * @param {object} [options]
 * @param {number} [options.dirMode=0o755]
 * @param {number} [options.fileMode=0o644]
 * @param {number} [options.maxDepth=2]
 * @returns {Promise<void>}
 */
export const normalizeManagedTree = async (rootPath, {dirMode = 0o755, fileMode = 0o644, maxDepth = 2} = {}) => {
  const desiredOwner = await getDesiredOwnerForPath(rootPath);

  const walk = async (targetPath, depth) => {
    const details = await stat(targetPath).catch(() => null); /* expected: path may have been removed */
    if (!details) {
      return;
    }

    await syncPathOwnership(targetPath, desiredOwner);
    await syncPathMode(targetPath, details.isDirectory() ? dirMode : fileMode);

    if (!details.isDirectory() || depth >= maxDepth) {
      return;
    }

    const entries = await readdir(targetPath).catch(() => []); /* expected: dir may have been removed */
    await Promise.all(entries.map((entry) => walk(path.join(targetPath, entry), depth + 1)));
  };

  await walk(rootPath, 0);
};

/**
 * Write an object as pretty-printed JSON with managed ownership/mode.
 * @param {string} targetPath
 * @param {any} payload
 * @returns {Promise<void>}
 */
export const writeJsonFile = async (targetPath, payload) => {
  await writeManagedFile(targetPath, JSON.stringify(payload, null, 2));
};

/**
 * Check if a file or directory exists.
 * @param {string} targetPath
 * @returns {Promise<boolean>}
 */
export const fileExists = async (targetPath) => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Build an API URL for serving a local file.
 * @param {string} targetPath
 * @param {string|number|null} [version]
 * @returns {string} URL path like `/api/file?path=...`
 */
export const createFileUrl = (targetPath, version = null) => {
  const absolutePath = path.resolve(String(targetPath || ""));
  const versionSuffix = version === null || version === undefined || version === ""
    ? ""
    : `&v=${encodeURIComponent(String(version))}`;
  return `/api/file?path=${encodeURIComponent(absolutePath)}${versionSuffix}`;
};

/**
 * Read a file as UTF-8 text, returning empty string on error.
 * @param {string} targetPath
 * @returns {Promise<string>}
 */
export const readTextFile = async (targetPath) => {
  try {
    return await readFile(targetPath, "utf8");
  } catch {
    return "";
  }
};

/**
 * Delete a file, silently ignoring errors.
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
export const safeUnlink = async (targetPath) => {
  try {
    await unlink(targetPath);
  } catch {}
};

/**
 * Encode a file path as a base64url video ID.
 * @param {string} filePath
 * @returns {string}
 */
export const toVideoId = (filePath) => Buffer.from(String(filePath || ""), "utf8").toString("base64url");

/**
 * Decode a base64url video ID back to a file path.
 * @param {string} value
 * @returns {string}
 */
export const fromVideoId = (value) => {
  try {
    return Buffer.from(String(value || ""), "base64url").toString("utf8");
  } catch {
    return "";
  }
};

/**
 * Round a value to millisecond precision.
 * @param {number} value
 * @returns {number}
 */
export const roundSeconds = (value) => Math.round(Number(value || 0) * 1000) / 1000;

/**
 * Count whitespace-separated words in a string.
 * @param {string} text
 * @returns {number}
 */
export const countWords = (text) =>
  String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/**
 * Escape HTML special characters.
 * @param {string} value
 * @returns {string}
 */
export const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * Get the current time as an ISO 8601 string.
 * @returns {string}
 */
export const toIsoNow = () => new Date().toISOString();

/**
 * Parse a date string to Unix milliseconds, or null if invalid.
 * @param {string} value
 * @returns {number|null}
 */
export const toTimestampMs = (value) => {
  const ms = Date.parse(String(value || "").trim());
  return Number.isFinite(ms) ? ms : null;
};

/**
 * Parse a value as a positive integer, or null if invalid.
 * @param {string|number} value
 * @returns {number|null}
 */
export const normalizePositiveInt = (value) => {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
