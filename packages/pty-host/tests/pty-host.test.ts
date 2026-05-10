import { describe, expect, it } from "vitest";

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
    expect(resolveShell({ shell: "/bin/sh" }).executable).toBe("/bin/sh");
  });

  it("resolves PATH shell names to executable paths", () => {
    const resolved = resolveShell({ shell: "sh", env: { PATH: "/bin:/usr/bin" } });

    expect(resolved.executable).toMatch(/\/sh$/);
  });

  it("spawns a PTY, writes input, resizes, and observes exit", async () => {
    const host = new NodePtyHost();
    const chunks: string[] = [];
    const exits: Array<{ exitCode: number | null; signal: string | null }> = [];
    const pty = await host.spawn({
      sessionId: createSessionId("pty-test"),
      shell: resolveShell({ shell: "/bin/sh", cwd: process.cwd() }),
      cols: 80,
      rows: 24,
    });

    pty.onData((data) => chunks.push(data));
    pty.onExit((event) => exits.push(event));
    pty.resize(100, 30);
    pty.write("printf 'PHASE1_PTY_OK\\n'\nexit\n");

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
