/**
 * @typedef {object} OutputProfile
 * @property {string} id - Profile key (e.g. "vertical-short").
 * @property {string} label - Human-readable name.
 * @property {string} description - Short description.
 * @property {"vertical"|"horizontal"} layout
 * @property {string} aspectRatio - e.g. "9:16", "16:9".
 * @property {number} width - Render width in pixels.
 * @property {number} height - Render height in pixels.
 * @property {string} compositionId - Remotion composition ID.
 * @property {number} defaultTargetSeconds - Default video duration.
 * @property {number[]} durations - Allowed duration options in seconds.
 * @property {number} minScenes
 * @property {number} maxScenes
 */

/** @type {Record<string, OutputProfile>} */
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

/**
 * Resolve an output profile by ID, falling back to the default.
 * @param {string} value - Profile ID.
 * @returns {OutputProfile}
 */
export const resolveOutputProfileConfig = (value) => {
  const normalized = String(value || DEFAULT_OUTPUT_PROFILE).trim().toLowerCase();
  return OUTPUT_PROFILES[normalized] || OUTPUT_PROFILES[DEFAULT_OUTPUT_PROFILE];
};

/**
 * List all profiles as UI-friendly option objects.
 * @returns {{value: string, label: string, description: string, layout: string, aspectRatio: string, width: number, height: number, defaultTargetSeconds: number, durations: number[], compositionId: string}[]}
 */
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

/**
 * Get allowed duration options (in seconds) for a given profile.
 * @param {string} profileValue - Profile ID.
 * @returns {number[]}
 */
export const getDurationOptionsForProfile = (profileValue) => resolveOutputProfileConfig(profileValue).durations;

/**
 * Resolve the recommended storyboard scene range for a profile and duration.
 * Vertical short-form videos get a tighter range based on the target runtime.
 * Horizontal profiles keep their profile-level defaults.
 * @param {string} profileValue
 * @param {number} targetSeconds
 * @returns {{minScenes: number, maxScenes: number}}
 */
export const getSceneCountRangeForDuration = (profileValue, targetSeconds) => {
  const profile = resolveOutputProfileConfig(profileValue);
  const seconds = Number(targetSeconds);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return {
      minScenes: profile.minScenes,
      maxScenes: profile.maxScenes
    };
  }

  if (profile.layout === "horizontal") {
    return {
      minScenes: profile.minScenes,
      maxScenes: profile.maxScenes
    };
  }

  // TikTok-locked format for short videos (50-60s sweet spot, ≤65s penalty cliff):
  // 9-11 scenes with 2-3 shots each. Total 24-30 images for visual variety.
  if (seconds <= 65) {
    return {minScenes: 9, maxScenes: 11};
  }

  if (seconds <= 85) {
    return {minScenes: 8, maxScenes: 10};
  }

  if (seconds <= 115) {
    return {minScenes: 10, maxScenes: 12};
  }

  if (seconds <= 155) {
    return {minScenes: 12, maxScenes: 14};
  }

  return {
    minScenes: profile.minScenes,
    maxScenes: profile.maxScenes
  };
};

/**
 * Get a single recommended scene count for a duration.
 * @param {string} profileValue
 * @param {number} targetSeconds
 * @returns {number}
 */
export const getRecommendedSceneCountForDuration = (profileValue, targetSeconds) => {
  const {minScenes, maxScenes} = getSceneCountRangeForDuration(profileValue, targetSeconds);
  return Math.max(1, Math.round((minScenes + maxScenes) / 2));
};

/**
 * Infer the best output profile from pixel dimensions.
 * @param {number} width
 * @param {number} height
 * @returns {OutputProfile}
 */
export const inferOutputProfileFromDimensions = (width, height) => {
  const numericWidth = Number(width);
  const numericHeight = Number(height);

  if (numericWidth > numericHeight) {
    return OUTPUT_PROFILES["horizontal-5m"];
  }

  return OUTPUT_PROFILES[DEFAULT_OUTPUT_PROFILE];
};
