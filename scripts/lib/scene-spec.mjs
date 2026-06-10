const SCHEMA_VERSION = 1;

const FRAME_PATTERNS = [
  {value: "extreme_closeup", patterns: [/extreme[-\s]?close[-\s]?up/i, /\bmacro\b/i]},
  {value: "closeup", patterns: [/\bclose[-\s]?up\b/i, /\bclose shot\b/i]},
  {value: "three_quarter", patterns: [/\bthree[-\s]?quarter\b/i, /\b3\/4\b/i]},
  {value: "full_body", patterns: [/\bfull[-\s]?body\b/i, /\bwhole body\b/i, /\bfull figure\b/i, /\bentire body\b/i]},
  {value: "wide", patterns: [/\bwide shot\b/i, /\bwide\b/i, /\benvironmental shot\b/i]}
];

const VIEWPOINT_PATTERNS = [
  {value: "back", patterns: [/\bfrom behind\b/i, /\bseen from behind\b/i, /\bback of the head\b/i, /\brear view\b/i, /\bback view\b/i]},
  {value: "profile", patterns: [/\bprofile\b/i, /\bside view\b/i, /\bfrom the side\b/i]},
  {value: "topdown", patterns: [/\btop[-\s]?down\b/i, /\boverhead\b/i, /\bbird'?s[-\s]?eye\b/i]},
  {value: "low_angle", patterns: [/\blow angle\b/i, /\bfrom below\b/i]},
  {value: "three_quarter", patterns: [/\bthree[-\s]?quarter\b/i, /\b3\/4\b/i]}
];

const PERSON_TERMS = [
  "person",
  "character",
  "man",
  "woman",
  "boy",
  "girl",
  "human",
  "figure",
  "adult",
  "child",
  "couple",
  "people"
];

const BODY_PART_TERMS = {
  face: ["face", "eyes", "eye", "mouth", "smile", "expression", "gaze", "look", "stare", "cheeks", "jaw"],
  hands: ["hand", "hands", "finger", "fingers", "thumb", "palm", "wrist", "pointing", "grabbing", "holding", "touching", "pinching"],
  legs: ["leg", "legs", "foot", "feet", "ankle", "knees", "knee", "standing", "walking", "running", "sitting", "crouching"],
  torso: ["chest", "torso", "shoulders", "shoulder", "back", "spine", "breathing", "breath"],
  head: ["head", "back of the head", "skull", "hair", "profile"]
};

const ACTION_TERMS = [
  "holding",
  "touching",
  "pointing",
  "reaching",
  "grabbing",
  "pressing",
  "using",
  "looking at",
  "looking out",
  "staring",
  "breathing",
  "sleeping",
  "lying",
  "sitting",
  "walking",
  "running",
  "typing",
  "scrolling",
  "reading",
  "drinking",
  "eating"
];

const EMOTION_PATTERNS = [
  {value: "calm", patterns: [/\bcalm\b/i, /\bpeaceful\b/i, /\bserene\b/i, /\brelaxed\b/i, /\btranquil\b/i, /\bcozy\b/i]},
  {value: "tense", patterns: [/\btense\b/i, /\bstressed\b/i, /\banxious\b/i, /\bworried\b/i, /\brestless\b/i]},
  {value: "confused", patterns: [/\bconfused\b/i, /\bpuzzled\b/i, /\bbewildered\b/i]},
  {value: "sad", patterns: [/\bsad\b/i, /\bdown\b/i, /\bdepressed\b/i]},
  {value: "angry", patterns: [/\bangry\b/i, /\bfrustrated\b/i, /\bannoyed\b/i, /\birritated\b/i]},
  {value: "joyful", patterns: [/\bjoyful\b/i, /\bhappy\b/i, /\bsmiling\b/i, /\bsmile\b/i, /\bcheerful\b/i]},
  {value: "sleepy", patterns: [/\bsleepy\b/i, /\bdrowsy\b/i, /\btired\b/i, /\bexhausted\b/i]}
];

const LOCATION_TERMS = [
  "bedroom",
  "bed",
  "kitchen",
  "bathroom",
  "office",
  "desk",
  "street",
  "road",
  "car",
  "living room",
  "window",
  "classroom",
  "hospital",
  "park",
  "forest",
  "beach",
  "store",
  "shop",
  "room"
];

const DEVICE_TERMS = [
  "phone",
  "smartphone",
  "tablet",
  "laptop",
  "computer",
  "monitor",
  "screen",
  "display",
  "interface",
  "dashboard",
  "tv",
  "television"
];

const OBJECT_TERMS = [
  "bed",
  "pillow",
  "clock",
  "book",
  "cup",
  "paper",
  "pen",
  "chair",
  "desk",
  "lamp",
  "window",
  "door",
  "bag",
  "car",
  "road",
  "map",
  "route"
];

const DEFAULT_FORBIDDEN_TERMS = [
  "text",
  "letters",
  "words",
  "logo",
  "watermark",
  "signature",
  "brand mark",
  "extra arms",
  "extra hands",
  "extra legs",
  "extra fingers",
  "duplicate limbs",
  "mutated anatomy",
  "deformed anatomy",
  "cropped head",
  "cropped limbs"
];

const DEFAULT_SCENE_SPEC = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  sceneId: "",
  sceneNumber: null,
  title: "",
  narration: "",
  searchQuery: "",
  visualGoal: "",
  sceneType: "unknown",
  subject: {
    kind: "scene",
    count: 1,
    description: "",
    identityRefs: []
  },
  camera: {
    framing: "medium",
    viewpoint: "front",
    lensStyle: "normal",
    cropPriority: "environment"
  },
  pose: {
    bodyPose: "static",
    handVisibility: "partial",
    faceVisibility: "partial",
    interaction: "none"
  },
  affect: {
    emotion: "neutral",
    intensity: "low",
    gaze: "off_camera"
  },
  environment: {
    location: "",
    allowedProps: [],
    forbiddenProps: [],
    clutterLevel: "moderate"
  },
  constraints: {
    mustShow: [],
    mustAvoid: [],
    focusRegions: [],
    continuityPriority: "composition"
  },
  repairStrategy: {
    anatomy: "retry",
    props: "retry",
    framing: "retry",
    expression: "retry"
  },
  raw: {}
});

