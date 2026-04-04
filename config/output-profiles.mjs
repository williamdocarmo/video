export const OUTPUT_PROFILES = {
  "vertical-short": {
    id: "vertical-short",
    label: "Vertical curto",
    description: "Formato 9:16 para shorts, reels e TikTok.",
    layout: "vertical",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    compositionId: "CodexShort",
    defaultTargetSeconds: 100,
    durations: [60, 90, 100, 150],
    minScenes: 14,
    maxScenes: 18
  },
  "horizontal-5m": {
    id: "horizontal-5m",
    label: "Horizontal 5 minutos",
    description: "Formato 16:9 para vídeos horizontais de aproximadamente 5 minutos.",
    layout: "horizontal",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    compositionId: "CodexWide",
    defaultTargetSeconds: 300,
    durations: [300],
    minScenes: 20,
    maxScenes: 30
  },
  "horizontal-10m": {
    id: "horizontal-10m",
    label: "Horizontal 10 minutos",
    description: "Formato 16:9 para vídeos horizontais de aproximadamente 10 minutos.",
    layout: "horizontal",
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    compositionId: "CodexWide",
    defaultTargetSeconds: 600,
    durations: [600],
    minScenes: 30,
    maxScenes: 42
  }
};

export const DEFAULT_OUTPUT_PROFILE = "vertical-short";

export const resolveOutputProfileConfig = (value) => {
  const normalized = String(value || DEFAULT_OUTPUT_PROFILE).trim().toLowerCase();
  return OUTPUT_PROFILES[normalized] || OUTPUT_PROFILES[DEFAULT_OUTPUT_PROFILE];
};

export const listOutputProfileOptions = () =>
  Object.values(OUTPUT_PROFILES).map((profile) => ({
    value: profile.id,
    label: profile.label,
    description: profile.description,
    layout: profile.layout,
    aspectRatio: profile.aspectRatio,
    width: profile.width,
    height: profile.height,
    defaultTargetSeconds: profile.defaultTargetSeconds,
    durations: profile.durations,
    compositionId: profile.compositionId
  }));

export const getDurationOptionsForProfile = (profileValue) => resolveOutputProfileConfig(profileValue).durations;

export const inferOutputProfileFromDimensions = (width, height) => {
  const numericWidth = Number(width);
  const numericHeight = Number(height);

  if (numericWidth > numericHeight) {
    return OUTPUT_PROFILES["horizontal-5m"];
  }

  return OUTPUT_PROFILES[DEFAULT_OUTPUT_PROFILE];
};
