import {AbsoluteFill, Sequence, interpolate, useCurrentFrame, useVideoConfig} from "remotion";

type DemoStyleId =
  | "clean-broadcast"
  | "bold-tiktok-block"
  | "soft-karaoke"
  | "outline-punch"
  | "caption-strip";

type DemoSegment = {
  id: DemoStyleId;
  label: string;
  accent: string;
  text: string;
};

const SEGMENT_FRAMES = 300;

const segments: DemoSegment[] = [
  {
    id: "clean-broadcast",
    label: "Clean Broadcast",
    accent: "#facc15",
    text: "Você ainda usa ideias antigas sem perceber."
  },
  {
    id: "bold-tiktok-block",
    label: "Bold TikTok Block",
    accent: "#fb7185",
    text: "Isto não é novo. Só ficou menor e mais rápido."
  },
  {
    id: "soft-karaoke",
    label: "Soft Karaoke",
    accent: "#22c55e",
    text: "A bússola mudou de forma, mas a pergunta é a mesma."
  },
  {
    id: "outline-punch",
    label: "Outline Punch",
    accent: "#38bdf8",
    text: "Tecnologia boa sobrevive porque resolve algo de verdade."
  },
  {
    id: "caption-strip",
    label: "Caption Strip",
    accent: "#a78bfa",
    text: "Se durar dois mil anos, já não é moda. É genial."
  }
];

const baseFontFamily = "\"Avenir Next\", \"SF Pro Display\", Inter, \"Trebuchet MS\", Verdana, sans-serif";

const normalizeCaptionText = (text: string) => String(text ?? "").normalize("NFC");

