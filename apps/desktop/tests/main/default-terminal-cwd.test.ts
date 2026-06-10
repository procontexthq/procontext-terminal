import { describe, expect, it, vi } from "vitest";

import { resolveDefaultTerminalCwd } from "../../src/main/default-terminal-cwd";

describe("resolveDefaultTerminalCwd", () => {
  it("prefers the Electron app home directory over the app process cwd", () => {
    const result = resolveDefaultTerminalCwd({
      appHome: "/Users/sunita",
      env: { HOME: "/Users/env-home" },
      isDirectory: directorySet(["/Users/sunita", "/Users/env-home", "/"]),
      platform: "darwin",
      processCwd: () => "/",
    });

    expect(result).toEqual({ cwd: "/Users/sunita", source: "app-home" });
  });

  it("falls back to the POSIX home environment when the app home is unavailable", () => {
    const result = resolveDefaultTerminalCwd({
      appHome: "/missing",
      env: { HOME: "/home/sunita" },
      isDirectory: directorySet(["/home/sunita", "/"]),
      platform: "linux",
      processCwd: () => "/",
    });

    expect(result).toEqual({ cwd: "/home/sunita", source: "env-home" });
  });

  it("falls back to the Windows profile home when the app home is unavailable", () => {
    const result = resolveDefaultTerminalCwd({
      appHome: "C:\\Missing",
      env: { USERPROFILE: "C:\\Users\\Sunita" },
      isDirectory: directorySet(["C:\\Users\\Sunita", "C:\\"]),
      platform: "win32",
      processCwd: () => "C:\\",
    });

    expect(result).toEqual({ cwd: "C:\\Users\\Sunita", source: "env-home" });
  });

  it("falls back to HOMEDRIVE and HOMEPATH on Windows when USERPROFILE is absent", () => {
    const result = resolveDefaultTerminalCwd({
      appHome: "C:\\Missing",
      env: { HOMEDRIVE: "D:", HOMEPATH: "\\Users\\Sunita" },
      isDirectory: directorySet(["D:\\Users\\Sunita", "C:\\"]),
      platform: "win32",
      processCwd: () => "C:\\",
    });

    expect(result).toEqual({ cwd: "D:\\Users\\Sunita", source: "env-home" });
  });

  it("uses process cwd only as the last valid fallback", () => {
    const result = resolveDefaultTerminalCwd({
      appHome: "/missing",
      env: { HOME: "/also-missing" },
      isDirectory: directorySet(["/fallback"]),
      platform: "darwin",
      processCwd: () => "/fallback",
    });

    expect(result).toEqual({ cwd: "/fallback", source: "process-cwd" });
  });

  it("falls back to the platform root when every directory probe fails", () => {
    const processCwd = vi.fn(() => {
      throw new Error("cwd deleted");
    });

    const result = resolveDefaultTerminalCwd({
      appHome: "/missing",
      env: {},
      isDirectory: () => false,
      platform: "darwin",
      processCwd,
    });

    expect(result).toEqual({ cwd: "/", source: "platform-root" });
  });
});

function directorySet(paths: string[]): (path: string) => boolean {
  const directories = new Set(paths);
  return (path) => directories.has(path);
}
