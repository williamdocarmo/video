import {Composition} from "remotion";
import {CaptionStyleDemo, captionStyleDemoDurationInFrames} from "./CaptionStyleDemo";
import {ShortVideo} from "./ShortVideo";
import {type ShortVideoProps} from "./types";

const defaultProps: ShortVideoProps = {
  title: "Exemplo de video vertical",
  hook: "Um formato simples, rapido e nativo para shorts.",
  cta: "Segue para mais videos.",
  channelHandle: "@teucanal",
  durationInFrames: 300,
  narrationPath: null,
  musicPath: null,
  scenes: [
    {
      id: "scene-01",
      title: "Hook",
      narration: "A tua stack nao precisa de ser cara para parecer profissional.",
      overlay: "Hook forte",
      searchQuery: "person using phone at night",
      clipPath: null,
      attribution: null,
      startFrame: 0,
      durationInFrames: 150
    },
    {
      id: "scene-02",
      title: "Fecho",
      narration: "Stock vertical, voz limpa e legendas boas ja chegam longe.",
      overlay: "Visual simples",
      searchQuery: "city people walking vertical",
      clipPath: null,
      attribution: null,
      startFrame: 150,
      durationInFrames: 150
    }
  ],
  captions: [
    {
      text: "A tua stack nao",
      startFrame: 0,
      endFrame: 49,
      words: [
        {text: "A", startFrame: 0, endFrame: 16},
        {text: "tua", startFrame: 17, endFrame: 33},
        {text: "stack", startFrame: 34, endFrame: 49}
      ]
    },
    {
      text: "precisa de ser",
      startFrame: 50,
      endFrame: 99,
      words: [
        {text: "precisa", startFrame: 50, endFrame: 66},
        {text: "de", startFrame: 67, endFrame: 82},
        {text: "ser", startFrame: 83, endFrame: 99}
      ]
    },
    {
      text: "cara para parecer",
      startFrame: 100,
      endFrame: 149,
      words: [
        {text: "cara", startFrame: 100, endFrame: 116},
        {text: "para", startFrame: 117, endFrame: 132},
        {text: "parecer", startFrame: 133, endFrame: 149}
      ]
    },
    {
      text: "profissional.",
      startFrame: 150,
      endFrame: 174,
      words: [
        {text: "profissional.", startFrame: 150, endFrame: 174}
      ]
    },
    {
      text: "Stock vertical, voz",
      startFrame: 175,
      endFrame: 224,
      words: [
        {text: "Stock", startFrame: 175, endFrame: 191},
        {text: "vertical,", startFrame: 192, endFrame: 208},
        {text: "voz", startFrame: 209, endFrame: 224}
      ]
    },
    {
      text: "limpa e legendas",
      startFrame: 225,
      endFrame: 266,
      words: [
        {text: "limpa", startFrame: 225, endFrame: 238},
        {text: "e", startFrame: 239, endFrame: 252},
        {text: "legendas", startFrame: 253, endFrame: 266}
      ]
    },
    {
      text: "boas ja chegam",
      startFrame: 267,
      endFrame: 290,
      words: [
        {text: "boas", startFrame: 267, endFrame: 274},
        {text: "ja", startFrame: 275, endFrame: 282},
        {text: "chegam", startFrame: 283, endFrame: 290}
      ]
    },
    {
      text: "longe.",
      startFrame: 291,
      endFrame: 299,
      words: [
        {text: "longe.", startFrame: 291, endFrame: 299}
      ]
    }
  ]
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="CodexShort"
        component={ShortVideo}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={defaultProps.durationInFrames}
        defaultProps={defaultProps}
        calculateMetadata={({props}) => {
          const input = props as ShortVideoProps;

          return {
            durationInFrames:
              input.durationInFrames ||
              input.scenes.reduce((total, scene) => total + scene.durationInFrames, 0) ||
              300
          };
        }}
      />
      <Composition
        id="CodexWide"
        component={ShortVideo}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={defaultProps.durationInFrames}
        defaultProps={defaultProps}
        calculateMetadata={({props}) => {
          const input = props as ShortVideoProps;

          return {
            durationInFrames:
              input.durationInFrames ||
              input.scenes.reduce((total, scene) => total + scene.durationInFrames, 0) ||
              300
          };
        }}
      />
      <Composition
        id="CaptionStyleDemo"
        component={CaptionStyleDemo}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={captionStyleDemoDurationInFrames}
        defaultProps={{}}
      />
    </>
  );
};
