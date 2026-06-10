// Tone, voice, image-model, channel and style presets extracted from server.mjs

import path from "node:path";
import {VISUAL_STYLE_PRESETS} from "../../config/visual-style-presets.mjs";

export const FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE =
  "Write like a sharp Brazilian short-form creator telling an ironic true story with surprise, contrast, and internet-native rhythm. The tone should feel human, sarcastic, observant, and slightly irreverent, but not motivational, preachy, or self-help-like. Use casual spoken Brazilian Portuguese when the video is in pt-BR. Prefer lines that sound like real reactions, such as 'parecia arriscado', 'muita gente desconfiava', 'eu ja vi gente fazer isso', or 'essa ideia nao foi uma boa ideia', whenever they fit naturally. Do not reuse the old catchphrase about an idea going badly, or close variants of it. Start with a hard surprising statement built on irony, reversal, or contradiction, not with advice to the viewer. If the source material includes a concrete number or scale metric, put the strongest one directly in the hook together with the irony or contradiction. Build momentum through consequence, embarrassment, cost, and absurd contrast. Include at most one colloquial reaction line in the body of the script, only when it fits naturally. Keep the script punchy, specific, and visually concrete. Keep each scene focused on one clear beat, but let the full script carry real progression instead of feeling like generic educational filler. Use ALL CAPS selectively for 2 to 5 of the hardest-hitting words across the hook and narration. The ending should land on the ironic fact or consequence itself, not on a moral-of-the-story lesson, direct advice, or coach-style takeaway. Do not add audio directions, editing directions, or narration outside the script itself.";

export const tonePresets = {
  natural_clean: {
    label: "Natural limpo",
    description: "Explicativo direto, visual e humano, sem conectores artificiais.",
    scriptGuidance:
      "Keep the current practical explainer structure, but remove filler connector openings. Do not start scenes with phrases like 'Só que', 'Mas olha só', 'Ao mesmo tempo', 'Agora' or 'Na prática'. Keep it direct, human, visual, and native to short-form video. Do not include CTA in the narration or ending.",
    voiceStyles: {
      "pt-BR": "com narracao natural, clara, segura e direta",
      "en-US": "with a natural, clear, direct narration"
    }
  },
  shortform_native: {
    label: "Short-form nativo",
    description: "Hook rapido, payoff cedo e ritmo nativo de TikTok/Reels/Shorts.",
    scriptGuidance: FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE,
    voiceStyles: {
      "pt-BR": "com ritmo curto, visual e nativo de redes sociais",
      "en-US": "with a native short-form social rhythm"
    }
  },
  wellness_comfort: {
    label: "Wellness • Calmo reconfortante",
    description: "Acolhe, valida e alivia sem parecer coaching vazio.",
    scriptGuidance:
      "Write a wellness script in a calm, human and comforting tone. Start from a real emotional state, validate it gently, reduce pressure, and end with relief or acceptance. Use short, spoken lines, no CTA, no guru language, no hype, no artificial connectors.",
    voiceStyles: {
      "pt-BR": "com voz calma, acolhedora, serena e reconfortante",
      "en-US": "with a calm, gentle and comforting voice"
    }
  },
  wellness_end_of_day: {
    label: "Wellness • Soltar o peso do dia",
    description: "Fecho de dia, cansaco, descanso e permissao para desacelerar.",
    scriptGuidance:
      "Write a wellness script for the end of the day. Speak to tiredness, mental overload, and the need to release pressure. Make it feel like permission to stop, rest and soften. Avoid spiritual grandiosity, productivity language, CTA, and generic inspiration. End with rest.",
    voiceStyles: {
      "pt-BR": "com voz baixa, serena e acolhedora",
      "en-US": "with a soft, low and soothing voice"
    }
  },
  wellness_truth_reset: {
    label: "Wellness • Verdade que eleva",
    description: "Cutuca a acomodacao com verdade, mas termina devolvendo autoestima, dignidade e forca.",
    scriptGuidance:
      "Write a reflective short-form script that gently confronts complacency, self-deception, avoidance, or emotional stagnation. Use one honest uncomfortable truth that wakes the viewer up, but never humiliate, shame, attack, or sound cruel. The tone should feel human, clear-eyed, grounded, and emotionally intelligent. Build tension through recognition and self-awareness, then end by restoring self-respect, agency, and calm confidence. No CTA, no guru language, no empty hype, no toxic toughness.",
    voiceStyles: {
      "pt-BR": "com voz humana, firme, calma e encorajadora",
      "en-US": "with a calm, firm, human voice that challenges gently and ends with reassurance"
    }
  }
};

export const DEFAULT_VOICE = "Iapetus";
export const DEFAULT_ENGLISH_VOICE = "Charon";
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
export const DEFAULT_GENERATION_MODE = "image-pipeline";