const normalizeText = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeLowerText = (value) => normalizeText(value).toLowerCase();

const escapeRegex = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildWholeWordPattern = (term) => {
  const escaped = escapeRegex(term).replace(/\s+/g, "\\s+");
  return new RegExp(`\\b${escaped}\\b`, "i");
};

const PERSON_NEGATION_PATTERNS = [
  /\bno\s+(?:extra\s+)?(?:people|person|character|man|woman|human|figure|adult|child|couple)\b/gi,
  /\bwithout\s+(?:any\s+)?(?:people|person|character|man|woman|human|figure|adult|child|couple)\b/gi,
  /\bsem\s+(?:qualquer\s+)?(?:pessoas|pessoa|personagem|homem|mulher)\b/gi
];

const stripNegatedPersonPhrases = (value) => {
  let text = String(value ?? "");
  for (const pattern of PERSON_NEGATION_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  return normalizeText(text);
};

const uniqueStrings = (values) => {
  const seen = new Set();
  const result = [];

  for (const rawValue of Array.isArray(values) ? values : []) {
    const value = normalizeText(rawValue);
    if (!value || seen.has(value.toLowerCase())) {
      continue;
    }

    seen.add(value.toLowerCase());
    result.push(value);
  }

  return result;
};

const includesAny = (text, terms) => {
  const source = String(text ?? "");
  return terms.some((term) => buildWholeWordPattern(term).test(source));
};

const matchPatternValue = (text, patterns) => {
  const source = String(text ?? "");
  return patterns.some((pattern) => pattern.test(source));
};

const firstMatchValue = (text, patternGroups, fallback) => {
  const source = String(text ?? "");

  for (const group of patternGroups) {
    if (matchPatternValue(source, group.patterns)) {
      return group.value;
    }
  }

  return fallback;
};

const asArray = (value) => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => asArray(item));
  }

  if (value === null || value === undefined) {
    return [];
  }

  const text = normalizeText(value);
  return text ? [text] : [];
};

const extractKnownTerms = (text, terms) => {
  const source = String(text ?? "");
  return terms.filter((term) => buildWholeWordPattern(term).test(source));
};

