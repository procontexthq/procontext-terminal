import { describe, expect, it } from "vitest";

import {
  findTerminalLinkCandidates,
  parseTerminalLinkTarget,
} from "../../src/shared/terminal-links";

describe("terminal link parsing", () => {
  it("finds supported web URLs and trims terminal punctuation", () => {
    expect(
      findTerminalLinkCandidates("Docs: https://example.com/path?q=ok, then continue.", "linux"),
    ).toEqual([
      {
        endIndex: 35,
        kind: "url",
        startIndex: 6,
        target: "https://example.com/path?q=ok",
      },
    ]);

    expect(findTerminalLinkCandidates("Local: http://[::1].", "linux")).toEqual([
      {
        endIndex: 19,
        kind: "url",
        startIndex: 7,
        target: "http://[::1]",
      },
    ]);
  });

  it("finds local POSIX and Windows paths without treating relative paths as links", () => {
    expect(
      findTerminalLinkCandidates("open /tmp/project/src/app.ts:12:4 but not src/app.ts", "linux"),
    ).toEqual([
      {
        endIndex: 33,
        kind: "path",
        startIndex: 5,
        target: "/tmp/project/src/app.ts:12:4",
      },
    ]);
    expect(
      findTerminalLinkCandidates(
        String.raw`open C:\Users\dev\project\src\app.ts:8 and continue`,
        "win32",
      ),
    ).toEqual([
      {
        endIndex: 38,
        kind: "path",
        startIndex: 5,
        target: String.raw`C:\Users\dev\project\src\app.ts:8`,
      },
    ]);

    expect(
      findTerminalLinkCandidates(
        String.raw`open "C:\Program Files\Project\app.ts:8" and continue`,
        "win32",
      ),
    ).toEqual([
      {
        endIndex: 39,
        kind: "path",
        startIndex: 6,
        target: String.raw`C:\Program Files\Project\app.ts:8`,
      },
    ]);

    expect(findTerminalLinkCandidates("open '/tmp/project files/app.ts:12' now", "linux")).toEqual([
      {
        endIndex: 34,
        kind: "path",
        startIndex: 6,
        target: "/tmp/project files/app.ts:12",
      },
    ]);
  });

  it("accepts only http(s) URLs without credentials and platform-local absolute paths", () => {
    expect(parseTerminalLinkTarget("https://example.com/docs", "url", "linux")).toEqual({
      kind: "url",
      target: "https://example.com/docs",
    });
    expect(parseTerminalLinkTarget("javascript:alert(1)", "url", "linux")).toBeNull();
    expect(parseTerminalLinkTarget("https://user:secret@example.com", "url", "linux")).toBeNull();
    expect(parseTerminalLinkTarget("file:///tmp/secret", "url", "linux")).toBeNull();

    expect(parseTerminalLinkTarget("/tmp/project/app.ts", "path", "linux")).toEqual({
      kind: "path",
      target: "/tmp/project/app.ts",
    });
    expect(parseTerminalLinkTarget("../project/app.ts", "path", "linux")).toBeNull();
    expect(parseTerminalLinkTarget("//server/share/file.txt", "path", "linux")).toBeNull();
    expect(parseTerminalLinkTarget(String.raw`C:\project\app.ts`, "path", "win32")).toEqual({
      kind: "path",
      target: String.raw`C:\project\app.ts`,
    });
    expect(
      parseTerminalLinkTarget(String.raw`\\server\share\file.txt`, "path", "win32"),
    ).toBeNull();
  });

  it("rejects control characters and oversized values at the renderer boundary", () => {
    expect(parseTerminalLinkTarget("https://example.com/\u0000secret", "url", "linux")).toBeNull();
    expect(parseTerminalLinkTarget(`/tmp/${"a".repeat(4096)}`, "path", "linux")).toBeNull();
  });
});
