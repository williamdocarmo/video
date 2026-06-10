import {normalizeText} from "../../../shared/utils.mjs";
import {getAiplatformHost, getGcpAccessToken, resolveGcpConfig, resolveVertexModelLocation} from "./gcp-config.mjs";

const supportsThinkingBudgetZero = (model = "") => !/gemini-2\.5-pro/i.test(String(model || "").trim());

const withThinkingDisabled = (config = {}, model = "") =>
  supportsThinkingBudgetZero(model)
    ? {
        ...config,
        thinkingConfig: {
          thinkingBudget: 0
        }
      }
    : {...config};

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
  systemInstruction,
  generationConfig
}) => {
  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const endpoint =
    `https://${getAiplatformHost(config.location)}/v1/projects/${config.projectId}` +
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

  if (systemInstruction) {
    body.systemInstruction = {parts: [{text: systemInstruction}]};
  }

  if (generationConfig && Object.keys(generationConfig).length > 0) {
    body.generationConfig = withThinkingDisabled(generationConfig, model);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({})); /* expected: response body may not be valid JSON */

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
  if (String(model || "").trim().startsWith("imagen-")) {
    const config = resolveGcpConfig(process.env);
    const accessToken = await getGcpAccessToken();
    const endpoint =
      `https://${getAiplatformHost(config.location)}/v1/projects/${config.projectId}` +
      `/locations/${config.location}/publishers/google/models/${model}:predict`;

    const body = {
      instances: [
        {
          prompt: normalizeText(prompt)
        }
      ],
      parameters: {
        sampleCount: Math.max(1, Number(numberOfImages) || 1),
        aspectRatio,
        sampleImageSize: "2K",
        personGeneration: "allow_all",
        safetySetting: "block_medium_and_above",
        enhancePrompt: false,
        addWatermark: false,
        outputOptions: {
          mimeType: "image/png"
        }
      }
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({})); /* expected: response body may not be valid JSON */

    if (!response.ok) {
      const details = normalizeText(JSON.stringify(payload));
      throw new Error(`Vertex image predict failed (${response.status}): ${details.slice(0, 300)}`);
    }

    const prediction = Array.isArray(payload?.predictions) ? payload.predictions[0] : null;
    const mimeType = String(prediction?.mimeType || "image/png").trim().toLowerCase();
    const data = String(prediction?.bytesBase64Encoded || "").trim();

    if (!data) {
      throw new Error("Vertex image response did not include image bytes.");
    }

    return {
      payload,
      mimeType,
      bytes: Buffer.from(data, "base64")
    };
  }

  const config = resolveGcpConfig(process.env);
  const accessToken = await getGcpAccessToken();
  const modelLocation = resolveVertexModelLocation(model, config.location);
  const endpoint =
    `https://${getAiplatformHost(modelLocation)}/v1/projects/${config.projectId}` +
    `/locations/${modelLocation}/publishers/google/models/${model}:generateContent`;

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
    }, model)
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

  const payload = await response.json().catch(() => ({})); /* expected: response body may not be valid JSON */

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
