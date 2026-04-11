const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const compactText = (value) => normalizeText(value).replace(/[^a-z0-9]+/g, " ");

const tokenize = (value) =>
  compactText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

const includesAny = (text, patterns) =>
  patterns.some((pattern) => pattern.test(text));

const findMatches = (text, patterns) =>
  patterns.flatMap((pattern) => {
    const match = text.match(pattern);
    return match ? [match[0]] : [];
  });

const makeRule = ({
  id,
  label,
  priority,
  category,
  repairMode,
  scope,
  patterns,
  hints = [],
  operations = [],
  promptHints = []
}) => ({
  id,
  label,
  priority,
  category,
  repairMode,
  scope,
  patterns,
  hints,
  operations,
  promptHints
});

const FAILURE_RULES = [
  makeRule({
    id: "ocr_text",
    label: "Readable text or UI chrome",
    priority: 100,
    category: "text_overlay",
    repairMode: "mask_edit",
    scope: "local",
    patterns: [
      /\breadable text\b/i,
      /\btext on (?:the |a )?(?:screen|phone|tablet|monitor|display)\b/i,
      /\binterface elements?\b/i,
      /\bui elements?\b/i,
      /\blogo\b/i,
      /\bwatermark\b/i,
      /\bletters?\b/i,
      /\bwords?\b/i,
      /\bsignature\b/i
    ],
    hints: [
      "remove any visible text or interface chrome",
      "prefer a blank or abstract surface",
      "mask the object surface instead of regenerating the whole scene"
    ],
    operations: ["semantic_mask_remove", "local_inpaint", "retry_with_no_text"],
    promptHints: ["no readable text", "no UI chrome", "no letters or numbers"]
  }),
  makeRule({
    id: "screen_content",
    label: "Wrong screen contents",
    priority: 95,
    category: "screen_content_mismatch",
    repairMode: "mask_edit",
    scope: "local",
    patterns: [
      /\bsmartphone screen\b/i,
      /\bphone screen\b/i,
      /\btablet screen\b/i,
      /\bmonitor screen\b/i,
      /\bdisplay screen\b/i,
      /\bblank screen\b/i,
      /\bglowing screen\b/i
    ],
    hints: [
      "reduce the scene to a blank or abstract display",
      "remove any app-like content or symbols",
      "repair the screen locally before retrying the shot"
    ],
    operations: ["screen_mask_edit", "local_inpaint", "retry_with_blank_display"],
    promptHints: ["blank screen", "abstract display", "no app content"]
  }),
  makeRule({
    id: "viewpoint_mismatch",
    label: "Wrong viewpoint or perspective",
    priority: 94,
    category: "viewpoint_mismatch",
    repairMode: "controlled_edit",
    scope: "scene",
    patterns: [
      /\bfrom behind\b/i,
      /\bseen from behind\b/i,
      /\bfront view\b/i,
      /\bfrom the front\b/i,
      /\bprofile\b/i,
      /\bside profile\b/i,
      /\bthree[- ]quarter\b/i,
      /\btop[- ]down\b/i,
      /\bbird'?s[- ]eye\b/i,
      /\blow angle\b/i,
      /\bover[- ]the[- ]shoulder\b/i
    ],
    hints: [
      "lock the camera viewpoint before regenerating",
      "avoid changing the subject orientation after the first pass",
      "use a controlled edit or a stricter camera prompt"
    ],
    operations: ["controlled_reframe", "retry_with_camera_lock"],
    promptHints: ["camera viewpoint locked", "keep the same angle", "preserve orientation"]
  }),
  makeRule({
    id: "framing_mismatch",
    label: "Wrong framing or crop",
    priority: 92,
    category: "framing_mismatch",
    repairMode: "controlled_edit",
    scope: "scene",
    patterns: [
      /\bclose[- ]up\b/i,
      /\bextreme close[- ]up\b/i,
      /\bfull body\b/i,
      /\bwide shot\b/i,
      /\bmedium shot\b/i,
      /\bcropped head\b/i,
      /\bcropped limbs?\b/i,
      /\bfull frame\b/i
    ],
    hints: [
      "replace the current crop with the required framing",
      "if the subject is otherwise correct, use a crop or reframe pass",
      "tighten the composition to the target shot size"
    ],
    operations: ["crop_repair", "controlled_reframe", "retry_with_framing_lock"],
    promptHints: ["framing locked", "target crop", "preserve composition"]
  }),
  makeRule({
    id: "anatomy_defect",
    label: "Anatomy defect",
    priority: 91,
    category: "anatomy_defect",
    repairMode: "crop_repair",
    scope: "local",
    patterns: [
      /\bextra arms?\b/i,
      /\bextra legs?\b/i,
      /\bextra hands?\b/i,
      /\bextra fingers?\b/i,
      /\bduplicate limbs?\b/i,
      /\bfused limbs?\b/i,
      /\bfloating limbs?\b/i,
      /\bmutated anatomy\b/i,
      /\bdeformed anatomy\b/i,
      /\bmisshapen\b/i,
      /\bwarped\b/i
    ],
    hints: [
      "repair the anatomical region locally",
      "crop the defective part if the rest of the image is good",
      "regenerate with stronger anatomy constraints only if local repair fails"
    ],
    operations: ["local_anatomy_repair", "crop_repair", "retry_with_anatomy_lock"],
    promptHints: ["clean anatomy", "one head", "two arms", "two legs", "no extra limbs"]
  }),
  makeRule({
    id: "hand_defect",
    label: "Hand or finger defect",
    priority: 90,
    category: "hand_defect",
    repairMode: "crop_repair",
    scope: "local",
    patterns: [
      /\bhand[s]?\b/i,
      /\bfinger[s]?\b/i,
      /\bthumb[s]?\b/i,
      /\bgrabbing\b/i,
      /\bpointing\b/i,
      /\btouching\b/i,
      /\bholding\b/i,
      /\bscratching\b/i,
      /\breaching\b/i,
      /\bgesture\b/i
    ],
    hints: [
      "repair the hand region locally",
      "prefer a crop or hand-focused inpaint over full regeneration",
      "reduce hand complexity in the retry prompt"
    ],
    operations: ["hand_crop_repair", "local_inpaint", "retry_with_hand_lock"],
    promptHints: ["hands readable but simplified", "no extra fingers", "hand pose locked"]
  }),
  makeRule({
    id: "face_defect",
    label: "Face or expression defect",
    priority: 89,
    category: "face_defect",
    repairMode: "mask_edit",
    scope: "local",
    patterns: [
      /\bface\b/i,
      /\beyes?\b/i,
      /\bmouth\b/i,
      /\bsmile\b/i,
      /\bexpression\b/i,
      /\bpeaceful\b/i,
      /\bcalm\b/i,
      /\bworried\b/i,
      /\btense\b/i,
      /\brelieved\b/i,
      /\bangry\b/i,
      /\bsad\b/i
    ],
    hints: [
      "preserve the face or expression with a focused local repair",
      "if expression is the only issue, edit the facial region instead of the full frame",
      "keep emotional intent stable across retries"
    ],
    operations: ["face_mask_edit", "expression_repair", "retry_with_emotion_lock"],
    promptHints: ["expression locked", "face preserved", "emotion consistent"]
  }),
  makeRule({
    id: "emotion_mismatch",
    label: "Wrong emotion or affect",
    priority: 88,
    category: "emotion_mismatch",
    repairMode: "retry_with_constraints",
    scope: "scene",
    patterns: [
      /\bpeaceful\b/i,
      /\bcalm\b/i,
      /\brelaxed\b/i,
      /\bcontent\b/i,
      /\bserene\b/i,
      /\bworried\b/i,
      /\btense\b/i,
      /\bstressed\b/i,
      /\bfrustrated\b/i,
      /\bangry\b/i,
      /\bconfused\b/i,
      /\brelieved\b/i
    ],
    hints: [
      "rewrite the emotional target in a stricter way",
      "avoid adding unrelated actions that fight the mood",
      "if the face is already good, keep the scene and only repair the emotional emphasis"
    ],
    operations: ["retry_with_emotion_lock", "scene_semantic_rewrite"],
    promptHints: ["emotion locked", "consistent mood", "single emotional beat"]
  }),
  makeRule({
    id: "prop_mismatch",
    label: "Wrong or extraneous prop",
    priority: 87,
    category: "prop_mismatch",
    repairMode: "mask_edit",
    scope: "local",
    patterns: [
      /\bdevice\b/i,
      /\bphone\b/i,
      /\btablet\b/i,
      /\blaptop\b/i,
      /\bmonitor\b/i,
      /\bclock\b/i,
      /\bbackpack\b/i,
      /\bcup\b/i,
      /\bbook\b/i,
      /\bpen\b/i,
      /\bdial\b/i,
      /\bpanel\b/i,
      /\bicon\b/i,
      /\bwire\b/i
    ],
    hints: [
      "remove the unwanted prop locally if the core subject is correct",
      "if a key prop is missing, regenerate with the prop explicitly locked",
      "prefer scene repair over a full rerender when the mismatch is localized"
    ],
    operations: ["prop_mask_edit", "local_inpaint", "retry_with_prop_lock"],
    promptHints: ["prop locked", "only the required object", "no extra objects"]
  }),
  makeRule({
    id: "background_clutter",
    label: "Background clutter or distraction",
    priority: 86,
    category: "background_clutter",
    repairMode: "mask_edit",
    scope: "local",
    patterns: [
      /\bbusy background\b/i,
      /\bclutter\b/i,
      /\bdistracting\b/i,
      /\bbackground\b/i,
      /\bextra props\b/i,
      /\btoo many\b/i,
      /\bnoise\b/i,
      /\bblurry\b/i
    ],
    hints: [
      "clear the background and keep only the essential support elements",
      "prefer a local cleanup when the subject is already acceptable",
      "reduce environmental complexity in the retry prompt"
    ],
    operations: ["background_mask_edit", "clean_background", "retry_with_minimal_props"],
    promptHints: ["minimal background", "clean composition", "single focal subject"]
  }),
  makeRule({
    id: "scene_semantics",
    label: "Scene does not match the requested idea",
    priority: 85,
    category: "scene_semantics_mismatch",
    repairMode: "retry_with_constraints",
    scope: "scene",
    patterns: [
      /\bdoes not match\b/i,
      /\bdoes not align\b/i,
      /\bcontradict(s|ory)?\b/i,
      /\bnot the focus\b/i,
      /\bwrong subject\b/i,
      /\bsubject matter\b/i,
      /\bvisual goal\b/i,
      /\bscene is\b/i,
      /\bthe image shows\b/i
    ],
    hints: [
      "rewrite the shot with a tighter semantic description",
      "keep only the core subject and one visible action",
      "if multiple mismatches are present, prefer a scene retry over local repair"
    ],
    operations: ["scene_semantic_rewrite", "retry_with_target_lock"],
    promptHints: ["one clear subject", "one visible action", "semantic target locked"]
  }),
  makeRule({
    id: "unknown",
    label: "Unclassified visual failure",
    priority: 0,
    category: "unknown",
    repairMode: "manual_review",
    scope: "scene",
    patterns: [],
    hints: [
      "inspect the image and the prompt together",
      "fall back to a conservative retry if the failure is persistent"
    ],
    operations: ["manual_review", "retry_with_conservative_prompt"],
    promptHints: ["conservative retry", "review required"]
  })
];

