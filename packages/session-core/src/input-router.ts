import type { InputOrigin, TerminalKey } from "@terminal/protocol";

export type EncodedTerminalInput = {
  data: string;
  origin: InputOrigin;
};

const keySequences: Record<TerminalKey, string> = {
  Enter: "\r",
  Tab: "\t",
  Backspace: "\x7f",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  "Ctrl+C": "\x03",
  "Ctrl+D": "\x04",
  "Ctrl+Z": "\x1a",
};

export function encodeTerminalKey(key: TerminalKey): string {
  return keySequences[key];
}

export function normalizeTerminalInput(data: string, origin?: InputOrigin): EncodedTerminalInput {
  return {
    data,
    origin: origin ?? "human",
  };
}
