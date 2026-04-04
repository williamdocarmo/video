import {spawnSync} from "node:child_process";

const secretPlaceholders = new Set(["__KEYCHAIN__", "KEYCHAIN", "<KEYCHAIN>", "<FROM_KEYCHAIN>"]);

export const secretKeys = [
  "OPENROUTER_API_KEY",
  "ELEVENLABS_API_KEY",
  "GOOGLE_API_KEY",
  "AZURE_SPEECH_KEY",
  "PEXELS_API_KEY",
  "ENVATO_EMAIL",
  "ENVATO_PASSWORD",
  "AGENDADOR_EMAIL",
  "AGENDADOR_PASSWORD"
];

export const resolveKeychainService = () =>
  String(process.env.KEYCHAIN_SERVICE || process.env.VIDEOS_ENVATO_KEYCHAIN_SERVICE || "video-engine").trim();

export const hasUsableSecretValue = (value) => {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return false;
  }

  return !secretPlaceholders.has(normalized.toUpperCase());
};

const runSecurity = (args) => {
  const result = spawnSync("security", args, {
    encoding: "utf8",
    stdio: "pipe"
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? ""
  };
};

export const readSecretFromKeychain = (key, {service = resolveKeychainService()} = {}) => {
  const result = runSecurity(["find-generic-password", "-a", key, "-s", service, "-w"]);
  return result.status === 0 ? result.stdout : "";
};

export const loadSecretsIntoEnv = (keys, {service = resolveKeychainService()} = {}) => {
  for (const key of keys) {
    if (hasUsableSecretValue(process.env[key])) {
      continue;
    }

    const value = readSecretFromKeychain(key, {service});

    if (value) {
      process.env[key] = value;
    }
  }
};

export const writeSecretsToKeychain = (entries, {service = resolveKeychainService()} = {}) => {
  for (const [key, value] of Object.entries(entries)) {
    if (!hasUsableSecretValue(value)) {
      continue;
    }

    const result = runSecurity(["add-generic-password", "-U", "-a", key, "-s", service, "-w", String(value)]);

    if (result.status !== 0) {
      throw new Error(result.stderr || `Nao consegui guardar ${key} no Keychain.`);
    }
  }
};