const splitWords = (text: string) =>
  normalizeCaptionText(text)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const DemoCaption = ({segment}: {segment: DemoSegment}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  const words = splitWords(segment.text);
  const localFrame = frame % SEGMENT_FRAMES;
  const framesPerWord = Math.max(12, Math.floor(SEGMENT_FRAMES / Math.max(1, words.length)));
  const activeWordIndex = Math.min(words.length - 1, Math.floor(localFrame / framesPerWord));
  const reveal = interpolate(localFrame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const panelTranslate = interpolate(localFrame, [0, 14], [24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const isWide = width > height;
  const commonText = {
    fontFamily: baseFontFamily,
    fontVariantLigatures: "none" as const,
    textRendering: "geometricPrecision" as const,
    WebkitFontSmoothing: "antialiased" as const,
    MozOsxFontSmoothing: "grayscale" as const,
    lineHeight: 1.12
  };

  const wordNodes = words.map((word, index) => {
    const active = index === activeWordIndex;
    const past = index < activeWordIndex;
    const baseSize = isWide ? 56 : 72;
    const color = active ? segment.accent : past ? "#ffffff" : "rgba(255,255,255,0.72)";

    if (segment.id === "clean-broadcast") {
      return (
        <span
          key={`${segment.id}-${index}-${word}`}
          style={{
            ...commonText,
            color,
            fontSize: baseSize,
            fontWeight: active ? 800 : 760,
            letterSpacing: -0.8,
            textShadow: active ? "0 0 18px rgba(0,0,0,0.3)" : "0 3px 14px rgba(0,0,0,0.28)"
          }}
        >
          {word}
        </span>
      );
    }

    if (segment.id === "bold-tiktok-block") {
      return (
        <span
          key={`${segment.id}-${index}-${word}`}
          style={{
            ...commonText,
            background: active ? segment.accent : "rgba(255,255,255,0.12)",
            borderRadius: 18,
            color: active ? "#0b0b0b" : "#ffffff",
            display: "inline-block",
            fontSize: baseSize - 2,
            fontWeight: 900,
            letterSpacing: -0.9,
            padding: "8px 14px",
            boxShadow: active ? "0 12px 28px rgba(0,0,0,0.28)" : "none"
          }}
        >
          {word}
        </span>
      );
    }

    if (segment.id === "soft-karaoke") {
      return (
        <span
          key={`${segment.id}-${index}-${word}`}
          style={{
            ...commonText,
            color,
            fontSize: baseSize,
            fontWeight: 800,
            letterSpacing: -0.7,
            textShadow: active
              ? `0 0 18px ${segment.accent}55, 0 3px 12px rgba(0,0,0,0.35)`
              : "0 3px 12px rgba(0,0,0,0.35)"
          }}
        >
          {word}
        </span>
      );
    }

    if (segment.id === "outline-punch") {
      return (
        <span
          key={`${segment.id}-${index}-${word}`}
          style={{
            ...commonText,
            color,
            fontSize: baseSize + 2,
            fontWeight: 900,
            letterSpacing: -1,
            WebkitTextStroke: "10px rgba(0,0,0,0.86)",
            paintOrder: "stroke fill" as const,
            textShadow: active ? `0 0 22px ${segment.accent}55` : "none"
          }}
        >
          {word}
        </span>
      );
    }

    return (
      <span
        key={`${segment.id}-${index}-${word}`}
        style={{
          ...commonText,
          color: active ? "#0b0b0b" : "#ffffff",
          fontSize: baseSize - 4,
          fontWeight: 820,
          letterSpacing: -0.6,
          padding: active ? "6px 12px" : 0,
          background: active ? segment.accent : "transparent",
          borderRadius: 12
        }}
      >
        {word}
      </span>
    );
  });

  const panel =
    segment.id === "caption-strip" ? (
      <div
        style={{
          background: "rgba(0,0,0,0.72)",
          borderTop: `4px solid ${segment.accent}`,
          padding: isWide ? "20px 28px" : "24px 32px",
          width: "100%"
        }}
      >
        <div
          style={{
            color: "rgba(255,255,255,0.78)",
            fontFamily: baseFontFamily,
            fontSize: isWide ? 24 : 30,
            fontWeight: 700,
            letterSpacing: 1.2,
            marginBottom: 12,
            textTransform: "uppercase"
          }}
        >
          {segment.label}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "10px 14px"
          }}
        >
          {wordNodes}
        </div>
      </div>
    ) : (
      <div
        style={{
          background:
            segment.id === "soft-karaoke"
              ? "rgba(255,255,255,0.08)"
              : segment.id === "clean-broadcast"
                ? "rgba(10,10,10,0.28)"
                : "transparent",
          border:
            segment.id === "soft-karaoke" ? "1px solid rgba(255,255,255,0.12)" : "none",
          borderRadius: 26,
          maxWidth: isWide ? 1180 : 980,
          padding: segment.id === "bold-tiktok-block" ? 0 : isWide ? "18px 24px" : "20px 28px"
        }}
      >
        <div
          style={{
            color: "rgba(255,255,255,0.72)",
            fontFamily: baseFontFamily,
            fontSize: isWide ? 24 : 30,
            fontWeight: 700,
            letterSpacing: 1.2,
            marginBottom: 14,
            textAlign: "center",
            textTransform: "uppercase"
          }}
        >
          {segment.label}
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: segment.id === "bold-tiktok-block" ? "12px 14px" : "8px 18px",
            justifyContent: "center"
          }}
        >
          {wordNodes}
        </div>
      </div>
    );

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        background: `radial-gradient(circle at 20% 20%, ${segment.accent}33, #0b1020 30%, #020617 72%)`,
        justifyContent: "center",
        opacity: reveal,
        padding: isWide ? 80 : 72,
        transform: `translateY(${panelTranslate}px)`
      }}
    >
      <div
        style={{
          color: "rgba(255,255,255,0.56)",
          fontFamily: baseFontFamily,
          fontSize: isWide ? 28 : 34,
          fontWeight: 700,
          left: isWide ? 60 : 54,
          letterSpacing: 1.8,
          position: "absolute",
          textTransform: "uppercase",
          top: isWide ? 44 : 48
        }}
      >
        Demo de Legendas
      </div>
      {panel}
    </AbsoluteFill>
  );
};

export const CaptionStyleDemo = () => {
  return (
    <AbsoluteFill style={{backgroundColor: "#020617"}}>
      {segments.map((segment, index) => (
        <Sequence
          key={segment.id}
          from={index * SEGMENT_FRAMES}
          durationInFrames={SEGMENT_FRAMES}
        >
          <DemoCaption segment={segment} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const captionStyleDemoDurationInFrames = segments.length * SEGMENT_FRAMES;
