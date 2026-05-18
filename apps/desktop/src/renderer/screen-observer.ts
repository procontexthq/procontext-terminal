import type { SessionId, TerminalScreenSnapshot } from "@terminal/protocol";

type BufferLineLike = {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
};

type BufferLike = {
  readonly type: "normal" | "alternate";
  readonly cursorX: number;
  readonly cursorY: number;
  readonly viewportY: number;
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
};

export type ObservableTerminal = {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: BufferLike;
  };
};

export function captureTerminalScreen({
  terminal,
  sessionId,
  title,
  now = () => new Date().toISOString(),
}: {
  terminal: ObservableTerminal;
  sessionId: SessionId;
  title: string | null;
  now?: () => string;
}): TerminalScreenSnapshot {
  const buffer = terminal.buffer.active;
  const viewport = [];
  const rowCount = Math.min(terminal.rows, buffer.length);

  for (let row = 0; row < rowCount; row += 1) {
    const bufferRow = buffer.viewportY + row;
    const line = buffer.getLine(bufferRow);
    viewport.push({
      row,
      text: line?.translateToString(true, 0, terminal.cols) ?? "",
      wrapped: line?.isWrapped ?? false,
    });
  }

  return {
    sessionId,
    cols: terminal.cols,
    rows: terminal.rows,
    cursor: {
      x: buffer.cursorX,
      y: buffer.cursorY,
      visible: true,
    },
    alternateScreen: buffer.type === "alternate",
    title,
    viewport,
    capturedAt: now(),
  };
}

export function isObservableTerminal(value: unknown): value is ObservableTerminal {
  return (
    typeof value === "object" &&
    value !== null &&
    "cols" in value &&
    "rows" in value &&
    "buffer" in value
  );
}
