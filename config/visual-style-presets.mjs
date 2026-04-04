export const VISUAL_STYLE_PRESETS = {
  claude: {
    id: "claude",
    label: "Video estilo Claude",
    description: "Visual claro, flat, fundo branco, traço limpo e linguagem corporate memphis.",
    expectStickman: true,
    characterPrompt:
      "simple stick figure character with thin black lines, one large round head with minimal facial expression, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, no detailed features, clean outline drawing style, expressive body posture, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "flat vector illustration, stick figure art, corporate memphis style, minimalist line art, solid flat colors, clean black outlines, white background, 2d vector art, simple geometric shapes, editorial illustration, no gradients, no shadows, no photorealism, high contrast, explanatory diagram style",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stick figure design, same thin black line weight, same flat white background treatment, same colorful corporate memphis palette, same clean editorial composition language",
    compositionRules:
      "single clear focal character, one main action only, one consistent scene only, clean readable silhouette, anatomically consistent stick figure with one head, two arms, two hands, two legs, simple supporting objects, show the action literally, not symbolically, no text",
    backgroundDirectives: [
      "clean white or very light gray background, no dark backgrounds, no colored backgrounds, no complex scenery",
      "objects drawn as simple flat colored icons or minimal line art shapes",
      "if small icons or symbols surround the character, draw them as tiny flat colored pictograms floating nearby"
    ],
    defaultLighting: "clean high-contrast lighting on a white background",
    plannerGuidance:
      "All shots must stay compatible with a minimalist stick figure illustration style: thin black line art, large round heads, long thin limbs, flat solid color accents, clean white or light gray background. Think corporate memphis meets stick figure animation.",
    humanGuidance:
      "Any human must be described as a simple stick figure character with a large round head, dot eyes, thin black line body, and expressive body posture. No detailed facial features, no realistic proportions. Keep character designs consistent across shots.",
    anatomyGuidance:
      "If a shot shows one stick figure, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "If a shot includes a person, make the stick figure clearly readable and substantial in frame. Do not describe the person as a tiny distant mark, a micro figure, or a single vertical line.",
    attemptDirectives: [
      "draw all characters as simple stick figures with thin black lines, large round head, dot eyes, simple line mouth, long thin limbs, no realistic anatomy, no detailed faces, no shading on body",
      "for each visible stick figure, keep exactly one head, two arms, two hands, two legs, and two feet unless a limb is fully hidden by framing",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, ghost limbs, extra fingers, or multiple heads",
      "keep the entire head circle visible and do not crop the character at the top edge",
      "avoid oversized face close-ups and avoid camera zoom that hides the body posture",
      "prefer clear silhouette separation so each arm and hand is readable",
      "when a character is part of the idea, keep the main stick figure large and legible, never as a tiny distant scribble or a single thin vertical line"
    ],
    refinePromptLead: "minimalist stick figure illustration",
    refinePromptFinish: "flat colors, black outlines, white background, no text",
    auditStyleDescription:
      "minimalist stick figure illustration style with thin black lines, large round heads, flat colors, and simplified body language"
  },
  kiro: {
    id: "kiro",
    label: "Video estilo Kiro",
    description: "Visual cinematografico, fundo escuro, contraste forte e paleta mais dramatica.",
    expectStickman: true,
    characterPrompt:
      "simple stick figure adult with thin black lines, one large round head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, long thin limbs, minimal facial features, expressive posture, clean silhouette, dark-scene friendly design, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "dark cinematic stick figure illustration, minimalist line art, controlled vivid accents, strong contrast, moody environment, expressive pose, editorial composition, non-photorealistic",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stick figure design, same thin black line weight, same dark cinematic background treatment, same controlled teal amber magenta palette, same dramatic rim light, same polished composition language",
    compositionRules:
      "single clear focal character, one main action only, one consistent scene only, clean readable silhouette, anatomically consistent stick figure with one head, two arms, two hands, two legs, atmospheric environment around the character, deep contrast, show the action literally, not symbolically, no text",
    backgroundDirectives: [
      "dark cinematic background with strong subject separation and controlled color accents",
      "atmospheric environment around the character, polished composition, dramatic contrast",
      "no readable text, no UI text, no logos, no watermark"
    ],
    defaultLighting: "controlled cinematic lighting with strong subject separation on a dark background",
    plannerGuidance:
      "All shots must stay compatible with a dark cinematic stick figure illustration style: thin black line art, large round head, expressive posture, dramatic contrast, controlled color accents, and readable silhouette separation.",
    humanGuidance:
      "Any human must be described as a stylized dark-scene stick figure character with a large round head, minimal facial detail, expressive posture, and no realistic anatomy.",
    anatomyGuidance:
      "If a shot shows one stick figure, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "If a shot includes a person, keep the stick figure large enough to read clearly against the dark background. Avoid tiny distant silhouettes or body parts disappearing into shadows.",
    attemptDirectives: [
      "draw all characters as dark-scene friendly stick figures with thin black outlines, large round head, long thin limbs, minimal face, and readable silhouette",
      "for each visible stick figure, keep exactly one head, two arms, two hands, two legs, and two feet unless a limb is fully hidden by framing",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, ghost limbs, extra fingers, or multiple heads",
      "avoid oversized face close-ups and avoid camera zoom that hides the body posture",
      "preserve strong silhouette separation so each arm and hand is readable against the dark background",
      "when a character is part of the idea, keep the main stick figure large and legible, never as a tiny distant scribble or a single thin vertical line"
    ],
    refinePromptLead: "dark cinematic stick figure illustration",
    refinePromptFinish: "controlled vivid accents, strong contrast, dark background, no text",
    auditStyleDescription:
      "dark cinematic stick figure illustration style with dramatic contrast, minimal facial detail, and readable silhouette separation",
    negativePromptRemovals: ["dark background", "complex shadows", "high saturation", "neon glow"]
  },
  editorial_clean: {
    id: "editorial_clean",
    label: "Editorial Clean",
    description: "Ilustração editorial limpa, humana e clara, com foco em objetos, prova visual e leitura rápida.",
    expectStickman: false,
    characterPrompt:
      "stylized simplified human character, clear silhouette, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, minimal facial detail, readable posture, modern editorial illustration, no extra limbs, no duplicate hands, no duplicate arms, not a stick figure",
    stylePrompt:
      "clean editorial illustration, modern explainer art, simplified human scenes, crisp shapes, restrained palette, light neutral background, subtle depth, non-photorealistic, high clarity, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same editorial illustration language, same clean shape treatment, same restrained palette, same object hierarchy, same polished explainer composition",
    compositionRules:
      "single clear focal subject, one proof visual per scene, readable objects, clean human posture, one main action only, no symbolic clutter, no text, no UI chrome",
    backgroundDirectives: [
      "light neutral or off-white background with minimal environmental shapes",
      "clear object hierarchy with one or two supporting props only",
      "no clutter, no readable text, no logos, no watermark"
    ],
    defaultLighting: "clean studio-style lighting on a light neutral background",
    plannerGuidance:
      "All shots must stay compatible with a clean editorial illustration style: simplified modern people, clear objects, restrained palettes, strong visual hierarchy, and easy readability on mobile.",
    humanGuidance:
      "Any human must be described as a simplified editorial illustrated person with readable posture, minimal facial detail, and clean anatomy. Do not describe humans as stick figures or realistic portraits.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy clean: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "If a shot includes a person, keep the character large enough to read clearly and avoid tiny background people.",
    attemptDirectives: [
      "draw humans as simplified editorial illustrated people with clear silhouette, clean anatomy, and minimal facial detail",
      "keep exactly one head, two arms, two hands, two legs, and two feet for each visible person unless a limb is fully hidden by framing",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "prefer one proof visual, one main object cluster, and one readable focal character",
      "avoid close-up face crops that remove the action context"
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
      "single realistic human subject when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, natural proportions, readable pose, expressive but grounded body language, no extra limbs, no duplicate hands, no duplicate arms, no deformed anatomy",
    stylePrompt:
      "cinematic realistic film still, natural light, documentary realism, subtle color grading, real-world textures, shallow depth of field, polished but grounded composition, non-fantasy, no text, no logos, no watermark",
    styleLockPrompt:
      "consistent visual identity across all scenes, same filmic realism, same natural-light treatment, same grounded lens language, same restrained color grade, same premium cinematic composition",
    compositionRules:
      "single strong focal subject, one real-world action or proof visual per frame, no surreal symbolic clutter, keep scenes believable, no text, no fake UI",
    backgroundDirectives: [
      "realistic environments with controlled detail and clean subject separation",
      "prefer natural surfaces, believable objects, and premium documentary framing",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "natural cinematic lighting with realistic depth and subject separation",
    plannerGuidance:
      "All shots must stay compatible with cinematic realistic film stills: believable locations, natural human behavior, strong object realism, and a premium documentary or commercial frame quality.",
    humanGuidance:
      "Any human must be described as a real person in a believable setting with natural posture, clothing, and emotion. Avoid caricature, stick figures, or exaggerated poses.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy realistic and strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no warped body parts.",
    scaleGuidance:
      "Keep the main subject prominent and readable in frame. Avoid tiny distant people unless the shot is intentionally environmental.",
    attemptDirectives: [
      "render the scene as a cinematic realistic film still with believable real-world textures and natural light",
      "if a person is present, keep realistic anatomy with exactly one head, two arms, two hands, two legs, and no deformities",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "prefer one strong photographic idea with a clear subject and clean depth separation",
      "avoid posterized or overdesigned symbolic compositions"
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
      "stylized 3d cartoon character when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, simple expressive face, rounded forms, clean silhouette, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "stylized 3d cartoon render, soft volumetric lighting, rounded shapes, clean materials, vibrant but controlled palette, family-friendly premium animation look, high readability, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same stylized 3d cartoon world, same rounded modeling language, same material treatment, same soft volumetric lighting, same polished animation-film composition",
    compositionRules:
      "one clear focal subject, one simple action, readable props, bold silhouette, no clutter, no text, no realistic UI, no uncanny realism",
    backgroundDirectives: [
      "stylized 3d environment with simple readable props and soft depth",
      "keep backgrounds supportive, clean and colorful without becoming noisy",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "soft volumetric 3d lighting with clean subject separation",
    plannerGuidance:
      "All shots must stay compatible with a premium stylized 3d cartoon look: rounded forms, readable props, simplified but believable characters, and clean family-friendly cinematic staging.",
    humanGuidance:
      "Any human must be described as a stylized 3d cartoon person with rounded forms, clear silhouette, and simple expressive face. Avoid realism, stick figures, and flat vector framing.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy clean and strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "Keep the main character or object large and readable, like a frame from a polished animated short.",
    attemptDirectives: [
      "render the scene as a stylized 3d cartoon shot with rounded forms, clean materials, and soft volumetric light",
      "if a character is present, keep exactly one head, two arms, two hands, two legs, and a clear readable silhouette",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "prefer one charming readable action and one main prop cluster",
      "avoid flat poster-like layouts and avoid overbusy environments"
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
      "loose hand-drawn human figure when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, expressive posture, urban sketchbook style, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "urban sketchbook illustration, ink line drawing with light watercolor wash, observational drawing feel, travel journal energy, handmade imperfections, elegant composition, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same urban sketchbook line quality, same watercolor wash treatment, same hand-drawn rhythm, same observational composition language",
    compositionRules:
      "one clear subject, hand-drawn observation feel, readable props, no clutter, no text, no fake typography, no heavy comic-book stylization",
    backgroundDirectives: [
      "paper-like light background with visible sketchbook or watercolor feel",
      "supporting elements should look hand-drawn and loosely observed, not rigid vector icons",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "soft natural daylight translated into ink and watercolor washes",
    plannerGuidance:
      "All shots must stay compatible with an urban sketchbook illustration style: hand-drawn ink lines, light watercolor washes, observational scenes, and a lively handmade rhythm.",
    humanGuidance:
      "Any human must be described as a hand-drawn sketchbook person with expressive gesture and readable posture. Avoid stick figures, realistic photos, and over-rendered faces.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy readable and strict even in loose drawing form: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands.",
    scaleGuidance:
      "Keep the subject large enough to feel intentional on mobile. Avoid tiny scribbles and overly distant cityscape compositions.",
    attemptDirectives: [
      "render the scene as an urban sketchbook illustration with lively ink lines and light watercolor wash",
      "if a person is present, keep one head, two arms, two hands, two legs, and readable gesture despite the loose drawing style",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "preserve a handmade observational feel with one clear focal subject",
      "avoid over-dense backgrounds and avoid rigid vector symmetry"
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
      "ink-drawn human figure when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, bold silhouette, minimal face detail, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "bold ink illustration, high-contrast brush and pen work, graphic black shapes, mature editorial ink drawing, limited accent color if needed, strong negative space, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same bold ink line quality, same contrast logic, same graphic black-shape treatment, same mature editorial composition",
    compositionRules:
      "one dominant subject, strong black-white hierarchy, readable silhouette, restrained props, no clutter, no text, no fake UI",
    backgroundDirectives: [
      "light paper or neutral background with strong ink contrast and negative space",
      "supporting objects should be rendered in bold ink strokes or graphic black shapes",
      "no readable text, no logos, no watermark"
    ],
    defaultLighting: "graphic high-contrast lighting translated into bold ink shadows and negative space",
    plannerGuidance:
      "All shots must stay compatible with a bold editorial ink illustration style: strong contrast, graphic black shapes, controlled negative space, and readable immediate composition.",
    humanGuidance:
      "Any human must be described as a bold ink-drawn person with clear silhouette and minimal face detail. Avoid stick figures, watercolor softness, and photorealism.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "Keep the main figure or object large and graphic in frame. Avoid tiny low-contrast details that disappear on mobile.",
    attemptDirectives: [
      "render the scene as a bold ink illustration with strong black-white hierarchy and controlled negative space",
      "if a person is present, keep exactly one head, two arms, two hands, two legs, and a strong readable silhouette",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "prefer one graphic focal subject and one immediate readable action",
      "avoid muddy gray rendering and avoid cluttered compositions"
    ],
    refinePromptLead: "bold ink illustration",
    refinePromptFinish: "high contrast, graphic black shapes, clean negative space, no text",
    auditStyleDescription:
      "bold ink illustration style with high contrast, graphic black shapes, clean negative space, and readable silhouettes"
  },
  editorial_line_green: {
    id: "editorial_line_green",
    label: "Editorial Line Green",
    description: "Line art preto e branco com acentos verdes sutis, cara de editorial moderno e ambiente detalhado.",
    expectStickman: false,
    characterPrompt:
      "editorial line art human figure when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, clean black contour drawing, readable posture, minimal facial detail, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "black and white editorial line art illustration with subtle green accent details, refined pen drawing, modern magazine illustration look, crisp contour lines, controlled detail density, premium monochrome composition, no photorealism, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same black ink line quality, same monochrome drawing language, same subtle green accent treatment, same editorial illustration composition, same detailed but clean environmental storytelling",
    compositionRules:
      "one clear focal subject, one readable action, detailed but organized environment, no clutter collapse, no text, no fake UI, no noisy poster composition",
    backgroundDirectives: [
      "light paper or clean off-white background with black line work and restrained green highlights only where useful",
      "supporting props should be drawn as detailed line art objects, not flat icons and not photorealistic renders",
      "preserve practical environment detail through furniture, books, lamps, shelves, cables, tools, and room structure without readable text or numeral-like marks",
      "only include notes, clocks, calendars, papers, or watch faces when the scene explicitly requires them, and render them as abstract unreadable shapes without letters, numbers, dates, or glyphs"
    ],
    defaultLighting: "clean editorial lighting translated through line weight, negative space, and subtle green accents",
    plannerGuidance:
      "All shots must stay compatible with a black-and-white editorial line art look with subtle green accents, crisp pen drawing, and detailed lived-in environments. Think modern newspaper magazine illustration, not comic book and not stick figure corporate art.",
    humanGuidance:
      "Any human must be described as a drawn editorial character with readable gesture, simple face, clear hair silhouette when relevant, and natural proportions. Avoid stick figures, 3d cartoon forms, and photorealism.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "Keep the main subject readable on mobile while still preserving surrounding room or object detail. Avoid tiny distant figures and avoid oversized close-up heads.",
    attemptDirectives: [
      "render as black ink line art with subtle green accents only on selected objects or light details",
      "preserve environmental storytelling with desks, books, devices, lamps, shelves, tools, or room details when the scene needs them",
      "if the scene requires a watch, calendar, paper, notebook, or interface, keep it abstract and unreadable with no letters, numbers, dates, or watch-face numerals",
      "if a person is present, keep one head, two arms, two hands, two legs, and a readable posture with natural proportions",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "avoid comic-book exaggeration, avoid childish doodle style, and avoid corporate memphis icons"
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
      "stylized editorial human figure when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, clear silhouette, simple face, natural proportions, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "bold editorial vertical illustration with a dominant hero object, antique-vs-modern comparison, strong silhouette, high contrast, minimal filler, clean shapes, mobile-first composition, crisp negative space, controlled accent colors, readable at small size, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same bold comparison language, same dominant hero-object framing, same high-contrast editorial composition, same modern short-form visual rhythm",
    compositionRules:
      "one hero object per scene, obvious old-versus-modern contrast when possible, one immediate readable action, minimal filler, strong mobile readability, no text, no fake UI, no tiny clutter",
    backgroundDirectives: [
      "clean light or lightly textured background with bold negative space and minimal environmental filler",
      "supporting props must reinforce the antique-vs-modern comparison, never compete with the hero object",
      "if an interface, paper, label, map, or watch face is required, render it as abstract unreadable shapes only"
    ],
    defaultLighting: "clean high-contrast editorial lighting with strong subject separation and crisp object edges",
    plannerGuidance:
      "Plan each shot around one dominant hero object and one clear contrast between past and present. Keep the frame bold, simple, and instantly readable on mobile. Minimize filler and prioritize comparison over decoration.",
    humanGuidance:
      "Any human must be secondary to the hero object unless body language is the key idea. Keep people simple, natural, and readable, never tiny or over-detailed.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "Keep the hero object large and dominant in frame. Ancient and modern comparison elements should be readable in under one second on a phone screen.",
    attemptDirectives: [
      "make one hero object dominate the frame and keep supporting elements minimal",
      "show the ancient and modern version in the same frame whenever the scene allows it",
      "prefer bold close or medium-close framing over distant wide shots",
      "use clean high-contrast shapes and controlled accent colors for instant readability",
      "if a person is present, keep anatomy normal with one head, two arms, two hands, two legs and a readable silhouette",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "avoid filler props, busy rooms, tiny background details, fake UI, and unreadable decorative clutter"
    ],
    refinePromptLead: "bold editorial comparison illustration",
    refinePromptFinish: "hero object dominant, antique versus modern contrast, high readability, no text",
    auditStyleDescription:
      "bold editorial comparison style with a dominant hero object, strong antique-versus-modern contrast, crisp negative space, and immediate mobile readability"
  },
  punk: {
    id: "punk",
    label: "Punk Poster",
    description: "Energia punk editorial, colagem agressiva, contraste bruto e composição de poster de rua.",
    expectStickman: false,
    characterPrompt:
      "stylized punk editorial human figure when needed, exactly one head, exactly two arms, exactly two hands, exactly two legs, exactly two feet, raw silhouette, simple face, natural proportions, no extra limbs, no duplicate hands, no duplicate arms",
    stylePrompt:
      "punk editorial poster illustration, raw collage energy, cut-paper layers, rough ink texture, bold black shapes, dirty off-white paper, sharp red accents, rebellious street poster composition, high contrast, hero object dominant, no text, no logos",
    styleLockPrompt:
      "consistent visual identity across all scenes, same punk poster language, same raw collage rhythm, same dirty paper texture, same red-black-off-white palette, same aggressive short-form composition",
    compositionRules:
      "one dominant hero object, immediate old-versus-modern contrast, poster-like impact, minimal filler, bold mobile readability, no text, no fake UI, no tiny clutter",
    backgroundDirectives: [
      "dirty off-white paper or wall-poster background with torn-edge collage feeling and bold negative space",
      "supporting elements should feel pasted, layered, or stamped, but never compete with the main object",
      "if a screen, paper, watch face, label, or map is needed, render it as abstract unreadable shapes only"
    ],
    defaultLighting: "graphic poster contrast with rough print texture and hard subject separation",
    plannerGuidance:
      "Plan each shot like a rebellious street poster: one dominant object, one fast old-versus-modern clash, raw layered composition, instant readability on mobile, no filler.",
    humanGuidance:
      "Any human should feel secondary unless gesture is essential. Keep people simple, bold, and poster-readable, not realistic and not soft.",
    anatomyGuidance:
      "If a shot includes a person, keep anatomy strict: one head, two arms, two hands, two legs, no extra limbs, no duplicate hands, no merged limbs.",
    scaleGuidance:
      "Keep the hero object huge in frame. The old-versus-modern comparison should read in less than a second on a phone screen.",
    attemptDirectives: [
      "make one hero object dominate the frame with raw punk poster energy",
      "show old and modern versions in the same frame whenever possible",
      "use rough collage layers, bold black shapes, dirty paper texture, and restrained red accents",
      "prefer close or medium-close poster framing over wide scenic shots",
      "if a person is present, keep anatomy normal with one head, two arms, two hands, two legs and a readable silhouette",
      "never draw extra hands, duplicate arms, fused limbs, floating limbs, extra fingers, or multiple heads",
      "avoid filler props, fake UI, clean corporate polish, and unreadable decorative clutter"
    ],
    refinePromptLead: "punk editorial poster illustration",
    refinePromptFinish: "hero object dominant, old versus modern clash, rough collage texture, no text",
    auditStyleDescription:
      "punk editorial poster style with raw collage energy, dirty paper texture, dominant hero objects, and immediate mobile readability"
  }
};

export const DEFAULT_VISUAL_STYLE_PRESET = "claude";

export const resolveVisualStylePreset = (value) => {
  const normalized = String(value || DEFAULT_VISUAL_STYLE_PRESET).trim().toLowerCase();
  return VISUAL_STYLE_PRESETS[normalized] || VISUAL_STYLE_PRESETS[DEFAULT_VISUAL_STYLE_PRESET];
};
