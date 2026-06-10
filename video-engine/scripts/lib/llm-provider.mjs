import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {z} from "zod";
import {
  getRecommendedSceneCountForDuration,
  getSceneCountRangeForDuration,
  resolveOutputProfileConfig
} from "../../../config/output-profiles.mjs";
import {normalizeText, sleep as wait, uniqueStrings} from "../../../../shared/utils.mjs";
import {createGeminiUsageSummary, recordGeminiUsage} from "./gemini-usage.mjs";
import {getGcpAccessToken, resolveGcpConfig} from "./gcp-config.mjs";

const STORYBOARD_REPAIR_MAX_ATTEMPTS = Math.max(
  0,
  Number.parseInt(process.env.STORYBOARD_REPAIR_MAX_ATTEMPTS || "3", 10) || 3
);
const OUTPUT_PROFILE = resolveOutputProfileConfig(process.env.OUTPUT_PROFILE || "vertical-short");
const DEFAULT_STORYBOARD_SCENE_RANGE = getSceneCountRangeForDuration(
  OUTPUT_PROFILE.id,
  OUTPUT_PROFILE.defaultTargetSeconds
);
const getStoryboardSceneRange = (desiredDurationSeconds) =>
  getSceneCountRangeForDuration(OUTPUT_PROFILE.id, desiredDurationSeconds);
const createStoryboardSchemaForDuration = (desiredDurationSeconds) =>
  createStoryboardSchema(getStoryboardSceneRange(desiredDurationSeconds));
const createStoryboardOutputSchemaForDuration = (desiredDurationSeconds) =>
  createStoryboardOutputSchema(getStoryboardSceneRange(desiredDurationSeconds));
const OUTPUT_FORMAT_DESCRIPTION =
  OUTPUT_PROFILE.layout === "horizontal"
    ? `horizontal long-form video in 16:9 (${OUTPUT_PROFILE.label})`
    : `vertical short-form video in 9:16 (${OUTPUT_PROFILE.label})`;
const SEARCH_QUERY_MAX_LENGTH = Math.max(
  160,
  Number.parseInt(process.env.SEARCH_QUERY_MAX_LENGTH || "220", 10) || 220
);

const imagePromptSchema = z.string().min(40).max(1200);

const audioPlanSchema = z.object({
  provider: z.string().min(2).max(40),
  voiceName: z.string().min(2).max(120),
  voiceId: z.string().max(120).optional().default(""),
  modelId: z.string().max(120).optional().default("eleven_multilingual_v2"),
  voiceStyle: z.string().min(8).max(320)
});

const sceneSchema = z.object({
  title: z.string().min(2).max(80),
  narration: z.string().min(12).max(520),
  searchQuery: z.string().min(3).max(SEARCH_QUERY_MAX_LENGTH),
  overlay: z.string().min(2).max(80),
  imagePrompts: z.array(imagePromptSchema).min(1).max(4)
});

const createStoryboardSchema = (sceneRange = DEFAULT_STORYBOARD_SCENE_RANGE) =>
  z.object({
    videoTitle: z.string().min(4).max(160),
    hook: z.string().min(8).max(220),
    postCaption: z.string().min(12).max(500),
    hashtags: z.array(z.string().min(2).max(32)).min(3).max(8),
    cta: z.string().max(120),
    audio: audioPlanSchema,
    thumbnailPrompt: z.string().max(2000).optional().default(""),
    scenes: z
      .array(sceneSchema)
      .min(sceneRange.minScenes)
      .max(sceneRange.maxScenes)
  });

const createStoryboardOutputSchema = (sceneRange = DEFAULT_STORYBOARD_SCENE_RANGE) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    videoTitle: {type: "string"},
    hook: {type: "string"},
    postCaption: {type: "string"},
    hashtags: {
      type: "array",
      items: {type: "string"}
    },
    cta: {type: "string"},
    audio: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: {type: "string"},
        voiceName: {type: "string"},
        voiceId: {type: "string"},
        modelId: {type: "string"},
        voiceStyle: {type: "string"}
      },
      required: ["provider", "voiceName", "voiceId", "modelId", "voiceStyle"]
    },
    thumbnailPrompt: {type: "string"},
    scenes: {
      type: "array",
      minItems: sceneRange.minScenes,
      maxItems: sceneRange.maxScenes,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {type: "string"},
          narration: {type: "string"},
          searchQuery: {type: "string"},
          overlay: {type: "string"},
          imagePrompts: {
            type: "array",
            items: {type: "string"},
            minItems: 1,
            maxItems: 4
          }
        },
        required: ["title", "narration", "searchQuery", "overlay", "imagePrompts"]
      }
    }
  },
  required: ["videoTitle", "hook", "postCaption", "hashtags", "cta", "audio", "thumbnailPrompt", "scenes"]
});

const clampText = (value, maxLength) => {
  const normalized = normalizeText(value);
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trim();
};

const clampTextAtWordBoundary = (value, maxLength) => {
  const normalized = normalizeText(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const trimmed = normalized.slice(0, maxLength).trim();
  const boundaryIndex = Math.max(trimmed.lastIndexOf(" "), trimmed.lastIndexOf("-"));

  if (boundaryIndex >= Math.floor(maxLength * 0.6)) {
    return trimmed.slice(0, boundaryIndex).trim();
  }

  return trimmed;
};

const clampTextAtSentenceBoundary = (value, maxLength) => {
  const normalized = normalizeText(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  const trimmed = normalized.slice(0, maxLength).trim();
  const boundaryIndex = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?")
  );

  if (boundaryIndex >= Math.floor(maxLength * 0.5)) {
    return trimmed.slice(0, boundaryIndex + 1).trim();
  }

  return trimmed;
};

const sanitizeGeminiResponseSchema = (schema) => {
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeGeminiResponseSchema(item));
  }

  const entries = Object.entries(schema)
    .filter(([key]) => key !== "additionalProperties" && key !== "$schema")
    .map(([key, value]) => [key, sanitizeGeminiResponseSchema(value)]);

  return Object.fromEntries(entries);
};

