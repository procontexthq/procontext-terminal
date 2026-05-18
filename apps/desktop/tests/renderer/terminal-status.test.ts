import { describe, expect, it } from "vitest";

import type { RendererSessionEvent, SessionId, TerminalSessionSnapshot } from "@terminal/protocol";

import { nextTerminalStatus } from "../../src/renderer/terminal-status";

const sessionId = "session-1" as SessionId;

describe("terminal status", () => {
  it("does not regress terminal states when trailing output arrives after exit or failure", () => {
    const output: RendererSessionEvent = {
      type: "session.output",
      payload: { sessionId, data: "late output" },
    };

    expect(nextTerminalStatus("exited", output)).toBe("exited");
    expect(nextTerminalStatus("failed", output)).toBe("failed");
    expect(nextTerminalStatus("exiting", output)).toBe("exiting");
    expect(nextTerminalStatus("starting", output)).toBe("running");
  });

  it("derives status from lifecycle events", () => {
    const snapshot: TerminalSessionSnapshot = {
      sessionId,
      state: "running",
      shell: "/bin/sh",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      title: null,
      createdBy: "human",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    };

    expect(
      nextTerminalStatus("starting", {
        type: "session.created",
        payload: snapshot,
      }),
    ).toBe("running");
    expect(
      nextTerminalStatus("running", {
        type: "session.exited",
        payload: { sessionId, exitCode: 0, signal: null },
      }),
    ).toBe("exited");
    expect(
      nextTerminalStatus("running", {
        type: "session.detached",
        payload: { ...snapshot, state: "detached" },
      }),
    ).toBe("detached");
    expect(
      nextTerminalStatus("detached", {
        type: "session.attached",
        payload: snapshot,
      }),
    ).toBe("running");
    expect(
      nextTerminalStatus("running", {
        type: "session.error",
        payload: { type: "session_kill_failed", message: "kill failed", sessionId },
      }),
    ).toBe("failed");
  });
});
