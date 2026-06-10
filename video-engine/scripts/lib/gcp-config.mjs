import {existsSync} from "node:fs";
import {GoogleAuth} from "google-auth-library";

/**
 * Check if an environment variable value is non-empty after trimming.
 * @param {string|undefined} value
 * @returns {boolean}
 */
export const hasEnvValue = (value) => String(value ?? "").trim().length > 0;

/**
 * @typedef {object} GcpConfig
 * @property {string} projectId - GCP project ID.
 * @property {string} location - Vertex AI location (e.g. "us-central1").
 * @property {string} credentialsPath - Path to service account JSON.
 * @property {string} storyModel - LLM model for storyboard generation.
 * @property {string} visionModel - Model for vision audits.
 * @property {string} imageModel - Default image generation model.
 * @property {string[]} imageModelFallbacks - Ordered fallback image models.
 */

/**
 * Resolve GCP configuration from environment variables.
 * @param {Record<string, string>} [env=process.env]
 * @returns {GcpConfig}
 */
export const resolveGcpConfig = (env = process.env) => {
  const projectId = String(env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || "").trim();
  const location = String(env.GOOGLE_CLOUD_LOCATION || env.VERTEX_AI_LOCATION || "us-central1").trim();
  const credentialsPath = String(env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();

  return {
    projectId,
    location,
    credentialsPath,
    storyModel: String(env.STORY_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash").trim(),
    visionModel: String(env.VISION_MODEL || env.GEMINI_VISION_MODEL || env.GEMINI_MODEL || "gemini-2.5-flash").trim(),
    imageModel: String(env.GOOGLE_IMAGE_MODEL || env.IMAGE_MODEL || "gemini-3.1-flash-image-preview").trim(),
    imageModelFallbacks: String(env.GOOGLE_IMAGE_MODEL_FALLBACKS || env.IMAGE_MODEL_FALLBACKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
};

export const getAiplatformHost = (location) => {
  const normalized = String(location || "").trim().toLowerCase();
  return normalized === "global" ? "aiplatform.googleapis.com" : `${normalized}-aiplatform.googleapis.com`;
};

export const resolveVertexModelLocation = (model, fallbackLocation) => {
  const normalizedModel = String(model || "").trim().toLowerCase();
  if (/^gemini-3(?:\.\d+)?-.*image/.test(normalizedModel) || normalizedModel === "gemini-3-pro-image-preview") {
    return "global";
  }
  return String(fallbackLocation || "us-central1").trim();
};

/**
 * Validate that all required Vertex AI env vars are set.
 * Credentials file is optional — if not set, ADC (Application Default Credentials) is used.
 * @param {Record<string, string>} [env=process.env]
 * @returns {GcpConfig} Validated config.
 * @throws {Error} If required variables are missing or credentials file not found.
 */
export const validateVertexEnv = (env = process.env) => {
  const config = resolveGcpConfig(env);
  const missing = [];

  if (!hasEnvValue(config.projectId)) {
    missing.push("GOOGLE_CLOUD_PROJECT");
  }

  if (!hasEnvValue(config.location)) {
    missing.push("GOOGLE_CLOUD_LOCATION");
  }

  if (missing.length > 0) {
    throw new Error(`Config Vertex incompleta: ${missing.join(", ")}`);
  }

  if (hasEnvValue(config.credentialsPath) && !existsSync(config.credentialsPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS aponta para ficheiro inexistente: ${config.credentialsPath}`);
  }

  return config;
};

let authClientPromise = null;

/**
 * Get (or create) a cached Google Auth client with cloud-platform scope.
 * @returns {Promise<import("google-auth-library").AuthClient>}
 */
export const getGoogleAuthClient = async () => {
  if (!authClientPromise) {
    const config = validateVertexEnv(process.env);
    const authOpts = {
      scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/generative-language"],
      projectId: config.projectId
    };
    if (hasEnvValue(config.credentialsPath)) {
      authOpts.keyFilename = config.credentialsPath;
    }
    const auth = new GoogleAuth(authOpts);
    authClientPromise = auth.getClient();
  }

  return authClientPromise;
};

/**
 * Get a fresh OAuth2 Bearer access token for GCP API calls.
 * @returns {Promise<string>}
 * @throws {Error} If token retrieval fails.
 */
export const getGcpAccessToken = async () => {
  const client = await getGoogleAuthClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;

  if (!hasEnvValue(token)) {
    throw new Error("Nao consegui obter access token do Google Cloud via ADC.");
  }

  return token;
};