const uniqueFindings = (values = []) => {
  const seen = new Set();

  return (Array.isArray(values) ? values : []).filter((finding) => {
    if (!finding || typeof finding !== "object") {
      return false;
    }

    const key = `${String(finding.severity || "")}|${String(finding.code || "")}|${String(finding.message || "")}|${JSON.stringify(finding.details || {})}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const createQaFinding = ({code, message, severity, details = {}}) => ({
  code,
  severity,
  message,
  details
});

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

const isEnglishLanguage = (language) => String(language || "").trim().toLowerCase().startsWith("en");
let geminiUsageSummary = createGeminiUsageSummary();

const cleanRepeatedLead = (text) => {
  return text
    .replace(/^(ao mesmo tempo,\s*){2,}/i, "Ao mesmo tempo, ")
    .replace(/^(s[oó] que,\s*){2,}/i, "Só que, ")
    .replace(/^(agora,\s*){2,}/i, "Agora, ")
    .replace(/^(na pr[aá]tica,\s*){2,}/i, "Na prática, ")
    .replace(/^(meanwhile,\s*){2,}/i, "Meanwhile, ")
    .replace(/^(now,\s*){2,}/i, "Now, ")
    .replace(/^(but,\s*){2,}/i, "But, ")
    .replace(/^(in practice,\s*){2,}/i, "In practice, ");
};

const stripLeadingConnector = (text) => {
  return text.replace(
    /^(ao mesmo tempo|agora|s[oó] que|na pr[aá]tica|e [ée] aqui que|e, no meio disso tudo|mas olha s[oó]|e n[aã]o para por a[ií]|o mais interessante [ée] que|e sabe o que mais|o problema [ée] que|e o mais louco [ée] que|mas calma|e tem mais|por outro lado|meanwhile|now|but|in practice|and this is where|and in the middle of all this|but look|and it does not stop there|the most interesting part is that|and you know what else|the problem is that|and the wildest part is that|but wait|there is more|on the other hand)\??,?\s+/i,
    ""
  );
};

const GENERIC_PT_OVERLAYS = new Set([
  "atenção",
  "alerta",
  "no bolso",
  "no trabalho",
  "nas compras",
  "na saude",
  "em casa",
  "na cidade",
  "aprender",
  "conversar",
  "mercado",
  "rotina",
  "pessoas",
  "novo normal"
]);

const PT_OVERLAY_STOPWORDS = new Set([
  "a",
  "as",
  "o",
  "os",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "em",
  "na",
  "no",
  "nas",
  "nos",
  "para",
  "por",
  "com",
  "sem",
  "um",
  "uma",
  "uns",
  "umas"
]);

const normalizeOverlayKey = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const deriveOverlayFromTitle = (title, narration = "") => {
  const rawTitle = normalizeText(title);
  const preferred = rawTitle.includes(":") ? rawTitle.split(":").slice(1).join(":").trim() : rawTitle;
  const source = preferred || rawTitle || normalizeText(narration);

  if (!source) {
    return "";
  }

  const words = source
    .split(/\s+/)
    .map((word) => word.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, ""))
    .filter((word) => word && !PT_OVERLAY_STOPWORDS.has(normalizeOverlayKey(word)));

  return words.slice(0, 3).join(" ").trim();
};

const isWeakGenericOverlay = (overlay, title = "", narration = "") => {
  const normalizedOverlay = normalizeOverlayKey(overlay);

  if (!normalizedOverlay) {
    return true;
  }

  if (GENERIC_PT_OVERLAYS.has(normalizedOverlay)) {
    return true;
  }

  const context = normalizeOverlayKey(`${title} ${narration}`);
  if (!context) {
    return false;
  }

  const overlayWords = normalizedOverlay.split(" ").filter(Boolean);
  const overlap = overlayWords.filter((word) => word.length >= 4 && context.includes(word)).length;
  return overlayWords.length > 0 && overlap === 0 && overlayWords.length <= 3;
};

export const pickSceneOverlay = ({overlay, title, narration, fallbackOverlay = ""}) => {
  const normalizedOverlay = normalizeText(overlay);

  if (normalizedOverlay && !isWeakGenericOverlay(normalizedOverlay, title, narration)) {
    return normalizedOverlay;
  }

  const derivedOverlay = deriveOverlayFromTitle(title, narration);
  if (derivedOverlay) {
    return derivedOverlay;
  }

  return normalizeText(fallbackOverlay);
};

const cleanTopic = (title) => {
  return title
    .replace(/^como vai ser\s+/i, "")
    .replace(/^como sera\s+/i, "")
    .replace(/^como será\s+/i, "")
    .trim();
};

const sanitizeEnglishSearchQuery = (value) => {
  let result = normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9\s-]+/g, " ")
    .replace(/\b(news alert|headline|breaking news)\b/gi, "abstract warning symbol")
    .replace(/\b(password input fields?|input fields?|password fields?|form fields?)\b/gi, "abstract password symbols")
    .replace(/\blogin page\b/gi, "blank abstract panel")
    .replace(/\b(suspicious message|message on (a )?(phone|smartphone|screen)|notification message)\b/gi, "suspicious notification symbol")
    .replace(/\blink on (a )?(phone|smartphone|screen)\b/gi, "suspicious link icon near a smartphone")
    .replace(/\bwarning message\b/gi, "warning symbol")
    .replace(/\bprogress bar animation\b/gi, "abstract progress bar icon")
    .replace(/\bsoftware installation or update completion\b/gi, "software refresh symbol")
    .replace(/\bdisplaying\b/gi, "with")
    .replace(/\bdisplayed\b/gi, "shown")
    .replace(/\bshowing\b/gi, "with")
    /* ── Screen-content sanitisation: rewrite device+content into abstract device shots ── */
    .replace(/\b(screen|display|monitor)\s+with\s+(?:a\s+)?(?:\w+\s+){0,3}(online store|website|app|dashboard|chat|code|analytics|interface|ui|menu|feed|inbox|search results?|product list(?:ing)?s?|shopping cart|browser|checkout|form|page|profile|timeline|map)\b/gi, "blank glowing $1")
    .replace(/\b(phone|smartphone|tablet|laptop|computer)\s+(?:screen\s+)?with\s+(?:a\s+)?(?:\w+\s+){0,3}(selection of products?|products? list(?:ing)?s?|online store|website|app|shopping|items?|messages?|notifications?|search results?|social media|feed|chat|browser|checkout)\b/gi, "$1 with a blank glowing screen")
    .replace(/\bscrolling through\s+(?:a\s+)?(?:vast |large |huge )?(selection of |variety of )?(products?|items?|options?|listings?|results?|messages?|posts?|feed)\s+on\s+(?:a\s+)?(phone|smartphone|tablet|screen)\b/gi, "browsing a $3 with a blank glowing screen")
    .replace(/\b(?:shown|displayed|projected)\s+on\s+(?:a\s+)?(phone|smartphone|tablet|laptop|computer|monitor|screen)\s*(screen)?\b/gi, "near a $1 with a blank glowing screen")
    .replace(/\bnotification bubble\b/gi, "notification icon bubble")
    .replace(/\blow balance indicator\b/gi, "nearly empty balance bar icon")
    .replace(/\bemail\b/gi, "envelope icon")
    .replace(/\btemplate\b/gi, "abstract panel")
    .replace(/\bon the screen\b/gi, "near the device")
    .replace(/\bon\s+(?:a\s+)?(computer|laptop|phone|smartphone|tablet|monitor)\s+screen\b/gi, "near a $1 with a blank glowing screen")
    .replace(/\b(vertical|portrait)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  /* If a device is mentioned but no screen state is specified, force dark/off screen
     to prevent the image model from hallucinating text on the device */
  if (/\b(smartphone|phone|tablet|laptop|computer|monitor)\b/i.test(result) &&
      !/\b(blank|glowing|dark|off|turned.off|black screen)\b/i.test(result)) {
    result = result.replace(/\b(smartphone|phone|tablet|laptop|computer|monitor)\b/i, "$1 with dark screen");
  }
  return result;
};

const DESK_LAPTOP_QUERY_RE =
  /\b(desk|laptop|computer|keyboard|monitor|office worker|email inbox|screen)\b/i;
const TEXTISH_QUERY_RE =
  /\b(access denied|update now|update|click here|bank alert|error message|warning message|declined message|payment declined|password reset|verification code|verify|sign in|login|log in|login page|headline|news alert|breaking news|input fields?|password fields?|form fields?|notification message|message on (a )?(phone|smartphone|screen)|suspicious message|link on (a )?(phone|smartphone|screen)|email copy|button label|email\b|notification bubble|low balance indicator|progress bar animation)\b/i;
const QUOTED_UI_TEXT_RE = /["'][A-Za-z][A-Za-z0-9 -]{1,24}["']/;
const MULTI_PANEL_QUERY_RE =
  /\b(split[\s-]?screen|multi[\s-]?panel|triptych|three[\s-]?way|collage of|grid of|montage of|side by side of three|three countries|multiple countries)\b/i;
const MULTI_SUBJECT_SEQUENCE_QUERY_RE =
  /\b(sequence of|different people|several people|multiple people|many people|various people|different hands|multiple devices|several devices|many devices|smartphones and tablets|keyboards smartphones and tablets|phones and tablets)\b/i;
const DANGLING_SEARCH_QUERY_END_RE =
  /\b(with|without|the|a|an|of|to|for|in|on|at|from|where|when|while|into|onto|toward|towards|near|around|through|across|inside|outside|behind|before|after|between|among|showing|including|featuring|many|several|multiple|turned-off)\s*$/i;

const normalizeTopicKey = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TOPIC_STOPWORDS = new Set([
  "como", "sera", "serao", "sobre", "para", "porque", "quando", "onde", "com", "sem", "entre",
  "essa", "esse", "isso", "dele", "dela", "numa", "num", "uma", "umas", "uns", "mais", "menos",
  "muito", "muita", "muitas", "muitos", "todo", "toda", "todos", "todas", "voce", "voces",
  "aqui", "ali", "depois", "antes", "mesmo", "mesma", "mesmos", "mesmas", "mito", "verdade",
  "ideia", "ideias", "coisa", "coisas", "curiosidades", "about", "with", "without", "from",
  "into", "your", "their", "this", "that", "these", "those", "video", "short", "shorts", "reels", "tiktok"
]);

const GENERIC_TECH_FILLER_TOKENS = new Set([
  "traducao", "traduzir", "resumo", "resumos", "resumir", "pesquisa", "pesquisar", "organizacao",
  "organizar", "apps", "app", "aplicativos", "workflow", "produtividade", "software", "automacao",
  "chat", "browser", "navegador", "multimodal"
]);

const extractTopicTokens = (value) =>
  normalizeTopicKey(value)
    .split(" ")
    .filter((token) => token.length >= 4 && !TOPIC_STOPWORDS.has(token));

const countDeskLaptopScenes = (storyboard) =>
  (storyboard?.scenes ?? []).filter((scene) => DESK_LAPTOP_QUERY_RE.test(String(scene?.searchQuery || ""))).length;

const countTextishQueries = (storyboard) =>
  (storyboard?.scenes ?? []).filter((scene) => {
    const query = String(scene?.searchQuery || "");
    return TEXTISH_QUERY_RE.test(query) || QUOTED_UI_TEXT_RE.test(query);
  }).length;

const getMultiPanelQueryScenes = (storyboard) =>
  (storyboard?.scenes ?? []).flatMap((scene, index) => {
    const query = String(scene?.searchQuery || "");

    return MULTI_PANEL_QUERY_RE.test(query)
      ? [{
          index,
          title: String(scene?.title || "").trim() || `scene ${index + 1}`,
          searchQuery: query
        }]
      : [];
  });

const getMultiSubjectSequenceQueryScenes = (storyboard) =>
  (storyboard?.scenes ?? []).flatMap((scene, index) => {
    const query = String(scene?.searchQuery || "");

    return MULTI_SUBJECT_SEQUENCE_QUERY_RE.test(query)
      ? [{
          index,
          title: String(scene?.title || "").trim() || `scene ${index + 1}`,
          searchQuery: query
        }]
      : [];
  });

const getDanglingSearchQueryScenes = (storyboard) =>
  (storyboard?.scenes ?? []).flatMap((scene, index) => {
    const query = normalizeText(scene?.searchQuery || "");

    return DANGLING_SEARCH_QUERY_END_RE.test(query)
      ? [{
          index,
          title: String(scene?.title || "").trim() || `scene ${index + 1}`,
          searchQuery: query
        }]
      : [];
  });

const getTitleLeakScenes = (storyboard, title) => {
  const topicKey = normalizeTopicKey(cleanTopic(title) || title);

  if (!topicKey || topicKey.length < 18) {
    return [];
  }

  return (storyboard?.scenes ?? []).flatMap((scene, index, scenes) => {
    const narrationKey = normalizeTopicKey(scene?.narration || "");
    const sceneCount = scenes.length;
    const suspiciousIntro =
      index > 0 &&
      index < sceneCount - 1 &&
      (
        /^se voce quer entender\b/i.test(String(scene?.narration || "")) ||
        narrationKey.includes(topicKey)
      );

    return suspiciousIntro ? [{index, title: scene?.title || `Scene ${index + 1}`}] : [];
  });
};

const hookStartsAsQuestion = (storyboard) => {
  const hook = normalizeText(storyboard?.hook || "");
  const firstNarration = normalizeText(storyboard?.scenes?.[0]?.narration || "");
  return hook.includes("?") || firstNarration.includes("?");
};

const hasSoftGenericEnding = (storyboard) => {
  const lastNarration = normalizeText(storyboard?.scenes?.at(-1)?.narration || "");
  return /^(mantenha|proteja|evite|prefira|use|cuide|lembre|nao caia|não caia)\b/i.test(lastNarration) ||
    /\b(proteja seu celular|solucoes reais|soluções reais|solucoes certas|soluções certas|evite dor de cabeca|evite dor de cabeça|cuide bem dele)\b/i.test(lastNarration);
};

const firstAndLastSceneFeelDuplicated = (storyboard) => {
  const firstNarration = normalizeTopicKey(storyboard?.scenes?.[0]?.narration || "");
  const lastNarration = normalizeTopicKey(storyboard?.scenes?.at(-1)?.narration || "");

  if (!firstNarration || !lastNarration) {
    return false;
  }

  return firstNarration === lastNarration || firstNarration.includes(lastNarration) || lastNarration.includes(firstNarration);
};

const POST_CAPTION_CTA_RE =
  /\b(compartilhe|partilha|salve|guarde|comente|comenta|curta|deixe seu like|deixa o like|segue|siga|follow|envie para|manda para|marque|marca alguem|marca alguém|fique ligado|fica ligado)\b/i;
const PRODUCTIVITY_LEAK_RE =
  /\b(traducao|tradução|traduzir|resumo|resumos|resumir|pesquisa|pesquisas|pesquisar|organizacao|organização|organizar|mesmas apps|apps\b|aplicativos\b|workflow|produtividade|software|automacao|automação|browser|navegador|multimodal)\b/i;
const PRODUCTIVITY_TITLE_RE =
  /\b(ai|ia|app|apps|aplicativo|aplicativos|produtividade|traducao|tradução|resumo|pesquisa|organizacao|organização|software|workflow|automacao|automação)\b/i;
/* ── Semantic domain groups for off-topic detection ──
   Each group defines a conceptual domain. If the searchQuery triggers a domain
   pattern AND the narration/title shares ANY token from the same semantic group,
   the query is considered on-topic regardless of exact wording or language. */
const SEMANTIC_DOMAIN_GROUPS = [
  {
    label: "payment-or-checkout imagery",
    queryRe: /\b(credit card|payment terminal|declined|checkout counter|empty wallet|cashier|price displayed)\b/i,
    /* Any of these tokens in title+narration means the video is about this domain */
    topicTokens: new Set([
      /* EN */ "card", "credit", "payment", "checkout", "wallet", "cashier", "money", "bank",
      "banking", "purchase", "shopping", "store", "price", "buy", "buying", "commerce",
      "ecommerce", "online", "internet", "financial", "transaction",
      /* PT */ "cartao", "cartoes", "credito", "pagamento", "pagar", "caixa", "dinheiro",
      "banco", "bancario", "bancarios", "compra", "comprar", "compras", "loja", "lojas",
      "preco", "precos", "comercio", "financeiro", "transacao", "online", "internet",
    ]),
  },
  {
    label: "photo-or-camera imagery",
    queryRe: /\b(taking photo|portrait photo|phone camera|smartphone camera)\b/i,
    topicTokens: new Set([
      /* EN */ "photo", "photograph", "camera", "portrait", "selfie", "picture", "snap",
      "photography", "lens", "shoot", "shooting",
      /* PT */ "foto", "fotos", "fotografia", "camera", "retrato", "selfie", "imagem",
      "fotografar", "tirando",
    ]),
  },
];

const hasPostCaptionCta = (storyboard) => {
  const combined = normalizeText(`${storyboard?.postCaption || ""} ${storyboard?.cta || ""}`);
  return POST_CAPTION_CTA_RE.test(combined);
};

const getCrossTopicLeakScenes = (storyboard, title) => {
  const titleKey = normalizeTopicKey(cleanTopic(title) || title);
  const titleTokens = new Set(extractTopicTokens(cleanTopic(title) || title));

  if (!titleKey || PRODUCTIVITY_TITLE_RE.test(titleKey)) {
    return [];
  }

  return (storyboard?.scenes ?? []).flatMap((scene, index) => {
    const narration = normalizeText(scene?.narration || "");
    const searchQuery = normalizeText(scene?.searchQuery || "");
    const overlay = normalizeText(scene?.overlay || "");
    const combined = `${narration} ${searchQuery} ${overlay}`.trim();
    const sceneTokens = uniqueStrings(extractTopicTokens(combined));
    const fillerTokens = sceneTokens.filter((token) => GENERIC_TECH_FILLER_TOKENS.has(token));
    const sharesTitleAnchor = sceneTokens.some((token) => titleTokens.has(token));

    return PRODUCTIVITY_LEAK_RE.test(combined) && fillerTokens.length > 0 && !sharesTitleAnchor
      ? [{index, title: scene?.title || `Scene ${index + 1}`, narration, fillerTokens}]
      : [];
  });
};

const getOffTopicQueryScenes = (storyboard, title) => {
  const titleKey = normalizeTopicKey(cleanTopic(title) || title);

  if (!titleKey) {
    return [];
  }

  return (storyboard?.scenes ?? []).flatMap((scene, index) => {
    const query = normalizeText(scene?.searchQuery || "");
    const topicContext = normalizeText(`${title} ${scene?.narration || ""}`);
    const topicTokens = extractTopicTokens(topicContext);
    const reasons = [];

    for (const {queryRe, label, topicTokens: domainTokens} of SEMANTIC_DOMAIN_GROUPS) {
      if (!queryRe.test(query)) continue;

      /* If ANY token from the narration/title appears in this domain's
         semantic group, the video is about this domain → not off-topic. */
      const isOnTopic = topicTokens.some((t) => domainTokens.has(t));

      if (!isOnTopic) {
        reasons.push(label);
      }
    }

    return reasons.length > 0
      ? [{index, title: scene?.title || `Scene ${index + 1}`, reasons}]
      : [];
  });
};

const hasOffTopicCaptionLeak = (storyboard, title) => {
  const titleKey = normalizeTopicKey(cleanTopic(title) || title);
  const titleTokens = new Set(extractTopicTokens(cleanTopic(title) || title));

  if (!titleKey || PRODUCTIVITY_TITLE_RE.test(titleKey)) {
    return false;
  }

  const combined = normalizeText(`${storyboard?.postCaption || ""} ${storyboard?.cta || ""}`);
  const captionTokens = uniqueStrings(extractTopicTokens(combined));
  const fillerTokens = captionTokens.filter((token) => GENERIC_TECH_FILLER_TOKENS.has(token));
  const sharesTitleAnchor = captionTokens.some((token) => titleTokens.has(token));

  return PRODUCTIVITY_LEAK_RE.test(combined) && fillerTokens.length > 0 && !sharesTitleAnchor;
};

const VIRAL_SHORTFORM_GUIDANCE_RE = /\b(short-form creator|internet-native|all caps|viral|sarcastic|nao cai nessa|bad tech idea|fail energy|parecia arriscado|muita gente desconfiava)\b/i;
const HARD_HOOK_RE = /\b(nao use|não use|pare|pessima ideia|péssima ideia|ruim|perigo|alerta|grave|mito|destruindo|arruinando|erro|pior erro|inutil|inútil|descartad|ridiculo|ridículo|absurdo|achou que|considerada)\b/i;
const CONTRAST_HOOK_RE = /\b(mas\b|so que\b|só que\b|por \d+ anos\b|durante \d+ anos\b|sem vender\b|recusando\b|recusou\b|recusaram\b|achavam que\b|nao queria\b|não queria\b|acabou virando\b|hoje vale\b|virou\b)\b/i;
const COLLOQUIAL_REACTION_RE = /\b(nao cai nessa|não caia nessa|parecia arriscado|muita gente desconfiava|ninguem sabia se dava para confiar|ninguém sabia se dava para confiar|ninguem queria testar|ninguém queria testar|pessima ideia|péssima ideia|mito perigoso|dor de cabeca|dor de cabeça|fortuna a toa|fortuna à toa|essa ideia nao foi uma boa ideia|essa ideia não foi uma boa ideia|nao faca isso|não faça isso|erro grave|cilada|mano|cara|meu deus|que ideia ruim|que ideia péssima|que avaliacao ruim|que avaliação ruim)\b/i;
const NO_ENGLISH_VISUAL_TEXT_RULE = "The prompt itself may be written in English, but the generated image must not contain English words, English UI labels, random Latin lettering, fake app copy, or readable signage. Prefer no readable text at all; if in-world text is unavoidable, it must be simple Brazilian Portuguese only.";
const BLANK_UI_VISUAL_RULE = "Use blank screens, icon-only interface shapes, blank signs, blank placards, route lines, pins, stars, check marks, and abstract symbols instead of words, letters, numbers, button labels, brand marks, or UI copy.";
const SOFT_ADVICE_START_RE = /^(para|sempre|mantenha|proteja|evite|prefira|use|procure|opte|cuide|lembre|considere)\b/i;
const ENDING_STING_RE = /\b(caro|custa|custar|fortuna|prejuizo|prejuízo|erro grave|perigo|ruim|estragar|danificar|piorar|irreversivel|irreversível|dor de cabeca|dor de cabeça|cilada|nao faca isso|não faça isso|nao caia nessa|não caia nessa|lotada|nunca fica vazia|controla a sua vida|controla sua vida)\b/i;
const MORALIZING_DIRECT_ADVICE_RE = /\b(nao cometa|não cometa|pensa nisso|na proxima vez|na próxima vez|sua proxima ideia|sua próxima ideia|nao subestime|não subestime|aprenda com|licao final|lição final|moral da historia|moral da história|aviso brutal|lembre disso)\b/i;
const UPPERCASE_EMPHASIS_RE = /(^|[^A-Za-zÀ-ÖØ-öø-ÿ])([A-ZÀ-ÖØ-Þ]{2,})(?=[^A-Za-zÀ-ÖØ-öø-ÿ]|$)/g;
const CONCRETE_DATA_RE = /\b(\d+|milh(?:ao|ões|oes)|bilh(?:ao|ões|oes)|trilh(?:ao|ões|oes))\b/i;

const isViralShortformGuidance = (scriptGuidance = "") => VIRAL_SHORTFORM_GUIDANCE_RE.test(normalizeText(scriptGuidance));

const collectUppercaseEmphasisTokens = (storyboard) => {
  const combined = [
    storyboard?.hook || "",
    ...(storyboard?.scenes ?? []).map((scene) => `${scene?.narration || ""} ${scene?.overlay || ""}`)
  ].join(" ");
  const tokens = [];

  for (const match of combined.matchAll(UPPERCASE_EMPHASIS_RE)) {
    const token = String(match?.[2] || "").trim();

    if (token.length >= 3) {
      tokens.push(token);
    }
  }

  return uniqueStrings(tokens);
};

const countColloquialReactionLines = (storyboard) => {
  const lines = [storyboard?.hook || "", ...(storyboard?.scenes ?? []).map((scene) => scene?.narration || "")];
  return lines.filter((line) => COLLOQUIAL_REACTION_RE.test(normalizeText(line))).length;
};

const countSoftAdviceLines = (storyboard) => {
  return (storyboard?.scenes ?? []).filter((scene) => SOFT_ADVICE_START_RE.test(normalizeText(scene?.narration || ""))).length;
};

const hasHardHookStatement = (storyboard) => {
  const opening = normalizeText(`${storyboard?.hook || ""} ${storyboard?.scenes?.[0]?.narration || ""}`);
  const hasContrastiveFactHook = hookContainsConcreteDataPoint(storyboard) && CONTRAST_HOOK_RE.test(opening);
  return !hookStartsAsQuestion(storyboard) && (HARD_HOOK_RE.test(opening) || hasContrastiveFactHook);
};

const hasViralEndingSting = (storyboard) => {
  const closing = normalizeText(storyboard?.scenes?.at(-1)?.narration || "");
  return !hasSoftGenericEnding(storyboard) && ENDING_STING_RE.test(closing);
};

const hasMoralizingHookOrEnding = (storyboard) => {
  const opening = normalizeText(storyboard?.hook || "");
  const closing = normalizeText(
    `${storyboard?.scenes?.at(-1)?.title || ""} ${storyboard?.scenes?.at(-1)?.narration || ""} ${storyboard?.postCaption || ""}`
  );

  return MORALIZING_DIRECT_ADVICE_RE.test(opening) || MORALIZING_DIRECT_ADVICE_RE.test(closing);
};

const storyboardContainsConcreteDataPoint = (storyboard) => {
  const combined = [
    storyboard?.hook || "",
    storyboard?.postCaption || "",
    ...(storyboard?.scenes ?? []).map((scene) => `${scene?.narration || ""} ${scene?.overlay || ""}`)
  ].join(" ");

  return CONCRETE_DATA_RE.test(normalizeText(combined));
};

const hookContainsConcreteDataPoint = (storyboard) => {
  return CONCRETE_DATA_RE.test(normalizeText(storyboard?.hook || ""));
};

const getStoryboardIssueList = ({storyboard, title}) => {
  const issues = [];
  const deskLaptopScenes = countDeskLaptopScenes(storyboard);
  const textishQueries = countTextishQueries(storyboard);
  const titleLeakScenes = getTitleLeakScenes(storyboard, title);
  const crossTopicLeakScenes = getCrossTopicLeakScenes(storyboard, title);
  const offTopicQueryScenes = getOffTopicQueryScenes(storyboard, title);
  const multiPanelQueryScenes = getMultiPanelQueryScenes(storyboard);
  const multiSubjectSequenceQueryScenes = getMultiSubjectSequenceQueryScenes(storyboard);
  const danglingSearchQueryScenes = getDanglingSearchQueryScenes(storyboard);

  if (deskLaptopScenes > 4) {
    issues.push(createQaFinding({
      code: "too_many_desk_laptop_scenes",
      severity: "issue",
      message: `Too many desk/laptop scenes (${deskLaptopScenes}). Rewrite several scenes to use phones, cards, routers, doors, wallets, checkout counters, home devices, hands-only object shots, or street/home settings instead.`,
      details: {deskLaptopScenes}
    }));
  }

  if (textishQueries > 0) {
    issues.push(createQaFinding({
      code: "readable_interface_text_in_queries",
      severity: "issue",
      message: `${textishQueries} searchQuery entries still imply readable interface text. Replace headlines, messages, links, emails, buttons, and form fields with blank panels, warning icons, lock symbols, or abstract alerts.`,
      details: {textishQueries}
    }));
  }

  if (multiPanelQueryScenes.length > 0) {
    issues.push(createQaFinding({
      code: "multi_panel_search_query",
      severity: "issue",
      message: `Some searchQuery entries ask for split-screen, collage, or montage-style images that usually break single-frame generation: ${multiPanelQueryScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title})`)
        .join(", ")}. Rewrite them as one place, one main subject, and one action in a single coherent frame.`,
      details: {
        sceneIndexes: multiPanelQueryScenes.map((scene) => scene.index + 1),
        sceneTitles: multiPanelQueryScenes.map((scene) => scene.title)
      }
    }));
  }

  if (multiSubjectSequenceQueryScenes.length > 0) {
    issues.push(createQaFinding({
      code: "multi_subject_sequence_query",
      severity: "issue",
      message: `Some searchQuery entries still describe a sequence, several people, or multiple device types inside one scene: ${multiSubjectSequenceQueryScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title})`)
        .join(", ")}. Rewrite them as one single coherent frame with one dominant subject, one place, and one main action.`,
      details: {
        sceneIndexes: multiSubjectSequenceQueryScenes.map((scene) => scene.index + 1),
        sceneTitles: multiSubjectSequenceQueryScenes.map((scene) => scene.title)
      }
    }));
  }

  if (danglingSearchQueryScenes.length > 0) {
    issues.push(createQaFinding({
      code: "dangling_search_query",
      severity: "issue",
      message: `Some searchQuery entries still end in a dangling connector or incomplete descriptor: ${danglingSearchQueryScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title})`)
        .join(", ")}. Rewrite each query so it ends as one complete image description, not a clipped fragment.`,
      details: {
        sceneIndexes: danglingSearchQueryScenes.map((scene) => scene.index + 1),
        sceneTitles: danglingSearchQueryScenes.map((scene) => scene.title)
      }
    }));
  }

  if (titleLeakScenes.length > 0) {
    issues.push(createQaFinding({
      code: "narration_title_leak",
      severity: "issue",
      message: `Narration leaks the video title or generic intro phrasing in mid-storyboard scenes: ${titleLeakScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title})`)
        .join(", ")}. Rewrite those lines so they explain the topic directly instead of repeating the title.`,
      details: {
        sceneIndexes: titleLeakScenes.map((scene) => scene.index + 1),
        sceneTitles: titleLeakScenes.map((scene) => scene.title)
      }
    }));
  }

  if (hookStartsAsQuestion(storyboard)) {
    issues.push(createQaFinding({
      code: "hook_opens_as_question",
      severity: "issue",
      message: "The hook still opens as a question. Rewrite the hook and opening scene so the video starts with a hard statement, warning, accusation, or shocking reveal instead of asking the viewer a question."
    }));
  }

  if (hasSoftGenericEnding(storyboard)) {
    issues.push(createQaFinding({
      code: "ending_too_soft_generic",
      severity: "issue",
      message: "The ending is too soft or generic. Rewrite the last scene so it lands with a sharper cautionary sting, consequence, or memorable warning."
    }));
  }

  if (firstAndLastSceneFeelDuplicated(storyboard)) {
    issues.push(createQaFinding({
      code: "ending_duplicates_opening",
      severity: "issue",
      message: "The ending feels too close to the opening scene. Rewrite the closing beat so it echoes the theme without duplicating the first scene or first sentence."
    }));
  }

  if (crossTopicLeakScenes.length > 0) {
    issues.push(createQaFinding({
      code: "cross_topic_leak",
      severity: "issue",
      message: `Some scenes drift into an unrelated apps/productivity topic that does not match the title: ${crossTopicLeakScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title}) via ${scene.fillerTokens.join(", ")}`)
        .join(", ")}. Rewrite those scenes so they stay strictly on the video's real subject.`,
      details: {
        sceneIndexes: crossTopicLeakScenes.map((scene) => scene.index + 1),
        sceneTitles: crossTopicLeakScenes.map((scene) => scene.title),
        fillerTokens: crossTopicLeakScenes.flatMap((scene) => scene.fillerTokens)
      }
    }));
  }

  if (offTopicQueryScenes.length > 0) {
    issues.push(createQaFinding({
      code: "off_topic_search_query",
      severity: "issue",
      message: `Some searchQuery entries introduce unrelated visual domains that do not match their scene narration: ${offTopicQueryScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title}) via ${scene.reasons.join(", ")}`)
        .join(", ")}. Rewrite those queries so they stay on the same exact subject as the narration.`,
      details: {
        sceneIndexes: offTopicQueryScenes.map((scene) => scene.index + 1),
        sceneTitles: offTopicQueryScenes.map((scene) => scene.title),
        reasons: offTopicQueryScenes.flatMap((scene) => scene.reasons)
      }
    }));
  }

  if (hasPostCaptionCta(storyboard)) {
    issues.push(createQaFinding({
      code: "caption_contains_cta",
      severity: "issue",
      message: "The postCaption or cta still contains a call to action. Rewrite the caption to stay descriptive and platform-native without asking the viewer to share, save, comment, like, or follow."
    }));
  }

  if (hasOffTopicCaptionLeak(storyboard, title)) {
    issues.push(createQaFinding({
      code: "caption_topic_drift",
      severity: "issue",
      message: "The postCaption drifts into unrelated generic tech filler instead of the real title topic. Rewrite it so it stays tightly about the same concrete subject as the storyboard."
    }));
  }

  // Duplicate scene titles
  const sceneTitles = (storyboard.scenes || []).map((s) => (s.title || "").trim().toLowerCase());
  const duplicateTitles = sceneTitles.filter((t, i) => t && sceneTitles.indexOf(t) !== i);
  if (duplicateTitles.length > 0) {
    const unique = [...new Set(duplicateTitles)];
    issues.push(createQaFinding({
      code: "duplicate_scene_titles",
      severity: "issue",
      message: `Duplicate scene titles found: ${unique.map((t) => `"${t}"`).join(", ")}. Every scene title must be unique — rename them to reflect their distinct beats.`,
      details: {duplicateTitles: unique}
    }));
  }

  return issues;
};

const BLOCKING_QA_CODES = new Set([
  "readable_interface_text_in_queries",
  "multi_panel_search_query",
  "multi_subject_sequence_query",
  "dangling_search_query",
  "cross_topic_leak",
  "off_topic_search_query"
]);

const partitionQaFindings = (findings = []) => {
  const blocking = [];
  const advisory = [];

  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || typeof finding !== "object") {
      continue;
    }

    if (BLOCKING_QA_CODES.has(String(finding.code || ""))) {
      blocking.push({...finding, severity: "issue"});
    } else {
      advisory.push({...finding, severity: "warning"});
    }
  }

  return {
    blocking,
    advisory
  };
};

export const evaluateStoryboardQa = ({
  storyboard,
  title,
  language = "pt-BR",
  desiredDurationSeconds = 100,
  scriptGuidance = ""
}) => {
  const baseFindings = getStoryboardIssueList({storyboard, title});
  const partitionedFindings = partitionQaFindings(baseFindings);
  const issueFindings = [...partitionedFindings.blocking];
  const warningFindings = [...partitionedFindings.advisory];
  const issues = issueFindings.map((finding) => finding.message);
  const warnings = warningFindings.map((finding) => finding.message);
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const wordCount = getStoryboardWordCount(storyboard);
  const uppercaseEmphasisTokens = collectUppercaseEmphasisTokens(storyboard);
  const colloquialReactionLineCount = countColloquialReactionLines(storyboard);
  const softAdviceLineCount = countSoftAdviceLines(storyboard);
  const profile = isViralShortformGuidance(scriptGuidance) ? "viral_shortform" : "default";
  let viralScore = null;

  const addIssueFinding = ({code, message, details = {}}) => {
    issueFindings.push(createQaFinding({code, severity: "issue", message, details}));
    issues.push(message);
  };

  const addWarningFinding = ({code, message, details = {}}) => {
    warningFindings.push(createQaFinding({code, severity: "warning", message, details}));
    warnings.push(message);
  };

  if (profile === "viral_shortform") {
    viralScore = 100;

    if (!hasHardHookStatement(storyboard)) {
      viralScore -= 25;
      if (hookContainsConcreteDataPoint(storyboard)) {
        addWarningFinding({
          code: "viral_hook_could_hit_harder",
          message: "The hook could hit harder for this channel. If possible, sharpen the contradiction or consequence in the opening."
        });
      } else {
        addIssueFinding({
          code: "viral_hook_not_accusatory",
          message: "The hook still lacks a hard short-form opening built on irony, contradiction, or consequence. Rewrite it as a surprising factual statement instead of a soft explainer."
        });
      }
    }

    if (storyboardContainsConcreteDataPoint(storyboard) && !hookContainsConcreteDataPoint(storyboard)) {
      viralScore -= 18;
      addIssueFinding({
        code: "viral_hook_missing_data_point",
        message: "The script contains a strong concrete number or scale fact, but the hook does not use it. Rewrite the opening so it includes the strongest data point together with the irony or contradiction."
      });
    }

    if (hasMoralizingHookOrEnding(storyboard)) {
      viralScore -= 18;
      addIssueFinding({
        code: "viral_moralizing_direct_advice",
        message: "The hook or ending drifts into direct advice, moral-of-the-story framing, or coach-style wording. Rewrite it so the irony and factual consequence speak for themselves without telling the viewer what lesson to take."
      });
    }

    if (uppercaseEmphasisTokens.length === 0) {
      viralScore -= 18;
      addWarningFinding({
        code: "viral_all_caps_missing",
        message: "Add 2 to 5 impact words in ALL CAPS across the hook and narration so the script carries the channel's emphasis style."
      });
    } else if (uppercaseEmphasisTokens.length === 1) {
      viralScore -= 8;
      addWarningFinding({
        code: "viral_all_caps_sparse",
        message: "The script uses too little ALL CAPS emphasis for this channel style. Add one or two more impact words."
      });
    }

    if (colloquialReactionLineCount === 0) {
      viralScore -= 15;
      addWarningFinding({
        code: "viral_colloquial_reaction_missing",
        message: "Add at least one human colloquial reaction line so the script sounds like a smart friend calling out a bad idea."
      });
    }

    if (softAdviceLineCount >= 3) {
      viralScore -= 20;
      addWarningFinding({
        code: "viral_soft_advice_drift",
        message: "Too many scenes drift into generic advice or educational explainer tone. Rewrite several lines to sound sharper, more internet-native, and more emotionally charged."
      });
    } else if (softAdviceLineCount === 2) {
      viralScore -= 8;
      addWarningFinding({
        code: "viral_soft_advice_drift_warning",
        message: "Some scenes are drifting into generic advice tone. Keep the pacing punchier and less educational."
      });
    }

    if (!hasViralEndingSting(storyboard)) {
      viralScore -= 18;
      addWarningFinding({
        code: "viral_ending_missing_sting",
        message: "The ending still lacks a strong consequence, cost, embarrassment, or cautionary sting. Rewrite the last scene so it lands harder."
      });
    }

    if (viralScore < 60) {
      addWarningFinding({
        code: "viral_overall_too_educational",
        message: "Overall the storyboard still reads too educational for this channel. Rewrite it with more accusation, sharper contrast, stronger spoken rhythm, and clearer fail energy."
      });
    }
  }

  const uniqueIssueFindings = uniqueFindings(issueFindings);
  const uniqueWarningFindings = uniqueFindings(warningFindings);

  return {
    passed: uniqueIssueFindings.length === 0,
    profile,
    issues: uniqueIssueFindings.map((finding) => finding.message),
    issueObjects: uniqueIssueFindings,
    warnings: uniqueWarningFindings.map((finding) => finding.message),
    warningObjects: uniqueWarningFindings,
    metrics: {
      wordCount,
      minWords,
      maxWords,
      uppercaseEmphasisCount: uppercaseEmphasisTokens.length,
      uppercaseEmphasisTokens,
      colloquialReactionLineCount,
      softAdviceLineCount,
      viralScore
    }
  };
};

const sanitizeNarrationLine = (value, fallbackValue = "") => {
  let text = cleanRepeatedLead(normalizeText(value) || normalizeText(fallbackValue));

  text = text
    .replace(/^(ao mesmo tempo|agora|s[oó] que|na pr[aá]tica|e [ée] aqui que|e, no meio disso tudo|mas olha s[oó]|e n[aã]o para por a[ií]|o mais interessante [ée] que|e sabe o que mais|o problema [ée] que|e o mais louco [ée] que|mas calma|e tem mais|por outro lado|meanwhile|now|but|in practice|and this is where|and in the middle of all this|but look|and it does not stop there|the most interesting part is that|and you know what else|the problem is that|and the wildest part is that|but wait|there is more|on the other hand)\??,?\s+/i, "")
    .replace(/^[-–—,:;]+\s*/, "")
    .replace(/^ou\s+/i, "Pense em ")
    .replace(/^e\s+(um|uma|o|a)\b/i, "$1");

  text = stripLeadingConnector(text);

  if (text && text[0] === text[0].toLowerCase()) {
    text = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
  }

  return text;
};

const countWords = (text) => {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean).length;
};

const getTargetWordRange = (desiredDurationSeconds = 100, language = "pt-BR") => {
  const normalizedLanguage = String(language || "pt-BR").trim().toLowerCase();
  const targetWordsPerSecond = normalizedLanguage.startsWith("pt")
    ? Number.parseFloat(process.env.TARGET_WORDS_PER_SECOND_PT || "2.9") || 2.9
    : Number.parseFloat(process.env.TARGET_WORDS_PER_SECOND_DEFAULT || "2.75") || 2.75;
  const center = Math.max(24, Math.round(desiredDurationSeconds * targetWordsPerSecond));
  const minWords = Math.max(20, Math.round(center * 0.92));
  const maxWords = Math.max(minWords + 8, Math.round(center * 1.06));

  return {minWords, maxWords};
};

const getStoryboardWordCount = (storyboard) => {
  return (storyboard?.scenes ?? []).reduce((total, scene) => total + countWords(scene.narration), 0);
};

const extractJsonObject = (input) => {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Nao encontrei JSON valido na resposta do OpenRouter.");
  }

  return input.slice(start, end + 1);
};

const messagesToPrompt = (messages) => {
  return messages
    .map((message) => {
      const content = Array.isArray(message?.content)
        ? message.content
            .map((item) => item?.text ?? "")
            .join("\n")
            .trim()
        : String(message?.content ?? "").trim();

      return `${String(message?.role || "user").toUpperCase()}:\n${content}`;
    })
    .join("\n\n");
};

const MAX_SOURCE_TEXT_CHARACTERS = 12000;
const STRUCTURED_SOURCE_SECTION_ALIASES = new Map([
  ["titulo", "title"],
  ["title", "title"],
  ["headline", "title"],
  ["base factual", "base_facts"],
  ["fatos base", "base_facts"],
  ["fatos", "base_facts"],
  ["nota de precisao historica", "base_facts"],
  ["nota de precisao", "base_facts"],
  ["historical note", "base_facts"],
  ["precision note", "base_facts"],
  ["cronologia", "timeline"],
  ["linha do tempo", "timeline"],
  ["timeline", "timeline"],
  ["numeros obrigatorios", "required_numbers"],
  ["numeros obrigatorios e datas", "required_numbers"],
  ["required numbers", "required_numbers"],
  ["beats obrigatorios", "required_beats"],
  ["momentos obrigatorios", "required_beats"],
  ["beats", "required_beats"],
  ["required beats", "required_beats"],
  ["tom", "tone"],
  ["tone", "tone"],
  ["evitar", "avoid"],
  ["avoid", "avoid"],
  ["nao usar", "avoid"],
  ["fechamento desejado", "desired_ending"],
  ["ending desired", "desired_ending"],
  ["closing desired", "desired_ending"],
  ["fechamento", "desired_ending"],
  ["cenas guia", "scene_beats"],
  ["guia de cenas", "scene_beats"],
  ["scene beats", "scene_beats"],
  ["estrutura sugerida", "scene_beats"],
  ["contexto extra", "extra_context"],
  ["observacoes", "extra_context"],
  ["extra context", "extra_context"]
]);

const normalizeStructuredSourceSectionKey = (value) =>
  normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const truncateSourceText = (value) => {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  if (text.length <= MAX_SOURCE_TEXT_CHARACTERS) {
    return text;
  }

  return `${text.slice(0, MAX_SOURCE_TEXT_CHARACTERS).trim()}\n\n[Source material truncated for prompt size]`;
};

const parseStructuredNumberStrength = (value) => {
  const text = normalizeText(value);
  const matches = Array.from(text.matchAll(/\b(\d+(?:[.,]\d+)?)\b/g));

  if (matches.length === 0) {
    return 0;
  }

  const unitMultiplier =
    /\btrilh(?:ao|ão|oes|ões)\b/i.test(text) ? 1e12
    : /\bbilh(?:ao|ão|oes|ões)\b/i.test(text) ? 1e9
    : /\bmilh(?:ao|ão|oes|ões)\b/i.test(text) ? 1e6
    : /\bmil\b/i.test(text) ? 1e3
    : 1;

  return matches.reduce((maxValue, match) => {
    const numericValue = Number.parseFloat(String(match[1] || "").replace(",", "."));
    if (!Number.isFinite(numericValue)) {
      return maxValue;
    }

    return Math.max(maxValue, numericValue * unitMultiplier);
  }, 0);
};

const pickStrongestStructuredNumberLine = (items = []) => {
  const ranked = items
    .map((item) => ({
      item,
      strength: parseStructuredNumberStrength(item)
    }))
    .filter((entry) => entry.strength > 0)
    .sort((left, right) => right.strength - left.strength);

  return ranked[0]?.item || "";
};

const buildHookNumberFragment = (value) => {
  const text = normalizeText(value);

  if (!text) {
    return "";
  }

  const splitFragment = text.split(/\s+[—-]\s+/)[0]?.trim() || text;
  const fragment = splitFragment.replace(/[.;:!?]+$/g, "").trim();
  return fragment ? `${fragment}.` : "";
};

const buildTitleContradictionFragment = (value) => {
  const text = normalizeText(value).replace(/[.;:!?]+$/g, "").trim();
  return text ? `${text}.` : "";
};

const extractStructuredSourceItems = (value) => {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) =>
      normalizeText(line)
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
        .trim()
    )
    .filter(Boolean);

  return lines.length > 0 ? lines : [normalizeText(value)];
};

const parseStructuredSourceText = (value) => {
  const rawText = String(value ?? "").trim();

  if (!rawText) {
    return null;
  }

  const lines = rawText.split(/\r?\n/);
  const sections = [];
  const introChunks = [];
  let currentKey = "";
  let currentLabel = "";
  let buffer = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    buffer = [];

    if (!content) {
      return;
    }

    if (currentKey) {
      sections.push({key: currentKey, label: currentLabel, content});
    } else {
      introChunks.push(content);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const unwrapped = trimmed
      .replace(/^\*\*(.*?)\*\*$/u, "$1")
      .replace(/^__(.*?)__$/u, "$1")
      .trim();
    const match = trimmed.match(
      /^(?:#{1,3}\s*)?(?:\[\s*([^\]]+?)\s*\]|([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 _-]{1,48}))\s*:?\s*$/
    ) || unwrapped.match(
      /^(?:#{1,3}\s*)?(?:\[\s*([^\]]+?)\s*\]|([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9 _-]{1,48}))\s*:?\s*$/
    );

    if (match) {
      const label = String(match[1] || match[2] || "").trim();
      const canonicalKey = STRUCTURED_SOURCE_SECTION_ALIASES.get(normalizeStructuredSourceSectionKey(label));

      if (canonicalKey) {
        flush();
        currentKey = canonicalKey;
        currentLabel = label;
        continue;
      }
    }

    buffer.push(line);
  }

  flush();

  if (sections.length < 1) {
    return null;
  }

  const grouped = new Map();

  for (const section of sections) {
    const existing = grouped.get(section.key) || [];
    grouped.set(section.key, [...existing, ...extractStructuredSourceItems(section.content)]);
  }

  return {
    intro: introChunks.join("\n\n").trim(),
    sections,
    grouped
  };
};

const buildCreativeContextLines = ({sourceText, scriptGuidance}) => {
  const lines = [];
  const normalizedGuidance = normalizeText(scriptGuidance);
  const structuredSource = parseStructuredSourceText(sourceText);
  const preparedSourceText = truncateSourceText(sourceText);

  if (normalizedGuidance) {
    lines.push(`Creative guidance: ${normalizedGuidance}`);
  }

  if (structuredSource) {
    const getItems = (key) => (structuredSource.grouped.get(key) || []).slice(0, 12);
    const titleItems = getItems("title");
    const factItems = getItems("base_facts");
    const timelineItems = getItems("timeline");
    const requiredNumberItems = getItems("required_numbers");
    const requiredBeatItems = getItems("required_beats");
    const toneItems = getItems("tone");
    const avoidItems = getItems("avoid");
    const desiredEndingItems = getItems("desired_ending");
    const sceneBeatItems = getItems("scene_beats");
    const extraContextItems = getItems("extra_context");

    lines.push("STRUCTURED SOURCE BRIEF DETECTED:");

    if (titleItems.length > 0) {
      lines.push(`Source title anchor: ${titleItems[0]}`);
    }

    if (factItems.length > 0) {
      lines.push("Base factual anchors:");
      lines.push(...factItems.map((item) => `- ${item}`));
    }

    if (timelineItems.length > 0) {
      lines.push("Chronology anchors to preserve when relevant:");
      lines.push(...timelineItems.map((item) => `- ${item}`));
    }

    if (requiredNumberItems.length > 0) {
      lines.push("Required numbers and dates:");
      lines.push(...requiredNumberItems.map((item) => `- ${item}`));
      lines.push("Use the strongest required number or scale fact directly in the hook when it creates irony or contrast.");
      const strongestNumberLine = pickStrongestStructuredNumberLine(requiredNumberItems);
      if (strongestNumberLine) {
        lines.push(`Preferred hook anchor: ${strongestNumberLine}`);
        lines.push("Hook format preference: sentence 1 states the strongest number or scale fact; sentence 2 states the contradiction, refusal, or irony.");
      }
    }

    if (requiredBeatItems.length > 0) {
      lines.push("Required beats to preserve as concrete scenes or narration beats:");
      lines.push(...requiredBeatItems.map((item) => `- ${item}`));
      lines.push("Do not replace required beats with generic abstractions.");
    }

    if (toneItems.length > 0) {
      lines.push(`Tone override: ${toneItems.join(" ")}`);
    }

    if (avoidItems.length > 0) {
      lines.push("Avoid these patterns explicitly:");
      lines.push(...avoidItems.map((item) => `- ${item}`));
    }

    if (desiredEndingItems.length > 0) {
      lines.push(`Desired ending: ${desiredEndingItems.join(" ")}`);
    }

    if (sceneBeatItems.length > 0) {
      lines.push("Optional scene guidance from the source brief:");
      lines.push(...sceneBeatItems.map((item) => `- ${item}`));
    }

    if (extraContextItems.length > 0) {
      lines.push("Additional context:");
      lines.push(...extraContextItems.map((item) => `- ${item}`));
    }

    if (structuredSource.intro) {
      lines.push("Intro context:");
      lines.push(structuredSource.intro);
    }

    lines.push("Treat the structured brief above as higher priority than generic storytelling defaults.");
    lines.push("If there is any conflict, preserve base facts, required numbers, required beats, tone, avoid-list, and desired ending.");
    return lines;
  }

  if (preparedSourceText) {
    lines.push("STRICT SCRIPT ADHERENCE:");
    lines.push("Do NOT invent generic scenes when source material is provided.");
    lines.push("Extract the most human, ironic, surprising, and memorable beats directly from the source text.");
    lines.push("Prefer specific actions and props from the source, such as a typed test string, a whispered warning, a note, a gesture, a terminal, or a single symbolic object that the script actually mentions.");
    lines.push("If the source contains a tiny ironic detail, keep it. Those details are usually the best scenes.");
    lines.push("Use the source material below as the primary factual basis for the short video.");
    lines.push("Distill it into a native video script without inventing details that are not supported by the source.");
    lines.push("Source material:");
    lines.push(preparedSourceText);
  }

  return lines;
};

const enforceStructuredHookAnchors = ({storyboard, title, sourceText}) => {
  const structuredSource = parseStructuredSourceText(sourceText);

  if (!structuredSource) {
    return storyboard;
  }

  const requiredNumberItems = (structuredSource.grouped.get("required_numbers") || []).slice(0, 12);
  const strongestNumberLine = pickStrongestStructuredNumberLine(requiredNumberItems);

  if (!strongestNumberLine) {
    return storyboard;
  }

  if (hookContainsConcreteDataPoint(storyboard) && hasHardHookStatement(storyboard)) {
    return storyboard;
  }

  const structuredTitle = (structuredSource.grouped.get("title") || [])[0] || title;
  const numberFragment = buildHookNumberFragment(strongestNumberLine);
  const titleFragment = buildTitleContradictionFragment(structuredTitle || title);
  const rebuiltHook = clampTextAtSentenceBoundary(`${numberFragment} ${titleFragment}`.trim(), 220);

  if (!rebuiltHook) {
    return storyboard;
  }

  return {
    ...storyboard,
    hook: rebuiltHook
  };
};

const normalizeStoryboardWithSource = (
  input,
  title,
  language = "pt-BR",
  sceneRange = DEFAULT_STORYBOARD_SCENE_RANGE,
  desiredDurationSeconds = OUTPUT_PROFILE.defaultTargetSeconds,
  sourceText = ""
) =>
  enforceStructuredHookAnchors({
    storyboard: normalizeStoryboard(input, title, language, sceneRange, desiredDurationSeconds),
    title,
    sourceText
  });

export const resolveLlmProvider = (value) => {
  const normalized = String(value ?? process.env.LLM_PROVIDER ?? process.env.STORY_PROVIDER ?? "vertex")
    .trim()
    .toLowerCase();

  if (["vertex", "vertexai"].includes(normalized)) {
    return "vertex";
  }

  if (["gemini", "google", "googleai"].includes(normalized)) {
    return "gemini";
  }

  if (["codex", "openrouter", "kiro", "zai"].includes(normalized)) {
    return normalized;
  }

  return "vertex";
};

const buildJsonRepairMessages = (rawText) => [
  {
    role: "system",
    content:
      "You repair malformed JSON responses. Return valid JSON only. Preserve the original meaning and fields as much as possible. Do not add markdown."
  },
  {
    role: "user",
    content: `Repair this into valid JSON only:\n${rawText}`
  }
];

const expandFallbackScenes = (baseScenes, desiredSceneCount) => {
  const targetCount = Math.max(1, Number(desiredSceneCount) || baseScenes.length || 1);

  return Array.from({length: targetCount}, (_, index) => {
    const template = baseScenes[index % baseScenes.length] || baseScenes[0];
    const cycle = Math.floor(index / baseScenes.length);

    if (!template) {
      return {
        title: `Scene ${index + 1}`,
        narration: "This scene keeps the topic moving with a concrete visual beat.",
        searchQuery: "person using smartphone at home vertical",
        overlay: "Scene"
      };
    }

    if (cycle === 0) {
      return template;
    }

    return {
      ...template,
      title: `${template.title} ${cycle + 1}`,
      overlay: `${template.overlay} ${cycle + 1}`
    };
  });
};

const DEFAULT_AUDIO_PLAN = {
  provider: "elevenlabs",
  voiceName: "Liam",
  voiceId: "TX3LPaxmHKxFdv7VOQHJ",
  modelId: "eleven_multilingual_v2",
  voiceStyle:
    "Pt-BR documentary short-form delivery: engaged, warm, fast, curious, slightly ironic, with crisp diction and natural pauses for high-retention narration."
};

const formatSceneCountInstruction = (sceneRange, verb = "Create") =>
  sceneRange.minScenes === sceneRange.maxScenes
    ? `${verb} exactly ${sceneRange.minScenes} scenes.`
    : `${verb} ${sceneRange.minScenes} to ${sceneRange.maxScenes} scenes.`;

const sanitizeEnglishImagePrompt = (value) =>
  normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildDefaultImagePrompt = (scene = {}) => {
  const exactFrame = sanitizeEnglishSearchQuery(scene.searchQuery || scene.visualGoal || scene.title || "person reacting to a surprising technology story");
  const visualTitle = sanitizeEnglishImagePrompt(scene.title || "short documentary scene");

  return clampTextAtSentenceBoundary(
    [
      `Vertical 9:16 image for a fast-paced documentary short about ${visualTitle}.`,
      `${exactFrame}.`,
      "One clear focal subject, one concrete physical action, one specific real-world setting, strong foreground detail, mobile-first composition, varied camera angle, directional lighting, high contrast, editorial documentary mood, consistent illustration style, clean space for captions, readable at phone size, no readable text, logos, watermarks, UI labels, charts, collage, or split screen."
    ].join(" "),
    1200
  );
};

const normalizeImagePrompts = (scene = {}, backup = {}) => {
  const prompts = Array.isArray(scene?.imagePrompts)
    ? scene.imagePrompts
        .map((prompt) => clampTextAtSentenceBoundary(sanitizeEnglishImagePrompt(prompt), 1200))
        .filter((prompt) => prompt.length >= 40)
    : [];

  if (prompts.length > 0) {
    return prompts.slice(0, 4);
  }

  return [buildDefaultImagePrompt({...backup, ...scene})];
};

const normalizeAudioPlan = (audio = {}) => {
  const provider = normalizeText(audio?.provider) || DEFAULT_AUDIO_PLAN.provider;
  const voiceName = normalizeText(audio?.voiceName || audio?.voice || audio?.name) || DEFAULT_AUDIO_PLAN.voiceName;
  const voiceId = normalizeText(audio?.voiceId) || DEFAULT_AUDIO_PLAN.voiceId;
  const modelId = normalizeText(audio?.modelId) || DEFAULT_AUDIO_PLAN.modelId;
  const voiceStyle = clampTextAtSentenceBoundary(audio?.voiceStyle || audio?.style || DEFAULT_AUDIO_PLAN.voiceStyle, 320);

  return {
    provider,
    voiceName,
    voiceId,
    modelId,
    voiceStyle
  };
};

const fallbackScenes = (title, language = "pt-BR", desiredSceneCount = DEFAULT_STORYBOARD_SCENE_RANGE.maxScenes) => {
  const topic = cleanTopic(title) || title;
  const english = isEnglishLanguage(language);
  const baseScenes = english
    ? [
        {
          title: "Hook",
          narration: `Living alone can look calm from the outside, but inside the room the silence starts to feel heavier every night.`,
          searchQuery: "person sitting alone on bed in small apartment at night vertical",
          overlay: "Living alone"
        },
        {
          title: "Morning",
          narration: "Meanwhile, the day begins without anyone saying good morning, and even the kitchen feels colder than it should.",
          searchQuery: "person alone in kitchen making coffee in quiet apartment morning vertical",
          overlay: "Quiet morning"
        },
        {
          title: "Phone",
          narration: "Now, the phone lights up again, but most messages are work alerts, ads, or something that means nothing.",
          searchQuery: "close up smartphone with notifications in lonely apartment vertical",
          overlay: "Empty notifications"
        },
        {
          title: "Meals",
          narration: "In practice, eating alone every day turns dinner into a routine with no conversation, no laughter, and no pause.",
          searchQuery: "person eating dinner alone at small table in apartment vertical",
          overlay: "Dinner alone"
        },
        {
          title: "Work",
          narration: "But, when the workday ends, there is no one on the other side asking how your day really went.",
          searchQuery: "person closing laptop alone after work at home vertical",
          overlay: "After work"
        },
        {
          title: "Weekend",
          narration: "And this is where the sadness gets sharper, because weekends create empty hours that stretch across the whole room.",
          searchQuery: "person alone on couch looking around quiet apartment weekend vertical",
          overlay: "Long weekend"
        },
        {
          title: "Memories",
          narration: "And in the middle of all this, old photos, voice notes, and familiar songs can pull the chest back into places that no longer exist.",
          searchQuery: "person holding phone with old photos while sitting alone at home vertical",
          overlay: "Memories"
        },
        {
          title: "Routine",
          narration: "But look, the hardest part is not always crying, because sometimes it is acting normal while everything feels emotionally muted.",
          searchQuery: "person quietly folding laundry alone with distant expression vertical",
          overlay: "Muted feelings"
        },
        {
          title: "Night",
          narration: "And it does not stop there, because nighttime makes every sound louder and every unanswered thought harder to escape.",
          searchQuery: "person awake at night in dark bedroom alone vertical",
          overlay: "Night thoughts"
        },
        {
          title: "Comparison",
          narration: "The most interesting part is that social media can make the loneliness worse, showing full tables, couples, and crowded rooms while you scroll in silence.",
          searchQuery: "person scrolling social media alone in dark room vertical",
          overlay: "Comparison"
        },
        {
          title: "Body",
          narration: "And you know what else? The body feels it too, with tired eyes, low energy, and a strange heaviness that follows the whole day.",
          searchQuery: "close up tired person alone by window in apartment vertical",
          overlay: "The body feels it"
        },
        {
          title: "Truth",
          narration: "The problem is that people often confuse living alone with being strong, when sometimes it is simply surviving one quiet day after another.",
          searchQuery: "person standing alone by window looking outside reflective vertical",
          overlay: "Hidden weight"
        },
        {
          title: "Relief",
          narration: "But wait, healing can begin in small ways, like calling one friend, leaving the house, or letting somebody know the silence is hurting.",
          searchQuery: "person making phone call for support while alone at home vertical",
          overlay: "Small relief"
        },
        {
          title: "Close",
          narration: "There is more, because living alone does not need to become emotional exile when connection is rebuilt one honest step at a time.",
          searchQuery: "person stepping outside apartment into daylight hopeful vertical",
          overlay: "One step at a time"
        }
      ]
    : [
        {
          title: "Hook",
          narration: `Se você quer entender ${topic}, começa por uma imagem simples: a tecnologia já está entrando na rotina sem pedir licença.`,
          searchQuery: "person using smartphone at home vertical",
          overlay: "Atenção"
        },
        {
          title: "Primeiro sinal",
          narration: "Ao mesmo tempo, o primeiro sinal aparece no bolso, porque o celular virou mapa, banco, agenda e balcão de atendimento na mesma tela.",
          searchQuery: "person checking smartphone app vertical",
          overlay: "No bolso"
        },
        {
          title: "Trabalho",
          narration: "Só que essa mudança não fica no celular. Ela entra no trabalho, acelera tarefas repetidas e muda o ritmo de equipes inteiras.",
          searchQuery: "office team using laptops vertical",
          overlay: "No trabalho"
        },
        {
          title: "Compras",
          narration: "Agora isso também aparece nas compras, com recomendações, pagamentos rápidos e entregas que parecem quase instantâneas.",
          searchQuery: "woman paying with smartphone in store vertical",
          overlay: "Nas compras"
        },
        {
          title: "Saúde",
          narration: "E na saúde o efeito fica ainda mais claro, porque sensores, exames digitais e acompanhamento remoto já começam a encurtar distâncias.",
          searchQuery: "doctor using tablet with patient vertical",
          overlay: "Na saúde"
        },
        {
          title: "Casa",
          narration: "Ao mesmo tempo, a casa deixa de ser só casa e passa a responder a comandos, horários e preferências quase sem esforço.",
          searchQuery: "smart home woman using phone vertical",
          overlay: "Em casa"
        },
        {
          title: "Cidade",
          narration: "Na rua, o impacto chega no trânsito, na energia e na forma como as cidades tentam funcionar com mais precisão.",
          searchQuery: "smart city traffic aerial vertical",
          overlay: "Na cidade"
        },
        {
          title: "Educação",
          narration: "Só que a mudança também passa pelo aprendizado, porque estudar deixou de depender de um único lugar ou de um único horário.",
          searchQuery: "student studying on laptop at home vertical",
          overlay: "Aprender"
        },
        {
          title: "Comunicação",
          narration: "Agora até conversar mudou, com tradução, resumo, pesquisa e organização a acontecer em segundos dentro das mesmas apps.",
          searchQuery: "person video calling on phone vertical",
          overlay: "Conversar"
        },
        {
          title: "Segurança",
          narration: "E é aqui que surge o alerta: quanto mais sistemas entendem hábitos, mais importante fica proteger dados e acessos.",
          searchQuery: "person enabling phone security vertical",
          overlay: "Alerta"
        },
        {
          title: "Mercado",
          narration: "No mercado, isso separa quem testa cedo de quem chega atrasado, porque a vantagem passa a ser adaptação rápida.",
          searchQuery: "business meeting with screen data vertical",
          overlay: "Mercado"
        },
        {
          title: "Rotina",
          narration: "Ao mesmo tempo, a rotina muda em detalhes pequenos, como pedir transporte, marcar consulta ou resolver documentos sem filas longas.",
          searchQuery: "person booking service on smartphone vertical",
          overlay: "Rotina"
        },
        {
          title: "Pessoas",
          narration: "Só que nada disso funciona de verdade sem pessoas, porque a tecnologia só ganha valor quando resolve dor real do dia a dia.",
          searchQuery: "close up person smiling using phone vertical",
          overlay: "Pessoas"
        },
        {
          title: "Fecho",
          narration: `Por isso, ${topic} não é sobre ficção distante. É sobre mudanças silenciosas que começam pequenas e, quando se nota, já viraram normalidade.`,
          searchQuery: "content creator talking to camera vertical",
          overlay: "Novo normal"
        }
      ];

  return expandFallbackScenes(
    baseScenes.map((scene) => ({
      ...scene,
      searchQuery: normalizeText(scene.searchQuery)
        .replace(/\b(vertical|portrait)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim(),
      imagePrompts: normalizeImagePrompts(scene, scene)
    })),
    desiredSceneCount
  );
};

const ensureHashtags = (hashtags) => {
  if (!Array.isArray(hashtags)) {
    return null;
  }

  const normalized = hashtags
    .map((tag) => normalizeText(tag))
    .filter(Boolean)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`));

  return normalized.length >= 3 ? normalized.slice(0, 8) : null;
};

