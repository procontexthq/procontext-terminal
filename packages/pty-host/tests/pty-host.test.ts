import { describe, expect, it } from "vitest";
import { dirname } from "node:path";

import { createSessionId } from "@terminal/protocol";

import { NodePtyHost, resolveShell } from "../src/index";

function waitForOutput(chunks: string[], expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 5000);
    const interval = setInterval(() => {
      if (chunks.join("").includes(expected)) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 25);
  });
}

function waitForExit(
  exits: Array<{ exitCode: number | null; signal: string | null }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for PTY exit")), 5000);
    const interval = setInterval(() => {
      if (exits.length > 0) {
        clearTimeout(timeout);
        clearInterval(interval);
        resolve();
      }
    }, 25);
  });
}

describe("NodePtyHost", () => {
  it("resolves an explicit shell without platform-specific leakage", () => {
    const shell = platformShell();

    expect(resolveShell({ shell }).executable).toBe(shell);
  });

  it("resolves PATH shell names to executable paths", () => {
    const { shellName, env } = pathResolutionFixture();
    const resolved = resolveShell({ shell: shellName, env });

    expect(resolved.executable.toLowerCase()).toContain(shellName.toLowerCase());
  });

  it("applies Windows environment overrides case-insensitively", () => {
    const resolved = resolveShell(
      {
        shell: "custom-shell",
        env: { PATH: "C:\\Tools\\Bin" },
      },
      {
        platform: "win32",
        processEnv: {
          Path: "C:\\Windows\\System32",
          PATHEXT: ".EXE",
        },
        canExecute: (candidate) => candidate.toLowerCase() === "c:\\tools\\bin\\custom-shell.exe",
      },
    );

    expect(resolved.executable).toBe("C:\\Tools\\Bin\\custom-shell.exe");
    expect(resolved.env.Path).toBe("C:\\Tools\\Bin");
    expect("PATH" in resolved.env).toBe(false);
  });

  it("prefers Windows PowerShell from PATH before ComSpec defaults", () => {
    const resolved = resolveShell(
      {},
      {
        platform: "win32",
        processEnv: {
          Path: "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PATHEXT: ".EXE",
        },
        canExecute: (candidate) => candidate.toLowerCase().endsWith("\\pwsh.exe"),
      },
    );

    expect(resolved.executable).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("rejects relative path-like shell values", () => {
    expect(() =>
      resolveShell({ shell: "./local-shell" }, { platform: "linux", processEnv: { PATH: "/bin" } }),
    ).toThrow(/absolute path/);
    expect(() =>
      resolveShell(
        { shell: ".\\local-shell.exe" },
        { platform: "win32", processEnv: { PATH: "C:\\Windows\\System32" } },
      ),
    ).toThrow(/absolute path/);
  });

  it("spawns a PTY, writes input, resizes, and observes exit", async () => {
    const host = new NodePtyHost();
    const chunks: string[] = [];
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    const pty = await host.spawn({
      sessionId: createSessionId("pty-test"),
      shell: resolveShell({ shell: platformShell(), cwd: process.cwd() }),
      cols: 80,
      rows: 24,
    });

    pty.onData((data) => chunks.push(data));
    pty.onExit((event) => exits.push(event));
    pty.resize(100, 30);
    pty.write(platformEchoAndExitCommand("PHASE1_PTY_OK"));

    await waitForOutput(chunks, "PHASE1_PTY_OK");
    await waitForExit(exits);

    expect(chunks.join("")).toContain("PHASE1_PTY_OK");
    expect(exits.length).toBeGreaterThanOrEqual(1);
  });

  it("maps spawn failures to typed terminal errors", async () => {
    const host = new NodePtyHost();

    await expect(
      host.spawn({
        sessionId: createSessionId("bad-pty"),
        shell: {
          executable: "/definitely/not/a/shell",
          args: [],
          cwd: process.cwd(),
          env: {},
        },
        cols: 80,
        rows: 24,
      }),
    ).rejects.toMatchObject({ type: "pty_spawn_failed" });
  });
});

function platformShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }

  return "/bin/sh";
}

function pathResolutionFixture(): { shellName: string; env: Record<string, string> } {
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    return {
      shellName: "cmd.exe",
      env: { PATH: dirname(comSpec), PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    };
  }

  return { shellName: "sh", env: { PATH: "/bin:/usr/bin" } };
}

function platformEchoAndExitCommand(text: string): string {
  if (process.platform === "win32") {
    return `echo ${text}\r\nexit\r\n`;
  }

  return `printf '${text}\\n'\nexit\n`;
}
