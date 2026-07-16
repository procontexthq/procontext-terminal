import { describe, expect, it, vi } from "vitest";

import { createTerminalLinkOpener } from "../../src/main/terminal-link-opener";

describe("terminal link opener", () => {
  it("opens a validated web URL through OS integration", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const opener = createTerminalLinkOpener({
      platform: "linux",
      openExternal,
      showItemInFolder: vi.fn(),
      statPath: vi.fn(),
    });

    await expect(opener({ kind: "url", target: "https://example.com/docs" })).resolves.toEqual({
      status: "opened",
    });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("rejects unsupported or credential-bearing URLs before OS integration", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const opener = createTerminalLinkOpener({
      platform: "linux",
      openExternal,
      showItemInFolder: vi.fn(),
      statPath: vi.fn(),
    });

    await expect(opener({ kind: "url", target: "javascript:alert(1)" })).rejects.toMatchObject({
      type: "invalid_request",
    });
    await expect(
      opener({ kind: "url", target: "https://user:secret@example.com" }),
    ).rejects.toMatchObject({ type: "invalid_request" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("checks a local absolute path before revealing it and supports line suffixes", async () => {
    const statPath = vi.fn((path: string) =>
      path === "/tmp/project/app.ts"
        ? Promise.resolve({ isFile: () => true, isDirectory: () => false })
        : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    );
    const showItemInFolder = vi.fn();
    const opener = createTerminalLinkOpener({
      platform: "linux",
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder,
      statPath,
    });

    await expect(opener({ kind: "path", target: "/tmp/project/app.ts:12:4" })).resolves.toEqual({
      status: "opened",
    });
    expect(statPath).toHaveBeenNthCalledWith(1, "/tmp/project/app.ts:12:4");
    expect(statPath).toHaveBeenNthCalledWith(2, "/tmp/project/app.ts");
    expect(showItemInFolder).toHaveBeenCalledWith("/tmp/project/app.ts");
  });

  it("rejects relative, remote, missing, and non-file-system targets", async () => {
    const showItemInFolder = vi.fn();
    const opener = createTerminalLinkOpener({
      platform: "win32",
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder,
      statPath: vi.fn(() =>
        Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
      ),
    });

    await expect(opener({ kind: "path", target: "src/app.ts" })).rejects.toMatchObject({
      type: "invalid_request",
    });
    await expect(
      opener({ kind: "path", target: String.raw`\\server\share\app.ts` }),
    ).rejects.toMatchObject({ type: "invalid_request" });
    await expect(
      opener({ kind: "path", target: String.raw`C:\project\missing.ts` }),
    ).rejects.toMatchObject({ type: "invalid_request" });
    expect(showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals executable-looking files instead of launching terminal-derived code", async () => {
    const showItemInFolder = vi.fn();
    const opener = createTerminalLinkOpener({
      platform: "win32",
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder,
      statPath: vi.fn(() => Promise.resolve({ isFile: () => true, isDirectory: () => false })),
    });

    await expect(
      opener({ kind: "path", target: String.raw`C:\project\tool.exe` }),
    ).resolves.toEqual({ status: "opened" });
    expect(showItemInFolder).toHaveBeenCalledWith(String.raw`C:\project\tool.exe`);
  });

  it("surfaces OS reveal failures as typed errors", async () => {
    const opener = createTerminalLinkOpener({
      platform: "linux",
      openExternal: vi.fn(() => Promise.resolve()),
      showItemInFolder: vi.fn(() => {
        throw new Error("File manager unavailable");
      }),
      statPath: vi.fn(() => Promise.resolve({ isFile: () => true, isDirectory: () => false })),
    });

    await expect(opener({ kind: "path", target: "/tmp/project/app.ts" })).rejects.toMatchObject({
      type: "link_open_failed",
    });
  });
});