const normalizeStoryboard = (
  input,
  title,
  language = "pt-BR",
  sceneRange = DEFAULT_STORYBOARD_SCENE_RANGE,
  desiredDurationSeconds = OUTPUT_PROFILE.defaultTargetSeconds
) => {
  const fallback = fallbackStoryboard(
    title,
    language,
    Math.max(sceneRange.minScenes, getRecommendedSceneCountForDuration(OUTPUT_PROFILE.id, desiredDurationSeconds))
  );
  const sourceScenes = Array.isArray(input?.scenes) ? input.scenes : fallback.scenes;
  const scenes = sourceScenes.slice(0, sceneRange.maxScenes).map((scene, index) => {
    const backup = fallback.scenes[index % fallback.scenes.length];
    const searchQuery =
      clampTextAtWordBoundary(sanitizeEnglishSearchQuery(scene?.searchQuery), SEARCH_QUERY_MAX_LENGTH) ||
      backup.searchQuery;

    return {
      title: clampText(scene?.title, 80) || backup.title,
      narration: clampText(sanitizeNarrationLine(scene?.narration, backup.narration), 520),
      searchQuery,
      overlay: clampText(
        pickSceneOverlay({
          overlay: scene?.overlay,
          title: scene?.title || backup.title,
          narration: scene?.narration || backup.narration,
          fallbackOverlay: backup.overlay
        }),
        80
      ) || backup.overlay,
      imagePrompts: normalizeImagePrompts(scene, {...backup, searchQuery})
    };
  });

  while (scenes.length < sceneRange.minScenes) {
    const backup = fallback.scenes[scenes.length % fallback.scenes.length];
    scenes.push({
      title: backup.title,
      narration: backup.narration,
      searchQuery: backup.searchQuery,
      overlay: backup.overlay,
      imagePrompts: normalizeImagePrompts(backup, backup)
    });
  }

  return {
    videoTitle: clampText(input?.videoTitle, 160) || fallback.videoTitle,
    hook: clampText(input?.hook, 220) || fallback.hook,
    postCaption: clampText(input?.postCaption, 500) || fallback.postCaption,
    hashtags: ensureHashtags(input?.hashtags) || fallback.hashtags,
    cta: clampText(input?.cta, 120),
    audio: normalizeAudioPlan(input?.audio || fallback.audio),
    thumbnailPrompt: clampTextAtSentenceBoundary(input?.thumbnailPrompt, 2000) || "",
    scenes: scenes.length >= sceneRange.minScenes ? scenes : fallback.scenes
  };
};

