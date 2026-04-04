import {getGcpAccessToken, resolveGcpConfig} from "./gcp-config.mjs";

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const withThinkingDisabled = (config = {}) => ({
  ...config,
  thinkingConfig: {
    thinkingBudget: 0
  }
});

const extractVertexText = (payload) =>
  normalizeText(
    payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join(" ")
  );

const extractFirstInlineImage = (payload) => {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }

  for (const part of parts) {
    const mimeType = String(part?.inlineData?.mimeType || "").trim().toLowerCase();
    const data = String(part?.inlineData?.data || "").trim();
    if (data && mimeType.startsWith("image/")) {
      return {mimeType, data};
    }
  }

  return null;
};

export const callVertexMultimodalText = async ({
  model,
  textParts = [],
  inlineDataParts = [],
  generationConfig
}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}` +
    `/locations/${config.location}/publishers/google/models/${model}:generateContent`;

  const parts = [
    ...inlineDataParts.map((part) => ({
      inlineData: {
        mimeType: part.mimeType,
        data: part.data
      }
    })),
    ...textParts
      .map((text) => normalizeText(text))
      .filter(Boolean)
      .map((text) => ({text}))
  ];

  const body = {
    contents: [{role: "user", parts}]
  };

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    body.generationConfig = withThinkingDisabled(generationConfig);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const details = normalizeText(JSON.stringify(payload));
    throw new Error(`Vertex generateContent failed (${response.status}): ${details.slice(0, 300)}`);
  }

  return {
    payload,
    text: extractVertexText(payload)
  };
};

export const generateVertexImage = async ({
  model,
  prompt,
  aspectRatio = "9:16",
  numberOfImages = 1
}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${config.location}-aiplatform.googleapis.com/v1/projects/${config.projectId}` +
    `/locations/${config.location}/publishers/google/models/${model}:generateContent`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{text: normalizeText(prompt)}]
      }
    ],
    generationConfig: withThinkingDisabled({
      responseModalities: ["TEXT", "IMAGE"],
      candidateCount: Math.max(1, Number(numberOfImages) || 1)
    })
  };

  if (aspectRatio) {
    body.generationConfig.imageConfig = {aspectRatio};
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const details = normalizeText(JSON.stringify(payload));
    throw new Error(`Vertex image generateContent failed (${response.status}): ${details.slice(0, 300)}`);
  }

  const image = extractFirstInlineImage(payload);
  if (!image?.data) {
    throw new Error("Vertex image response did not include inline image data.");
  }

  return {
    payload,
    mimeType: image.mimeType,
    bytes: Buffer.from(image.data, "base64")
  };
};