const extractFocusRegions = (text) => {
  const source = normalizeLowerText(text);
  const regions = [];

  if (includesAny(source, BODY_PART_TERMS.face)) regions.push("face");
  if (includesAny(source, BODY_PART_TERMS.hands)) regions.push("hands");
  if (includesAny(source, BODY_PART_TERMS.legs)) regions.push("legs");
  if (includesAny(source, BODY_PART_TERMS.torso)) regions.push("torso");
  if (includesAny(source, BODY_PART_TERMS.head)) regions.push("head");
  if (includesAny(source, DEVICE_TERMS)) regions.push("device");
  if (includesAny(source, LOCATION_TERMS)) regions.push("environment");

  if (/\bfull[-\s]?body\b/i.test(source) || /\bwhole body\b/i.test(source)) {
    regions.push("full_body");
  }

  return uniqueStrings(regions);
};

const extractConcreteReferences = (sceneText) => {
  const source = stripNegatedPersonPhrases(sceneText);
  const references = [];

  if (includesAny(source, PERSON_TERMS)) references.push("person");
  if (includesAny(source, DEVICE_TERMS)) references.push(...extractKnownTerms(source, DEVICE_TERMS));
  if (includesAny(source, OBJECT_TERMS)) references.push(...extractKnownTerms(source, OBJECT_TERMS));
  if (includesAny(source, LOCATION_TERMS)) references.push(...extractKnownTerms(source, LOCATION_TERMS));
  if (includesAny(source, BODY_PART_TERMS.face)) references.push("face");
  if (includesAny(source, BODY_PART_TERMS.hands)) references.push("hands");
  if (includesAny(source, BODY_PART_TERMS.legs)) references.push("legs");
  if (includesAny(source, BODY_PART_TERMS.torso)) references.push("torso");

  return uniqueStrings(references);
};

const countPeopleSignals = (text) => {
  const source = stripNegatedPersonPhrases(text);
  const hits = PERSON_TERMS.reduce((count, term) => count + (buildWholeWordPattern(term).test(source) ? 1 : 0), 0);
  const explicitPlural = /\bpeople\b/i.test(source) || /\bcouple\b/i.test(source) || /\bgroup\b/i.test(source) || /\bcrowd\b/i.test(source);
  return explicitPlural ? Math.max(2, hits) : Math.max(1, hits > 0 ? 1 : 0);
};

const inferSubjectKind = (text) => {
  const source = stripNegatedPersonPhrases(text);

  if (includesAny(source, PERSON_TERMS)) return "person";
  if (includesAny(source, DEVICE_TERMS)) return "device";
  if (/\banimal\b|\bdog\b|\bcat\b|\bbird\b|\bhorse\b/i.test(source)) return "animal";
  if (includesAny(source, OBJECT_TERMS)) return "object";
  return "scene";
};

const inferFraming = (text) => firstMatchValue(text, FRAME_PATTERNS, "medium");

const inferViewpoint = (text) => firstMatchValue(text, VIEWPOINT_PATTERNS, "front");

const inferBodyPose = (text) => {
  const source = normalizeLowerText(text);

  if (/\bwalking\b/.test(source) || /\bwalking\b/.test(source)) return "walking";
  if (/\brunning\b/.test(source) || /\bsprinting\b/.test(source)) return "running";
  if (/\bsitting\b/.test(source) || /\bseated\b/.test(source) || /\bsits?\b/.test(source)) return "sitting";
  if (/\blying\b/.test(source) || /\blying in bed\b/.test(source) || /\blying down\b/.test(source)) return "lying";
  if (/\breaching\b/.test(source) || /\breaching out\b/.test(source)) return "reaching";
  if (/\bholding\b/.test(source) || /\bgripping\b/.test(source)) return "holding";
  if (/\bstanding\b/.test(source)) return "standing";
  if (/\bbreath(?:ing|s)?\b/.test(source)) return "breathing";

  return "static";
};

const inferHandVisibility = (text, framing, viewpoint) => {
  const source = normalizeLowerText(text);
  if (/\bno hands?\b|\bhands hidden\b|\bhands out of frame\b/i.test(source)) return "none";
  if (includesAny(source, BODY_PART_TERMS.hands) || /\bfinger\b/.test(source) || /\bhand\b/.test(source)) return "clear";
  if (["closeup", "extreme_closeup"].includes(framing) && viewpoint === "back") return "partial";
  return "partial";
};