export const fallbackStoryboard = (title, language = "pt-BR", desiredSceneCount = DEFAULT_STORYBOARD_SCENE_RANGE.maxScenes) => {
  const safeSceneCount = Math.max(1, Number(desiredSceneCount) || DEFAULT_STORYBOARD_SCENE_RANGE.maxScenes);

  if (isEnglishLanguage(language)) {
    return {
      videoTitle: title,
      hook:
        OUTPUT_PROFILE.layout === "horizontal"
          ? "Living alone can look peaceful online while the silence quietly gets heavier in real life."
          : "Living alone can look peaceful online while the silence quietly gets heavier in real life.",
      postCaption: `A reflective ${OUTPUT_PROFILE.layout === "horizontal" ? "long-form video" : "short"} about how loneliness grows inside everyday routines when someone is living alone.`,
      hashtags:
        OUTPUT_PROFILE.layout === "horizontal"
          ? ["#loneliness", "#livingalone", "#mentalhealth", "#youtube"]
          : ["#loneliness", "#livingalone", "#mentalhealth", "#shorts"],
      cta: "",
      audio: DEFAULT_AUDIO_PLAN,
      thumbnailPrompt: "",
      scenes: fallbackScenes(title, language, safeSceneCount)
    };
  }

  return {
    videoTitle: title,
    hook:
      OUTPUT_PROFILE.layout === "horizontal"
        ? `Se você quer entender ${cleanTopic(title) || title}, começa por uma imagem simples: a ideia principal precisa aparecer logo na tela.`
        : "Se o seu vídeo não prende nos primeiros segundos, você já perdeu boa parte da audiência.",
    postCaption: `Um formato simples e barato para transformar ${title} num ${OUTPUT_PROFILE.layout === "horizontal" ? "vídeo longo" : "short"} que parece nativo da plataforma.`,
    hashtags:
        OUTPUT_PROFILE.layout === "horizontal"
          ? ["#youtube", "#video", "#conteudo", "#criadores"]
          : ["#tiktoktips", "#shorts", "#reels", "#conteudo"],
    cta: "",
    audio: DEFAULT_AUDIO_PLAN,
    thumbnailPrompt: "",
    scenes: fallbackScenes(title, language, safeSceneCount)
  };
};

