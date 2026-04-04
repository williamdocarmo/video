import {readdir, rm} from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(new URL("../..", import.meta.url).pathname);
const tmpRoot = path.join(projectRoot, "tmp");
const envatoAssetsRoot = path.join(projectRoot, "assets", "envato");

const safeEntries = async (dirPath) => {
  try {
    return await readdir(dirPath, {withFileTypes: true});
  } catch {
    return [];
  }
};

export const cleanupStaleEnvatoChromeProfiles = async ({preserveNames = []} = {}) => {
  const protectedNames = new Set(preserveNames.filter(Boolean));
  const entries = await safeEntries(tmpRoot);
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (!entry.name.startsWith("envato-chrome-user-data-")) {
      continue;
    }

    if (protectedNames.has(entry.name)) {
      continue;
    }

    try {
      await rm(path.join(tmpRoot, entry.name), {recursive: true, force: true});
      removed += 1;
    } catch {
      // Ignore active/busy Chrome profiles. They will be retried later.
    }
  }

  return removed;
};

export const cleanupEnvatoAssetDirs = async ({preserveSlugs = []} = {}) => {
  const protectedSlugs = new Set(preserveSlugs.filter(Boolean));
  const entries = await safeEntries(envatoAssetsRoot);
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (protectedSlugs.has(entry.name)) {
      continue;
    }

    try {
      await rm(path.join(envatoAssetsRoot, entry.name), {recursive: true, force: true});
      removed += 1;
    } catch {
      // Ignore directories that are still in use by an active render.
    }
  }

  return removed;
};

export const cleanupEnvatoArtifactsForSlug = async (slug) => {
  if (!slug) {
    return;
  }

  await rm(path.join(envatoAssetsRoot, slug), {recursive: true, force: true});
};
