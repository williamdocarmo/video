import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig
} from "remotion";
import {type CaptionChunk, type Scene, type ShortVideoProps} from "./types";

type CaptionStyle =
  | "clean-broadcast"
  | "bold-tiktok-block"
  | "soft-karaoke"
  | "outline-punch"
  | "caption-strip";

const backgroundPalette = [
  ["#06131f", "#0e7490"],
  ["#101010", "#4338ca"],
  ["#172554", "#1d4ed8"],
  ["#111827", "#0f766e"],
  ["#1e1b4b", "#be185d"]
];

const getActiveCaption = (captions: CaptionChunk[], frame: number) => {
  return captions.find((caption) => frame >= caption.startFrame && frame <= caption.endFrame) ?? null;
};

const ACTIVE_COLOR = "#facc15";
const PAST_COLOR = "#ffffff";
const FUTURE_COLOR = "rgba(255,255,255,0.75)";
const TEXT_STROKE = "0 4px 18px rgba(0,0,0,0.55), 0 0 1px rgba(0,0,0,0.9)";
const CAPTION_FONT_STACK = "\"Avenir Next\", \"SF Pro Display\", Inter, \"Trebuchet MS\", Verdana, sans-serif";

const KaraokeCaption = ({
  caption,
  isWide,
  captionStyle = "bold-tiktok-block"
}: {
  caption: CaptionChunk;
  isWide: boolean;
  captionStyle?: CaptionStyle;
}) => {
  const frame = useCurrentFrame();
  const words = (caption.words?.length
    ? caption.words
    : caption.text.trim().split(/\s+/).filter(Boolean).map((word) => ({
        text: word,
        startFrame: caption.startFrame,
        endFrame: caption.endFrame
      }))) as Array<{text: string; startFrame: number; endFrame: number}>;
  let activeWordIndex = 0;

  for (let index = 0; index < words.length; index += 1) {
    if (frame >= words[index].startFrame) {
      activeWordIndex = index;
    }
  }

  // Captions are time-critical; keep them readable immediately instead of fading in over ~200ms.
  const entranceOpacity = 1;
  const entranceTranslateY = interpolate(frame, [caption.startFrame, caption.startFrame + 2], [4, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const entranceScale = interpolate(frame, [caption.startFrame, caption.startFrame + 2], [0.995, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const baseFontSize = isWide ? 58 : 66;
  const leadHighlightCount = Math.max(0, Number(caption.highlightLeadWords) || 0);

  const wordNodes = words.map((word, index) => {
    const isActive = index === activeWordIndex;
    const isPast = index < activeWordIndex;
    const normalizedWord = String(word.text ?? "").normalize("NFC");
    const isLeadHighlight = leadHighlightCount > 0 && index < leadHighlightCount;
    const commonStyle = {
      fontFamily: CAPTION_FONT_STACK,
      lineHeight: 1.18,
      textRendering: "geometricPrecision" as const,
      transform: "translateZ(0)"
    };

    if (captionStyle === "clean-broadcast") {
      return (
        <span
          key={`${caption.startFrame}-${normalizedWord}-${index}`}
          style={{
            ...commonStyle,
            color: isActive ? ACTIVE_COLOR : isPast ? "#ffffff" : "rgba(255,255,255,0.72)",
            fontSize: baseFontSize - 2,
            fontWeight: isActive ? 800 : 760,
            letterSpacing: isWide ? -0.2 : -0.45,
            textShadow: isActive ? "0 0 18px rgba(0,0,0,0.3)" : "0 3px 14px rgba(0,0,0,0.28)"
          }}
        >
          {normalizedWord}
        </span>
      );
    }

    if (captionStyle === "bold-tiktok-block") {
      return (
        <span
          key={`${caption.startFrame}-${normalizedWord}-${index}`}
          style={{
            ...commonStyle,
            borderRadius: isLeadHighlight ? 999 : 16,
            color: isActive || isLeadHighlight ? "#0b0b0b" : "#ffffff",
            display: "inline-block",
            fontSize: isLeadHighlight ? baseFontSize - 1 : baseFontSize - 4,
            fontWeight: isLeadHighlight ? 950 : 820,
            letterSpacing: isWide ? -0.18 : -0.28,
            padding: isLeadHighlight ? "7px 14px" : "6px 12px",
            boxShadow:
              isActive || isLeadHighlight ? "0 10px 24px rgba(0,0,0,0.24)" : "none",
            background: isLeadHighlight ? "#ffffff" : isActive ? ACTIVE_COLOR : "rgba(255,255,255,0.12)"
          }}
        >
          {normalizedWord}
        </span>
      );
    }

    if (captionStyle === "soft-karaoke") {
      return (
        <span
          key={`${caption.startFrame}-${normalizedWord}-${index}`}
          style={{
            ...commonStyle,
            color: isActive ? ACTIVE_COLOR : isPast ? "#ffffff" : "rgba(255,255,255,0.72)",
            fontSize: baseFontSize,
            fontWeight: 800,
            letterSpacing: isWide ? -0.35 : -0.6,
            textShadow: isActive
              ? "0 0 18px rgba(250,204,21,0.35), 0 3px 12px rgba(0,0,0,0.35)"
              : "0 3px 12px rgba(0,0,0,0.35)"
          }}
        >
          {normalizedWord}
        </span>
      );
    }

    if (captionStyle === "outline-punch") {
      return (
        <span
          key={`${caption.startFrame}-${normalizedWord}-${index}`}
          style={{
            ...commonStyle,
            color: isActive ? ACTIVE_COLOR : isPast ? "#ffffff" : "rgba(255,255,255,0.74)",
            fontSize: baseFontSize + 2,
            fontWeight: 900,
            letterSpacing: isWide ? -0.45 : -0.8,
            WebkitTextStroke: "8px rgba(0,0,0,0.88)",
            paintOrder: "stroke fill",
            textShadow: isActive ? "0 0 22px rgba(250,204,21,0.3)" : "none"
          }}
        >
          {normalizedWord}
        </span>
      );
    }

    return (
      <span
        key={`${caption.startFrame}-${normalizedWord}-${index}`}
        style={{
          ...commonStyle,
          background: isActive ? ACTIVE_COLOR : "transparent",
          borderRadius: 12,
          color: isActive ? ACTIVE_COLOR : isPast ? PAST_COLOR : FUTURE_COLOR,
          fontSize: baseFontSize - 2,
          fontWeight: 800,
          letterSpacing: isWide ? -0.35 : -0.6,
          padding: isActive ? "3px 9px" : "0",
          textShadow: isActive ? "none" : TEXT_STROKE,
          transition: "color 80ms ease-out, text-shadow 80ms ease-out"
        }}
      >
        <span style={{color: isActive ? "#0b0b0b" : undefined}}>{normalizedWord}</span>
      </span>
    );
  });

  const containerStyles =
    captionStyle === "clean-broadcast"
      ? {
          alignSelf: "center",
          background: "rgba(0,0,0,0.34)",
          borderRadius: 22,
          maxWidth: isWide ? 1180 : 960,
          padding: isWide ? "16px 24px" : "18px 28px",
          textAlign: "center" as const
        }
      : captionStyle === "bold-tiktok-block"
        ? {
            alignSelf: "center",
            maxWidth: isWide ? 1180 : 980,
            padding: 0,
            textAlign: "center" as const
          }
        : captionStyle === "soft-karaoke"
          ? {
              alignSelf: "center",
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 24,
              maxWidth: isWide ? 1180 : 960,
              padding: isWide ? "16px 22px" : "18px 26px",
              textAlign: "center" as const
            }
          : captionStyle === "outline-punch"
            ? {
                alignSelf: "center",
                maxWidth: isWide ? 1180 : 980,
                padding: 0,
                textAlign: "center" as const
              }
            : {
                alignSelf: "stretch",
                background: "rgba(0,0,0,0.58)",
                borderTop: `3px solid ${ACTIVE_COLOR}`,
                boxShadow: "0 -10px 28px rgba(0,0,0,0.18)",
                padding: isWide ? "14px 24px" : "16px 26px"
              };

  return (
    <div
      style={{
        ...containerStyles,
        opacity: entranceOpacity,
        transform: `translateY(${entranceTranslateY}px) scale(${entranceScale})`
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap:
            captionStyle === "bold-tiktok-block"
              ? "10px 12px"
              : captionStyle === "caption-strip"
                ? isWide
                  ? "8px 14px"
                  : "8px 18px"
                : "8px 14px",
          justifyContent:
            captionStyle === "caption-strip" ? "flex-start" : "center"
        }}
      >
        {wordNodes}
      </div>
    </div>
  );
};

const SceneBackground = ({scene, sceneIndex}: {scene: Scene; sceneIndex: number}) => {
  const frame = useCurrentFrame();
  const transitionInFrames = scene.transitionInFrames ?? 12;
  const isFirstScene = sceneIndex === 0;
  const durationInFrames = Math.max(1, scene.durationInFrames);
  const motionProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.bezier(0.22, 0, 0.18, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const sceneFade = interpolate(
    frame,
    isFirstScene
      ? [0, Math.max(1, durationInFrames - transitionInFrames), durationInFrames]
      : [0, transitionInFrames, Math.max(transitionInFrames + 1, durationInFrames - transitionInFrames), durationInFrames],
    isFirstScene ? [1, 1, 0] : [0, 1, 1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp"
    }
  );
  const stillMotionVariants = [
    {fromScale: 1.03, toScale: 1.08, fromX: -12, toX: 8, fromY: 10, toY: -4},
    {fromScale: 1.06, toScale: 1.02, fromX: 14, toX: -10, fromY: -6, toY: 6},
    {fromScale: 1.04, toScale: 1.09, fromX: 0, toX: 0, fromY: 12, toY: -10},
    {fromScale: 1.07, toScale: 1.03, fromX: -18, toX: 16, fromY: 0, toY: 0}
  ];
  const stillMotion = stillMotionVariants[sceneIndex % stillMotionVariants.length];
  const stillScale = interpolate(motionProgress, [0, 1], [stillMotion.fromScale, stillMotion.toScale]);
  const stillTranslateX = interpolate(motionProgress, [0, 1], [stillMotion.fromX, stillMotion.toX]);
  const stillTranslateY = interpolate(motionProgress, [0, 1], [stillMotion.fromY, stillMotion.toY]);

  if (scene.illustration) {
    return (
      <AbsoluteFill
        style={{
          opacity: sceneFade,
          overflow: "hidden"
        }}
      >
        <Img
          src={staticFile(scene.illustration)}
          style={{
            height: "100%",
            objectFit: "cover",
            transform: `translate3d(${stillTranslateX}px, ${stillTranslateY}px, 0) scale(${stillScale})`,
            transformOrigin: "center center",
            width: "100%"
          }}
        />
      </AbsoluteFill>
    );
  }

  if (scene.clipPath) {
    return (
      <AbsoluteFill
        style={{
          opacity: sceneFade,
          overflow: "hidden"
        }}
      >
        <OffthreadVideo
          loop
          muted
          src={staticFile(scene.clipPath)}
          style={{
            height: "100%",
            objectFit: "cover",
            width: "100%"
          }}
        />
      </AbsoluteFill>
    );
  }

  const colors = backgroundPalette[sceneIndex % backgroundPalette.length];
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(circle at 20% 20%, ${colors[1]}, ${colors[0]} 60%)`,
        opacity: sceneFade
      }}
    />
  );
};

export const ShortVideo = ({
  title,
  hook,
  cta,
  channelHandle: _channelHandle,
  captionStyle = "bold-tiktok-block",
  narrationPath,
  musicPath,
  scenes,
  captions
}: ShortVideoProps) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames, width, height} = useVideoConfig();
  const activeCaption = getActiveCaption(captions, frame);
  const isWide = width > height;
  const layoutPadding = isWide ? 56 : 72;
  const captionBottomSpacer = isWide ? 0 : 180;
  const introVisibility = interpolate(frame, [0, 10, 30, 48], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp"
  });
  const headerEntrance = spring({
    fps,
    frame,
    config: {
      damping: 18,
      stiffness: 120
    }
  });

  return (
    <AbsoluteFill style={{backgroundColor: "#050505", color: "white", fontFamily: CAPTION_FONT_STACK}}>
      {scenes.map((scene, sceneIndex) => (
        <Sequence
          key={scene.id}
          from={sceneIndex === 0 ? scene.startFrame : Math.max(0, scene.startFrame - (scene.transitionInFrames ?? 12))}
          durationInFrames={scene.durationInFrames + (sceneIndex === 0 ? 0 : scene.transitionInFrames ?? 12)}
        >
          <SceneBackground scene={scene} sceneIndex={sceneIndex} />
        </Sequence>
      ))}

      <AbsoluteFill
        style={{
          background: "linear-gradient(180deg, rgba(0,0,0,0.68) 0%, rgba(0,0,0,0.12) 28%, rgba(0,0,0,0.1) 62%, rgba(0,0,0,0.82) 100%)"
        }}
      />

      <AbsoluteFill
        style={{
          padding: layoutPadding
        }}
      >
        <div
          style={{
            opacity: 0
          }}
        >
          <div style={{height: 42}} />

          <div
            style={{
              fontSize: 92,
              fontWeight: 900,
              letterSpacing: -2.8,
              lineHeight: 0.92,
              maxWidth: 880,
              textShadow: "0 12px 48px rgba(0,0,0,0.45)",
              transform: `scale(${interpolate(headerEntrance, [0, 1], [0.96, 1])})`
            }}
          >
            {title}
          </div>

          <div style={{height: 28}} />

          <div
            style={{
              color: "rgba(255,255,255,0.88)",
              fontSize: 46,
              fontWeight: 650,
              lineHeight: 1.08,
              maxWidth: 860
            }}
          >
            {hook}
          </div>
        </div>

        <div style={{height: 28}} />

        <div style={{flex: 1}} />

        {activeCaption ? (
          <KaraokeCaption caption={activeCaption} isWide={isWide} captionStyle={captionStyle} />
        ) : null}

        <div style={{height: captionBottomSpacer}} />
      </AbsoluteFill>

      {narrationPath ? <Audio src={staticFile(narrationPath)} /> : null}
      {musicPath ? <Audio src={staticFile(musicPath)} volume={0.05} /> : null}
    </AbsoluteFill>
  );
};
