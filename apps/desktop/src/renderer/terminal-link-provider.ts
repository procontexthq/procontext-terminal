import type { ILinkProvider } from "@xterm/xterm";

import {
  findTerminalLinkCandidates,
  type TerminalLinkPlatform,
  type TerminalLinkTarget,
} from "../shared/terminal-links";

export type CreateTerminalLinkProviderOptions = {
  platform: TerminalLinkPlatform;
  columns: number | (() => number);
  getLine(line: number): {
    cells: ReadonlyArray<{ chars: string; width: number }>;
    isWrapped: boolean;
  } | null;
  open(target: TerminalLinkTarget): Promise<{ status: "opened" }>;
  onError?(error: unknown): void;
};

type LogicalLine = {
  positions: Array<{ x: number; y: number }>;
  text: string;
};

export function createTerminalLinkProvider(
  options: CreateTerminalLinkProviderOptions,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const columns = Math.max(
        1,
        typeof options.columns === "function" ? options.columns() : options.columns,
      );
      const logicalLine = readLogicalLine(bufferLineNumber, columns, (line) =>
        options.getLine(line),
      );
      if (logicalLine === null) {
        callback(undefined);
        return;
      }

      const candidates = findTerminalLinkCandidates(logicalLine.text, options.platform)
        .map((candidate) => {
          const start = logicalLine.positions[candidate.startIndex];
          const end = logicalLine.positions[candidate.endIndex - 1];
          return start && end ? { candidate, range: { start, end } } : null;
        })
        .filter((candidate) => candidate !== null)
        .filter(
          ({ range }) => range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber,
        );
      callback(
        candidates.length === 0
          ? undefined
          : candidates.map(({ candidate, range }) => ({
              text: candidate.target,
              range,
              activate: () => {
                void options
                  .open({ kind: candidate.kind, target: candidate.target })
                  .catch((error: unknown) => options.onError?.(error));
              },
            })),
      );
    },
  };
}

function readLogicalLine(
  bufferLineNumber: number,
  columns: number,
  getLine: CreateTerminalLinkProviderOptions["getLine"],
): LogicalLine | null {
  let startLine = bufferLineNumber;
  let firstLine = getLine(startLine);
  if (firstLine === null) return null;

  while (firstLine.isWrapped && startLine > 1) {
    const previousLine = getLine(startLine - 1);
    if (previousLine === null) break;
    startLine -= 1;
    firstLine = previousLine;
  }

  const lines = [{ lineNumber: startLine, line: firstLine }];
  let nextLineNumber = startLine + 1;
  for (;;) {
    const nextLine = getLine(nextLineNumber);
    if (nextLine === null || !nextLine.isWrapped) break;
    lines.push({ lineNumber: nextLineNumber, line: nextLine });
    nextLineNumber += 1;
  }

  let text = "";
  const positions: LogicalLine["positions"] = [];
  for (const { lineNumber, line } of lines) {
    for (let column = 0; column < columns; column += 1) {
      const cell = line.cells[column] ?? { chars: "", width: 1 };
      if (cell.width === 0) continue;
      const chars = cell.chars || " ";
      text += chars;
      for (let index = 0; index < chars.length; index += 1) {
        positions.push({ x: column + 1, y: lineNumber });
      }
    }
  }

  const trimmedText = text.trimEnd();
  return { text: trimmedText, positions: positions.slice(0, trimmedText.length) };
}