const normalizeMatchList = (matches) =>
  Array.from(new Set(matches.map((match) => normalizeText(match)).filter(Boolean)));

const scoreRule = (text, rule) => {
  const matches = findMatches(text, rule.patterns);
  const tokenCount = tokenize(matches.join(" ")).length;
  const phraseCount = matches.length;
  const score = rule.priority + phraseCount * 3 + tokenCount;

  return {
    ...rule,
    matched: matches,
    score
  };
};

export const classifyFailureText = (value, options = {}) => {
  const rawText = String(value ?? options.text ?? "");
  const text = normalizeText(rawText);
  const tokens = tokenize(text);
  const scoredRules = FAILURE_RULES.map((rule) => scoreRule(text, rule))
    .filter((rule) => rule.category === "unknown" || rule.matched.length > 0)
    .sort((left, right) => right.score - left.score || right.priority - left.priority);

  const primary = scoredRules[0] ?? scoreRule(text, FAILURE_RULES[FAILURE_RULES.length - 1]);
  const secondary = scoredRules.slice(1, 4);
  const categories = scoredRules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    category: rule.category,
    score: rule.score,
    matched: normalizeMatchList(rule.matched),
    repairMode: rule.repairMode,
    scope: rule.scope
  }));
  const confidence = Math.max(
    0,
    Math.min(1, Number(((primary.score - 70) / 40).toFixed(2)))
  );

  return {
    rawText,
    normalizedText: text,
    tokens,
    primaryCategory: primary.category,
    primaryRuleId: primary.id,
    label: primary.label,
    repairMode: primary.repairMode,
    scope: primary.scope,
    confidence,
    categories,
    secondaryCategories: secondary.map((rule) => ({
      id: rule.id,
      label: rule.label,
      category: rule.category,
      score: rule.score,
      matched: normalizeMatchList(rule.matched),
      repairMode: rule.repairMode,
      scope: rule.scope
    })),
    evidence: normalizeMatchList(primary.matched),
    hints: primary.hints,
    operations: primary.operations,
    promptHints: primary.promptHints,
    isUnknown: primary.category === "unknown"
  };
};

