import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

import { captureTerminalScreen, type ObservableTerminal } from "../../src/renderer/screen-observer";

describe("screen observer", () => {
  it("captures visible rows, cursor, title, and alternate-screen state", () => {
    const terminal = fakeTerminal({
      type: "alternate",
      rows: ["one", "two"],
      cursorX: 3,
      cursorY: 1,
    });

    expect(
      captureTerminalScreen({
        terminal,
        sessionId: createSessionId("session-1"),
        title: "vim",
        now: () => "2026-05-11T00:00:00.000Z",
      }),
    ).toEqual({
      sessionId: "session-1",
      cols: 80,
      rows: 2,
      cursor: { x: 3, y: 1, visible: true },
      alternateScreen: true,
      title: "vim",
      viewport: [
        { row: 0, text: "one", wrapped: false },
        { row: 1, text: "two", wrapped: false },
      ],
      capturedAt: "2026-05-11T00:00:00.000Z",
    });
  });
});

function fakeTerminal({
  type,
  rows,
  cursorX,
  cursorY,
}: {
  type: "normal" | "alternate";
  rows: string[];
  cursorX: number;
  cursorY: number;
}): ObservableTerminal {
  return {
    cols: 80,
    rows: rows.length,
    buffer: {
      active: {
        type,
        cursorX,
        cursorY,
        viewportY: 0,
        length: rows.length,
        getLine: (index) => {
          const text = rows[index];
          if (text === undefined) {
            return undefined;
          }
          return {
            isWrapped: false,
            translateToString: () => text,
          };
        },
      },
    },
  };
}
