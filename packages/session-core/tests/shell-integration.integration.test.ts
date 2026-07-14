import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TerminalSessionSummary } from "@terminal/protocol";
import { NodePtyHost } from "@terminal/pty-host";

import { TerminalSessionManager } from "../src/index";

describe("real shell integration", () => {
  it.each(installedShells())(
    "integrates an installed $name session",
    async ({ name, executable }) => {
      const fixture = createShellFixture(name);
      const manager = new TerminalSessionManager(new NodePtyHost(), {
        shellIntegrationInitializationTimeoutMs: 5_000,
      });
      try {
        const session = await manager.createSession({
          shell: executable,
          cwd: fixture.home,
          env: fixture.env,
        });
        const ready = await waitForSummary(
          manager,
          session,
          (summary) =>
            summary.shellIntegration.status === "available" && summary.command.state === "idle",
        );

        expect(ready.cwd).toBe(fixture.home);
        await manager.input({
          sessionId: session.sessionId,
          input: commandFor(name),
          origin: "system",
        });
        const completed = await waitForSummary(
          manager,
          ready,
          (summary) =>
            summary.command.state === "idle" &&
            summary.command.lastCommand?.exitCode === 0 &&
            summary.command.lastCommand.commandLine?.includes("PCT_REAL_OK") === true,
        );

        expect(completed.command).toMatchObject({
          state: "idle",
          lastCommand: { exitCode: 0 },
        });
        const observation = await manager.observe({
          sessionId: session.sessionId,
          timeoutMs: 1_000,
        });
        expect(observation).toMatchObject({
          status: "changed",
          observation: {
            cwd: fixture.home,
          },
        });
        if (observation.status !== "changed") throw new Error("Expected a current observation.");
        expect(observation.observation.viewport.rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: "PCT_REAL_OK" })]),
        );
      } finally {
        await manager.shutdown({ timeoutMs: 2_000 });
        fixture.cleanup();
      }
    },
  );
});

async function waitForSummary(
  manager: TerminalSessionManager,
  initial: TerminalSessionSummary,
  predicate: (summary: TerminalSessionSummary) => boolean,
): Promise<TerminalSessionSummary> {
  let current = initial;
  const deadline = Date.now() + 8_000;
  while (!predicate(current)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for shell integration: ${JSON.stringify({
          status: current.shellIntegration.status,
          capabilities: current.shellIntegration.capabilities,
          command: current.command.state,
        })}`,
      );
    }
    const result = await manager.observe({
      sessionId: current.sessionId,
      afterVersion: current.observationVersion,
      timeoutMs: Math.min(1_000, deadline - Date.now()),
    });
    current = manager.getSession({ sessionId: current.sessionId });
    if (result.status === "changed") {
      current = {
        ...current,
        observationVersion: result.observation.version,
      };
    }
  }
  return current;
}

function installedShells(): Array<{ name: ShellName; executable: string }> {
  if (process.platform === "win32") {
    return [
      { name: "pwsh", executable: "pwsh.exe" },
      { name: "powershell", executable: "powershell.exe" },
    ].filter(({ executable }) => canResolveExecutable(executable));
  }
  return [
    { name: "bash", executable: "/bin/bash" },
    { name: "zsh", executable: "/bin/zsh" },
    { name: "fish", executable: "/usr/bin/fish" },
    { name: "fish", executable: "/opt/homebrew/bin/fish" },
  ].filter(
    (candidate, index, values) =>
      isExecutable(candidate.executable) &&
      values.findIndex((value) => value.name === candidate.name) === index,
  );
}

type ShellName = "bash" | "zsh" | "fish" | "pwsh" | "powershell";

function createShellFixture(name: ShellName): {
  home: string;
  env: Record<string, string>;
  cleanup(): void;
} {
  const home = mkdtempSync(join(tmpdir(), `procontext-${name}-`));
  const config = join(home, ".config");
  mkdirSync(join(config, "fish"), { recursive: true });
  writeFileSync(join(home, ".bashrc"), "export PCT_USER_STARTUP=loaded\n", "utf8");
  writeFileSync(join(home, ".zshrc"), "export PCT_USER_STARTUP=loaded\n", "utf8");
  writeFileSync(join(config, "fish", "config.fish"), "set -gx PCT_USER_STARTUP loaded\n", "utf8");
  return {
    home,
    env: {
      HOME: home,
      ZDOTDIR: home,
      XDG_CONFIG_HOME: config,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function commandFor(name: ShellName): string {
  return name === "pwsh" || name === "powershell"
    ? "Write-Output PCT_REAL_OK\r"
    : "printf 'PCT_REAL_OK\\n'\n";
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canResolveExecutable(executable: string): boolean {
  const path = process.env.Path ?? process.env.PATH ?? "";
  return path
    .split(";")
    .filter(Boolean)
    .some((directory) => existsSync(join(directory, executable)));
}