const baseHeaders = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "HTTP-Referer": "https://localhost/codex-videos",
  "X-Title": "codex-videos"
});

const GEMINI_REQUEST_TIMEOUT_MS = Math.max(
  30000,
  Number.parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || "90000", 10) || 90000
);
const GEMINI_MAX_RETRIES = Math.max(
  0,
  Number.parseInt(process.env.GEMINI_MAX_RETRIES || "2", 10) || 2
);

const GEMINI_BACKOFF_BASE_MS = 4000;
const GEMINI_BACKOFF_MAX_MS = 120000;

const computeGeminiRetryDelayMs = (attempt) => {
  const exponentialDelay = GEMINI_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt);
  const jitterMs = Math.floor(Math.random() * 2000);
  return Math.min(GEMINI_BACKOFF_MAX_MS, exponentialDelay + jitterMs);
};

const isRetryableGeminiStatus = (status) => status === 408 || status === 409 || status === 429 || status >= 500;

const isRetryableGeminiError = (error) => {
  const message = String(error?.message ?? error ?? "")
    .trim()
    .toLowerCase();

  if (!message) {
    return false;
  }

  return (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("aborted") ||
    message.includes("status 408") ||
    message.includes("status 409") ||
    message.includes("status 429") ||
    message.includes("status 500") ||
    message.includes("status 502") ||
    message.includes("status 503") ||
    message.includes("status 504")
  );
};

const extractContent = async (response) => {
  if (!response.ok) {
    throw new Error(`OpenRouter falhou com status ${response.status}.`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  return Array.isArray(content)
    ? content
        .map((item) => item?.text ?? "")
        .join("\n")
        .trim()
    : String(content ?? "").trim();
};

const callOpenRouter = async ({apiKey, model, temperature, messages}) => {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: baseHeaders(apiKey),
    body: JSON.stringify({
      model,
      temperature,
      messages
    })
  });

  return extractContent(response);
};

const callZai = async ({apiKey, model, temperature, messages}) => {
  const systemParts = [];
  const nonSystemMessages = [];

  for (const msg of messages) {
    const text = Array.isArray(msg.content)
      ? msg.content.map((item) => item?.text ?? "").join("\n").trim()
      : String(msg.content ?? "").trim();

    if (msg.role === "system") {
      systemParts.push(text);
    } else {
      nonSystemMessages.push({role: msg.role, content: text});
    }
  }

  if (systemParts.length > 0 && nonSystemMessages.length > 0 && nonSystemMessages[0].role === "user") {
    nonSystemMessages[0].content = `${systemParts.join("\n\n")}\n\n${nonSystemMessages[0].content}`;
  }

  const response = await fetch("https://api.z.ai/api/coding/paas/v4/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "glm-5",
      max_tokens: 8192,
      messages: nonSystemMessages.map(m => ({role: m.role, content: m.content}))
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => ""); /* expected: body may be unreadable */
    throw new Error(`Z.ai falhou com status ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  return String(content ?? "").trim();
};

const callCodex = async ({model, schema, messages, cwd}) => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "videos-envato-codex-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "output.json");

  try {
    await writeFile(schemaPath, JSON.stringify(schema));

    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--color",
      "never",
      "-c",
      'model_reasoning_effort="low"',
      "-C",
      cwd || process.cwd(),
      "--output-schema",
      schemaPath,
      "-o",
      outputPath
    ];

    if (String(model || "").trim()) {
      args.push("-m", String(model).trim());
    }

    args.push(messagesToPrompt(messages));

    const result = spawnSync("codex", args, {
      encoding: "utf8",
      stdio: "pipe"
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || result.stdout?.trim() || "Codex falhou.");
    }

    const raw = await readFile(outputPath, "utf8");

    if (!raw.trim()) {
      throw new Error("Codex nao devolveu JSON.");
    }

    return JSON.parse(raw);
  } finally {
    await rm(tempDir, {recursive: true, force: true});
  }
};

const parseOpenRouterJson = async ({text, apiKey, model, repairProvider = "openrouter"}) => {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch (error) {
    if (!apiKey || !["openrouter", "zai", "gemini"].includes(repairProvider)) {
      throw error;
    }

    const repairMessages = buildJsonRepairMessages(text);
    const repairedText =
      repairProvider === "zai"
        ? await callZai({apiKey, model: "", temperature: 0, messages: repairMessages})
        : repairProvider === "gemini"
          ? await callGemini({apiKey, model, messages: repairMessages, jsonMode: true, usageContext: "json-repair"})
          : await callOpenRouter({apiKey, model, temperature: 0, messages: repairMessages});

    return JSON.parse(extractJsonObject(repairedText));
  }
};

const callVertexGemini = async ({model, messages, jsonMode = false, responseSchema, usageContext = "unspecified"}) => {
  const systemParts = [];
  const userParts = [];
  const gcpConfig = resolveGcpConfig(process.env);
  const selectedModel = String(model || gcpConfig.storyModel || "gemini-2.5-flash").trim();
  const endpoint = `https://${gcpConfig.location}-aiplatform.googleapis.com/v1/projects/${gcpConfig.projectId}/locations/${gcpConfig.location}/publishers/google/models/${selectedModel}:generateContent`;

  for (const msg of messages) {
    const text = Array.isArray(msg.content)
      ? msg.content.map((item) => item?.text ?? "").join("\n").trim()
      : String(msg.content ?? "").trim();
    if (msg.role === "system") {
      systemParts.push(text);
    } else {
      userParts.push(text);
    }
  }

  let lastError = null;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      const signal =
        typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS) : undefined;
      const accessToken = await getGcpAccessToken();

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          systemInstruction: systemParts.length > 0 ? {parts: [{text: systemParts.join("\n\n")}]} : undefined,
          contents: [{role: "user", parts: [{text: userParts.join("\n\n")}]}],
          generationConfig: withThinkingDisabled(
            jsonMode
              ? {
                  temperature: 0,
                  responseMimeType: "application/json",
                  ...(responseSchema ? {responseSchema} : {})
                }
              : {
                  temperature: 0
                },
            selectedModel
          )
        }),
        signal
      });

      if (!response.ok) {
        const err = await response.text().catch(() => ""); /* expected: body may be unreadable */
        const failure = new Error(`Vertex Gemini falhou com status ${response.status}: ${err.slice(0, 240)}`);

        if (!isRetryableGeminiStatus(response.status) || attempt >= GEMINI_MAX_RETRIES) {
          throw failure;
        }

        lastError = failure;
        await wait(computeGeminiRetryDelayMs(attempt));
        continue;
      }

      const payload = await response.json();
      recordGeminiUsage(geminiUsageSummary, {
        model: payload?.modelVersion || selectedModel,
        usageMetadata: payload?.usageMetadata,
        context: usageContext
      });
      const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
        ? payload.candidates[0].content.parts
        : [];

      return parts
        .map((part) => part?.text ?? "")
        .join("\n")
        .trim();
    } catch (error) {
      lastError = error;

      if (!isRetryableGeminiError(error) || attempt >= GEMINI_MAX_RETRIES) {
        throw error;
      }

      await wait(computeGeminiRetryDelayMs(attempt));
    }
  }

  throw lastError || new Error("Vertex Gemini falhou sem resposta.");
};

