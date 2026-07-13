import { describe, expect, it } from "vitest";

import {
  createSessionId,
  type RendererSessionEvent,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import { nextTerminalStatus } from "../../src/renderer/terminal-status";

const sessionId = createSessionId("session-1");

describe("terminal status", () => {
  it("does not regress terminal states when trailing output arrives", () => {
    const output: RendererSessionEvent = {
      type: "session.output",
      payload: { sessionId, sequence: 4, data: "late output" },
    };

    expect(nextTerminalStatus("exited", output)).toBe("exited");
    expect(nextTerminalStatus("failed", output)).toBe("failed");
    expect(nextTerminalStatus("exiting", output)).toBe("exiting");
    expect(nextTerminalStatus("starting", output)).toBe("running");
  });

  it("derives state exclusively from canonical session updates", () => {
    const summary = createSummary();

    expect(
      nextTerminalStatus("starting", {
        type: "session.updated",
        payload: summary,
      }),
    ).toBe("running");
    expect(
      nextTerminalStatus("running", {
        type: "session.updated",
        payload: { ...summary, lifecycle: "exited" },
      }),
    ).toBe("exited");
    expect(
      nextTerminalStatus("running", {
        type: "session.error",
        payload: { type: "recording_failed", message: "recording failed", sessionId },
      }),
    ).toBe("running");
  });
});

function createSummary(): TerminalSessionSummary {
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "human",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}
