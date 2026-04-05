import {spawnSync} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {z} from "zod";
import {resolveOutputProfileConfig} from "../../../config/output-profiles.mjs";
import {createGeminiUsageSummary, recordGeminiUsage} from "./gemini-usage.mjs";
import {getGcpAccessToken, resolveGcpConfig} from "./gcp-config.mjs";

const MIN_SCENES = Math.max(10, Number.parseInt(process.env.MIN_SCENE_COUNT || "10", 10) || 10);
const MAX_SCENES = Math.max(MIN_SCENES, Number.parseInt(process.env.MAX_SCENE_COUNT || "16", 10) || 16);
const STORYBOARD_REPAIR_MAX_ATTEMPTS = Math.max(
  0,
  Number.parseInt(process.env.STORYBOARD_REPAIR_MAX_ATTEMPTS || "3", 10) || 3
);
const OUTPUT_PROFILE = resolveOutputProfileConfig(process.env.OUTPUT_PROFILE || "vertical-short");
const OUTPUT_FORMAT_DESCRIPTION =
  OUTPUT_PROFILE.layout === "horizontal"
    ? `horizontal long-form video in 16:9 (${OUTPUT_PROFILE.label})`
    : `vertical short-form video in 9:16 (${OUTPUT_PROFILE.label})`;

const sceneSchema = z.object({
  title: z.string().min(2).max(80),
  narration: z.string().min(12).max(520),
  searchQuery: z.string().min(3).max(140),
  overlay: z.string().min(2).max(80)
});

const storyboardSchema = z.object({
  videoTitle: z.string().min(4).max(160),
  hook: z.string().min(8).max(220),
  postCaption: z.string().min(12).max(500),
  hashtags: z.array(z.string().min(2).max(32)).min(3).max(8),
  cta: z.string().max(120),
  scenes: z.array(sceneSchema).min(MIN_SCENES).max(MAX_SCENES)
});

const storyboardOutputSchema = {
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
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {type: "string"},
          narration: {type: "string"},
          searchQuery: {type: "string"},
          overlay: {type: "string"}
        },
        required: ["title", "narration", "searchQuery", "overlay"]
      }
    }
  },
  required: ["videoTitle", "hook", "postCaption", "hashtags", "cta", "scenes"]
};

const normalizeText = (value) => {
  return String(value ?? "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

const clampText = (value, maxLength) => {
  const normalized = normalizeText(value);
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trim();
};

const uniqueStrings = (values = []) => {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map((value) => normalizeText(value)).filter(Boolean))];
};

const withThinkingDisabled = (config = {}) => ({
  ...config,
  thinkingConfig: {
    thinkingBudget: 0
  }
});

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
  return normalizeText(value)
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
    .replace(/\bshowing\b/gi, "with")
    .replace(/\bnotification bubble\b/gi, "notification icon bubble")
    .replace(/\blow balance indicator\b/gi, "nearly empty balance bar icon")
    .replace(/\bemail\b/gi, "envelope icon")
    .replace(/\btemplate\b/gi, "abstract panel")
    .replace(/\bon the screen\b/gi, "near the device")
    .replace(/\b(vertical|portrait)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
};

const DESK_LAPTOP_QUERY_RE =
  /\b(desk|laptop|computer|keyboard|monitor|office worker|email inbox|screen)\b/i;
const TEXTISH_QUERY_RE =
  /\b(access denied|update now|update|click here|bank alert|error message|warning message|declined message|payment declined|password reset|verification code|verify|sign in|login|log in|login page|headline|news alert|breaking news|input fields?|password fields?|form fields?|notification message|message on (a )?(phone|smartphone|screen)|suspicious message|link on (a )?(phone|smartphone|screen)|email copy|button label|email\b|notification bubble|low balance indicator|progress bar animation)\b/i;