const parseVertexJson = async ({text, model}) => {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch (error) {
    const repairedText = await callVertexGemini({
      model,
      messages: buildJsonRepairMessages(text),
      jsonMode: true,
      usageContext: "json-repair"
    });
    return JSON.parse(extractJsonObject(repairedText));
  }
};

const callGemini = async ({apiKey, model, messages, jsonMode = false, responseSchema, usageContext = "unspecified"}) => {
  const systemParts = [];
  const userParts = [];
  const sanitizedResponseSchema = responseSchema ? sanitizeGeminiResponseSchema(responseSchema) : undefined;

  for (const msg of messages) {
    const text = Array.isArray(msg.content)
      ? msg.content.map((item) => item?.text ?? "").join("\n").trim()
      : String(msg.content ?? "").trim();
    if (msg.role === "system") {
      systemParts.push(text);
    } else {
      userParts.push(text);
    }
  }

  let lastError = null;

  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      const signal =
        typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS) : undefined;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            systemInstruction: systemParts.length > 0 ? {parts: [{text: systemParts.join("\n\n")}]} : undefined,
            contents: [{parts: [{text: userParts.join("\n\n")}]}],
            generationConfig: withThinkingDisabled(
              jsonMode
                ? {
                    temperature: 0,
                    responseMimeType: "application/json",
                    ...(sanitizedResponseSchema ? {responseSchema: sanitizedResponseSchema} : {})
                  }
                : {
                    temperature: 0
                  },
              model
            )
          }),
          signal
        }
      );

      if (!response.ok) {
        const err = await response.text().catch(() => ""); /* expected: body may be unreadable */
        const failure = new Error(`Gemini falhou com status ${response.status}: ${err.slice(0, 200)}`);

        if (!isRetryableGeminiStatus(response.status) || attempt >= GEMINI_MAX_RETRIES) {
          throw failure;
        }

        lastError = failure;
        await wait(computeGeminiRetryDelayMs(attempt));
        continue;
      }

      const payload = await response.json();
      recordGeminiUsage(geminiUsageSummary, {
        model: payload?.modelVersion || model,
        usageMetadata: payload?.usageMetadata,
        context: usageContext
      });
      const parts = Array.isArray(payload?.candidates?.[0]?.content?.parts)
        ? payload.candidates[0].content.parts
        : [];

      return parts
        .map((part) => part?.text ?? "")
        .join("\n")
        .trim();
    } catch (error) {
      lastError = error;

      if (!isRetryableGeminiError(error) || attempt >= GEMINI_MAX_RETRIES) {
        throw error;
      }

      await wait(computeGeminiRetryDelayMs(attempt));
    }
  }

  throw lastError || new Error("Gemini falhou sem resposta.");
};

export const resetGeminiUsageSummary = () => {
  geminiUsageSummary = createGeminiUsageSummary();
};

export const getGeminiUsageSummary = () => JSON.parse(JSON.stringify(geminiUsageSummary));

export const callJsonProvider = async ({provider, apiKey, model, messages, schema, cwd, usageContext = "json-provider"}) => {
  const selectedProvider = resolveLlmProvider(provider);

  if (selectedProvider === "vertex") {
    const selectedModel = String(model || process.env.STORY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
    const rawText = await callVertexGemini({
      model: selectedModel,
      messages,
      jsonMode: true,
      responseSchema: schema,
      usageContext
    });

    return parseVertexJson({text: rawText, model: selectedModel});
  }

  if (selectedProvider === "codex") {
    return callCodex({
      model,
      schema,
      messages,
      cwd
    });
  }

  if (selectedProvider === "kiro") {
    throw new Error("kiro-cli ainda nao tem exec nao interativo estavel nesta maquina; usa Codex por agora.");
  }

  if (selectedProvider === "zai") {
    const zaiKey = process.env.ZAI_API_KEY;

    if (!zaiKey) {
      throw new Error("ZAI_API_KEY em falta para provider=zai.");
    }

    const rawText = await callZai({
      apiKey: zaiKey,
      model: process.env.ZAI_MODEL || "",
      temperature: 0.1,
      messages
    });

    return parseOpenRouterJson({text: rawText, apiKey: zaiKey, model: "zai", repairProvider: "zai"});
  }

  if (selectedProvider === "gemini") {
    const geminiKey = process.env.GOOGLE_API_KEY;
    if (!geminiKey) throw new Error("GOOGLE_API_KEY em falta para provider=gemini.");

    const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const rawText = await callGemini({
      apiKey: geminiKey,
      model: geminiModel,
      messages,
      jsonMode: true,
      responseSchema: schema,
      usageContext
    });

    return parseOpenRouterJson({text: rawText, apiKey: geminiKey, model: geminiModel, repairProvider: "gemini"});
  }

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY em falta para provider=openrouter.");
  }

  const rawText = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.1,
    messages
  });

  return parseOpenRouterJson({text: rawText, apiKey, model, repairProvider: "openrouter"});
};

const requestedShape = JSON.stringify({
  videoTitle: "string",
  hook: "string",
  postCaption: "string",
  hashtags: ["#one", "#two", "#three"],
  cta: "string",
  audio: {
    provider: "elevenlabs",
    voiceName: "Liam",
    voiceId: "TX3LPaxmHKxFdv7VOQHJ",
    modelId: "eleven_multilingual_v2",
    voiceStyle: "string"
  },
  thumbnailPrompt: "string",
  scenes: [
    {
      title: "string",
      narration: "string",
      searchQuery: "string",
      overlay: "string",
      imagePrompts: ["string"]
    }
  ]
});

const buildFormatGuidance = () =>
  OUTPUT_PROFILE.layout === "horizontal"
    ? `Create a ${OUTPUT_FORMAT_DESCRIPTION}. Keep scenes broader, let ideas breathe a little more, and avoid short-form wording like "shorts" or "vertical".`
    : `Create a ${OUTPUT_FORMAT_DESCRIPTION}. Keep the pacing punchy, concise, and optimized for short-form retention.`;

const buildVisualStyleGuidance = (imageStyleHint) => {
  const hint = String(imageStyleHint || "").trim().toLowerCase();
  if (!hint || hint === "claude" || hint === "kiro") {
    return {
      styleDescription: "minimalist stick figure illustration: simple line art characters with thin black lines, large round heads, and flat colored icons or objects. Think corporate memphis meets stick figure animation on a white background.",
      preferredConcepts: "Prefer visual concepts that work as simple flat illustrations: a person at a desk, someone holding a phone, a laptop with a blank screen, coins or money symbols, a simple house, a clock, arrows pointing up, a lightbulb, simple icons floating around a character.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a simple everyday scene that can be drawn as a stick figure illustration.",
      generalPreference: "Prefer people interacting with objects, simple devices, everyday scenes, workspaces, homes, and iconic symbols that convey the idea visually.",
      searchQueryExample: "stick figure character at a messy desk surrounded by floating paper icons and clock symbols, overwhelmed expression, flat white background"
    };
  }
  if (hint === "ink") {
    return {
      styleDescription: "editorial ink illustration with crisp black brushwork, strong contrast, graphic shadow masses, clean paper background, and controlled negative space. Think premium editorial magazine art with bold silhouettes.",
      preferredConcepts: "Prefer visual concepts that work as bold ink illustrations: a person with confident silhouette, hands interacting with objects, strong figure-ground separation, dramatic ink shadow masses, and clean readable compositions.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a concrete human scene with bold ink rendering and strong visual contrast.",
      generalPreference: "Prefer people with clear silhouettes, strong postures, crisp ink objects, and editorial framing with generous negative space.",
      searchQueryExample: "editorial ink illustration of a person holding a solar panel with bold black brushwork, strong contrast, clean paper background, dramatic shadow masses, no text"
    };
  }
  if (hint === "realistic_film") {
    return {
      styleDescription: "cinematic realistic film still with natural light, documentary realism, subtle color grading, real-world textures, and shallow depth of field. Think premium documentary photography.",
      preferredConcepts: "Prefer visual concepts that work as realistic film stills: a real person at a desk, hands on a device, natural environments, believable textures, and grounded human moments.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a believable real-world scene with natural lighting and grounded human behavior.",
      generalPreference: "Prefer realistic people in natural settings, real objects, documentary-style framing, and premium cinematic composition.",
      searchQueryExample: "cinematic film still of a person installing solar panels on a rooftop, natural golden hour light, documentary realism, shallow depth of field, no text"
    };
  }
  if (hint === "editorial_clean") {
    return {
      styleDescription: "clean editorial illustration with modern explainer art, crisp shapes, restrained palette, light neutral background, and high clarity. Think modern infographic meets editorial magazine art.",
      preferredConcepts: "Prefer visual concepts that work as clean editorial illustrations: simplified human figures, clear object hierarchy, one proof visual per scene, and restrained color palette.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a clean editorial illustration with one clear focal subject and readable objects.",
      generalPreference: "Prefer simplified editorial humans, crisp shapes, one main object or proof visual, and clean compositions with high readability.",
      searchQueryExample: "clean editorial illustration of a person comparing two energy sources side by side, crisp shapes, restrained palette, light background, no text"
    };
  }
  if (hint === "cartoon_3d") {
    return {
      styleDescription: "stylized 3D cartoon render with soft volumetric lighting, rounded shapes, clean materials, and a vibrant but controlled palette. Think Pixar-quality animated short frame.",
      preferredConcepts: "Prefer visual concepts that work as 3D cartoon renders: rounded friendly characters, colorful props, charming actions, and clean staging like an animated film frame.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a charming 3D cartoon scene with friendly characters and readable props.",
      generalPreference: "Prefer stylized 3D characters with expressive faces, rounded forms, clean materials, and polished animated-short composition.",
      searchQueryExample: "stylized 3D cartoon render of a cheerful character holding a glowing solar panel on a rooftop, soft volumetric lighting, rounded forms, vibrant palette, no text"
    };
  }
  if (hint === "punk") {
    return {
      styleDescription: "punk editorial poster illustration with raw collage energy, torn-paper layers, rough ink texture, bold black shapes, dirty off-white paper, and sharp red accents. Think rebellious street poster art.",
      preferredConcepts: "Prefer visual concepts that work as punk poster compositions: one dominant hero subject, raw collage layers, bold shapes, aggressive framing, and immediate visual impact.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a rebellious punk poster frame with one dominant subject and raw editorial energy.",
      generalPreference: "Prefer bold hero subjects, torn-edge collage textures, strong poster-like impact, and aggressive short-form compositions.",
      searchQueryExample: "punk editorial poster of a giant solar panel crushing oil barrels, raw collage texture, torn paper layers, bold black shapes, sharp red accents, dirty paper background, no text"
    };
  }
  if (hint === "editorial_line_green") {
    return {
      styleDescription: "black and white editorial line art illustration with subtle green accents, refined pen drawing, modern magazine look, crisp contour lines, and detailed environmental storytelling.",
      preferredConcepts: "Prefer visual concepts that work as detailed line art: editorial humans in rich environments, practical room details, clear object hierarchy, and subtle green accent highlights.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a detailed line art scene with environmental storytelling and practical objects.",
      generalPreference: "Prefer editorial line art humans with natural proportions, detailed lived-in environments, and crisp pen drawing with selective green accents.",
      searchQueryExample: "editorial line art illustration of a person on a rooftop installing solar panels with detailed environment, crisp black contour lines, subtle green accents on the panels, no text"
    };
  }
  if (hint === "urban_sketching") {
    return {
      styleDescription: "urban sketchbook illustration with ink line drawing, light watercolor wash, observational drawing feel, travel journal energy, and handmade imperfections.",
      preferredConcepts: "Prefer visual concepts that work as urban sketches: hand-drawn scenes, loose ink lines, watercolor washes, observational everyday moments, and sketchbook texture.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a hand-drawn sketchbook scene with observational rhythm and watercolor energy.",
      generalPreference: "Prefer hand-drawn sketchbook figures, lively ink lines, light watercolor washes, and observational compositions with paper texture.",
      searchQueryExample: "urban sketchbook illustration of workers installing solar panels, lively ink lines, light watercolor wash, observational drawing feel, paper texture, no text"
    };
  }
  if (hint === "time_split_bold") {
    return {
      styleDescription: "bold editorial comparison illustration with one dominant hero object, clear past-versus-present contrast, high-contrast shapes, controlled accent colors, and strong mobile-first composition.",
      preferredConcepts: "Prefer visual concepts that work as bold comparison illustrations: one hero object dominating the frame, clear antique-versus-modern contrast, strong negative space, and immediate mobile readability.",
      complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a bold comparison frame with one hero object and clear past-versus-present visual contrast.",
      generalPreference: "Prefer dominant hero objects, clear comparison beats, high-contrast editorial shapes, and bold mobile-first framing.",
      searchQueryExample: "bold editorial comparison of a tiny coal power plant next to a massive modern solar farm, dominant hero object, clear past-versus-present contrast, high contrast, no text"
    };
  }
  // fallback to stick figure
  return {
    styleDescription: "minimalist stick figure illustration: simple line art characters with thin black lines, large round heads, and flat colored icons or objects.",
    preferredConcepts: "Prefer visual concepts that work as simple flat illustrations: a person at a desk, someone holding a phone, a laptop with a blank screen, coins or money symbols.",
    complexTopicRule: "If the title is about future technology or complex topics, translate each idea into a simple everyday scene that can be drawn as a stick figure illustration.",
    generalPreference: "Prefer people interacting with objects, simple devices, everyday scenes, workspaces, homes, and iconic symbols that convey the idea visually.",
    searchQueryExample: "stick figure character at a messy desk surrounded by floating paper icons and clock symbols, overwhelmed expression, flat white background"
  };
};

