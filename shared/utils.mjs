import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {access, readFile} from "node:fs/promises";

export const normalizeText = (value) => {
  return String(value ?? "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const uniqueStrings = (values = []) => {
  const seen = new Set();

  return (Array.isArray(values) ? values : []).filter((value) => {
    const normalized = normalizeText(value).toLowerCase();

    if (!normalized || seen.has(normalized)) {
      return false;
    }

    seen.add(normalized);
    return true;
  });
};

export const slugify = (input) => {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
};

export const extractJsonObject = (input) => {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Nao encontrei JSON valido na resposta do OpenRouter.");
  }

  return input.slice(start, end + 1);
};

export const parseEnvFile = async (envPath) => {
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

/** @param {string} p @returns {Promise<boolean>} */
export async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** @param {string} p @returns {Promise<any|null>} */
export async function loadJsonIfExists(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

/** @param {string} text @returns {number} */
export function countWords(text) {
  return String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

/** @param {string} cmd @param {string[]} args @param {object} [options] @returns {Promise<{code: number, stdout: string, stderr: string}>} */
export function runLoggedCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env ? {...process.env, ...options.env} : undefined,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { const t = d.toString(); stdout += t; process.stdout.write(t); });
    child.stderr?.on('data', (d) => { const t = d.toString(); stderr += t; process.stderr.write(t); });
    child.on('error', reject);
    child.on('close', (code) => resolve({code: code ?? 1, stdout, stderr}));
  });
}