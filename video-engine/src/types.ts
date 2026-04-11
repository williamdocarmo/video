export type Scene = {
  id: string;
  title: string;
  narration: string;
  overlay: string;
  searchQuery: string;
  illustration?: string | null;
  clipPath: string | null;
  attribution: string | null;
  startFrame: number;
  durationInFrames: number;
  transitionInFrames?: number;
};

export type CaptionChunk = {
  text: string;
  startFrame: number;
  endFrame: number;
  highlightLeadWords?: number;
  words?: Array<{
    text: string;
    startFrame: number;
    endFrame: number;
  }>;
};

export type ShortVideoProps = {
  title: string;
  hook: string;
  cta: string;
  channelHandle: string;
  captionStyle?:
    | "clean-broadcast"
    | "bold-tiktok-block"
    | "soft-karaoke"
    | "outline-punch"
    | "caption-strip";
  outputProfile?: string;
  compositionId?: string;
  videoWidth?: number;
  videoHeight?: number;
  durationInFrames: number;
  narrationPath: string | null;
  musicPath: string | null;
  scenes: Scene[];
  captions: CaptionChunk[];
};

export type BlackInkVideoProps = {
  title: string;
  hook: string;
  cta: string;
  durationInFrames: number;
  narrationPath: string | null;
  musicPath: string | null;
  variant?: "paper" | "charcoal";
  scenes: Scene[];
  captions: CaptionChunk[];
};