const inferFaceVisibility = (text, viewpoint, framing) => {
  const source = normalizeLowerText(text);
  if (/\bface hidden\b|\bno face\b|\bback of the head\b|\bseen from behind\b/i.test(source)) return "hidden";
  if (viewpoint === "back") return "hidden";
  if (includesAny(source, BODY_PART_TERMS.face) || /\bexpression\b/i.test(source) || /\bsmile\b/i.test(source) || /\beyes?\b/i.test(source)) {
    return "clear";
  }
  if (framing === "closeup" || framing === "extreme_closeup") return "partial";
  return "partial";
};

const inferGaze = (text) => {
  const source = normalizeLowerText(text);
  if (/\blooking at camera\b|\bface the camera\b/i.test(source)) return "camera";
  if (/\beyes closed\b|\bsleeping\b|\bbreathing\b|\bdown\b/i.test(source)) return "hidden";
  if (/\blooking down\b|\bdownward gaze\b/i.test(source)) return "down";
  if (/\blooking up\b|\bupward gaze\b/i.test(source)) return "up";
  if (/\blooking away\b|\bout the window\b|\boff camera\b/i.test(source)) return "off_camera";
  return "off_camera";
};

const inferEmotion = (text) => firstMatchValue(text, EMOTION_PATTERNS, "neutral");

const inferIntensity = (text, emotion) => {
  const source = normalizeLowerText(text);
  if (emotion === "calm" || emotion === "sleepy") return "low";
  if (/\bdeep\b|\bstrong\b|\bintense\b|\bfurious\b|\bextreme\b/i.test(source)) return "high";
  if (emotion === "angry" || emotion === "tense" || emotion === "confused") return "medium";
  return "low";
};

const inferLocation = (scene) => {
  const source = normalizeText(scene?.setting || scene?.visualGoal || scene?.searchQuery || scene?.narration);
  const lowered = normalizeLowerText(source);

  for (const location of LOCATION_TERMS) {
    if (lowered.includes(location.toLowerCase())) {
      return location;
    }
  }

  return "";
};

const inferClutterLevel = (text) => {
  const source = normalizeLowerText(text);
  if (/\bminimal\b|\bclean\b|\bblank\b|\bempty\b/.test(source)) return "minimal";
  if (/\bcrowded\b|\bcluttered\b|\bbusy\b|\bpacked\b/.test(source)) return "rich";
  return "moderate";
};

const buildMustAvoid = (scene, textCorpus) => {
  const rawAvoid = asArray(scene?.avoid ?? scene?.mustAvoid);
  const safetyAvoid = uniqueStrings([...DEFAULT_FORBIDDEN_TERMS, ...rawAvoid]);

  if (/\bscreen\b|\bmonitor\b|\bphone\b|\btablet\b|\blaptop\b|\bcomputer\b/i.test(textCorpus)) {
    safetyAvoid.push("readable text on screen");
  }

  return uniqueStrings(safetyAvoid);
};

const buildMustShow = (scene, textCorpus, subjectKind) => {
  const explicit = asArray(scene?.mustShow);
  const concrete = extractConcreteReferences(textCorpus);

  if (explicit.length > 0) {
    return uniqueStrings([...explicit, ...concrete]);
  }

  if (subjectKind === "scene") {
    return uniqueStrings(concrete);
  }

  return uniqueStrings([subjectKind, ...concrete]);
};

const buildSceneTextCorpus = (scene) =>
  normalizeText([
    scene?.title,
    scene?.narration,
    scene?.searchQuery,
    scene?.visualGoal,
    ...(Array.isArray(scene?.candidateQueries) ? scene.candidateQueries : [])
  ].filter(Boolean).join(" "));

const buildRepairStrategy = (riskFlags) => ({
  anatomy: riskFlags.handConflict || riskFlags.legConflict ? "mask_edit" : "retry",
  props: riskFlags.extraPropRisk || riskFlags.screenRisk ? "semantic_mask_remove" : "retry",
  framing: riskFlags.closeupFullBodyConflict || riskFlags.crowdedSceneRisk ? "controlled_edit" : "retry",
  expression: riskFlags.faceConflict || riskFlags.backViewExpressionConflict ? "face_mesh_edit" : "retry"
});

