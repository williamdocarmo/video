const PT_CONNECTORS = [
  "Ao mesmo tempo,",
  "Agora,",
  "Só que,",
  "Na prática,",
  "E é aqui que,",
  "E, no meio disso tudo,",
  "Mas olha só,",
  "E não para por aí,",
  "O mais interessante é que,",
  "E sabe o que mais?",
  "O problema é que,",
  "E o mais louco é que,",
  "Mas calma,",
  "E tem mais,",
  "Por outro lado,"
];

const EN_CONNECTORS = [
  "Meanwhile,",
  "Now,",
  "But,",
  "In practice,",
  "And this is where,",
  "And in the middle of all this,",
  "But look,",
  "And it does not stop there,",
  "The most interesting part is that,",
  "And you know what else?",
  "The problem is that,",
  "And the wildest part is that,",
  "But wait,",
  "There is more,",
  "On the other hand,"
];

export const connectors = PT_CONNECTORS;

const connectorAliases = [
  {alias: "É aqui que,", canonical: "E é aqui que,"},
  {alias: "É aqui que", canonical: "E é aqui que,"},
  {alias: "O mais louco é que,", canonical: "E o mais louco é que,"},
  {alias: "O mais louco é que", canonical: "E o mais louco é que,"},
  {alias: "This is where,", canonical: "And this is where,"},
  {alias: "This is where", canonical: "And this is where,"},
  {alias: "The wildest part is that,", canonical: "And the wildest part is that,"},
  {alias: "The wildest part is that", canonical: "And the wildest part is that,"}
];

const connectorSets = {
  pt: PT_CONNECTORS,
  "pt-br": PT_CONNECTORS,
  en: EN_CONNECTORS,
  "en-us": EN_CONNECTORS,
  "en-gb": EN_CONNECTORS
};

export const getConnectorsForLanguage = (language = "pt-BR") => {
  const normalized = String(language || "pt-BR").trim().toLowerCase();

  if (normalized.startsWith("en")) {
    return EN_CONNECTORS;
  }

  return connectorSets[normalized] || PT_CONNECTORS;
};

const getCandidateConnectors = (language) => {
  if (language) {
    return getConnectorsForLanguage(language);
  }

  return [...new Set([...PT_CONNECTORS, ...EN_CONNECTORS])];
};

export const normalizeForMatch = (value) => {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,:;!?]/g, "")
    .trim();
};

export const detectConnector = (text, language) => {
  const normalized = normalizeForMatch(text);
  const candidates = getCandidateConnectors(language);

  const directMatch = candidates.find((connector) => normalized.startsWith(normalizeForMatch(connector)));

  if (directMatch) {
    return directMatch;
  }

  const aliasMatch = connectorAliases.find(({alias}) => normalized.startsWith(normalizeForMatch(alias)));
  return aliasMatch?.canonical || null;
};

export const hasConnector = (text, language) => {
  return Boolean(detectConnector(text, language));
};

const decapitalizeNarration = (text, language) => {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    return "";
  }

  if (/^\p{Lu}(?=(?:\p{Ll}|\s))/u.test(trimmed)) {
    const locale = String(language || "").trim().toLowerCase().startsWith("en") ? "en-US" : "pt-BR";
    return `${trimmed.slice(0, 1).toLocaleLowerCase(locale)}${trimmed.slice(1)}`;
  }

  return trimmed;
};

const pickConnector = ({index, previousConnector, usedConnectors, language}) => {
  const activeConnectors = getConnectorsForLanguage(language);
  const previousNormalized = previousConnector ? normalizeForMatch(previousConnector) : "";
  const preferredStart = Math.max(0, (index - 1) % activeConnectors.length);

  for (let offset = 0; offset < activeConnectors.length; offset += 1) {
    const connector = activeConnectors[(preferredStart + offset) % activeConnectors.length];
    const normalized = normalizeForMatch(connector);

    if (normalized !== previousNormalized && !usedConnectors.has(normalized)) {
      return connector;
    }
  }

  for (const connector of activeConnectors) {
    if (normalizeForMatch(connector) !== previousNormalized) {
      return connector;
    }
  }

  return activeConnectors[0];
};

const applyConnector = (text, connector, language) => {
  const narration = decapitalizeNarration(text, language);

  if (!narration) {
    return connector;
  }

  return `${connector} ${narration}`.replace(/\s+/g, " ").trim();
};

export const connectScenes = (scenes, options = {}) => {
  const language = options.language || "pt-BR";

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return Array.isArray(scenes) ? scenes : [];
  }

  const usedConnectors = new Set();
  let previousConnector = null;

  return scenes.map((scene, index) => {
    if (!scene || index === 0) {
      return scene;
    }

    const existingConnector = detectConnector(scene.narration, language);

    if (existingConnector) {
      usedConnectors.add(normalizeForMatch(existingConnector));
      previousConnector = existingConnector;
      return scene;
    }

    const connector = pickConnector({index, previousConnector, usedConnectors, language});
    usedConnectors.add(normalizeForMatch(connector));
    previousConnector = connector;

    return {
      ...scene,
      narration: applyConnector(scene.narration, connector, language)
    };
  });
};