const QUOTED_UI_TEXT_RE = /["'][A-Za-z][A-Za-z0-9 -]{1,24}["']/;

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
const PAYMENT_QUERY_RE =
  /\b(credit card|payment terminal|declined|checkout counter|empty wallet|cashier|price displayed)\b/i;
const PAYMENT_TOPIC_RE =
  /\b(card|cartao|cartão|payment|checkout|wallet|repair bill|repair price|conserto|assistencia|assistência|prejuizo|prejuízo|orcamento|orçamento)\b/i;
const PHOTO_QUERY_RE =
  /\b(taking photo|portrait photo|phone camera|smartphone camera|outdoors)\b/i;
const PHOTO_TOPIC_RE =
  /\b(photo|foto|camera do celular|smartphone camera|portrait mode|portrait|retrato|selfie|tirando foto)\b/i;

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
    const reasons = [];

    if (PAYMENT_QUERY_RE.test(query) && !PAYMENT_TOPIC_RE.test(topicContext)) {
      reasons.push("payment-or-checkout imagery");
    }

    if (PHOTO_QUERY_RE.test(query) && !PHOTO_TOPIC_RE.test(topicContext)) {
      reasons.push("photo-or-camera imagery");
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

const VIRAL_SHORTFORM_GUIDANCE_RE = /\b(short-form creator|internet-native|all caps|viral|sarcastic|nao cai nessa|isso da ruim|bad tech idea|fail energy)\b/i;
const HARD_HOOK_RE = /\b(nao use|não use|pare|pessima ideia|péssima ideia|ruim|perigo|alerta|grave|mito|destruindo|arruinando|erro|nao faca isso|não faça isso)\b/i;
const COLLOQUIAL_REACTION_RE = /\b(nao cai nessa|não caia nessa|isso da ruim|isso dá ruim|pessima ideia|péssima ideia|mito perigoso|dor de cabeca|dor de cabeça|fortuna a toa|fortuna à toa|essa ideia nao foi uma boa ideia|essa ideia não foi uma boa ideia|nao faca isso|não faça isso|erro grave|cilada)\b/i;
const SOFT_ADVICE_START_RE = /^(para|sempre|mantenha|proteja|evite|prefira|use|procure|opte|cuide|lembre|considere)\b/i;
const ENDING_STING_RE = /\b(caro|custa|custar|fortuna|prejuizo|prejuízo|erro grave|perigo|ruim|estragar|danificar|piorar|irreversivel|irreversível|dor de cabeca|dor de cabeça|cilada|nao faca isso|não faça isso|nao caia nessa|não caia nessa)\b/i;
const UPPERCASE_EMPHASIS_RE = /(^|[^A-Za-zÀ-ÖØ-öø-ÿ])([A-ZÀ-ÖØ-Þ]{2,})(?=[^A-Za-zÀ-ÖØ-öø-ÿ]|$)/g;

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
  return !hookStartsAsQuestion(storyboard) && HARD_HOOK_RE.test(opening);
};

const hasViralEndingSting = (storyboard) => {
  const closing = normalizeText(storyboard?.scenes?.at(-1)?.narration || "");
  return !hasSoftGenericEnding(storyboard) && ENDING_STING_RE.test(closing);
};

const getStoryboardIssueList = ({storyboard, title}) => {
  const issues = [];
  const deskLaptopScenes = countDeskLaptopScenes(storyboard);
  const textishQueries = countTextishQueries(storyboard);
  const titleLeakScenes = getTitleLeakScenes(storyboard, title);
  const crossTopicLeakScenes = getCrossTopicLeakScenes(storyboard, title);
  const offTopicQueryScenes = getOffTopicQueryScenes(storyboard, title);

  if (deskLaptopScenes > 4) {
    issues.push(`Too many desk/laptop scenes (${deskLaptopScenes}). Rewrite several scenes to use phones, cards, routers, doors, wallets, checkout counters, home devices, hands-only object shots, or street/home settings instead.`);
  }

  if (textishQueries > 0) {
    issues.push(`${textishQueries} searchQuery entries still imply readable interface text. Replace headlines, messages, links, emails, buttons, and form fields with blank panels, warning icons, lock symbols, or abstract alerts.`);
  }

  if (titleLeakScenes.length > 0) {
    issues.push(
      `Narration leaks the video title or generic intro phrasing in mid-storyboard scenes: ${titleLeakScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title})`)
        .join(", ")}. Rewrite those lines so they explain the topic directly instead of repeating the title.`
    );
  }

  if (hookStartsAsQuestion(storyboard)) {
    issues.push("The hook still opens as a question. Rewrite the hook and opening scene so the video starts with a hard statement, warning, accusation, or shocking reveal instead of asking the viewer a question.");
  }

  if (hasSoftGenericEnding(storyboard)) {
    issues.push("The ending is too soft or generic. Rewrite the last scene so it lands with a sharper cautionary sting, consequence, or memorable warning.");
  }

  if (firstAndLastSceneFeelDuplicated(storyboard)) {
    issues.push("The ending feels too close to the opening scene. Rewrite the closing beat so it echoes the theme without duplicating the first scene or first sentence.");
  }

  if (crossTopicLeakScenes.length > 0) {
    issues.push(
      `Some scenes drift into an unrelated apps/productivity topic that does not match the title: ${crossTopicLeakScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title}) via ${scene.fillerTokens.join(", ")}`)
        .join(", ")}. Rewrite those scenes so they stay strictly on the video's real subject.`
    );
  }

  if (offTopicQueryScenes.length > 0) {
    issues.push(
      `Some searchQuery entries introduce unrelated visual domains that do not match their scene narration: ${offTopicQueryScenes
        .map((scene) => `scene ${scene.index + 1} (${scene.title}) via ${scene.reasons.join(", ")}`)
        .join(", ")}. Rewrite those queries so they stay on the same exact subject as the narration.`
    );
  }

  if (hasPostCaptionCta(storyboard)) {
    issues.push("The postCaption or cta still contains a call to action. Rewrite the caption to stay descriptive and platform-native without asking the viewer to share, save, comment, like, or follow.");
  }

  if (hasOffTopicCaptionLeak(storyboard, title)) {
    issues.push("The postCaption drifts into unrelated generic tech filler instead of the real title topic. Rewrite it so it stays tightly about the same concrete subject as the storyboard.");
  }

  return issues;
};