export const suggestRepairStrategy = (analysis, options = {}) => {
  const source =
    typeof analysis === "string"
      ? classifyFailureText(analysis, options)
      : analysis && typeof analysis === "object"
        ? analysis
        : classifyFailureText("", options);

  const primaryCategory = source.primaryCategory || "unknown";
  const promptHints = new Set([
    ...(source.promptHints ?? []),
    ...(options.promptHints ?? [])
  ]);

  const strategyByCategory = {
    text_overlay: {
      mode: "mask_edit",
      scope: "local",
      priority: "high",
      steps: ["mask_text", "remove_ui_chrome", "rerun_local_audit"],
      retryPolicy: "local-first"
    },
    screen_content_mismatch: {
      mode: "mask_edit",
      scope: "local",
      priority: "high",
      steps: ["mask_screen", "replace_with_blank_display", "rerun_local_audit"],
      retryPolicy: "local-first"
    },
    viewpoint_mismatch: {
      mode: "controlled_edit",
      scope: "scene",
      priority: "high",
      steps: ["lock_viewpoint", "reframe_scene", "regenerate_shot"],
      retryPolicy: "scene-first"
    },
    framing_mismatch: {
      mode: "controlled_edit",
      scope: "scene",
      priority: "high",
      steps: ["lock_framing", "crop_or_reframe", "regenerate_shot"],
      retryPolicy: "scene-first"
    },
    anatomy_defect: {
      mode: "crop_repair",
      scope: "local",
      priority: "high",
      steps: ["repair_anatomy_region", "crop_to_safe_area", "retry_with_anatomy_lock"],
      retryPolicy: "local-first"
    },
    hand_defect: {
      mode: "crop_repair",
      scope: "local",
      priority: "high",
      steps: ["repair_hand_region", "reduce_hand_complexity", "retry_with_hand_lock"],
      retryPolicy: "local-first"
    },
    face_defect: {
      mode: "mask_edit",
      scope: "local",
      priority: "high",
      steps: ["preserve_face_region", "repair_expression", "retry_with_emotion_lock"],
      retryPolicy: "local-first"
    },
    emotion_mismatch: {
      mode: "retry_with_constraints",
      scope: "scene",
      priority: "medium",
      steps: ["lock_emotion", "rewrite_scene_target", "regenerate_shot"],
      retryPolicy: "scene-first"
    },
    prop_mismatch: {
      mode: "mask_edit",
      scope: "local",
      priority: "medium",
      steps: ["remove_extra_prop", "lock_required_prop", "rerun_local_audit"],
      retryPolicy: "local-first"
    },
    background_clutter: {
      mode: "mask_edit",
      scope: "local",
      priority: "medium",
      steps: ["clean_background", "reduce_clutter", "rerun_local_audit"],
      retryPolicy: "local-first"
    },
    scene_semantics_mismatch: {
      mode: "retry_with_constraints",
      scope: "scene",
      priority: "high",
      steps: ["rewrite_semantic_target", "lock_subject_and_action", "regenerate_shot"],
      retryPolicy: "scene-first"
    },
    unknown: {
      mode: "manual_review",
      scope: "scene",
      priority: "low",
      steps: ["inspect_prompt_and_output", "apply_conservative_retry"],
      retryPolicy: "manual-review"
    }
  };

  const strategy = strategyByCategory[primaryCategory] ?? strategyByCategory.unknown;

  return {
    category: primaryCategory,
    mode: strategy.mode,
    scope: strategy.scope,
    priority: strategy.priority,
    retryPolicy: strategy.retryPolicy,
    steps: strategy.steps,
    operations: source.operations ?? [],
    evidence: source.evidence ?? [],
    confidence: source.confidence ?? 0,
    promptHints: Array.from(promptHints),
    suggestedPromptHints: Array.from(new Set([...(source.promptHints ?? []), ...strategy.steps])),
    needsLocalRepair: strategy.mode === "mask_edit" || strategy.mode === "crop_repair",
    needsSceneRetry: strategy.mode === "controlled_edit" || strategy.mode === "retry_with_constraints",
    needsManualReview: strategy.mode === "manual_review" || source.confidence < 0.35
  };
};

export const analyzeFailureText = (value, options = {}) => {
  const classification = classifyFailureText(value, options);
  const repair = suggestRepairStrategy(classification, options);

  return {
    ...classification,
    repairStrategy: repair
  };
};

export const classifyVisualFailure = analyzeFailureText;
export const classifyGeminiVisionFailure = analyzeFailureText;

export const FAILURE_TAXONOMY = FAILURE_RULES.map((rule) => ({
  id: rule.id,
  label: rule.label,
  category: rule.category,
  priority: rule.priority,
  repairMode: rule.repairMode,
  scope: rule.scope,
  hints: rule.hints,
  operations: rule.operations,
  promptHints: rule.promptHints
}));

export const REPAIR_STRATEGIES = {
  mask_edit: "local-first",
  crop_repair: "local-first",
  controlled_edit: "scene-first",
  retry_with_constraints: "scene-first",
  manual_review: "manual-review"
};

export default {
  FAILURE_TAXONOMY,
  REPAIR_STRATEGIES,
  analyzeFailureText,
  classifyFailureText,
  classifyGeminiVisionFailure,
  classifyVisualFailure,
  suggestRepairStrategy,
  tokenize
};
