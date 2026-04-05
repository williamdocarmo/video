export const VISUAL_STYLE_PRESETS = {
  claude: {
    id: "claude",
    label: "Video estilo Claude",
    description: "Visual claro, flat, fundo branco e linguagem corporate memphis com stick figures legíveis.",
    expectStickman: true,
    characterPrompt:
      "single stick figure character when needed, large round head, thin black limbs, minimal face, clean posture, clear silhouette, expressive body language",
    stylePrompt:
      "flat stick figure editorial illustration, clean black outlines, white background, corporate memphis color accents, simple geometric props, high clarity, immediate explainer readability, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stick figure design, same thin black line weight, same white-background treatment, same memphis accent palette, same explainer composition logic",
    compositionRules:
      "one clear focal character performing one literal action, readable silhouette, simple supporting props, clean layout, no text",
    backgroundDirectives: [
      "clean white or very light neutral background with generous open space",
      "supporting objects should stay simple as flat geometric props or small pictograms",
      "background detail should stay secondary so the action reads instantly on mobile"
    ],
    defaultLighting: "clean high-contrast lighting on a white background",
    plannerGuidance:
      "Every shot must read immediately as a clean stick figure explainer: large round head, thin black limbs, flat accents, white background, and one idea per frame.",
    humanGuidance:
      "Any human should read as a simple stick figure with a large round head, minimal face, expressive posture, and consistent proportions.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clean limb separation.",
    scaleGuidance:
      "If a shot includes a person, make the stick figure clearly readable and substantial in frame. Do not describe the person as a tiny distant mark, a micro figure, or a single vertical line.",
    attemptDirectives: [
      "render the scene as a clean stick figure explainer with thin black lines and flat memphis accents",
      "if a person is present, keep one readable stick figure with a large round head and well-separated limbs",
      "favor one focal subject, one literal action, and a white background with open space",
      "keep the full body readable so posture carries the idea",
      "use simple geometric props and avoid visual clutter"
    ],
    refinePromptLead: "clean stick figure editorial illustration",
    refinePromptFinish: "flat memphis accents, black outlines, white background, no text",
    auditStyleDescription:
      "clean stick figure editorial illustration style with thin black lines, large round heads, flat accents, and simplified body language"
  },
  kiro: {
    id: "kiro",
    label: "Video estilo Kiro",
    description: "Visual cinematografico, fundo escuro, contraste forte e paleta mais dramatica.",
    expectStickman: true,
    characterPrompt:
      "single stick figure character when needed, large round head, thin black limbs, minimal face, expressive posture, clean silhouette, built for dark cinematic scenes",
    stylePrompt:
      "dark cinematic stick figure illustration, controlled vivid accents, strong contrast, moody atmosphere, readable silhouette, polished editorial framing, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stick figure design, same dark cinematic treatment, same controlled accent palette, same dramatic rim separation, same polished composition logic",
    compositionRules:
      "one clear focal character, one literal action, deep contrast, readable silhouette, atmospheric but restrained environment, no text",
    backgroundDirectives: [
      "dark cinematic background with strong subject separation and restrained color accents",
      "environment detail should support the action without swallowing the character silhouette",
      "surfaces and props should feel moody, clean, and premium rather than noisy"
    ],
    defaultLighting: "controlled cinematic lighting with strong subject separation on a dark background",
    plannerGuidance:
      "Every shot must read as a dark cinematic stick figure frame with one focal subject, strong silhouette separation, controlled color accents, and immediate mobile readability.",
    humanGuidance:
      "Any human should read as a stylized dark-scene stick figure with a large round head, minimal face, expressive posture, and a readable silhouette.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clear separation against the dark background.",
    scaleGuidance:
      "If a shot includes a person, keep the stick figure large enough to read clearly against the dark background. Avoid tiny distant silhouettes or body parts disappearing into shadows.",
    attemptDirectives: [
      "render the scene as a dark cinematic stick figure illustration with strong contrast and controlled vivid accents",
      "if a person is present, keep one readable stick figure with a large round head and well-separated limbs",
      "favor one focal subject, one clear action, and strong rim or edge separation",
      "keep the body readable instead of over-zooming on the face",
      "use atmosphere and props to support the mood without clutter"
    ],
    refinePromptLead: "dark cinematic stick figure illustration",
    refinePromptFinish: "controlled vivid accents, strong contrast, dark background, no text",
    auditStyleDescription:
      "dark cinematic stick figure illustration style with dramatic contrast, controlled accents, and readable silhouette separation",
    negativePromptRemovals: ["dark background", "complex shadows", "high saturation", "neon glow"]
  },
  editorial_clean: {
    id: "editorial_clean",
    label: "Editorial Clean",
    description: "Ilustração editorial limpa, humana e clara, com foco em objetos, prova visual e leitura rápida.",
    expectStickman: false,
    characterPrompt:
      "single simplified editorial human when needed, clean human proportions, readable posture, clear silhouette, minimal facial detail, modern illustrated presence",
    stylePrompt:
      "clean editorial illustration, modern explainer art, crisp shapes, restrained palette, light neutral background, subtle depth, high clarity, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same editorial illustration language, same clean shape treatment, same restrained palette, same object hierarchy, same polished explainer composition",
    compositionRules:
      "one clear focal subject, one proof visual per scene, readable objects, clean posture, one main action, no symbolic clutter, no text",
    backgroundDirectives: [
      "light neutral or off-white background with minimal environmental shapes",
      "clear object hierarchy with one or two supporting props only",
      "background detail should stay soft and secondary to the proof visual"
    ],
    defaultLighting: "clean studio-style lighting on a light neutral background",
    plannerGuidance:
      "Every shot must read as a clean editorial explainer frame with one proof visual, one clear action, restrained color, and immediate mobile readability.",
    humanGuidance:
      "Any human should read as a simplified editorial person with readable posture, minimal facial detail, and clean anatomy.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clean separation and natural proportions.",
    scaleGuidance:
      "If a shot includes a person, keep the character large enough to read clearly and avoid tiny background people.",
    attemptDirectives: [
      "render the scene as a clean editorial illustration with crisp shapes and restrained color",
      "if a person is present, keep one readable human figure with natural proportions and minimal facial detail",
      "favor one proof visual, one main object cluster, and one clear action",
      "keep the frame readable on mobile with open space and restrained props",
      "preserve action context instead of over-cropping the face"
    ],
    refinePromptLead: "clean editorial illustration",
    refinePromptFinish: "crisp shapes, restrained palette, light neutral background, no text",
    auditStyleDescription:
      "clean editorial illustration style with simplified humans, crisp shapes, restrained palette, and strong object hierarchy"
  },
  realistic_film: {
    id: "realistic_film",
    label: "Realistic Film",
    description: "Frames com cara de cinema realista, luz natural, profundidade e cenas mais humanas.",
    expectStickman: false,
    characterPrompt:
      "single realistic human subject when needed, natural proportions, grounded body language, readable pose, believable presence, clean anatomy",
    stylePrompt:
      "cinematic realistic film still, natural light, documentary realism, subtle color grading, real-world textures, shallow depth of field, polished but grounded composition, non-fantasy, no text, no logos, no watermark",
    styleLockPrompt:
      "consistent visual identity across all scenes, same filmic realism, same natural-light treatment, same grounded lens language, same restrained grade, same premium cinematic composition",
    compositionRules:
      "one strong focal subject, one real-world action or proof visual per frame, believable environment, no surreal clutter, no text",
    backgroundDirectives: [
      "realistic environments with controlled detail and clean subject separation",
      "prefer natural surfaces, believable objects, and premium documentary framing",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "natural cinematic lighting with realistic depth and subject separation",
    plannerGuidance:
      "Every shot must read as a cinematic realistic film still with believable locations, natural behavior, strong object realism, and premium subject separation.",
    humanGuidance:
      "Any human should read as a real person in a believable setting with natural posture, clothing, and grounded emotion.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with realistic proportions and natural body structure.",
    scaleGuidance:
      "Keep the main subject prominent and readable in frame. Avoid tiny distant people unless the shot is intentionally environmental.",
    attemptDirectives: [
      "render the scene as a cinematic realistic film still with believable textures and natural light",
      "if a person is present, keep one realistic human figure with natural proportions and grounded body language",
      "favor one strong photographic idea with a clear subject and clean depth separation",
      "keep props and locations believable instead of symbolic",
      "preserve restrained grading and premium realism"
    ],
    refinePromptLead: "cinematic realistic film still",
    refinePromptFinish: "natural light, premium realism, restrained grade, no text",
    auditStyleDescription:
      "cinematic realistic film still style with believable humans, natural lighting, real-world objects, and premium subject separation"
  },
  cartoon_3d: {
    id: "cartoon_3d",
    label: "Cartoon 3D",
    description: "Visual 3D estilizado, amigável e volumétrico, com personagens claros e objetos fáceis de ler.",
    expectStickman: false,
    characterPrompt:
      "single stylized 3d cartoon character when needed, rounded forms, simple expressive face, clean silhouette, readable hands and limbs, friendly body language",
    stylePrompt:
      "stylized 3d cartoon render, soft volumetric lighting, rounded shapes, clean materials, vibrant but controlled palette, family-friendly premium animation look, high readability, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stylized 3d cartoon world, same rounded modeling language, same material treatment, same soft volumetric lighting, same polished animation-film composition",
    compositionRules:
      "one clear focal subject, one simple action, readable props, bold silhouette, clean layout, no text",
    backgroundDirectives: [
      "stylized 3d environment with simple readable props and soft depth",
      "keep backgrounds supportive, clean and colorful without becoming noisy",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "soft volumetric 3d lighting with clean subject separation",
    plannerGuidance:
      "Every shot must read as a premium stylized 3d cartoon frame with rounded forms, readable props, one clear action, and clean family-friendly staging.",
    humanGuidance:
      "Any human should read as a stylized 3d cartoon person with rounded forms, clean silhouette, and a simple expressive face.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with rounded, readable proportions.",
    scaleGuidance:
      "Keep the main character or object large and readable, like a frame from a polished animated short.",
    attemptDirectives: [
      "render the scene as a stylized 3d cartoon shot with rounded forms, clean materials, and soft volumetric light",
      "if a character is present, keep one readable figure with simple expressive features and well-separated limbs",
      "favor one charming action and one main prop cluster",
      "keep the frame readable on mobile with clean staging",
      "preserve a polished animated-short feeling rather than flat poster framing"
    ],
    refinePromptLead: "stylized 3d cartoon render",
    refinePromptFinish: "rounded forms, soft volumetric light, clean materials, no text",
    auditStyleDescription:
      "stylized 3d cartoon style with rounded forms, clean materials, readable characters, and soft volumetric lighting"
  },
  urban_sketching: {
    id: "urban_sketching",
    label: "Urban Sketching",
    description: "Traço solto de caderno urbano, com aquarela leve, observação do cotidiano e energia manual.",
    expectStickman: false,
    characterPrompt:
      "single hand-drawn sketchbook human when needed, expressive posture, readable gesture, loose confident linework, natural proportions",
    stylePrompt:
      "urban sketchbook illustration, ink line drawing with light watercolor wash, observational drawing feel, travel journal energy, handmade imperfections, elegant composition, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same urban sketchbook line quality, same watercolor wash treatment, same hand-drawn rhythm, same observational composition language",
    compositionRules:
      "one clear subject, observational sketchbook feel, readable props, open composition, no text",
    backgroundDirectives: [
      "paper-like light background with visible sketchbook or watercolor feel",
      "supporting elements should look hand-drawn and loosely observed, not rigid vector icons",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "soft natural daylight translated into ink and watercolor washes",
    plannerGuidance:
      "Every shot must read as an urban sketchbook illustration with lively ink lines, light watercolor wash, observational rhythm, and one clear focal idea.",
    humanGuidance:
      "Any human should read as a hand-drawn sketchbook person with expressive gesture, readable posture, and light facial detail.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with readable gesture even in loose drawing form.",
    scaleGuidance:
      "Keep the subject large enough to feel intentional on mobile. Avoid tiny scribbles and overly distant cityscape compositions.",
    attemptDirectives: [
      "render the scene as an urban sketchbook illustration with lively ink lines and light watercolor wash",
      "if a person is present, keep one readable sketchbook figure with natural proportions and expressive gesture",
      "favor one focal subject and a handmade observational feel",
      "keep the background supportive and breathable instead of dense",
      "preserve loose human rhythm rather than rigid vector symmetry"
    ],
    refinePromptLead: "urban sketchbook illustration",
    refinePromptFinish: "ink lines, watercolor wash, handmade paper feel, no text",
    auditStyleDescription:
      "urban sketchbook illustration style with ink lines, watercolor washes, handmade rhythm, and readable observational scenes"
  },
  ink: {
    id: "ink",
    label: "Ink",
    description: "Ilustração forte em tinta, contraste alto e leitura imediata, com energia gráfica mais madura.",
    expectStickman: false,
    characterPrompt:
      "single ink-drawn human figure when needed, clean human proportions, bold solid silhouette, minimal facial detail, confident continuous outlines, readable hands and limbs",
    stylePrompt:
      "editorial ink illustration, crisp black brushwork, strong contrast, graphic shadow masses, clean paper background, controlled negative space, subtle accent color only when useful, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same ink weight, same contrast ratio, same paper-and-ink treatment, same editorial composition logic",
    compositionRules:
      "one dominant subject performing one clear action, strong figure-ground separation, readable silhouette, restrained props, uncluttered layout, no text, no fake UI",
    backgroundDirectives: [
      "light paper or off-white neutral background with open negative space and crisp ink contrast",
      "supporting elements should stay simplified as bold ink shapes or economical brush marks",
      "paper texture should stay subtle and never compete with the main subject"
    ],
    defaultLighting: "translate lighting into flat ink shadow masses and clean negative space instead of realistic shading",
    plannerGuidance:
      "Every shot must read immediately at thumbnail size as a clean editorial ink illustration with one focal subject, one clear action, strong contrast, and generous negative space.",
    humanGuidance:
      "Any human should read as a confident ink-drawn person with clean proportions, clear silhouette, minimal facial detail, and decisive linework.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clear limb separation, readable hands, and natural proportions.",
    scaleGuidance:
      "Keep the main figure or object large and graphic in frame. Avoid tiny low-contrast details that disappear on mobile.",
    attemptDirectives: [
      "render the scene as a clean editorial ink illustration with crisp black brushwork and strong figure-ground separation",
      "if a person is present, keep one clear human figure with natural proportions, readable hands, and well-separated limbs",
      "favor one focal subject, one readable action, and generous negative space",
      "keep props simplified and graphic so the frame stays immediately readable on mobile",
      "prefer crisp black shapes and clean paper contrast over muddy gray rendering"
    ],
    refinePromptLead: "editorial ink illustration",
    refinePromptFinish: "crisp black brushwork, strong contrast, clean paper background, no text",
    auditStyleDescription:
      "editorial ink illustration style with crisp black brushwork, strong contrast, clean paper background, negative space, and readable silhouettes"
  },
  editorial_line_green: {
    id: "editorial_line_green",
    label: "Editorial Line Green",
    description: "Line art preto e branco com acentos verdes sutis, cara de editorial moderno e ambiente detalhado.",
    expectStickman: false,
    characterPrompt:
      "single editorial line art human when needed, clean black contour drawing, readable posture, natural proportions, minimal facial detail, clear silhouette",
    stylePrompt:
      "black and white editorial line art illustration with subtle green accents, refined pen drawing, modern magazine look, crisp contour lines, controlled detail density, premium monochrome composition, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same black ink line quality, same monochrome drawing language, same subtle green accent treatment, same editorial composition logic, same detailed but clean environmental storytelling",
    compositionRules:
      "one clear focal subject, one readable action, organized environment detail, clean frame hierarchy, no text",
    backgroundDirectives: [
      "light paper or clean off-white background with black line work and restrained green highlights only where useful",
      "supporting props should be drawn as detailed line art objects with clear hierarchy and mobile readability",
      "practical environment detail should enrich the scene through furniture, books, lamps, shelves, cables, tools, and room structure without dominating the focal subject",
      "required notes, clocks, calendars, papers, or watch faces should read as abstract graphic shapes rather than readable content"
    ],
    defaultLighting: "clean editorial lighting translated through line weight, negative space, and subtle green accents",
    plannerGuidance:
      "Every shot must read as a black-and-white editorial line art illustration with subtle green accents, crisp pen drawing, detailed lived-in environments, and immediate mobile readability.",
    humanGuidance:
      "Any human should read as a drawn editorial character with readable gesture, simple face, clear hair silhouette when relevant, and natural proportions.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clear limb separation and natural proportions.",
    scaleGuidance:
      "Keep the main subject readable on mobile while still preserving surrounding room or object detail. Avoid tiny distant figures and avoid oversized close-up heads.",
    attemptDirectives: [
      "render as black ink line art with subtle green accents only on selected objects or light details",
      "preserve environmental storytelling with practical room and desk details when the scene needs them",
      "if the scene requires a watch, paper, notebook, or interface, keep it abstract and unreadable as graphic content",
      "if a person is present, keep one readable human figure with natural proportions, readable hands, and a clear editorial silhouette",
      "favor organized detail and modern editorial clarity over comic exaggeration or childish doodle energy"
    ],
    refinePromptLead: "editorial black and white line art illustration",
    refinePromptFinish: "subtle green accents, crisp ink lines, detailed environment, no text",
    auditStyleDescription:
      "editorial black and white line art style with subtle green accents, crisp pen lines, natural proportions, and detailed environmental storytelling"
  },
  time_split_bold: {
    id: "time_split_bold",
    label: "Time Split Bold",
    description: "Objeto dominante, comparação antigo vs moderno e composição forte para retenção em mobile.",
    expectStickman: false,
    characterPrompt:
      "single stylized editorial human figure when needed, clean human proportions, simple face, clear silhouette, natural posture, readable hands and limbs",
    stylePrompt:
      "bold editorial comparison illustration with one dominant hero object, clear past-versus-present contrast, high-contrast shapes, controlled accent colors, strong negative space, crisp mobile-first composition, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same comparison logic, same hero-object dominance, same high-contrast editorial framing, same short-form visual rhythm",
    compositionRules:
      "one hero object per scene, one clear comparison beat, one immediately readable action, minimal supporting props, strong mobile readability, no fake UI",
    backgroundDirectives: [
      "clean light or lightly textured background with open negative space and minimal environmental noise",
      "supporting props should reinforce the past-versus-present contrast and stay secondary to the hero object",
      "required interfaces, labels, maps, or watch faces should read as abstract graphic shapes rather than detailed readable content"
    ],
    defaultLighting: "clean high-contrast editorial lighting with crisp object edges, simple separation, and strong figure-ground read",
    plannerGuidance:
      "Every shot must be built around one dominant hero object and one obvious contrast between past and present. Keep the frame bold, simple, and instantly readable on mobile.",
    humanGuidance:
      "Any human should stay secondary to the hero object unless body language is the key idea. Keep people simple, natural, and clearly readable.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clean limb separation, readable hands, and natural proportions.",
    scaleGuidance:
      "Keep the hero object large and dominant in frame. Comparison elements should read in under one second on a phone screen.",
    attemptDirectives: [
      "make one hero object dominate the frame and keep supporting elements minimal",
      "show the past and present version together whenever the scene allows it",
      "prefer bold close or medium-close framing for instant mobile readability",
      "use clean high-contrast shapes and controlled accent colors to clarify the comparison",
      "if a person is present, keep one clear figure with natural proportions, readable hands, and a strong silhouette",
      "keep supporting props minimal and subordinate to the main comparison"
    ],
    refinePromptLead: "bold editorial comparison illustration",
    refinePromptFinish: "dominant hero object, clear past-versus-present contrast, high mobile readability, no text",
    auditStyleDescription:
      "bold editorial comparison style with a dominant hero object, strong antique-versus-modern contrast, crisp negative space, and immediate mobile readability"
  },
  punk: {
    id: "punk",
    label: "Punk Poster",
    description: "Energia punk editorial, colagem agressiva, contraste bruto e composição de poster de rua.",
    expectStickman: false,
    characterPrompt:
      "single punk editorial human figure when needed, clean human proportions, raw silhouette, simple face, strong posture, readable hands and limbs",
    stylePrompt:
      "punk editorial poster illustration, raw collage energy, torn-paper layers, rough ink texture, bold black shapes, dirty off-white paper, sharp red accents, rebellious street-poster composition, high contrast, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same punk poster language, same raw collage rhythm, same dirty paper texture, same red-black-off-white palette, same aggressive short-form composition",
    compositionRules:
      "one dominant hero subject, one clear visual hit, poster-like impact, minimal filler, bold mobile readability, no text",
    backgroundDirectives: [
      "dirty off-white paper or wall-poster background with torn-edge collage feeling and bold negative space",
      "supporting elements should feel pasted, layered, or stamped, but stay secondary to the main subject",
      "required screens, papers, labels, or maps should read as abstract graphic shapes rather than readable content"
    ],
    defaultLighting: "graphic poster contrast with rough print texture and hard subject separation",
    plannerGuidance:
      "Every shot must read like a rebellious street poster: one dominant subject, one immediate visual hit, raw layered composition, instant readability on mobile, and no filler.",
    humanGuidance:
      "Any human should feel bold, simple, and poster-readable. Keep gesture strong and silhouette clear rather than realistic or soft.",
    anatomyGuidance:
      "If a shot includes a person, keep one head, two arms, two hands, two legs, and two feet with clean limb separation, readable hands, and natural proportions.",
    scaleGuidance:
      "Keep the hero subject huge in frame. The central visual hit should read in less than a second on a phone screen.",
    attemptDirectives: [
      "make one hero subject dominate the frame with raw punk poster energy",
      "use rough collage layers, bold black shapes, dirty paper texture, and restrained red accents",
      "prefer close or medium-close poster framing over wide scenic shots",
      "if a person is present, keep one clear figure with natural proportions, readable hands, and a strong silhouette",
      "preserve rough editorial impact and mobile readability over clean corporate polish"
    ],
    refinePromptLead: "punk editorial poster illustration",
    refinePromptFinish: "hero subject dominant, rough collage texture, hard contrast, no text",
    auditStyleDescription:
      "punk editorial poster style with raw collage energy, dirty paper texture, dominant hero objects, and immediate mobile readability"
  }
};

export const DEFAULT_VISUAL_STYLE_PRESET = "claude";

export const resolveVisualStylePreset = (value) => {
  const normalized = String(value || DEFAULT_VISUAL_STYLE_PRESET).trim().toLowerCase();
  return VISUAL_STYLE_PRESETS[normalized] || VISUAL_STYLE_PRESETS[DEFAULT_VISUAL_STYLE_PRESET];
};
