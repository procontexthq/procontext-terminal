import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TerminalSessionSummary } from "@terminal/protocol";
import { NodePtyHost } from "@terminal/pty-host";

import { TerminalSessionManager } from "../src/index";

describe("real shell integration", () => {
  it.each(installedShells())(
    "integrates an installed $name session",
    async ({ name, executable }) => {
      const fixture = createShellFixture(name);
      const manager = new TerminalSessionManager(new NodePtyHost());
      let session: TerminalSessionSummary | null = null;
      try {
        session = await manager.createSession({
          shell: executable,
          cwd: fixture.home,
          env: fixture.env,
        });
        const ready = await waitForSummary(
          manager,
          session,
          "negotiation",
          (summary) =>
            summary.shellIntegration.status === "available" && summary.command.state === "idle",
        );

        expect(canonicalPath(ready.cwd)).toBe(canonicalPath(fixture.home));
        await manager.input({
          sessionId: session.sessionId,
          input: commandFor(name),
          origin: "system",
        });
        const completed = await waitForSummary(
          manager,
          ready,
          "command completion",
          (summary) =>
            summary.command.state === "idle" &&
            summary.command.lastCommand?.exitCode === 0 &&
            summary.command.lastCommand.commandLine?.includes("PCT_REAL_OK") === true,
        );

        expect(completed.command).toMatchObject({
          state: "idle",
          lastCommand: { exitCode: 0 },
        });
        await waitForCondition(async () => {
          const current = await manager.observe({
            sessionId: session.sessionId,
            timeoutMs: 100,
          });
          return (
            current.status === "changed" &&
            current.observation.viewport.rows.some((row) => row.text === "PCT_REAL_OK")
          );
        }, 2_000);
        const observation = await manager.observe({
          sessionId: session.sessionId,
          timeoutMs: 1_000,
        });
        expect(observation).toMatchObject({
          status: "changed",
        });
        if (observation.status !== "changed") throw new Error("Expected a current observation.");
        expect(canonicalPath(observation.observation.cwd)).toBe(canonicalPath(fixture.home));
        expect(observation.observation.viewport.rows).toEqual(
          expect.arrayContaining([expect.objectContaining({ text: "PCT_REAL_OK" })]),
        );
      } finally {
        if (session) await exitFixtureShell(manager, session, name);
        await manager.shutdown({ timeoutMs: 2_000 });
        fixture.cleanup();
      }
    },
    90_000,
  );

  it.skipIf(process.platform !== "win32")(
    "accepts immediate input while Windows PowerShell integration initializes",
    async () => {
      const shells = installedShells().filter(
        ({ name }) => name === "pwsh" || name === "powershell",
      );
      expect(shells.length).toBeGreaterThan(0);

      for (const { name, executable } of shells) {
        const fixture = createShellFixture(name);
        const manager = new TerminalSessionManager(new NodePtyHost());
        const { command, marker } = immediatePowerShellCommand();
        const markerOutput = waitForSessionOutput(manager, marker, 30_000);
        let session: TerminalSessionSummary | null = null;
        try {
          session = await manager.createSession({
            shell: executable,
            cwd: fixture.home,
            env: fixture.env,
          });
          expect(session.shellIntegration.status, `${name} negotiated before immediate input`).toBe(
            "initializing",
          );

          await expect(
            manager.input({
              sessionId: session.sessionId,
              input: command,
              origin: "system",
            }),
          ).resolves.toMatchObject({ accepted: true });
          await markerOutput.promise;

          const ready = await waitForSummary(
            manager,
            manager.getSession({ sessionId: session.sessionId }),
            `${name} negotiation after immediate input`,
            (summary) =>
              summary.shellIntegration.status === "available" && summary.command.state === "idle",
          );
          expect(ready.lifecycle).toBe("running");
          expect(ready.shellIntegration.status).toBe("available");
        } finally {
          markerOutput.dispose();
          if (session) await exitFixtureShell(manager, session, name);
          await manager.shutdown({ timeoutMs: 2_000 });
          fixture.cleanup();
        }
      }
    },
    90_000,
  );

  const bash = installedShells().find((candidate) => candidate.name === "bash");
  it.skipIf(!bash)(
    "preserves Bash PROMPT_COMMAND arrays and the previous command status",
    async () => {
      if (!bash) throw new Error("Expected an installed Bash executable.");
      const fixture = createShellFixture("bash");
      writeFileSync(
        join(fixture.home, ".bashrc"),
        [
          "PROMPT_COMMAND=(",
          '  \'printf "PCT_PROMPT_STATUS:%s\\\\n" "$?"\'',
          "  'printf \"PCT_PROMPT_SECOND\\\\n\"'",
          ")",
          "",
        ].join("\n"),
        "utf8",
      );
      const manager = new TerminalSessionManager(new NodePtyHost(), {
        shellIntegrationInitializationTimeoutMs: 5_000,
      });
      let output = "";
      const unsubscribe = manager.onSessionEvent((event) => {
        if (event.type === "session.output") output += event.payload.data;
      });
      try {
        const session = await manager.createSession({
          shell: bash.executable,
          cwd: fixture.home,
          env: fixture.env,
        });
        const ready = await waitForSummary(
          manager,
          session,
          "bash negotiation",
          (summary) =>
            summary.shellIntegration.status === "available" && summary.command.state === "idle",
        );
        output = "";

        await manager.input({
          sessionId: ready.sessionId,
          input: "false\n",
          origin: "system",
        });
        await waitForSummary(
          manager,
          ready,
          "bash command completion",
          (summary) =>
            summary.command.state === "idle" && summary.command.lastCommand?.exitCode === 1,
        );
        await waitForCondition(
          () => output.includes("PCT_PROMPT_STATUS:1") && output.includes("PCT_PROMPT_SECOND"),
          1_000,
        );

        expect(output).toContain("PCT_PROMPT_STATUS:1");
        expect(output).toContain("PCT_PROMPT_SECOND");
      } finally {
        unsubscribe();
        await manager.shutdown({ timeoutMs: 2_000 });
        fixture.cleanup();
      }
    },
  );
});

