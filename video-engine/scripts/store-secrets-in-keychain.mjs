#!/usr/bin/env node

import "dotenv/config";
import {existsSync} from "node:fs";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {resolveKeychainService, secretKeys, writeSecretsToKeychain} from "./lib/secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");

const parseEnv = (content) => {
  const values = {};

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
    values[key] = value;
  }

  return values;
};

const sanitizeEnvFile = (content, service) => {
  const seen = new Set();
  const lines = content.split(/\r?\n/).map((rawLine) => {
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith("#") || !rawLine.includes("=")) {
      return rawLine;
    }

    const separatorIndex = rawLine.indexOf("=");
    const key = rawLine.slice(0, separatorIndex).trim();

    if (key === "KEYCHAIN_SERVICE") {
      seen.add(key);
      return `KEYCHAIN_SERVICE=${service}`;
    }

    if (secretKeys.includes(key)) {
      seen.add(key);
      return `${key}=`;
    }

    return rawLine;
  });

  if (!seen.has("KEYCHAIN_SERVICE")) {
    lines.push(`KEYCHAIN_SERVICE=${service}`);
  }

  for (const key of secretKeys) {
    if (!seen.has(key)) {
      lines.push(`${key}=`);
    }
  }

  return `${lines.filter((line, index, all) => index < all.length - 1 || line !== "").join("\n")}\n`;
};

const main = async () => {
  const service = resolveKeychainService();
  const envContent = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  const fileValues = parseEnv(envContent);
  const entries = {};

  for (const key of secretKeys) {
    const value = String(process.env[key] || fileValues[key] || "").trim();

    if (value) {
      entries[key] = value;
    }
  }

  if (Object.keys(entries).length === 0) {
    throw new Error("Nao encontrei segredos no ambiente nem no .env para guardar no Keychain.");
  }

  writeSecretsToKeychain(entries, {service});
  await writeFile(envPath, sanitizeEnvFile(envContent, service));

  process.stdout.write(
    `${JSON.stringify(
      {
        service,
        storedKeys: Object.keys(entries),
        envPath
      },
      null,
      2
    )}\n`
  );
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