export const evaluateStoryboardQa = ({
  storyboard,
  title,
  language = "pt-BR",
  desiredDurationSeconds = 100,
  scriptGuidance = ""
}) => {
  const issues = getStoryboardIssueList({storyboard, title});
  const warnings = [];
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const wordCount = getStoryboardWordCount(storyboard);
  const uppercaseEmphasisTokens = collectUppercaseEmphasisTokens(storyboard);
  const colloquialReactionLineCount = countColloquialReactionLines(storyboard);
  const softAdviceLineCount = countSoftAdviceLines(storyboard);
  const profile = isViralShortformGuidance(scriptGuidance) ? "viral_shortform" : "default";
  let viralScore = null;

  if (profile === "viral_shortform") {
    viralScore = 100;

    if (!hasHardHookStatement(storyboard)) {
      viralScore -= 25;
      issues.push("The hook still lacks a hard accusatory short-form opening. Rewrite the opening so it hits like a warning, mistake, or immediate danger instead of a soft explainer.");
    }

    if (uppercaseEmphasisTokens.length === 0) {
      viralScore -= 18;
      warnings.push("Add 2 to 5 impact words in ALL CAPS across the hook and narration so the script carries the channel's emphasis style.");
    } else if (uppercaseEmphasisTokens.length === 1) {
      viralScore -= 8;
      warnings.push("The script uses too little ALL CAPS emphasis for this channel style. Add one or two more impact words.");
    }

    if (colloquialReactionLineCount === 0) {
      viralScore -= 15;
      warnings.push("Add at least one human colloquial reaction line so the script sounds like a smart friend calling out a bad idea.");
    }

    if (softAdviceLineCount >= 3) {
      viralScore -= 20;
      issues.push("Too many scenes drift into generic advice or educational explainer tone. Rewrite several lines to sound sharper, more internet-native, and more emotionally charged.");
    } else if (softAdviceLineCount === 2) {
      viralScore -= 8;
      warnings.push("Some scenes are drifting into generic advice tone. Keep the pacing punchier and less educational.");
    }

    if (!hasViralEndingSting(storyboard)) {
      viralScore -= 18;
      issues.push("The ending still lacks a strong consequence, cost, embarrassment, or cautionary sting. Rewrite the last scene so it lands harder.");
    }

    if (viralScore < 60) {
      issues.push("Overall the storyboard still reads too educational for this channel. Rewrite it with more accusation, sharper contrast, stronger spoken rhythm, and clearer fail energy.");
    }

    const endingIssueIndex = issues.indexOf("The ending still lacks a strong consequence, cost, embarrassment, or cautionary sting. Rewrite the last scene so it lands harder.");

    if (viralScore >= 80 && endingIssueIndex !== -1 && issues.length === 1) {
      warnings.push("The ending could still hit harder, but the storyboard is strong enough to proceed without blocking image generation.");
      issues.splice(endingIssueIndex, 1);
    }
  }

  return {
    passed: issues.length === 0,
    profile,
    issues: uniqueStrings(issues),
    warnings: uniqueStrings(warnings),
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

const buildCreativeContextLines = ({sourceText, scriptGuidance}) => {
  const lines = [];
  const normalizedGuidance = normalizeText(scriptGuidance);
  const preparedSourceText = truncateSourceText(sourceText);

  if (normalizedGuidance) {
    lines.push(`Creative guidance: ${normalizedGuidance}`);
  }

  if (preparedSourceText) {
    lines.push("Use the source material below as the primary factual basis for the short video.");
    lines.push("Distill it into a native video script without inventing details that are not supported by the source.");
    lines.push("Source material:");
    lines.push(preparedSourceText);
  }

  return lines;
};

export const resolveLlmProvider = (value) => {
  const normalized = String(value ?? process.env.LLM_PROVIDER ?? process.env.STORY_PROVIDER ?? "vertex")
    .trim()
    .toLowerCase();

  if (["vertex", "vertexai", "gemini", "google"].includes(normalized)) {
    return "vertex";
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

const fallbackScenes = (title, language = "pt-BR") => {
  const topic = cleanTopic(title) || title;
  const english = isEnglishLanguage(language);

  if (english) {
    return [
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
    ].map((scene) => ({
      ...scene,
      searchQuery: normalizeText(scene.searchQuery)
        .replace(/\b(vertical|portrait)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
    }));
  }

  return [
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
].map((scene) => ({
  ...scene,
  searchQuery: normalizeText(scene.searchQuery)
    .replace(/\b(vertical|portrait)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}));
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

const normalizeStoryboard = (input, title, language = "pt-BR") => {
  const fallback = fallbackStoryboard(title, language);
  const sourceScenes = Array.isArray(input?.scenes) ? input.scenes : fallback.scenes;
  const scenes = sourceScenes.slice(0, MAX_SCENES).map((scene, index) => {
    const backup = fallback.scenes[index % fallback.scenes.length];

    return {
      title: clampText(scene?.title, 80) || backup.title,
      narration: clampText(sanitizeNarrationLine(scene?.narration, backup.narration), 520),
      searchQuery: clampText(sanitizeEnglishSearchQuery(scene?.searchQuery), 140) || backup.searchQuery,
      overlay: clampText(
        pickSceneOverlay({
          overlay: scene?.overlay,
          title: scene?.title || backup.title,
          narration: scene?.narration || backup.narration,
          fallbackOverlay: backup.overlay
        }),
        80
      ) || backup.overlay
    };
  });

  while (scenes.length < MIN_SCENES) {
    const backup = fallback.scenes[scenes.length % fallback.scenes.length];
    scenes.push({
      title: backup.title,
      narration: backup.narration,
      searchQuery: backup.searchQuery,
      overlay: backup.overlay
    });
  }

  return {
    videoTitle: clampText(input?.videoTitle, 160) || fallback.videoTitle,
    hook: clampText(input?.hook, 220) || fallback.hook,
    postCaption: clampText(input?.postCaption, 500) || fallback.postCaption,
    hashtags: ensureHashtags(input?.hashtags) || fallback.hashtags,
    cta: clampText(input?.cta, 120),
    scenes: scenes.length >= MIN_SCENES ? scenes : fallback.scenes
  };
};

export const fallbackStoryboard = (title, language = "pt-BR") => {
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
      scenes: fallbackScenes(title, language)
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
    scenes: fallbackScenes(title, language)
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const errorText = await response.text().catch(() => "");
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

const callVertexGemini = async ({model, messages, jsonMode = false, usageContext = "unspecified"}) => {
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
                responseMimeType: "application/json"
              }
              : {
                temperature: 0
              }
          )
        }),
        signal
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        const failure = new Error(`Vertex Gemini falhou com status ${response.status}: ${err.slice(0, 240)}`);

        if (!isRetryableGeminiStatus(response.status) || attempt >= GEMINI_MAX_RETRIES) {
          throw failure;
        }

        lastError = failure;
        await wait(1500 * (attempt + 1));
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

      await wait(1500 * (attempt + 1));
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

const callGemini = async ({apiKey, model, messages, jsonMode = false, usageContext = "unspecified"}) => {
  const systemParts = [];
  const userParts = [];

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
            generationConfig: jsonMode
              ? {
                  temperature: 0,
                  responseMimeType: "application/json"
                }
              : {
                  temperature: 0
                }
          }),
          signal
        }
      );

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        const failure = new Error(`Gemini falhou com status ${response.status}: ${err.slice(0, 200)}`);

        if (!isRetryableGeminiStatus(response.status) || attempt >= GEMINI_MAX_RETRIES) {
          throw failure;
        }

        lastError = failure;
        await wait(1500 * (attempt + 1));
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

      await wait(1500 * (attempt + 1));
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
  scenes: [
    {
      title: "string",
      narration: "string",
      searchQuery: "string",
      overlay: "string"
    }
  ]
});

