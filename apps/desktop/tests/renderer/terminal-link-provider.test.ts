import { describe, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";

import { createTerminalLinkProvider } from "../../src/renderer/terminal-link-provider";

describe("terminal link provider", () => {
  it("returns xterm ranges for validated candidates and opens only on activation", () => {
    const open = vi.fn(() => Promise.resolve({ status: "opened" as const }));
    const provider = createTerminalLinkProvider({
      platform: "linux",
      columns: 80,
      getLine: (line) => (line === 3 ? asciiBufferLine("see https://example.com/docs") : null),
      open,
    });
    let links: ILink[] | undefined;

    provider.provideLinks(3, (providedLinks) => {
      links = providedLinks;
    });

    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      range: { start: { x: 5, y: 3 }, end: { x: 28, y: 3 } },
      text: "https://example.com/docs",
    });
    expect(open).not.toHaveBeenCalled();

    links?.[0]?.activate({} as MouseEvent, "https://example.com/docs");
    expect(open).toHaveBeenCalledWith({ kind: "url", target: "https://example.com/docs" });
  });

  it("reports activation failures without exposing arbitrary details", async () => {
    const onError = vi.fn();
    const provider = createTerminalLinkProvider({
      platform: "win32",
      columns: 80,
      getLine: () => asciiBufferLine(String.raw`C:\project\app.ts:7`),
      open: () => Promise.reject(new Error("private filesystem detail")),
      onError,
    });
    let links: ILink[] | undefined;
    provider.provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });

    links?.[0]?.activate({} as MouseEvent, String.raw`C:\project\app.ts:7`);
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
  });

  it("reconstructs wrapped logical lines and returns a multi-row range", () => {
    const rows = new Map([
      [4, asciiBufferLine("see https:")],
      [5, asciiBufferLine("//example.", true)],
      [6, asciiBufferLine("com/docs", true)],
    ]);
    const provider = createTerminalLinkProvider({
      platform: "linux",
      columns: 10,
      getLine: (line) => rows.get(line) ?? null,
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    });
    let links: ILink[] | undefined;

    provider.provideLinks(5, (providedLinks) => {
      links = providedLinks;
    });

    expect(links).toHaveLength(1);
    expect(links?.[0]).toMatchObject({
      text: "https://example.com/docs",
      range: { start: { x: 5, y: 4 }, end: { x: 8, y: 6 } },
    });
  });

  it("maps wrapped links by terminal cells when wide characters precede the target", () => {
    const rows = new Map([
      [
        4,
        {
          isWrapped: false,
          cells: [{ chars: "界", width: 2 }, { chars: "", width: 0 }, ...asciiCells("https://")],
        },
      ],
      [5, asciiBufferLine("x.co", true)],
    ]);
    const provider = createTerminalLinkProvider({
      platform: "linux",
      columns: 10,
      getLine: (line) => rows.get(line) ?? null,
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    });
    let links: ILink[] | undefined;

    provider.provideLinks(4, (providedLinks) => {
      links = providedLinks;
    });

    expect(links?.[0]).toMatchObject({
      text: "https://x.co",
      range: { start: { x: 3, y: 4 }, end: { x: 4, y: 5 } },
    });
  });

  it("maps links after emoji and combining graphemes to terminal cells", () => {
    const provider = createTerminalLinkProvider({
      platform: "linux",
      columns: 30,
      getLine: () => ({
        isWrapped: false,
        cells: [
          { chars: "🙂", width: 2 },
          { chars: "", width: 0 },
          { chars: "e\u0301", width: 1 },
          { chars: " ", width: 1 },
          ...asciiCells("https://x.co"),
        ],
      }),
      open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    });
    let links: ILink[] | undefined;

    provider.provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });

    expect(links?.[0]).toMatchObject({
      text: "https://x.co",
      range: { start: { x: 5, y: 1 }, end: { x: 16, y: 1 } },
    });
  });
});

function asciiBufferLine(text: string, isWrapped = false) {
  return { isWrapped, cells: asciiCells(text) };
}

function asciiCells(text: string): Array<{ chars: string; width: number }> {
  return [...text].map((chars) => ({ chars, width: 1 }));
}