const buildGenerationMessages = ({title, language, desiredDurationSeconds, sourceText, scriptGuidance, imageStyleHint}) => {
  const visualStyle = buildVisualStyleGuidance(imageStyleHint);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);
  return [
    {
      role: "system",
      content:
      `Return valid JSON only. Do not include markdown. If the language is pt-BR, write only in Brazilian Portuguese and avoid European Portuguese wording. ${buildFormatGuidance()} Writing style rules: write as if you are a friend telling a fascinating true story to the viewer. Use short punchy sentences, one idea per sentence. Each sentence must describe something visually concrete that an illustration can show. Use surprising facts and numbers to hook attention. If you use rhetorical questions, use them sparingly and never as the opening hook. Avoid abstract or philosophical sentences that have no clear visual representation. Every narration line must paint a picture the viewer can see. Prefer present tense. Use direct address sparingly, and never turn the script into advice, coaching, or a self-help lesson. Never depend on sci-fi, CGI, Mars rovers, impossible quantum-computer shots, abstract holograms, or lab concepts that are hard to illustrate. Every scene must include imagePrompts with at least one highly detailed image-generation prompt.`
  },
  {
    role: "user",
    content: [
      // --- CRITICAL RULES (top of prompt for primacy) ---
      (() => {
        const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);

        return `Narration target: ${minWords} to ${maxWords} words total.`;
      })(),
      `Language: ${language}`,
      `Title: ${title}`,
      `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
      formatSceneCountInstruction(sceneRange, "Create"),
      "For a 60-second vertical Short, the default structure is exactly 12 fast-paced scenes: hook, context, fear/conflict, mechanism, resistance, first validation, adoption, backlash, turning point, consequence, today contrast, payoff.",
      "Each searchQuery must use ASCII English only: plain Latin letters, numbers, spaces, and hyphens. Never mix Portuguese, Chinese, emojis, or non-Latin characters.",
      "Every scene must include imagePrompts with 1 to 4 English prompts. Each image prompt must be optimized for AI image generation and include: subject, action, setting, composition/framing, camera angle or lens language, lighting, visual style/material, mood, mobile 9:16 readability, and negative constraints for text/logos/watermarks.",
      NO_ENGLISH_VISUAL_TEXT_RULE,
      BLANK_UI_VISUAL_RULE,
      "imagePrompts must be more detailed than searchQuery. searchQuery is a compact stock/image lookup; imagePrompts is the direct image-generation prompt.",
      "Each image prompt must describe one coherent frame only. Do not cram a sequence, multiple locations, collage, split-screen, charts, UI labels, or readable text into one prompt.",
      "The audio object must specify ElevenLabs with the locked short-form voice Liam: provider elevenlabs, voiceName Liam, voiceId TX3LPaxmHKxFdv7VOQHJ, modelId eleven_multilingual_v2, and a short voiceStyle for fast, high-retention short-form storytelling.",
      "Each searchQuery must avoid readable text inside devices, interfaces, signs, emails, buttons, documents, or alerts. Never write phrases like 'Access Denied', 'Update Now', 'error message', headlines, notification copy, button labels, links on screen, or form fields. Describe blank panels, warning icons, abstract alerts, or lock symbols instead.",
      "Never include literal button labels or quoted UI words like 'Update', 'Login', 'Verify', or 'Allow' in any searchQuery.",
      "Never ask for split-screen, collage, triptych, montage, or several disconnected countries or rooms inside one generated image. One frame must show one place, one main subject, and one action.",
      "Never describe a sequence, several people, or multiple device types inside one searchQuery. Avoid phrases like 'sequence of different people', 'hands on keyboards smartphones and tablets', or 'many users at once'.",
      "Set cta to an empty string.",
      "Do not start scenes with filler connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",

      // --- NARRATION STRUCTURE ---
      "Each narration line must be concrete, easy to understand, visually specific, and long enough for the full script to reach the target duration.",
      "Each narration line must describe something a viewer can SEE in an illustration: a person, an object, an action, a place. Avoid abstract concepts without visual anchors.",
      "Use short sentences. One sentence per visual idea. If a sentence has two ideas, split it into two scenes.",
      "Each narration line must be a complete spoken sentence.",
      "The narration must flow like one continuous voiceover without forced transition crutches.",
      "Never start a scene with loose continuation fragments like 'ou um menu', 'e uma tela', 'mas um detalhe' or any other incomplete phrase.",
      "Avoid robotic list formatting. Make it sound like one person is guiding the viewer from one idea to the next.",
      "Use a strong factual hook, but do not include CTA in the narration.",
      "The hook must be a sharp, surprising statement that creates immediate curiosity — never a generic intro, a question, a lecture, or direct advice to the viewer. Use irony, contradiction, a before-and-after contrast, or a surprising reversal. Example patterns: 'X parecia ridiculo... hoje domina tudo', 'A coisa mais banal virou a engrenagem do mundo', 'Chamaram X de inutil... e estavam olhando para a proxima revolucao'.",
      "When the source material contains a concrete number, date, scale metric, or hard fact, use the strongest one in the hook together with the core irony or contradiction.",
      "Do not end the hook or the final scene with moral-of-the-story wording, self-help framing, or lessons directed at the viewer. Let the ironic fact or consequence land by itself.",
      "Do not drop memorable source beats like typed test strings, throwaway lines, tiny notes, whispered reactions, or awkward human details when the source material includes them.",

      // --- VISUAL STYLE ---
      `The visual style is ${visualStyle.styleDescription}`,
      visualStyle.preferredConcepts,
      visualStyle.complexTopicRule,
      visualStyle.generalPreference,

      // --- SCENE VARIETY ---
      "Every scene title must be unique. Never reuse the same title for two different scenes. If two scenes cover related beats, differentiate their titles clearly — for example, instead of two scenes called 'A Queda', use 'O Preço Antigo' and 'O Preço Hoje'.",
      "Alternate scene types to create visual rhythm and dynamism. Follow a contrast pattern across scenes: human scene (person doing something) → symbolic scene (object or metaphor illustrating the point) → institutional/environmental scene (building, landscape, or wide context) → back to human. Never place three consecutive scenes of the same type. For example, avoid three scenes in a row showing a person at a desk — instead interleave with a symbolic shot (hand tossing old price tag in the trash) or an environmental shot (solar panels on rooftops across a neighbourhood).",
      "Across scenes, vary the environment, object, and staging. Do not repeat the same person-at-desk setup unless the topic truly stays in the same moment.",
      "Across the whole storyboard, avoid more than three desk-or-laptop scenes total unless the title is specifically about office workflow.",
      "Search queries must vary camera viewpoint and staging across scenes when possible: mix wider scene context, device-led shots, hands interacting with objects, side views, over-the-shoulder views, and top-down desk moments instead of repeating the same straight-on framing.",
      "Avoid scene plans that become one abstract category per scene.",
      "Do not inject unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",

      // --- RETENTION, HOOK & LOOP (engagement, SPEC v2) ---
      "HOOK decided in under 1 second: the first scene must open with a visual jolt and a first spoken line that is an incomplete or shocking statement opening a curiosity gap. No greeting, no channel intro, no slow build. The opening words must carry the single most surprising true fact or sharpest contradiction of the whole story.",
      "FACT INTEGRITY: never state an urban legend or unverified myth as fact. If a striking claim is actually a popular myth, reframe it to the closest defensible truth. The hook must be literally true — a hook that lies wins the first 3 seconds but kills completion and earns negative comments.",
      "LOOP / CALLBACK (replays are the strongest ranking signal): the final scene's last narration line must be a callback that gives the opening line new meaning, so a viewer who restarts feels the beginning now explains the end. The last visual must echo the opening/thumbnail composition (same recurring character or framing). Never end on a generic or moral closer.",
      "RETENTION DENSITY: every scene must end on a micro-curiosity that pulls the viewer into the next one. Place one mid-video spike — the single most shocking number or reversal — around the middle to re-grab attention. Use at most two or three big turns in one story; more is exhausting.",
      "CUT CADENCE: in the first third of the video keep visual changes fast (a new image roughly every 1.3 to 2.0 seconds). For the opening scenes provide 2 to 3 imagePrompts so the editor can cut quickly; later scenes may use 1 to 2.",
      "REPLAY BAIT: include exactly one tiny visual detail that is too fast to catch on first watch (describe it in one scene's imagePrompts) to reward a rewatch, without breaking comprehension.",
      "MUTED VIEWING: most viewers watch on mute, so write the narration so the burned-in captions alone carry the hook and the payoff. The opening line must deliver the hook by itself even with no sound.",

      // --- CRITICAL RULES (end of prompt for recency) ---
      "Avoid abstract visuals.",
      "Do not create icon-only scenes. Every scene must feel like a real illustrated moment with a person, object, action, or physical setting, not a floating symbol on empty space.",
      "NEVER use charts, graphs, bar charts, pie charts, line graphs, or any data visualization as a scene visual. Instead, translate statistics and percentages into human scenes: '70% of companies' becomes 'seven out of ten people holding phones', '3x faster' becomes 'a person finishing work early and leaving the office'. Use people, objects, and actions to represent numbers.",
      "NEVER use calendar visuals with specific dates, years, or numbers written on them. Instead show a person circling a date, a hand flipping pages, or a clock to represent time passing.",
      `Each searchQuery must be a vivid, detailed English description of the exact image to generate, as if describing it to an illustrator: include subject, action, setting, and mood. Example: '${visualStyle.searchQueryExample}'.`,
      "Every searchQuery must end cleanly on a full word. Never return a clipped or cut-off query.",
      "Never end a searchQuery with dangling connectors or incomplete tails like 'with', 'the', 'of', 'where', or 'turned-off'.",
      "For every scene, the narration and searchQuery should refer to the same exact visual idea.",
      "Hashtags should be relevant and platform-native.",
      "## thumbnailPrompt rules",
      "thumbnailPrompt is an English image-generation prompt sent directly to an AI image model to create the video cover thumbnail. It must produce one single striking image, NOT describe the video.",
      "1. Write in English regardless of video language.",
      "2. ONE dominant subject filling at least half the frame. Prefer a person with strong facial expression when topic involves people.",
      "3. Specify exactly one bold emotion with concrete detail: 'wide shocked eyes and open mouth', 'suspicious narrowed eyes looking directly at camera', 'sly smirk with one raised eyebrow'. Never say 'expressive' generically.",
      "4. High-contrast color scheme: name 2-3 specific colors. Use warm subject against dark background. Good combos: yellow+black, red+white, blue+orange.",
      "5. Maximum 3 visual elements total. No clutter.",
      "6. NO text, words, letters, numbers, titles, labels, watermarks, or logos in the image.",
      "7. Specify lighting direction and mood explicitly.",
      "8. Main subject in upper two-thirds of the frame. Bottom third relatively empty.",
      "9. Show the setup or reaction, never the answer — create a curiosity gap.",
      "10. Match the video visual style.",
      "10b. If the chosen visual style is illustrative or editorial, do NOT use realistic-film phrases like 'cinematic feel', 'film still', 'shallow depth of field', 'photorealistic', or documentary-camera wording.",
      "11. Between 40 and 250 words.",
      ...buildCreativeContextLines({sourceText, scriptGuidance}),
      "Return this JSON shape:",
      requestedShape
    ].join("\n")
  }
];
};

const buildReviewMessages = ({title, language, desiredDurationSeconds, storyboard, sourceText, scriptGuidance}) => {
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);

  return [
    {
      role: "system",
      content:
        `You are a strict video editor. Your job is to repair weak storyboard drafts so the narration, overlay, and stock-footage search query are tightly aligned. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()} Rewrite any scene that depends on futuristic CGI, impossible science visuals, Mars rovers, abstract holograms, quantum-computer beauty shots, or rare footage that a normal stock site probably does not have.`
    },
    {
      role: "user",
      content: [
        `Narration target: ${minWords} to ${maxWords} words total.`,
        `Language: ${language}`,
        `Title: ${title}`,
        `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
        "Review the draft below and rewrite it to improve visual matching.",
        "Rules:",
        `1. ${formatSceneCountInstruction(sceneRange, "Keep")}`,
        "2. Use Brazilian Portuguese if language is pt-BR.",
        "3. Every narration line must be a complete spoken sentence.",
        "4. Never leave fragment openings like 'ou um menu', 'e uma tela', 'mas um detalhe', or any other incomplete continuation.",
        "5. Every narration line must describe something that can clearly be shown in stock footage.",
        "6. Every searchQuery must be a highly specific English query that matches the narration exactly.",
        "6b. Every scene must include imagePrompts with 1 to 4 detailed English image-generation prompts. Each prompt must include subject, action, setting, composition, camera angle, lighting, style, mood, 9:16 mobile clarity, and negative constraints for text/logos/watermarks.",
        `6b2. ${NO_ENGLISH_VISUAL_TEXT_RULE}`,
        `6b3. ${BLANK_UI_VISUAL_RULE}`,
        "6c. The audio object must remain ElevenLabs Liam: voiceId TX3LPaxmHKxFdv7VOQHJ and modelId eleven_multilingual_v2.",
        "7. Every searchQuery must be ASCII English only, with no mixed-language tokens or non-Latin characters.",
        "7b. Every searchQuery must avoid readable interface text, button labels, error messages, headlines, links on screen, notification copy, or form fields. Replace them with blank panels, warning icons, abstract alerts, or lock symbols.",
        "7c. Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
        "7d. Never use split-screen, collage, triptych, montage, or several disconnected rooms or countries inside one image. Keep one coherent frame with one place, one main subject, and one action.",
        "7d2. Never describe a sequence, several people, or multiple device types inside one searchQuery. Keep one dominant subject and one device family per scene.",
        "7e. Every searchQuery must end on a full word. Never leave a clipped or cut-off query.",
        "7f. Never end a searchQuery with dangling connectors or incomplete tails like 'with', 'the', 'of', 'where', or 'turned-off'.",
        "8. Remove generic lines, abstract phrasing, and anything visually vague.",
        "8b. Remove icon-only or symbol-only scenes. Rewrite them into real illustrated moments with people, objects, actions, and settings.",
        "8c. Remove direct advice to the viewer, moral-of-the-story wording, self-help framing, and coach-style lessons. Let irony and factual consequence speak for themselves.",
        "9. Remove forced transition crutches like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' and 'Na prática'.",
        "10. Replace hard-to-find visuals with concrete human scenes that imply the same idea.",
        "10b. Reduce repeated desk-laptop scenes. If several scenes use the same desk setup, rewrite some of them into phone, wallet, card, checkout, room, home, office, router, tablet, or hands-only object scenes.",
        "10c. Remove any unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
        "10d. Ensure visual rhythm: alternate scene types across the storyboard — human scene (person doing something) → symbolic scene (object/metaphor) → institutional/environmental scene (building, landscape, wide context) → human. If three consecutive scenes are the same type, rewrite the middle one into a different type.",
        "10e. Every scene title must be unique. If two scenes share the same title, rename them to reflect their distinct beats.",
        "11. NEVER use charts, graphs, bar charts, pie charts, line graphs, or data visualizations. Replace any statistics with human scenes: '70% of companies' becomes 'seven out of ten people holding phones', '3x faster' becomes 'a person finishing work early and leaving the office'.",
        "12. NEVER use calendar visuals with specific years or numbers. Show a person circling a date or a clock instead.",
        "13. Every searchQuery must be a vivid, detailed English description of the exact image to illustrate: include subject, action, setting, and mood.",
        "14. Set cta to an empty string.",
        "15. The thumbnailPrompt must describe one vivid concrete image for the video cover. One dominant subject, one bold emotion, high-contrast colors, no text or labels. Between 40 and 250 words.",
        "15b. If the visual style is illustrative or editorial, remove realistic-film language like 'cinematic feel', 'film still', 'shallow depth of field', 'photorealistic', or documentary-camera wording from thumbnailPrompt.",
        "16. Return the same JSON shape only.",
        ...buildCreativeContextLines({sourceText, scriptGuidance}),
        "Draft JSON:",
        JSON.stringify(storyboard)
      ].join("\n")
    }
  ];
};

const buildExpansionMessages = ({title, language, desiredDurationSeconds, storyboard, sourceText, scriptGuidance}) => {
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const currentWords = getStoryboardWordCount(storyboard);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);

  return [
    {
      role: "system",
      content:
        `You are extending a storyboard so the narration lasts longer while staying visually matchable in stock footage. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()}`
    },
    {
      role: "user",
      content: [
        `Language: ${language}`,
        `Title: ${title}`,
        `Current narration length: ${currentWords} words.`,
        `Target narration length: ${minWords} to ${maxWords} words.`,
        "Rewrite the storyboard so it reaches the target length.",
        formatSceneCountInstruction(sceneRange, "Keep"),
        "Do not make the story generic.",
        "Expand each scene with one extra concrete detail when useful.",
        "Keep every narration line as a complete standalone spoken sentence.",
        "Do not turn the story into advice, a lesson, or coach-style wording directed at the viewer.",
        "Do not introduce fragment openings like 'ou um menu' or 'e uma tela'.",
        "Do not force transition connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",
        "Do not introduce unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
        "Every narration line must still describe visuals that can be found in stock footage.",
        "Avoid adding rare or impossible visuals while expanding.",
        "Do not expand into icon-only or symbol-only scenes; keep real people, objects, and settings.",
        "Every searchQuery must remain specific and directly matched to the narration.",
        "Every scene must keep or add imagePrompts with at least one detailed English image-generation prompt matching the narration and searchQuery.",
        NO_ENGLISH_VISUAL_TEXT_RULE,
        BLANK_UI_VISUAL_RULE,
        "Keep the audio object on ElevenLabs Liam when available.",
        "Every searchQuery must stay in ASCII English only.",
        "Every searchQuery must avoid readable screen text or button labels; use abstract alerts, lock icons, blank panels, or warning symbols instead.",
        "Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
        "Never turn one scene into split-screen, collage, triptych, montage, or multiple countries in one image. Keep one place, one main subject, and one action.",
        "Never expand one scene into several people, several device types, or a sequence of actions inside one frame.",
        "Every searchQuery must end on a full word. Never leave a clipped or cut-off query.",
        "Never end a searchQuery with dangling connectors or incomplete tails like 'with', 'the', 'of', 'where', or 'turned-off'.",
        "Do not expand by repeating the same desk-laptop setup across too many scenes; vary props and environments.",
        "Preserve the thumbnailPrompt unchanged unless it is empty.",
        "Set cta to an empty string.",
        ...buildCreativeContextLines({sourceText, scriptGuidance}),
        "Return the same JSON shape only.",
        "Draft JSON:",
        JSON.stringify(storyboard)
      ].join("\n")
    }
  ];
};