// Liam (ElevenLabs) — locked TikTok-style short-form delivery for the three
// content channels. Storyboards may override via top-level `audio` block;
// when absent, this preset is applied automatically.
export const TIKTOK_DEFAULT_AUDIO = Object.freeze({
  provider: "elevenlabs",
  voiceName: "Liam",
  voiceId: "TX3LPaxmHKxFdv7VOQHJ",
  modelId: "eleven_multilingual_v2",
  voiceStyle:
    "Pt-BR fast short-form creator delivery: direct, urgent, slightly confrontational, high-retention pace, crisp diction, no theatrical pauses."
});

export const TIKTOK_DEFAULT_AUDIO_CHANNELS = Object.freeze(["foiumaideia", "quiet2min", "ate2min"]);

export const voiceOptions = [
  {
    label: "Iapetus • Clear / claro",
    value: "Iapetus",
    badge: "Melhor para pt-BR geral",
    description: "Voz Gemini-TTS do Google com timbre claro e limpo, boa para narracao geral.",
    languages: ["pt-BR", "en-US"]
  },
  {
    label: "Charon • Informative / informativo",
    value: "Charon",
    badge: "Melhor para en-US",
    description: "Voz Gemini-TTS do Google com tom mais informativo e seguro, boa para explicacao e ingles.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Kore • Firm / firme",
    value: "Kore",
    badge: "Melhor para tom firme",
    description: "Voz Gemini-TTS do Google com entrega firme e assertiva, boa para hooks e tom deciso.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Puck • Upbeat / energetico",
    value: "Puck",
    badge: "Melhor para shorts",
    description: "Voz Gemini-TTS do Google com energia mais alta e ritmo mais animado para shorts.",
    languages: ["en-US", "pt-BR"]
  },
  {
    label: "Sulafat • Warm / caloroso",
    value: "Sulafat",
    badge: "Melhor para tom acolhedor",
    description: "Voz Gemini-TTS do Google com timbre mais quente e acolhedor.",
    languages: ["pt-BR", "en-US"]
  }
];

export const imageModelOptions = [
  {
    value: "imagen-4.0-fast-generate-001",
    label: "Imagen 4 Fast",
    provider: "Google",
    badge: "Mais barato",
    description: "Mais barato do grupo Imagen e, nos teus testes, o melhor para pessoas e anatomia neste tipo de cena.",
    costLabel: "US$ 0,02 / imagem",
    costDetail: "Melhor opção para volume e produção diária.",
    previewFile: "imagen-4.0-fast-generate-001.png"
  },
  {
    value: "imagen-4.0-generate-001",
    label: "Imagen 4 Full",
    provider: "Google",
    badge: "Padrão • Mais consistente",
    description: "Melhor equilíbrio para produção. Mais estável para pessoas, mãos e composição do que o Flash Image.",
    costLabel: "US$ 0,04 / imagem",
    costDetail: "Melhor custo-benefício para renders finais.",
    previewFile: "imagen-4.0-generate-001.png"
  },
  {
    value: "imagen-4.0-ultra-generate-001",
    label: "Imagen 4 Ultra",
    provider: "Google",
    badge: "Maior qualidade",
    description: "Melhor opção do grupo para cenas críticas com pessoas, mãos e fidelidade visual.",
    costLabel: "US$ 0,06 / imagem",
    costDetail: "Use para cenas difíceis e quando anatomia importa mais.",
    previewFile: "imagen-4.0-ultra-generate-001.png"
  },
  {
    value: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "Google",
    badge: "Experimental",
    description: "Bom para volume e iteração, mas composição menos previsível e menos confiável em anatomia humana.",
    costLabel: "~US$ 0,039 / imagem",
    costDetail: "Referência para 1024x1024 no Vertex.",
    previewFile: "gemini-2.5-flash-image.png"
  },
  {
    value: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
    provider: "Google",
    badge: "Novo • Melhor estilo",
    description: "Excelente para estilos artísticos (doodle, collage, ink). Segue prompts de estilo muito melhor que Imagen.",
    costLabel: "~US$ 0,02 / imagem",
    costDetail: "Rápido e barato. Ideal para storyboards com estilo visual definido.",
    previewFile: null
  },
  {
    value: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image",
    provider: "Google",
    badge: "Novo • Premium",
    description: "Modelo mais robusto para raciocínio visual avançado. Melhor fidelidade ao prompt e composição complexa.",
    costLabel: "~US$ 0,05 / imagem",
    costDetail: "Use para cenas que exigem máxima fidelidade ao prompt.",
    previewFile: null
  }
];

export const generationModeOptions = [
  {
    value: "image-pipeline",
    label: "Pipeline de imagens",
    badge: "Padrão",
    description: "Mantem o fluxo atual com imagens geradas antes do render final."
  },
  {
    value: "text-to-video",
    label: "Text-to-video",
    badge: "Novo modo",
    description: "Reserva o caminho para geração direta de video por cena."
  }
];