const buildFormatGuidance = () =>
  OUTPUT_PROFILE.layout === "horizontal"
    ? `Create a ${OUTPUT_FORMAT_DESCRIPTION}. Keep scenes broader, let ideas breathe a little more, and avoid short-form wording like "shorts" or "vertical".`
    : `Create a ${OUTPUT_FORMAT_DESCRIPTION}. Keep the pacing punchy, concise, and optimized for short-form retention.`;

const buildGenerationMessages = ({title, language, desiredDurationSeconds, sourceText, scriptGuidance}) => [
  {
    role: "system",
    content:
      `Return valid JSON only. Do not include markdown. If the language is pt-BR, write only in Brazilian Portuguese and avoid European Portuguese wording. ${buildFormatGuidance()} Writing style rules: write as if you are a friend explaining something fascinating to the viewer. Use short punchy sentences, one idea per sentence. Each sentence must describe something visually concrete that an illustration can show. Use surprising facts and numbers to hook attention. If you use rhetorical questions, use them sparingly and never as the opening hook. Avoid abstract or philosophical sentences that have no clear visual representation. Every narration line must paint a picture the viewer can see. Prefer present tense and direct address using voce. Never depend on sci-fi, CGI, Mars rovers, impossible quantum-computer shots, abstract holograms, or lab concepts that are hard to illustrate.`
  },
  {
    role: "user",
    content: [
      (() => {
        const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);

        return `Narration target: ${minWords} to ${maxWords} words total.`;
      })(),
      `Language: ${language}`,
      `Title: ${title}`,
      `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
      `Create a video plan with ${MIN_SCENES} to ${MAX_SCENES} scenes.`,
      "Each narration line must be concrete, easy to understand, visually specific, and long enough for the full script to reach the target duration.",
      "Each narration line must describe something a viewer can SEE in an illustration: a person, an object, an action, a place. Avoid abstract concepts without visual anchors.",
      "Use short sentences. One sentence per visual idea. If a sentence has two ideas, split it into two scenes.",
      "Each narration line must be a complete spoken sentence.",
      "The narration must flow like one continuous voiceover without forced transition crutches.",
      "Across scenes, vary the environment, object, and staging. Do not repeat the same person-at-desk setup unless the topic truly stays in the same moment.",
      "Across the whole storyboard, avoid more than three desk-or-laptop scenes total unless the title is specifically about office workflow.",
      "Do not start scenes with filler connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",
      "Never start a scene with loose continuation fragments like 'ou um menu', 'e uma tela', 'mas um detalhe' or any other incomplete phrase.",
      "Avoid robotic list formatting. Make it sound like one person is guiding the viewer from one idea to the next.",
      "Avoid abstract visuals.",
      "Use a strong practical hook, but do not include CTA in the narration.",
      "Set cta to an empty string.",
      "Do not inject unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
      "The visual style is minimalist stick figure illustration: simple line art characters with thin black lines, large round heads, and flat colored icons or objects. Think corporate memphis meets stick figure animation on a white background.",
      "Prefer visual concepts that work as simple flat illustrations: a person at a desk, someone holding a phone, a laptop with a blank screen, coins or money symbols, a simple house, a clock, arrows pointing up, a lightbulb, simple icons floating around a character.",
      "If the title is about future technology or complex topics, translate each idea into a simple everyday scene that can be drawn as a stick figure illustration.",
      "Prefer people interacting with objects, simple devices, everyday scenes, workspaces, homes, and iconic symbols that convey the idea visually.",
      "Do not create icon-only scenes. Every scene must feel like a real illustrated moment with a person, object, action, or physical setting, not a floating symbol on empty space.",
      "Search queries must vary camera viewpoint and staging across scenes when possible: mix wider scene context, device-led shots, hands interacting with objects, side views, over-the-shoulder views, and top-down desk moments instead of repeating the same straight-on framing.",
      "Avoid scene plans that become one abstract category per scene.",
      "NEVER use charts, graphs, bar charts, pie charts, line graphs, or any data visualization as a scene visual. Instead, translate statistics and percentages into human scenes: '70% of companies' becomes 'seven out of ten people holding phones', '3x faster' becomes 'a person finishing work early and leaving the office'. Use people, objects, and actions to represent numbers.",
      "NEVER use calendar visuals with specific dates, years, or numbers written on them. Instead show a person circling a date, a hand flipping pages, or a clock to represent time passing.",
      "Each searchQuery must be a vivid, detailed English description of the exact image to generate, as if describing it to an illustrator: include subject, action, setting, and mood. Example: 'stick figure character at a messy desk surrounded by floating paper icons and clock symbols, overwhelmed expression, flat white background'.",
      "Each searchQuery must use ASCII English only: plain Latin letters, numbers, spaces, and hyphens. Never mix Portuguese, Chinese, emojis, or non-Latin characters.",
      "Each searchQuery must avoid readable text inside devices, interfaces, signs, emails, buttons, documents, or alerts. Never write phrases like 'Access Denied', 'Update Now', 'error message', headlines, notification copy, button labels, links on screen, or form fields. Describe blank panels, warning icons, abstract alerts, or lock symbols instead.",
      "Never include literal button labels or quoted UI words like 'Update', 'Login', 'Verify', or 'Allow' in any searchQuery.",
      "For every scene, the narration and searchQuery should refer to the same exact visual idea.",
      "Hashtags should be relevant and platform-native.",
      ...buildCreativeContextLines({sourceText, scriptGuidance}),
      "Return this JSON shape:",
      requestedShape
    ].join("\n")
  }
];

const buildReviewMessages = ({title, language, desiredDurationSeconds, storyboard, sourceText, scriptGuidance}) => [
  {
    role: "system",
    content:
      `You are a strict video editor. Your job is to repair weak storyboard drafts so the narration, overlay, and stock-footage search query are tightly aligned. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()} Rewrite any scene that depends on futuristic CGI, impossible science visuals, Mars rovers, abstract holograms, quantum-computer beauty shots, or rare footage that a normal stock site probably does not have.`
  },
  {
    role: "user",
    content: [
      (() => {
        const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);

        return `Narration target: ${minWords} to ${maxWords} words total.`;
      })(),
      `Language: ${language}`,
      `Title: ${title}`,
      `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
      "Review the draft below and rewrite it to improve visual matching.",
      "Rules:",
      `1. Keep ${MIN_SCENES} to ${MAX_SCENES} scenes.`,
      "2. Use Brazilian Portuguese if language is pt-BR.",
      "3. Every narration line must be a complete spoken sentence.",
      "4. Never leave fragment openings like 'ou um menu', 'e uma tela', 'mas um detalhe', or any other incomplete continuation.",
      "5. Every narration line must describe something that can clearly be shown in stock footage.",
      "6. Every searchQuery must be a highly specific English query that matches the narration exactly.",
      "7. Every searchQuery must be ASCII English only, with no mixed-language tokens or non-Latin characters.",
      "7b. Every searchQuery must avoid readable interface text, button labels, error messages, headlines, links on screen, notification copy, or form fields. Replace them with blank panels, warning icons, abstract alerts, or lock symbols.",
      "7c. Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
      "8. Remove generic lines, abstract phrasing, and anything visually vague.",
      "8b. Remove icon-only or symbol-only scenes. Rewrite them into real illustrated moments with people, objects, actions, and settings.",
      "9. Remove forced transition crutches like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' and 'Na prática'.",
      "10. Replace hard-to-find visuals with concrete human scenes that imply the same idea.",
      "10b. Reduce repeated desk-laptop scenes. If several scenes use the same desk setup, rewrite some of them into phone, wallet, card, checkout, room, home, office, router, tablet, or hands-only object scenes.",
      "10c. Remove any unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
      "11. NEVER use charts, graphs, bar charts, pie charts, line graphs, or data visualizations. Replace any statistics with human scenes: '70% of companies' becomes 'seven out of ten people holding phones', '3x faster' becomes 'a person finishing work early and leaving the office'.",
      "12. NEVER use calendar visuals with specific years or numbers. Show a person circling a date or a clock instead.",
      "13. Every searchQuery must be a vivid, detailed English description of the exact image to illustrate: include subject, action, setting, and mood. Example: 'stick figure at a messy desk surrounded by floating paper icons and clock symbols, overwhelmed expression, flat white background'.",
      "14. Set cta to an empty string.",
      "15. Return the same JSON shape only.",
      ...buildCreativeContextLines({sourceText, scriptGuidance}),
      "Draft JSON:",
      JSON.stringify(storyboard)
    ].join("\n")
  }
];