const buildRiskFlags = (spec) => {
  const text = buildSceneTextCorpus(spec?.raw || spec);
  const camera = spec?.camera || DEFAULT_SCENE_SPEC.camera;
  const pose = spec?.pose || DEFAULT_SCENE_SPEC.pose;
  const subject = spec?.subject || DEFAULT_SCENE_SPEC.subject;
  const constraints = spec?.constraints || DEFAULT_SCENE_SPEC.constraints;
  const focusRegions = uniqueStrings(constraints.focusRegions || []);
  const concreteReferences = uniqueStrings(constraints.mustShow || []);
  const explicitFocusCount = focusRegions.length;

  const hasFaceFocus = focusRegions.includes("face") || focusRegions.includes("head");
  const hasHandFocus = focusRegions.includes("hands") || /hand|finger|pointing|holding|touching/i.test(text);
  const hasLegFocus = focusRegions.includes("legs") || /leg|feet|foot|knee|knees/i.test(text);
  const hasTorsoFocus = focusRegions.includes("torso") || /chest|torso|shoulder|breathing/i.test(text);
  const hasDeviceFocus = focusRegions.includes("device") || includesAny(text, DEVICE_TERMS);
  const hasBackView = camera.viewpoint === "back" || /from behind|seen from behind|back of the head/i.test(text);
  const hasCloseFraming = ["closeup", "extreme_closeup"].includes(camera.framing);
  const mentionsFullBody =
    /\bfull[-\s]?body\b|\bwhole body\b|\bfull figure\b|\bentire body\b/i.test(text) ||
    concreteReferences.some((item) => /\bfull[-\s]?body\b|\bwhole body\b|\bfull figure\b|\bentire body\b/i.test(item));
  const mentionsMultiplePeople = countPeopleSignals(text) >= 2 || Number(subject.count) >= 2;
  const mentionsObjectInteraction = /\bholding\b|\btouching\b|\bpointing\b|\breaching\b|\bpressing\b|\busing\b/i.test(text);
  const mentionsDevice = includesAny(text, DEVICE_TERMS);
  const mentionsScreen = /\bscreen\b|\bdisplay\b|\bmonitor\b|\binterface\b|\bdashboard\b/i.test(text);
  const abstractOnly = concreteReferences.length === 0 && /\bcalm\b|\bpeaceful\b|\btranquil\b|\brelax\b|\bthink\b|\breflect\b|\brest\b/i.test(text);

  const flags = {
    closeupFullBodyConflict: hasCloseFraming && mentionsFullBody,
    backViewExpressionConflict: hasBackView && (hasFaceFocus || /\bexpression\b|\bsmile\b|\beyes?\b/i.test(text)),
    faceConflict: pose.faceVisibility === "hidden" && hasFaceFocus,
    handConflict: pose.handVisibility === "none" && hasHandFocus,
    legConflict: pose.bodyPose === "lying" || pose.bodyPose === "sitting" ? hasLegFocus && hasCloseFraming : false,
    objectInteractionConflict: pose.interaction === "none" && mentionsObjectInteraction && (hasDeviceFocus || hasDeviceFocus || /object|prop/i.test(text)),
    multiFocusRegionConflict: hasCloseFraming && explicitFocusCount >= 3,
    underSpecifiedSubject: subject.kind === "scene" || concreteReferences.length === 0,
    crowdedSceneRisk: mentionsMultiplePeople || explicitFocusCount >= 4,
    screenRisk: mentionsScreen || mentionsDevice,
    abstractGoalRisk: abstractOnly,
    multiPersonControlRisk: mentionsMultiplePeople && (hasFaceFocus || hasHandFocus || hasCloseFraming)
  };

  const weightedFlags = [
    [flags.closeupFullBodyConflict, 30],
    [flags.backViewExpressionConflict, 25],
    [flags.faceConflict, 20],
    [flags.handConflict, 18],
    [flags.legConflict, 14],
    [flags.objectInteractionConflict, 16],
    [flags.multiFocusRegionConflict, 18],
    [flags.underSpecifiedSubject, 12],
    [flags.crowdedSceneRisk, 16],
    [flags.screenRisk, 10],
    [flags.abstractGoalRisk, 10],
    [flags.multiPersonControlRisk, 18]
  ];

  const score = weightedFlags.reduce((total, [enabled, points]) => total + (enabled ? points : 0), 0);
  const level = score >= 70 ? "critical" : score >= 45 ? "high" : score >= 20 ? "medium" : "low";

  return {
    flags,
    score,
    level,
    reasons: Object.entries(flags)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([key]) => key)
  };
};

