// Tone, voice, image-model, channel and style presets extracted from server.mjs

import path from "node:path";
import {VISUAL_STYLE_PRESETS} from "../../config/visual-style-presets.mjs";

export const FOIUMAIDEIA_VIRAL_SCRIPT_GUIDANCE =
  "Write like a sharp Brazilian short-form creator reacting to a bad tech idea that gives people false confidence. The tone should feel human, sarcastic, slightly exaggerated, and very internet-native, like a smart friend warning you before you do something dumb. Use casual spoken Brazilian Portuguese when the video is in pt-BR. Prefer lines that sound like real reactions, such as 'isso da ruim', 'nao cai nessa', 'eu ja vi gente fazer isso', or 'essa ideia nao foi uma boa ideia', whenever they fit naturally. Start with a hard statement, warning, accusation, or shocking reveal. Build momentum through consequence, embarrassment, cost, and fail energy. Keep the script punchy, specific, and visually concrete. Keep each scene focused on one clear beat, but let the full script carry real progression instead of feeling like generic educational filler. Use ALL CAPS selectively for 2 to 5 of the hardest-hitting words across the hook and narration. Let the ending land as a memorable sting that makes the bad idea feel obviously stupid in hindsight. Do not add audio directions, editing directions, or narration outside the script itself.";

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
  }
};

export const DEFAULT_VOICE = "Iapetus";
export const DEFAULT_ENGLISH_VOICE = "Charon";
export const DEFAULT_IMAGE_MODEL = "imagen-4.0-generate-001";
export const DEFAULT_GENERATION_MODE = "image-pipeline";

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
    badge: "Novo padrão",
    description: "Mais barato do grupo Imagen e, nos teus testes, o melhor para pessoas e anatomia neste tipo de cena.",
    costLabel: "US$ 0,02 / imagem",
    costDetail: "Melhor opção para volume e produção diária."
  },
  {
    value: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "Google",
    badge: "Mais rápido",
    description: "Modelo atual do app. Bom para volume e iteração, mas menos confiável em anatomia humana complexa.",
    costLabel: "~US$ 0,039 / imagem",
    costDetail: "Referência para 1024x1024 no Vertex."
  },
  {
    value: "imagen-4.0-generate-001",
    label: "Imagen 4",
    provider: "Google",
    badge: "Mais consistente",
    description: "Melhor equilíbrio para produção. Mais estável para pessoas, mãos e composição do que o Flash Image.",
    costLabel: "US$ 0,04 / imagem",
    costDetail: "Melhor custo-benefício para renders finais."
  },
  {
    value: "imagen-4.0-ultra-generate-001",
    label: "Imagen 4 Ultra",
    provider: "Google",
    badge: "Maior qualidade",
    description: "Melhor opção do grupo para cenas críticas com pessoas, mãos e fidelidade visual.",
    costLabel: "US$ 0,06 / imagem",
    costDetail: "Use para cenas difíceis e quando anatomia importa mais."
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
    description: "Reflexões calmas, autocuidado e clareza interior em poucos minutos."
  },
  {
    label: "@ate2min",
    value: "ate2min",
    handle: "@ate2min",
    folder: "ate2min",
    description: "Mensagens breves, tranquilas e inspiradoras para desacelerar."
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
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "editorial_line_green",
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
    tone: "wellness_comfort",
    voice: DEFAULT_ENGLISH_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz calma, acolhedora, serena e ritmo suave",
      "en-US": "with a calm, soothing, warm voice and a gentle, reassuring pace"
    },
    scriptGuidance:
      "Write calm, reflective and soothing short scripts focused on personal growth, emotional clarity, inner peace and gentle self-help. The tone should feel peaceful, grounded, reassuring and visually concrete, like a quiet reset for the day."
  },
  ate2min: {
    language: "pt-BR",
    tone: "wellness_end_of_day",
    voice: DEFAULT_VOICE,
    imageModel: DEFAULT_IMAGE_MODEL,
    voiceByLanguage: {
      "pt-BR": DEFAULT_VOICE,
      "en-US": DEFAULT_ENGLISH_VOICE
    },
    imageStyle: "punk",
    outputProfile: "vertical-short",
    targetSeconds: 100,
    customStylePromptByLanguage: {
      "pt-BR": "com voz calorosa, tranquila, humana e inspiradora",
      "en-US": "with a warm, calm, human and inspiring voice"
    },
    scriptGuidance:
      "Write brief reflective stories with a calm, human and inspiring tone. Prioritize emotional clarity, practical wisdom, soft transitions and a memorable ending that fits within two minutes."
  }
};