async function waitForSummary(
  manager: TerminalSessionManager,
  initial: TerminalSessionSummary,
  stage: string,
  predicate: (summary: TerminalSessionSummary) => boolean,
): Promise<TerminalSessionSummary> {
  let current = initial;
  const deadline = Date.now() + 30_000;
  while (!predicate(current)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out during ${stage}: ${JSON.stringify({
          lifecycle: current.lifecycle,
          status: current.shellIntegration.status,
          capabilities: current.shellIntegration.capabilities,
          command: current.command.state,
          hasLastCommand: current.command.state === "idle" && Boolean(current.command.lastCommand),
          lastExitCode:
            current.command.state === "idle" ? current.command.lastCommand?.exitCode : undefined,
          commandLineCaptured:
            current.command.state === "idle"
              ? Boolean(current.command.lastCommand?.commandLine)
              : undefined,
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

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for shell prompt output.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function installedShells(): Array<{ name: ShellName; executable: string }> {
  if (process.platform === "win32") {
    return [
      { name: "pwsh", executable: "pwsh.exe" },
      { name: "powershell", executable: "powershell.exe" },
    ].filter(({ executable }) => canResolveExecutable(executable));
  }
  const installed = [
    { name: "bash", executable: "/bin/bash" },
    { name: "zsh", executable: "/bin/zsh" },
    { name: "fish", executable: "/usr/bin/fish" },
    { name: "fish", executable: "/opt/homebrew/bin/fish" },
  ].filter(
    (candidate, index, values) =>
      isExecutable(candidate.executable) &&
      values.findIndex((value) => value.name === candidate.name) === index,
  ) as Array<{ name: ShellName; executable: string }>;
  if (canResolveExecutable("pwsh")) {
    installed.push({ name: "pwsh", executable: "pwsh" });
  }
  return installed;
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

function immediatePowerShellCommand(): { command: string; marker: string } {
  const token = randomUUID().replaceAll("-", "");
  const markerParts = ["PCT", "IMMEDIATE", "INPUT", token.slice(0, 16), token.slice(16), "OK"];
  const marker = markerParts.join("_");
  const command = `$pctMarkerParts=@('${markerParts.join("','")}'); Write-Output ($pctMarkerParts -join '_')\r`;
  if (command.includes(marker))
    throw new Error("Immediate-input marker must not appear in source.");
  return { command, marker };
}

function waitForSessionOutput(
  manager: TerminalSessionManager,
  expected: string,
  timeoutMs: number,
): { promise: Promise<void>; dispose(): void } {
  let output = "";
  let settled = false;
  let resolvePromise: () => void;
  let rejectPromise: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const unsubscribe = manager.onSessionEvent((event) => {
    if (event.type !== "session.output" || settled) return;
    output += event.payload.data;
    if (!output.includes(expected)) return;
    settled = true;
    clearTimeout(timeout);
    unsubscribe();
    resolvePromise();
  });
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    unsubscribe();
    rejectPromise(new Error("Timed out waiting for immediate PowerShell input output."));
  }, timeoutMs);

  return {
    promise,
    dispose: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
    },
  };
}

async function exitFixtureShell(
  manager: TerminalSessionManager,
  session: TerminalSessionSummary,
  name: ShellName,
): Promise<void> {
  if (manager.getSession({ sessionId: session.sessionId }).lifecycle !== "running") return;
  await manager.input({
    sessionId: session.sessionId,
    input: name === "pwsh" || name === "powershell" ? "exit\r" : "exit\n",
    origin: "system",
  });
  await manager.waitForExit(session.sessionId, 5_000);
}

function canonicalPath(path: string): string {
  const canonical = realpathSync.native(path);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
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
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => {
      const candidate = join(directory, executable);
      return process.platform === "win32" ? existsSync(candidate) : isExecutable(candidate);
    });
}