const buildIssue = ({code, severity, message, evidence = [], suggestion = ""}) => ({
  code,
  severity,
  message,
  evidence: uniqueStrings(evidence),
  suggestion: normalizeText(suggestion)
});

const buildLintIssues = (spec, risk) => {
  const issues = [];
  const camera = spec.camera || DEFAULT_SCENE_SPEC.camera;
  const pose = spec.pose || DEFAULT_SCENE_SPEC.pose;
  const subject = spec.subject || DEFAULT_SCENE_SPEC.subject;
  const focusRegions = uniqueStrings(spec.constraints?.focusRegions || []);

  if (risk.flags.closeupFullBodyConflict) {
    issues.push(buildIssue({
      code: "closeup_full_body_conflict",
      severity: "error",
      message: "A cena mistura close-up com pedidos de corpo inteiro.",
      evidence: [camera.framing, ...(focusRegions.includes("full_body") ? ["full_body"] : []), spec.visualGoal, spec.searchQuery],
      suggestion: "Escolha um enquadramento consistente: close-up focado ou plano mais aberto, mas não os dois ao mesmo tempo."
    }));
  }

  if (risk.flags.backViewExpressionConflict) {
    issues.push(buildIssue({
      code: "back_view_expression_conflict",
      severity: "error",
      message: "A cena pede vista por trás e também exige expressão facial legível.",
      evidence: [camera.viewpoint, spec.visualGoal, spec.searchQuery],
      suggestion: "Troque para vista frontal/lateral ou remova a dependência de expressão facial."
    }));
  }

  if (risk.flags.faceConflict) {
    issues.push(buildIssue({
      code: "face_visibility_conflict",
      severity: "error",
      message: "A spec esconde o rosto, mas a cena depende de rosto, olhos ou expressão.",
      evidence: [pose.faceVisibility, spec.visualGoal, spec.searchQuery],
      suggestion: "Permita rosto visível ou reescreva a cena para não depender de face legível."
    }));
  }

  if (risk.flags.handConflict) {
    issues.push(buildIssue({
      code: "hand_visibility_conflict",
      severity: "error",
      message: "A spec esconde as mãos, mas o shot pede mãos, dedos ou interação manual.",
      evidence: [pose.handVisibility, spec.visualGoal, spec.searchQuery],
      suggestion: "Torne as mãos visíveis ou simplifique a ação para não depender de dedos/mãos."
    }));
  }

  if (risk.flags.legConflict) {
    issues.push(buildIssue({
      code: "leg_visibility_conflict",
      severity: "warn",
      message: "A cena depende de pernas/pés, mas o enquadramento ou pose tende a cortá-los.",
      evidence: [pose.bodyPose, camera.framing, spec.visualGoal, spec.searchQuery],
      suggestion: "Abra o quadro ou retire as pernas da lista de regiões críticas."
    }));
  }

  if (risk.flags.objectInteractionConflict) {
    issues.push(buildIssue({
      code: "object_interaction_conflict",
      severity: "error",
      message: "A cena descreve interação com objeto, mas a pose está marcada como sem interação.",
      evidence: [pose.interaction, spec.visualGoal, spec.searchQuery],
      suggestion: "Marque a interação correta ou elimine o verbo de contato/uso do briefing."
    }));
  }

  if (risk.flags.multiFocusRegionConflict) {
    issues.push(buildIssue({
      code: "multi_focus_region_conflict",
      severity: "warn",
      message: "Close-up com muitas regiões focais simultâneas aumenta o risco de ambiguidade visual.",
      evidence: [camera.framing, ...focusRegions],
      suggestion: "Reduza o shot a um único foco dominante."
    }));
  }

  if (risk.flags.crowdedSceneRisk) {
    issues.push(buildIssue({
      code: "crowded_scene_risk",
      severity: "warn",
      message: "Há sinais de cena congestionada ou com múltiplas pessoas/intenções concorrentes.",
      evidence: [spec.subject?.count, spec.visualGoal, spec.searchQuery],
      suggestion: "Quebre em shots menores ou reduza o número de entidades visuais por frame."
    }));
  }

  if (risk.flags.underSpecifiedSubject) {
    issues.push(buildIssue({
      code: "under_specified_subject",
      severity: "warn",
      message: "A cena está pouco concreta; o alvo visual pode virar genérico demais.",
      evidence: [spec.narration, spec.visualGoal, spec.searchQuery],
      suggestion: "Adicione um sujeito, objeto ou ação mais específica."
    }));
  }

  if (risk.flags.abstractGoalRisk) {
    issues.push(buildIssue({
      code: "abstract_goal_risk",
      severity: "warn",
      message: "A intenção visual parece emocional, mas pouco ancorada em objetos ou ações concretas.",
      evidence: [spec.narration, spec.visualGoal],
      suggestion: "Ancore a emoção em um gesto, objeto ou cenário palpável."
    }));
  }

  return issues;
};

