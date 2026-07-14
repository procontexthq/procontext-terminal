import { describe, expect, it } from "vitest";

import {
  ShellIntegrationTracker,
  createShellIntegrationNonce,
  encodeShellIntegrationMarker,
  fullShellIntegrationCapabilities,
} from "../src/index";

const nonce = "AQEBAQEBAQEBAQEBAQEBAQ";
const initialCwd = "/workspace";

describe("shell integration marker state", () => {
  it("creates a 128-bit unpadded base64url nonce", () => {
    expect(createShellIntegrationNonce(() => new Uint8Array(16).fill(1))).toBe(nonce);
  });

  it("negotiates capabilities and tracks prompt, command, cwd, and exit code", () => {
    const times = [
      "2026-07-14T10:00:00.000Z",
      "2026-07-14T10:00:01.000Z",
      "2026-07-14T10:00:02.000Z",
      "2026-07-14T10:00:03.000Z",
    ];
    const tracker = new ShellIntegrationTracker({
      nonce,
      cwd: initialCwd,
      now: () => new Date(times.shift() ?? "2026-07-14T10:00:04.000Z"),
    });

    expect(
      tracker.acceptOsc(marker("ready", "", JSON.stringify(fullShellIntegrationCapabilities))),
    ).toEqual({ handled: true, changed: true });
    expect(tracker.snapshot.integration).toEqual({
      status: "available",
      capabilities: fullShellIntegrationCapabilities,
    });

    tracker.acceptOsc(marker("prompt", "", "/workspace"));
    expect(tracker.snapshot).toMatchObject({
      cwd: "/workspace",
      command: { state: "idle" },
    });

    tracker.acceptOsc(marker("command-start", "command-1", "pnpm test"));
    expect(tracker.snapshot.command).toEqual({
      state: "running",
      commandId: "command-1",
      commandLine: "pnpm test",
      startedAt: "2026-07-14T10:00:01.000Z",
    });

    tracker.acceptOsc(marker("command-finish", "command-1", "7"));
    expect(tracker.snapshot.command).toEqual({
      state: "idle",
      lastCommand: {
        commandId: "command-1",
        commandLine: "pnpm test",
        exitCode: 7,
        startedAt: "2026-07-14T10:00:01.000Z",
        finishedAt: "2026-07-14T10:00:02.000Z",
      },
    });

    tracker.acceptOsc(marker("prompt", "", "/workspace/packages"));
    expect(tracker.snapshot.cwd).toBe("/workspace/packages");
  });

  it("ignores untrusted markers without changing trusted state", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    const wrongNonce = encodeShellIntegrationMarker({
      nonce: "AgICAgICAgICAgICAgICAg",
      event: "ready",
      payload: JSON.stringify(fullShellIntegrationCapabilities),
    });

    expect(tracker.acceptOsc("Other;1;payload")).toEqual({ handled: false, changed: false });
    expect(tracker.acceptOsc(wrongNonce)).toEqual({ handled: true, changed: false });
    expect(tracker.snapshot.integration.status).toBe("initializing");
    expect(tracker.snapshot.command).toEqual({ state: "unknown" });
  });

  it("degrades matching malformed markers and rejects field limit violations", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });

    expect(tracker.acceptOsc(`PCT;1;${nonce};command-start;bad id;`)).toEqual({
      handled: true,
      changed: true,
    });
    expect(tracker.snapshot).toMatchObject({
      integration: { status: "degraded" },
      command: { state: "unknown" },
    });

    const oversized = "x".repeat(32 * 1024 + 1);
    const fresh = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    expect(fresh.acceptOsc(marker("command-start", "command-1", oversized))).toEqual({
      handled: true,
      changed: true,
    });
    expect(fresh.snapshot.integration.status).toBe("degraded");
  });

  it("times out to degraded, recovers on ready, and resets unfinished commands on exit", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    expect(tracker.markInitializationTimedOut()).toBe(true);
    expect(tracker.snapshot.integration.status).toBe("degraded");

    tracker.acceptOsc(marker("ready", "", JSON.stringify(fullShellIntegrationCapabilities)));
    tracker.acceptOsc(marker("prompt", "", initialCwd));
    tracker.acceptOsc(marker("command-start", "command-1", "vim"));
    expect(tracker.snapshot.command.state).toBe("running");

    expect(tracker.markShellExited()).toBe(true);
    expect(tracker.snapshot.command).toEqual({ state: "unknown" });
  });

  it("keeps partial capability negotiation degraded with unknown command state", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    tracker.acceptOsc(
      marker(
        "ready",
        "",
        JSON.stringify({ ...fullShellIntegrationCapabilities, commandLine: false }),
      ),
    );
    tracker.acceptOsc(marker("command-start", "command-1", "echo ignored"));

    expect(tracker.snapshot.integration).toMatchObject({
      status: "degraded",
      capabilities: { commandLine: false },
    });
    expect(tracker.snapshot.command).toEqual({ state: "unknown" });
  });

  it("accepts trusted cwd updates from partial prompt integration", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    tracker.acceptOsc(
      marker(
        "ready",
        "",
        JSON.stringify({
          ...fullShellIntegrationCapabilities,
          commandStart: false,
          commandFinish: false,
          commandLine: false,
          exitCode: false,
        }),
      ),
    );

    tracker.acceptOsc(marker("prompt", "", "/workspace/partial"));
    expect(tracker.snapshot).toMatchObject({
      cwd: "/workspace/partial",
      integration: { status: "degraded" },
      command: { state: "unknown" },
    });
  });

  it("accepts a command start before the first prompt after negotiation", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    tracker.acceptOsc(marker("ready", "", JSON.stringify(fullShellIntegrationCapabilities)));

    expect(tracker.acceptOsc(marker("command-start", "command-1", "echo startup"))).toEqual({
      handled: true,
      changed: true,
    });
    expect(tracker.snapshot.command).toMatchObject({
      state: "running",
      commandId: "command-1",
    });
  });

  it("preserves signed native exit codes", () => {
    const tracker = new ShellIntegrationTracker({ nonce, cwd: initialCwd });
    tracker.acceptOsc(marker("ready", "", JSON.stringify(fullShellIntegrationCapabilities)));
    tracker.acceptOsc(marker("prompt", "", initialCwd));
    tracker.acceptOsc(marker("command-start", "command-1", "native-command"));
    tracker.acceptOsc(marker("command-finish", "command-1", "-1073741510"));

    expect(tracker.snapshot.command).toMatchObject({
      state: "idle",
      lastCommand: { exitCode: -1073741510 },
    });
  });
});

function marker(
  event: "ready" | "prompt" | "command-start" | "command-finish",
  commandId: string,
  payload: string,
): string {
  return encodeShellIntegrationMarker({ nonce, event, commandId, payload });
}
