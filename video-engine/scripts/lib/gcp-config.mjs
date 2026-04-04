import {existsSync} from "node:fs";
import {GoogleAuth} from "google-auth-library";

export const hasEnvValue = (value) => String(value ?? "").trim().length > 0;

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
    imageModel: String(env.GOOGLE_IMAGE_MODEL || env.IMAGE_MODEL || "gemini-2.5-flash-image").trim(),
    imageModelFallbacks: String(env.GOOGLE_IMAGE_MODEL_FALLBACKS || env.IMAGE_MODEL_FALLBACKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };
};

export const validateVertexEnv = (env = process.env) => {
  const config = resolveGcpConfig(env);
  const missing = [];

  if (!hasEnvValue(config.projectId)) {
    missing.push("GOOGLE_CLOUD_PROJECT");
  }

  if (!hasEnvValue(config.location)) {
    missing.push("GOOGLE_CLOUD_LOCATION");
  }

  if (!hasEnvValue(config.credentialsPath)) {
    missing.push("GOOGLE_APPLICATION_CREDENTIALS");
  }

  if (missing.length > 0) {
    throw new Error(`Config Vertex incompleta: ${missing.join(", ")}`);
  }

  if (!existsSync(config.credentialsPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS aponta para ficheiro inexistente: ${config.credentialsPath}`);
  }

  return config;
};

let authClientPromise = null;

export const getGoogleAuthClient = async () => {
  if (!authClientPromise) {
    const config = validateVertexEnv(process.env);
    const auth = new GoogleAuth({
      keyFilename: config.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
    });
    authClientPromise = auth.getClient();
  }

  return authClientPromise;
};

export const getGcpAccessToken = async () => {
  const client = await getGoogleAuthClient();
  const accessToken = await client.getAccessToken();
  const token = typeof accessToken === "string" ? accessToken : accessToken?.token;

  if (!hasEnvValue(token)) {
    throw new Error("Nao consegui obter access token do Google Cloud via ADC.");
  }

  return token;
};
