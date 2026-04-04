import {spawn} from "node:child_process";

const ANSI_ESCAPE_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const ANSI_OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;

const stripAnsi = (value) =>
  String(value ?? "")
    .replace(ANSI_OSC_PATTERN, "")
    .replace(ANSI_ESCAPE_PATTERN, "");

const normalizeChunk = (value) => stripAnsi(value).replace(/\r\n/g, "\n");

const createStreamState = () => ({
  buffer: "",
  lastRenderedPercent: -1,
  lastEncodedPercent: -1,
  lastLine: ""
});

const shouldEmitProgressLine = (line, state) => {
  const renderedMatch = line.match(/^Rendered\s+(\d+)\/(\d+)/);
  if (renderedMatch) {
    const current = Number(renderedMatch[1]);
    const total = Math.max(1, Number(renderedMatch[2]));
    const percent = Math.floor((current / total) * 100);

    if (current === 0 || current === total || percent >= state.lastRenderedPercent + 5) {
      state.lastRenderedPercent = percent;
      return true;
    }

    return false;
  }

  const encodedMatch = line.match(/^Encoded\s+(\d+)\/(\d+)/);
  if (encodedMatch) {
    const current = Number(encodedMatch[1]);
    const total = Math.max(1, Number(encodedMatch[2]));
    const percent = Math.floor((current / total) * 100);

    if (current === total || percent >= state.lastEncodedPercent + 10) {
      state.lastEncodedPercent = percent;
      return true;
    }

    return false;
  }

  return true;
};

const emitNormalizedText = (text, target, state, compactProgress) => {
  state.buffer += normalizeChunk(text);
  const segments = state.buffer.split(/(\r|\n)/);
  state.buffer = "";

  for (let index = 0; index < segments.length; index += 2) {
    const line = segments[index] ?? "";
    const delimiter = segments[index + 1] ?? "";

    if (!delimiter) {
      state.buffer = line;
      break;
    }

    const normalizedLine = line.trimEnd();

    if (!normalizedLine) {
      if (delimiter === "\n" && state.lastLine !== "") {
        target.write("\n");
        state.lastLine = "";
      }
      continue;
    }

    if (compactProgress && !shouldEmitProgressLine(normalizedLine, state)) {
      continue;
    }

    if (normalizedLine === state.lastLine && delimiter === "\r") {
      continue;
    }

    target.write(`${normalizedLine}\n`);
    state.lastLine = normalizedLine;
  }
};

export const runStreamingCommand = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    const stdoutState = createStreamState();
    const stderrState = createStreamState();

    child.stdout?.on("data", (chunk) => {
      const text = normalizeChunk(chunk);
      stdout += text;
      emitNormalizedText(
        text,
        options.stdout ?? process.stdout,
        stdoutState,
        Boolean(options.compactProgress)
      );
    });

    child.stderr?.on("data", (chunk) => {
      const text = normalizeChunk(chunk);
      stderr += text;
      emitNormalizedText(
        text,
        options.stderr ?? process.stderr,
        stderrState,
        Boolean(options.compactProgress)
      );
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      resolve({
        status: code ?? (signal ? 1 : 0),
        signal,
        stdout,
        stderr
      });
    });
  });