const buildRepairStrategyFromIssues = (issues, baseStrategy) => {
  const strategy = {...baseStrategy};
  const codes = new Set((Array.isArray(issues) ? issues : []).map((issue) => issue.code));

  if (codes.has("closeup_full_body_conflict") || codes.has("crowded_scene_risk")) {
    strategy.framing = "controlled_edit";
  }

  if (codes.has("back_view_expression_conflict") || codes.has("face_visibility_conflict")) {
    strategy.expression = "face_mesh_edit";
  }

  if (codes.has("hand_visibility_conflict") || codes.has("leg_visibility_conflict")) {
    strategy.anatomy = "mask_edit";
  }

  if (codes.has("object_interaction_conflict")) {
    strategy.props = "semantic_mask_remove";
  }

  return strategy;
};

const normalizeSceneSpecInput = (input = {}) => {
  const raw = input?.raw && typeof input.raw === "object" ? input.raw : input;
  return {
    ...DEFAULT_SCENE_SPEC,
    ...input,
    raw
  };
};

export const compileSceneSpecFromStoryboardScene = (scene = {}, options = {}) => {
  const rawScene = scene && typeof scene === "object" ? scene : {};
  const textCorpus = buildSceneTextCorpus(rawScene);
  const subjectKind = inferSubjectKind(textCorpus);
  const framing = inferFraming(textCorpus);
  const viewpoint = inferViewpoint(textCorpus);
  const bodyPose = inferBodyPose(textCorpus);
  const emotion = inferEmotion(textCorpus);
  const spec = {
    ...DEFAULT_SCENE_SPEC,
    schemaVersion: SCHEMA_VERSION,
    sceneId: normalizeText(rawScene.sceneId || rawScene.id || rawScene.sceneNumber || rawScene.title || options.sceneId || ""),
    sceneNumber: Number.isFinite(Number(rawScene.sceneNumber)) ? Number(rawScene.sceneNumber) : Number.isFinite(Number(options.sceneNumber)) ? Number(options.sceneNumber) : null,
    title: normalizeText(rawScene.title || rawScene.name || ""),
    narration: normalizeText(rawScene.narration || ""),
    searchQuery: normalizeText(rawScene.searchQuery || ""),
    visualGoal: normalizeText(rawScene.visualGoal || ""),
    sceneType: normalizeText(rawScene.sceneType || options.sceneType || "unknown") || "unknown",
    subject: {
      kind: subjectKind,
      count: Math.max(1, countPeopleSignals(textCorpus)),
      description: normalizeText(rawScene.visualGoal || rawScene.searchQuery || rawScene.narration || ""),
      identityRefs: uniqueStrings([
        ...asArray(rawScene.identityRefs),
        ...extractConcreteReferences(textCorpus)
      ])
    },
    camera: {
      framing,
      viewpoint,
      lensStyle: framing === "extreme_closeup" || framing === "closeup" ? "portrait" : "normal",
      cropPriority: ["extreme_closeup", "closeup"].includes(framing)
        ? (includesAny(textCorpus, BODY_PART_TERMS.face) ? "face" : includesAny(textCorpus, BODY_PART_TERMS.hands) ? "hands" : "torso")
        : includesAny(textCorpus, LOCATION_TERMS) ? "environment" : "silhouette"
    },
    pose: {
      bodyPose,
      handVisibility: inferHandVisibility(textCorpus, framing, viewpoint),
      faceVisibility: inferFaceVisibility(textCorpus, viewpoint, framing),
      interaction: /\bholding\b|\btouching\b|\bpointing\b|\breaching\b|\bpressing\b|\busing\b/i.test(textCorpus)
        ? (includesAny(textCorpus, PERSON_TERMS) && /with another person|towards another person|talking to/i.test(textCorpus) ? "other_person" : "object")
        : "none"
    },
    affect: {
      emotion,
      intensity: inferIntensity(textCorpus, emotion),
      gaze: inferGaze(textCorpus)
    },
    environment: {
      location: inferLocation(rawScene),
      allowedProps: uniqueStrings([
        ...extractKnownTerms(textCorpus, DEVICE_TERMS),
        ...extractKnownTerms(textCorpus, OBJECT_TERMS)
      ]),
      forbiddenProps: uniqueStrings([
        ...DEFAULT_FORBIDDEN_TERMS,
        ...(rawScene.forbiddenProps ? asArray(rawScene.forbiddenProps) : [])
      ]),
      clutterLevel: inferClutterLevel(textCorpus)
    },
    constraints: {
      mustShow: buildMustShow(rawScene, textCorpus, subjectKind),
      mustAvoid: buildMustAvoid(rawScene, textCorpus),
      focusRegions: extractFocusRegions(textCorpus),
      continuityPriority: subjectKind === "person" ? "identity" : "composition"
    },
    repairStrategy: {
      anatomy: "retry",
      props: "retry",
      framing: "retry",
      expression: "retry"
    },
    raw: rawScene
  };

  const risk = buildRiskFlags(spec);
  const issues = buildLintIssues(spec, risk);
  spec.repairStrategy = buildRepairStrategyFromIssues(issues, spec.repairStrategy);
  spec.derived = {
    textCorpus,
    risk
  };

  return spec;
};