export const imageStylePreviewFiles = {
  claude: "video-estilo-claude.jpeg",
  kiro: "video-estilo-kiro.jpeg",
  editorial_clean: "editorial-clean.jpeg",
  realistic_film: "realistic-film.jpeg",
  cartoon_3d: "cartoon-3d.jpeg",
  urban_sketching: "urban-sketching.jpeg",
  ink: "ink.jpeg",
  editorial_line_green: "editorial-line-green.jpeg",
  time_split_bold: "time-split-bold.jpeg",
  punk: "punk-poster.jpeg"
};

export const buildImageStyleOptions = (stylePreviewDir) =>
  Object.values(VISUAL_STYLE_PRESETS).map((preset) => {
    const previewFile = imageStylePreviewFiles[preset.id] || `${preset.id}.jpeg`;
    return {
      label: preset.label,
      value: preset.id,
      description: preset.description,
      previewFile,
      previewImagePath: path.join(stylePreviewDir, previewFile),
      previewLinkPath: `/${previewFile}`
    };
  });

export const channelOptions = [
  {
    label: "@foiumaideia",
    value: "foiumaideia",
    handle: "@foiumaideia",
    folder: "foiumaideia",
    description: "Curiosidade, explicação clara e impacto prático."
  },
  {
    label: "@quiet2min",
    value: "quiet2min",
    handle: "@quiet2min",
    folder: "quiet2min",
    description: "Verdades curtas em ingles para sair da acomodacao e terminar mais forte."
  },
  {
    label: "@ate2min",
    value: "ate2min",
    handle: "@ate2min",
    folder: "ate2min",
    description: "Verdades curtas em pt-BR para sair da acomodacao e terminar mais forte."
  }
];

export const channelPublishProfiles = {
  foiumaideia: {
    identifierKeys: [
      "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
      "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME",
      "FOIUMAIDEIA_USER",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"],
    publicUrlKeys: ["FOIUMAIDEIA_URL"]
  },
  quiet2min: {
    identifierKeys: [
      "AGENDADOR_ONLINE_QUIET2MIN_EMAIL",
      "AGENDADOR_ONLINE_QUIET2MIN_USERNAME",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"]
  },
  ate2min: {
    identifierKeys: [
      "AGENDADOR_ONLINE_ATE2MIN_EMAIL",
      "AGENDADOR_ONLINE_ATE2MIN_USERNAME",
      "AGENDADOR_EMAIL",
      "AGENDADOR_USERNAME"
    ],
    passwordKeys: ["AGENDADOR_ONLINE_PASSWORD", "AGENDADOR_PASSWORD"]
  }
};

export const channelPresets = {
  foiumaideia: {
    tone: "shortform_native",
    voice: DEFAULT_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    defaultAudio: TIKTOK_DEFAULT_AUDIO,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "ink",
    outputProfile: "vertical-short",
    targetSeconds: 60,
    customStylePromptByLanguage: {
      "pt-BR": "com ritmo curto, visual e nativo de redes sociais, com voz firme, curiosa, ritmada e muito nativa de internet, sem soar teatral",
      "en-US": "with a native short-form social rhythm, a firm, curious, internet-native voice, and punchy delivery without sounding theatrical"
    },
    scriptGuidance: FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE
  },
  quiet2min: {
    language: "en-US",
    tone: "wellness_truth_reset",
    voice: DEFAULT_ENGLISH_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    defaultAudio: TIKTOK_DEFAULT_AUDIO,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "realistic_film",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz humana, firme, calma e acolhedora no final",
      "en-US": "with a calm, firm, human voice that tells the truth clearly and lands with reassurance"
    },
    scriptGuidance:
      "Write short reflective scripts that interrupt complacency with a clear uncomfortable truth, but never in a cruel or cynical way. The viewer should feel seen, gently challenged, and then emotionally stronger by the end. Keep the writing human, visually concrete, and grounded in real behavior. End with restored self-respect, dignity, and quiet confidence."
  },
  ate2min: {
    language: "pt-BR",
    tone: "wellness_truth_reset",
    voice: DEFAULT_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    defaultAudio: TIKTOK_DEFAULT_AUDIO,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "realistic_film",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz humana, firme, calma e acolhedora no final",
      "en-US": "with a calm, firm, human voice that tells the truth clearly and lands with reassurance"
    },
    scriptGuidance:
      "Write short reflective scripts that tiram a pessoa da acomodacao com uma verdade clara, mas sem humilhar, culpar ou soar agressivo. O texto deve provocar reconhecimento, honestidade e movimento interno, e terminar devolvendo autoestima, dignidade e forca tranquila. Priorize linguagem humana, concreta e emocionalmente madura."
  }
};
