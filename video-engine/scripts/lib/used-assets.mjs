import {mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);

export const defaultUsedAssetsPath = path.join(projectRoot, "data", "used-assets.json");

const normalizeUrl = (value) => String(value || "").trim().replace(/\?.*$/, "");

const uniqueNormalized = (values) => {
  const seen = new Set();

  return values
    .map((value) => normalizeUrl(value))
    .filter((value) => {
      if (!value || seen.has(value)) {
        return false;
      }

      seen.add(value);
      return true;
    });
};

const emptyRegistry = () => ({
  envatoItemUrls: [],
  pexelsVideoUrls: []
});

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const readRegistryFile = async (targetPath = defaultUsedAssetsPath) => {
  try {
    const payload = JSON.parse(await readFile(targetPath, "utf8"));
    return {
      envatoItemUrls: uniqueNormalized(payload?.envatoItemUrls ?? []),
      pexelsVideoUrls: uniqueNormalized(payload?.pexelsVideoUrls ?? [])
    };
  } catch {
    return emptyRegistry();
  }
};

const withRegistryLock = async (targetPath, action) => {
  const lockPath = `${targetPath}.lock`;
  const timeoutMs = Number(process.env.USED_ASSETS_LOCK_TIMEOUT_MS || 15000);
  const startedAt = Date.now();

  await mkdir(path.dirname(targetPath), {recursive: true});

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timeout ao obter lock do registro de assets em ${lockPath}`);
      }

      await sleep(100 + Math.floor(Math.random() * 150));
    }
  }

  try {
    return await action();
  } finally {
    await rm(lockPath, {recursive: true, force: true});
  }
};

export const readUsedAssetsRegistry = async (targetPath = defaultUsedAssetsPath) => {
  return readRegistryFile(targetPath);
};

export const writeUsedAssetsRegistry = async (registry, targetPath = defaultUsedAssetsPath) => {
  const safeRegistry = {
    envatoItemUrls: uniqueNormalized(registry?.envatoItemUrls ?? []),
    pexelsVideoUrls: uniqueNormalized(registry?.pexelsVideoUrls ?? [])
  };

  return withRegistryLock(targetPath, async () => {
    const currentRegistry = await readRegistryFile(targetPath);
    const mergedRegistry = mergeUsedAssetsRegistry(currentRegistry, safeRegistry);
    await writeFile(targetPath, `${JSON.stringify(mergedRegistry, null, 2)}\n`);
    return mergedRegistry;
  });
};

export const mergeUsedAssetsRegistry = (baseRegistry, patchRegistry) => {
  return {
    envatoItemUrls: uniqueNormalized([...(baseRegistry?.envatoItemUrls ?? []), ...(patchRegistry?.envatoItemUrls ?? [])]),
    pexelsVideoUrls: uniqueNormalized([...(baseRegistry?.pexelsVideoUrls ?? []), ...(patchRegistry?.pexelsVideoUrls ?? [])])
  };
};