export const calculateSceneRiskFlags = (sceneSpec = {}) => {
  const spec = sceneSpec?.schemaVersion === SCHEMA_VERSION
    ? normalizeSceneSpecInput(sceneSpec)
    : compileSceneSpecFromStoryboardScene(sceneSpec);

  const risk = buildRiskFlags(spec);

  return {
    ...risk,
    repairStrategy: buildRepairStrategy(risk.flags)
  };
};

export const lintSceneSpec = (sceneOrSpec = {}, options = {}) => {
  const spec = sceneOrSpec?.schemaVersion === SCHEMA_VERSION
    ? normalizeSceneSpecInput(sceneOrSpec)
    : compileSceneSpecFromStoryboardScene(sceneOrSpec, options);

  const risk = calculateSceneRiskFlags(spec);
  const issues = buildLintIssues(spec, risk);
  const repairStrategy = buildRepairStrategyFromIssues(issues, spec.repairStrategy);
  const hasErrors = issues.some((issue) => issue.severity === "error");
  const highestSeverity = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warn")
      ? "warn"
      : "info";

  return {
    ok: !hasErrors,
    schemaVersion: SCHEMA_VERSION,
    spec,
    risk,
    issues,
    severity: highestSeverity,
    repairStrategy,
    summary: {
      issueCount: issues.length,
      errorCount: issues.filter((issue) => issue.severity === "error").length,
      warningCount: issues.filter((issue) => issue.severity === "warn").length,
      score: risk.score,
      level: risk.level
    }
  };
};

export const isSceneSpec = (value) =>
  Boolean(value && typeof value === "object" && Number(value.schemaVersion) === SCHEMA_VERSION && value.subject && value.camera && value.pose);

export const createEmptySceneSpec = () => structuredClone(DEFAULT_SCENE_SPEC);

export const SCENE_SPEC_FIELDS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  subjectKinds: ["person", "device", "animal", "object", "scene"],
  framingValues: ["extreme_closeup", "closeup", "three_quarter", "full_body", "wide"],
  viewpointValues: ["front", "profile", "back", "topdown", "low_angle", "three_quarter"],
  repairValues: ["retry", "mask_edit", "controlled_edit", "semantic_mask_remove", "face_mesh_edit", "crop_repair"]
});
