const PRICING_SOURCE_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const PRICING_SNAPSHOT_DATE = "2026-03-30";

const GEMINI_TEXT_PRICING = [
  {
    match: ["gemini-2.5-flash-lite-preview", "gemini-2.5-flash-lite"],
    inputPerMillionUsd: 0.1,
    outputPerMillionUsd: 0.4
  },
  {
    match: ["gemini-2.5-flash"],
    inputPerMillionUsd: 0.3,
    outputPerMillionUsd: 2.5
  },
  {
    match: ["gemini-2.0-flash-lite"],
    inputPerMillionUsd: 0.075,
    outputPerMillionUsd: 0.3
  },
  {
    match: ["gemini-2.0-flash"],
    inputPerMillionUsd: 0.1,
    outputPerMillionUsd: 0.4
  }
];

const roundMetric = (value, digits = 6) => Number(Number(value || 0).toFixed(digits));

const normalizeModelName = (value) => String(value || "").trim().toLowerCase();

const resolvePricing = (model) => {
  const normalized = normalizeModelName(model);

  if (!normalized) {
    return null;
  }

  return GEMINI_TEXT_PRICING.find((entry) => entry.match.some((prefix) => normalized.startsWith(prefix))) || null;
};

const normalizeUsageMetadata = (usageMetadata) => ({
  promptTokenCount: Math.max(0, Number(usageMetadata?.promptTokenCount ?? 0) || 0),
  candidatesTokenCount: Math.max(0, Number(usageMetadata?.candidatesTokenCount ?? 0) || 0),
  totalTokenCount: Math.max(0, Number(usageMetadata?.totalTokenCount ?? 0) || 0),
  thoughtsTokenCount: Math.max(0, Number(usageMetadata?.thoughtsTokenCount ?? 0) || 0)
});

const createCounterBucket = () => ({
  requestCount: 0,
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  totalTokenCount: 0,
  thoughtsTokenCount: 0,
  estimatedCostUsd: 0
});

export const createGeminiUsageSummary = () => ({
  provider: "gemini",
  pricingSource: PRICING_SOURCE_URL,
  pricingSnapshotDate: PRICING_SNAPSHOT_DATE,
  requestCount: 0,
  promptTokenCount: 0,
  candidatesTokenCount: 0,
  totalTokenCount: 0,
  thoughtsTokenCount: 0,
  estimatedCostUsd: 0,
  models: {},
  contexts: {}
});

export const estimateGeminiTextCostUsd = ({model, usageMetadata}) => {
  const pricing = resolvePricing(model);

  if (!pricing) {
    return null;
  }

  const normalizedUsage = normalizeUsageMetadata(usageMetadata);
  const inputCost = (normalizedUsage.promptTokenCount / 1_000_000) * pricing.inputPerMillionUsd;
  const outputCost = (normalizedUsage.candidatesTokenCount / 1_000_000) * pricing.outputPerMillionUsd;

  return roundMetric(inputCost + outputCost, 8);
};

export const recordGeminiUsage = (summary, {model, usageMetadata, context = "unspecified"} = {}) => {
  if (!summary || !usageMetadata) {
    return summary;
  }

  const normalizedUsage = normalizeUsageMetadata(usageMetadata);
  const hasAnyUsage =
    normalizedUsage.promptTokenCount > 0 ||
    normalizedUsage.candidatesTokenCount > 0 ||
    normalizedUsage.totalTokenCount > 0 ||
    normalizedUsage.thoughtsTokenCount > 0;

  if (!hasAnyUsage) {
    return summary;
  }

  const normalizedModel = normalizeModelName(model) || "unknown";
  const normalizedContext = String(context || "unspecified").trim() || "unspecified";
  const estimatedCostUsd = estimateGeminiTextCostUsd({model: normalizedModel, usageMetadata: normalizedUsage}) ?? 0;

  summary.requestCount += 1;
  summary.promptTokenCount += normalizedUsage.promptTokenCount;
  summary.candidatesTokenCount += normalizedUsage.candidatesTokenCount;
  summary.totalTokenCount += normalizedUsage.totalTokenCount;
  summary.thoughtsTokenCount += normalizedUsage.thoughtsTokenCount;
  summary.estimatedCostUsd += estimatedCostUsd;

  if (!summary.models[normalizedModel]) {
    summary.models[normalizedModel] = createCounterBucket();
  }

  if (!summary.contexts[normalizedContext]) {
    summary.contexts[normalizedContext] = createCounterBucket();
  }

  const modelBucket = summary.models[normalizedModel];
  const contextBucket = summary.contexts[normalizedContext];

  for (const bucket of [modelBucket, contextBucket]) {
    bucket.requestCount += 1;
    bucket.promptTokenCount += normalizedUsage.promptTokenCount;
    bucket.candidatesTokenCount += normalizedUsage.candidatesTokenCount;
    bucket.totalTokenCount += normalizedUsage.totalTokenCount;
    bucket.thoughtsTokenCount += normalizedUsage.thoughtsTokenCount;
    bucket.estimatedCostUsd += estimatedCostUsd;
  }

  summary.estimatedCostUsd = roundMetric(summary.estimatedCostUsd, 8);
  modelBucket.estimatedCostUsd = roundMetric(modelBucket.estimatedCostUsd, 8);
  contextBucket.estimatedCostUsd = roundMetric(contextBucket.estimatedCostUsd, 8);

  return summary;
};