const buildExpansionMessages = ({title, language, desiredDurationSeconds, storyboard, sourceText, scriptGuidance}) => {
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const currentWords = getStoryboardWordCount(storyboard);

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
      `Keep ${MIN_SCENES} to ${MAX_SCENES} scenes.`,
      "Do not make the story generic.",
      "Expand each scene with one extra concrete detail when useful.",
      "Keep every narration line as a complete standalone spoken sentence.",
      "Do not introduce fragment openings like 'ou um menu' or 'e uma tela'.",
      "Do not force transition connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",
      "Do not introduce unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
      "Every narration line must still describe visuals that can be found in stock footage.",
      "Avoid adding rare or impossible visuals while expanding.",
      "Do not expand into icon-only or symbol-only scenes; keep real people, objects, and settings.",
      "Every searchQuery must remain specific and directly matched to the narration.",
      "Every searchQuery must stay in ASCII English only.",
      "Every searchQuery must avoid readable screen text or button labels; use abstract alerts, lock icons, blank panels, or warning symbols instead.",
      "Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
      "Do not expand by repeating the same desk-laptop setup across too many scenes; vary props and environments.",
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
      `Keep ${MIN_SCENES} to ${MAX_SCENES} scenes.`,
      "Shorten only the narration. Keep the same topic progression.",
      "Do not make the narration generic or vague.",
      "Keep every narration line as a complete standalone spoken sentence.",
      "Do not introduce fragment openings like 'ou um menu' or 'e uma tela'.",
      "Do not force transition connectors like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'.",
      "Do not keep scenes that rely on rare or impossible stock footage; rewrite them into concrete human visuals instead.",
      "Do not keep icon-only or symbol-only scenes; rewrite them into real illustrated moments with people, objects, and settings.",
      "Do not keep or introduce unrelated generic tech filler such as translation, summaries, research, app workflows, organization features, AI capabilities, or browser habits unless the title or source material is explicitly about that subtopic.",
      "Every narration line must still match the searchQuery exactly.",
      "Every searchQuery must stay in ASCII English only.",
      "Every searchQuery must avoid readable screen text or button labels; use abstract alerts, lock icons, blank panels, or warning symbols instead.",
      "Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
      "Reduce repeated desk-laptop setups whenever possible by varying props and environments.",
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
  warnings = []
}) => [
  {
    role: "system",
    content:
      `You are repairing a storyboard that failed strict visual QA. Return valid JSON only. Do not include markdown. ${buildFormatGuidance()}`
  },
  {
    role: "user",
    content: [
      `Language: ${language}`,
      `Title: ${title}`,
      `Target duration: around ${desiredDurationSeconds || 100} seconds.`,
      "Fix the storyboard below without changing the overall topic.",
      `Keep ${MIN_SCENES} to ${MAX_SCENES} scenes.`,
      "Repair every issue listed below.",
      ...issues.map((issue, index) => `${index + 1}. ${issue}`),
      ...(warnings.length > 0 ? ["Keep these style nudges in mind:", ...warnings.map((warning, index) => `W${index + 1}. ${warning}`)] : []),
      "Hard rules:",
      "- The hook and first scene must not open as a question.",
      "- Start with a hard statement, warning, accusation, or shocking reveal.",
      "- Do not repeat the title sentence inside middle scenes.",
      "- Do not use more than four desk-or-laptop scenes total.",
      "- Keep scenes concrete and visually varied.",
      "- End with a sharper warning or consequence, not a soft generic wrap-up.",
      "- Remove any scene that drifts into apps, productivity, translation, summaries, organization, or any unrelated subtopic unless the title explicitly requires that topic.",
      "- Every narration line must be a complete spoken sentence in pt-BR when applicable.",
      "- Every searchQuery must be ASCII English only.",
      "- Every searchQuery must avoid readable text, labels, button copy, email copy, or UI chrome.",
      "- Never include literal UI words like 'Update', 'Login', 'Verify', or quoted button text in any searchQuery.",
      "- Keep the video specific to the topic, not generic tech filler.",
      "- Rewrite any scene that introduces an unrelated subtopic, generic app capability, AI productivity feature, translation feature, summary feature, search feature, or organization feature that is not directly tied to the title.",
      "- Set cta to an empty string.",
      "- postCaption must not ask the viewer to share, save, comment, like, follow, or tag anyone.",
      ...buildCreativeContextLines({sourceText, scriptGuidance}),
      "Current storyboard JSON:",
      JSON.stringify(storyboard)
    ].join("\n")
  }
];

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
  warnings = []
}) => {
  const selectedProvider = resolveLlmProvider(provider);

  if (selectedProvider === "openrouter" && !apiKey) {
    return normalizeStoryboard(storyboard, title, language);
  }

  return normalizeStoryboard(
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
        warnings
      }),
      schema: storyboardOutputSchema,
      cwd,
      usageContext: "storyboard-repair"
    }),
    title,
    language
  );
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
  scriptGuidance = ""
}) => {
  const selectedProvider = resolveLlmProvider(provider);

  if (selectedProvider === "openrouter" && !apiKey) {
    return fallbackStoryboard(title, language);
  }

  const generatedStoryboard = normalizeStoryboard(
    await callJsonProvider({
      provider: selectedProvider,
      apiKey,
      model,
      messages: buildGenerationMessages({title, language, desiredDurationSeconds, sourceText, scriptGuidance}),
      schema: storyboardOutputSchema,
      cwd,
      usageContext: "storyboard-generate"
    }),
    title,
    language
  );

  let sanitized = normalizeStoryboard(
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
      schema: storyboardOutputSchema,
      cwd,
      usageContext: "storyboard-review"
    }),
    title,
    language
  );
  const {minWords, maxWords} = getTargetWordRange(desiredDurationSeconds, language);
  const firstWordCount = getStoryboardWordCount(sanitized);

  if (firstWordCount < minWords) {
    sanitized = normalizeStoryboard(
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
        schema: storyboardOutputSchema,
        cwd,
        usageContext: "storyboard-expand"
      }),
      title,
      language
    );
  }

  if (getStoryboardWordCount(sanitized) > maxWords) {
    sanitized = normalizeStoryboard(
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
        schema: storyboardOutputSchema,
        cwd,
        usageContext: "storyboard-compress"
      }),
      title,
      language
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
      warnings: storyboardQa.warnings
    });
  }

  const parsed = storyboardSchema.safeParse(sanitized);

  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  return parsed.data;
};