const buildCompressionMessages = ({title, language, desiredDurationSeconds, storyboard, sourceText, scriptGuidance}) => {
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const currentWords = getStoryboardWordCount(storyboard);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);

  return [
    {
      role: "system",
      content:
        `You are tightening a storyboard so the narration hits the target duration while staying natural and visually precise. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()}`
    },
    {
      role: "user",
      content: [
        `Language: ${language}`,
        `Title: ${title}`,
        `Current narration length: ${currentWords} words.`,
        `Target narration length: ${minWords} to ${maxWords} words.`,
        "Rewrite the storyboard so it stays inside the target word range.",
        formatSceneCountInstruction(sceneRange, "Keep"),
        "Shorten only the narration. Keep the same topic progression.",
        "Do not make the narration generic or vague.",
        "Keep every narration line as a complete standalone spoken sentence.",
        "Do not rewrite the story into direct advice, self-help framing, or moral-of-the-story wording.",
        "Do not introduce fragment openings like 'ou um menu' or 'e uma tela'.",
        "Do not force transition connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",
        "Do not keep scenes that rely on rare or impossible stock footage; rewrite them into concrete human visuals instead.",
        "Do not keep icon-only or symbol-only scenes; rewrite them into real illustrated moments with people, objects, and settings.",
        "Do not keep or introduce unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
        "Every narration line must still match the searchQuery exactly.",
        "Every scene must keep imagePrompts with at least one detailed English image-generation prompt matching the shortened narration.",
        NO_ENGLISH_VISUAL_TEXT_RULE,
        BLANK_UI_VISUAL_RULE,
        "Keep the audio object on ElevenLabs Liam when available.",
        "Every searchQuery must stay in ASCII English only.",
        "Every searchQuery must avoid readable screen text or button labels; use abstract alerts, lock icons, blank panels, or warning symbols instead.",
        "Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
        "Never compress scenes into split-screen, collage, triptych, montage, or multiple disconnected places in one image.",
        "Never compress scenes into a sequence of several people or multiple device types in one frame.",
        "Every searchQuery must end on a full word. Never leave a clipped or cut-off query.",
        "Never end a searchQuery with dangling connectors or incomplete tails like 'with', 'the', 'of', 'where', or 'turned-off'.",
        "Reduce repeated desk-laptop setups whenever possible by varying props and environments.",
        "Preserve the thumbnailPrompt unchanged unless it is empty.",
        "Set cta to an empty string.",
        ...buildCreativeContextLines({sourceText, scriptGuidance}),
        "Return the same JSON shape only.",
        "Draft JSON:",
        JSON.stringify(storyboard)
      ].join("\n")
    }
  ];
};

const buildRepairMessages = ({
  title,
  language,
  desiredDurationSeconds,
  storyboard,
  sourceText,
  scriptGuidance,
  issues,
  issueObjects = [],
  warnings = []
}) => {
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);
  const structuredSource = parseStructuredSourceText(sourceText);
  const requiredNumberItems = structuredSource ? (structuredSource.grouped.get("required_numbers") || []).slice(0, 12) : [];
  const strongestNumberLine = pickStrongestStructuredNumberLine(requiredNumberItems);
  const issueCodes = Array.isArray(issueObjects)
    ? issueObjects.map((issue) => String(issue?.code || "").trim()).filter(Boolean)
    : [];
  const requiresHardDataHook =
    issueCodes.includes("viral_hook_missing_data_point") ||
    issueCodes.includes("viral_hook_not_accusatory");

  return [
    {
      role: "system",
      content:
        `You are repairing a storyboard that failed practical QA. Preserve the core creative direction while fixing only the problems that would break the video or pull it off-topic. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()}`
    },
    {
      role: "user",
      content: [
        `Language: ${language}`,
        `Title: ${title}`,
        `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
        "Fix the storyboard below without changing the overall topic.",
        formatSceneCountInstruction(sceneRange, "Keep"),
        "Repair every issue listed below.",
        ...issues.map((issue, index) => `${index + 1}. ${issue}`),
        ...(issueCodes.length > 0 ? [`Issue codes to resolve: ${issueCodes.join(", ")}`] : []),
        ...(warnings.length > 0 ? ["Keep these style nudges in mind:", ...warnings.map((warning, index) => `W${index + 1}. ${warning}`)] : []),
        ...(requiresHardDataHook
          ? [
              "Hook repair rule: rewrite the hook as a hard factual opening, never as a soft explainer.",
              "Hook repair rule: the hook must explicitly include the strongest concrete number or scale fact available, then land the irony, refusal, contradiction, or reversal."
            ]
          : []),
        ...(requiresHardDataHook && strongestNumberLine
          ? [
              `Strongest required number to use in the hook: ${strongestNumberLine}`,
              "Preferred hook shape: '<strongest number or scale fact>. <contradiction, refusal, or irony in one short sentence>'."
            ]
          : []),
        "Keep these constraints only where they matter technically:",
        "- Keep the same topic and overall progression.",
      "- Keep scenes concrete and visually varied.",
      "- Every scene must include imagePrompts with at least one detailed English image-generation prompt aligned to the narration and searchQuery.",
      `- ${NO_ENGLISH_VISUAL_TEXT_RULE}`,
      `- ${BLANK_UI_VISUAL_RULE}`,
      "- Keep audio.provider as elevenlabs and prefer Liam with voiceId TX3LPaxmHKxFdv7VOQHJ when available.",
      "- Every narration line must be a complete spoken sentence in pt-BR when applicable.",
      "- Do not turn the hook or ending into direct advice, coach-style language, or a moral-of-the-story lesson.",
      "- Every searchQuery must be ASCII English only.",
      "- Every searchQuery must avoid readable text, labels, button copy, email copy, or UI chrome.",
      "- Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
      "- Never use split-screen, collage, triptych, montage, or multiple disconnected places inside one image. Keep one coherent frame.",
      "- Never turn one scene into a sequence of several people or multiple device types inside one frame.",
      "- Every searchQuery must end on a full word. Never leave a clipped or cut-off query.",
      "- Never end a searchQuery with dangling connectors or incomplete tails like 'with', 'the', 'of', 'where', or 'turned-off'.",
      "- Remove only scenes that drift into unrelated topics or generic filler not tied to the title.",
        "- Set cta to an empty string.",
        "- postCaption must stay descriptive and on-topic.",
        "- Preserve or improve the thumbnailPrompt. It must describe one vivid concrete image for the video cover.",
        ...buildCreativeContextLines({sourceText, scriptGuidance}),
        "Current storyboard JSON:",
        JSON.stringify(storyboard)
      ].join("\n")
    }
  ];
};

export const repairStoryboard = async ({
  title,
  language,
  model,
  apiKey,
  desiredDurationSeconds,
  provider,
  cwd,
  storyboard,
  sourceText = "",
  scriptGuidance = "",
  issues = [],
  issueObjects = [],
  warnings = []
}) => {
  const selectedProvider = resolveLlmProvider(provider);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);

  if (selectedProvider === "openrouter" && !apiKey) {
    return normalizeStoryboardWithSource(storyboard, title, language, sceneRange, desiredDurationSeconds, sourceText);
  }

  return normalizeStoryboardWithSource(
    await callJsonProvider({
      provider: selectedProvider,
      apiKey,
      model,
      messages: buildRepairMessages({
        title,
        language,
        desiredDurationSeconds,
        storyboard,
        sourceText,
        scriptGuidance,
        issues,
        issueObjects,
        warnings
      }),
      schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
      cwd,
      usageContext: "storyboard-repair"
    }),
    title,
    language,
    sceneRange,
    desiredDurationSeconds,
    sourceText
  );
};

// ── Hook A/B variants (SPEC v2) ───────────────────────────────────────────────
// Generate alternative opening hooks for an existing storyboard so the same body
// can be posted with different first scenes and the 3s retention curve compared.

const HOOK_VARIANTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          angle: {type: "string"},
          narration: {type: "string"},
          overlay: {type: "string"},
          firstCaption: {type: "string"}
        },
        required: ["angle", "narration", "overlay", "firstCaption"]
      }
    }
  },
  required: ["variants"]
};

const buildHookVariantMessages = ({language, title, baseHook, baseOverlay, contextScenes, lastNarration, count}) => [
  {
    role: "system",
    content:
      `You rewrite ONLY the opening hook of a short-form video to A/B test retention. Return valid JSON only, no markdown. If the language is pt-BR, write only in Brazilian Portuguese. The body of the video never changes — you only produce alternative first lines. Every hook must be literally true given the story context provided; never invent facts or state urban legends as fact.`
  },
  {
    role: "user",
    content: [
      `Language: ${language}`,
      title ? `Video title: ${title}` : "",
      `Current opening hook (scene 1 narration): "${baseHook}"`,
      baseOverlay ? `Current scene 1 overlay: "${baseOverlay}"` : "",
      "Story context (do not change the body, only the opening):",
      contextScenes,
      lastNarration ? `The video ends on: "${lastNarration}". A great hook can set up this ending for a loop payoff.` : "",
      "",
      `Produce exactly ${count} alternative opening hooks, each using a DIFFERENT angle. Use these angles in order: 1) "curiosity-gap" — an incomplete or shocking true statement that opens a gap; 2) "start-mid-action" — drop the viewer straight into the most striking moment; 3) "absurd-contrast" — a recognizable absurdity or injustice, or a visual contradiction.`,
      "Rules for every variant:",
      "- The hook is decided in under 1 second. Open with the single most surprising true fact or sharpest contradiction. No greeting, no intro, no question as the opener.",
      "- Keep it the same language and roughly the same length as the current hook (one or two short spoken sentences).",
      "- No call-to-action, no moral, no self-help or coaching wording.",
      "- It must be literally true given the story context — a hook that lies wins 3 seconds but kills completion.",
      "- narration: the spoken opening line(s). overlay: a short punchy on-screen overlay (may be UPPERCASE, may include a number). firstCaption: 4 to 7 words, the burned-in caption card that delivers the hook on mute.",
      `Return JSON exactly as: {"variants":[{"angle":"curiosity-gap","narration":"...","overlay":"...","firstCaption":"..."}, ...]} with ${count} items.`
    ].filter(Boolean).join("\n")
  }
];

/**
 * Generate N alternative opening hooks for an existing storyboard.
 * Returns an array of {angle, narration, overlay, firstCaption}.
 */
export const generateHookVariants = async ({
  storyboard,
  language = "pt-BR",
  count = 3,
  provider,
  apiKey = "",
  model,
  cwd
} = {}) => {
  const scenes = Array.isArray(storyboard?.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) {
    throw new Error("Storyboard sem cenas — nada para gerar variantes de hook.");
  }

  const targetCount = Math.max(2, Math.min(3, Number(count) || 3));
  const baseHook = normalizeText(storyboard?.hook || scenes[0]?.narration || "");
  const baseOverlay = normalizeText(scenes[0]?.overlay || "");
  const contextScenes = scenes
    .slice(0, Math.min(5, scenes.length))
    .map((scene, index) => `Scene ${index + 1}: ${normalizeText(scene?.narration || "")}`)
    .join("\n");

  const raw = await callJsonProvider({
    provider: resolveLlmProvider(provider),
    apiKey,
    model,
    messages: buildHookVariantMessages({
      language,
      title: normalizeText(storyboard?.videoTitle || ""),
      baseHook,
      baseOverlay,
      contextScenes,
      lastNarration: normalizeText(scenes.at(-1)?.narration || ""),
      count: targetCount
    }),
    schema: HOOK_VARIANTS_OUTPUT_SCHEMA,
    cwd,
    usageContext: "hook-variants"
  });

  const seen = new Set();
  const variants = (Array.isArray(raw?.variants) ? raw.variants : [])
    .map((variant) => ({
      angle: normalizeText(variant?.angle || ""),
      narration: normalizeText(variant?.narration || ""),
      overlay: normalizeText(variant?.overlay || ""),
      firstCaption: normalizeText(variant?.firstCaption || "")
    }))
    .filter((variant) => {
      if (!variant.narration) return false;
      const key = variant.narration.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, targetCount);

  if (variants.length === 0) {
    throw new Error("O modelo nao devolveu nenhuma variante de hook utilizavel.");
  }

  return variants;
};

/**
 * Build a new storyboard that is identical to the base except for the opening
 * hook (scene 1 narration/overlay and the top-level hook). The body is untouched.
 */
export const buildVariantStoryboard = (baseStoryboard, variant) => {
  const clone = JSON.parse(JSON.stringify(baseStoryboard || {}));
  if (!Array.isArray(clone.scenes) || clone.scenes.length === 0) {
    return clone;
  }
  const narration = normalizeText(variant?.narration || "");
  const overlay = normalizeText(variant?.overlay || "");
  if (narration) {
    clone.scenes[0].narration = narration;
    clone.hook = narration;
  }
  if (overlay) {
    clone.scenes[0].overlay = overlay;
  }
  return clone;
};

export const generateStoryboard = async ({
  title,
  language,
  model,
  apiKey,
  desiredDurationSeconds,
  provider,
  cwd,
  sourceText = "",
  scriptGuidance = "",
  imageStyleHint = ""
}) => {
  const selectedProvider = resolveLlmProvider(provider);
  const sceneRange = getStoryboardSceneRange(desiredDurationSeconds);

  if (selectedProvider === "openrouter" && !apiKey) {
    return fallbackStoryboard(title, language, getRecommendedSceneCountForDuration(OUTPUT_PROFILE.id, desiredDurationSeconds));
  }

  const generatedStoryboard = normalizeStoryboardWithSource(
    await callJsonProvider({
      provider: selectedProvider,
      apiKey,
      model,
      messages: buildGenerationMessages({title, language, desiredDurationSeconds, sourceText, scriptGuidance, imageStyleHint}),
      schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
      cwd,
      usageContext: "storyboard-generate"
    }),
    title,
    language,
    sceneRange,
    desiredDurationSeconds,
    sourceText
  );

  let sanitized = normalizeStoryboardWithSource(
    await callJsonProvider({
      provider: selectedProvider,
      apiKey,
      model,
      messages: buildReviewMessages({
        title,
        language,
        desiredDurationSeconds,
        storyboard: generatedStoryboard,
        sourceText,
        scriptGuidance
      }),
      schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
      cwd,
      usageContext: "storyboard-review"
    }),
    title,
    language,
    sceneRange,
    desiredDurationSeconds,
    sourceText
  );
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const firstWordCount = getStoryboardWordCount(sanitized);

  if (firstWordCount < minWords) {
    sanitized = normalizeStoryboardWithSource(
      await callJsonProvider({
        provider: selectedProvider,
        apiKey,
        model,
        messages: buildExpansionMessages({
          title,
          language,
          desiredDurationSeconds,
          storyboard: sanitized,
          sourceText,
          scriptGuidance
        }),
        schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
        cwd,
        usageContext: "storyboard-expand"
      }),
      title,
      language,
      sceneRange,
      desiredDurationSeconds,
      sourceText
    );
  }

  if (getStoryboardWordCount(sanitized) > maxWords) {
    sanitized = normalizeStoryboardWithSource(
      await callJsonProvider({
        provider: selectedProvider,
        apiKey,
        model,
        messages: buildCompressionMessages({
          title,
          language,
          desiredDurationSeconds,
          storyboard: sanitized,
          sourceText,
          scriptGuidance
        }),
        schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
        cwd,
        usageContext: "storyboard-compress"
      }),
      title,
      language,
      sceneRange,
      desiredDurationSeconds,
      sourceText
    );
  }

  for (let repairAttempt = 0; repairAttempt < STORYBOARD_REPAIR_MAX_ATTEMPTS; repairAttempt += 1) {
    const storyboardQa = evaluateStoryboardQa({
      storyboard: sanitized,
      title,
      language,
      desiredDurationSeconds,
      scriptGuidance
    });
    const storyboardIssues = storyboardQa.issues;

    if (storyboardIssues.length === 0) {
      break;
    }

    sanitized = await repairStoryboard({
      title,
      language,
      model,
      apiKey,
      desiredDurationSeconds,
      provider: selectedProvider,
      cwd,
      storyboard: sanitized,
      sourceText,
      scriptGuidance,
      issues: storyboardIssues,
      issueObjects: storyboardQa.issueObjects,
      warnings: storyboardQa.warnings
    });
  }

  const repairedWordCount = getStoryboardWordCount(sanitized);

  if (repairedWordCount < minWords) {
    sanitized = normalizeStoryboardWithSource(
      await callJsonProvider({
        provider: selectedProvider,
        apiKey,
        model,
        messages: buildExpansionMessages({
          title,
          language,
          desiredDurationSeconds,
          storyboard: sanitized,
          sourceText,
          scriptGuidance
        }),
        schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
        cwd,
        usageContext: "storyboard-expand-after-repair"
      }),
      title,
      language,
      sceneRange,
      desiredDurationSeconds,
      sourceText
    );
  }

  if (getStoryboardWordCount(sanitized) > maxWords) {
    sanitized = normalizeStoryboardWithSource(
      await callJsonProvider({
        provider: selectedProvider,
        apiKey,
        model,
        messages: buildCompressionMessages({
          title,
          language,
          desiredDurationSeconds,
          storyboard: sanitized,
          sourceText,
          scriptGuidance
        }),
        schema: createStoryboardOutputSchemaForDuration(desiredDurationSeconds),
        cwd,
        usageContext: "storyboard-compress-after-repair"
      }),
      title,
      language,
      sceneRange,
      desiredDurationSeconds,
      sourceText
    );
  }

  const parsed = createStoryboardSchemaForDuration(desiredDurationSeconds).safeParse(sanitized);

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  return parsed.data;
};
