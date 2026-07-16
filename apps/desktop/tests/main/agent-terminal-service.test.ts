import { describe, expect, it, vi } from "vitest";

import { createSessionId, type TerminalSessionSummary } from "@terminal/protocol";
import type { TerminalOperationManager, TerminalSessionManager } from "@terminal/session-core";

import { createAgentTerminalService } from "../../src/main/agent-terminal-service";

const sessionId = createSessionId("agent-session");

describe("agent terminal service defaults", () => {
  it("keeps omitted agent create requests headless", async () => {
    const harness = createHarness();

    await harness.service.create({ shell: "/bin/sh" });

    expect(harness.sessions.createSession).toHaveBeenCalledWith({
      shell: "/bin/sh",
      createdBy: "agent",
    });
    expect(harness.presentation.setPresentation).toHaveBeenCalledWith({
      sessionId,
      presentation: "headless",
    });
  });

  it("preserves explicit agent create presentation and unchanged attach semantics", async () => {
    const harness = createHarness();

    await harness.service.create({ presentation: "foreground" });
    await harness.service.attach({ sessionId });

    expect(harness.presentation.setPresentation).toHaveBeenCalledOnce();
    expect(harness.presentation.setPresentation).toHaveBeenCalledWith({
      sessionId,
      presentation: "foreground",
    });
  });

  it("preserves omitted and explicit TTY-run presentation contracts", async () => {
    const harness = createHarness();

    await harness.service.run({ input: "watch tests", tty: true });
    await harness.service.run({ input: "watch tests", tty: true, presentation: "headless" });
    await harness.service.run({ input: "echo done", tty: false });

    expect(harness.operations.run).toHaveBeenNthCalledWith(
      1,
      { input: "watch tests", tty: true },
      expect.any(Object),
    );
    expect(harness.operations.run).toHaveBeenNthCalledWith(
      2,
      { input: "watch tests", tty: true, presentation: "headless" },
      expect.any(Object),
    );
    expect(harness.operations.run).toHaveBeenNthCalledWith(
      3,
      { input: "echo done", tty: false },
      expect.any(Object),
    );
  });
});

function createHarness() {
  const summary = createSummary();
  const sessions = {
    listSessions: vi.fn(() => [summary]),
    getSession: vi.fn(() => summary),
    createSession: vi.fn(() => Promise.resolve(summary)),
    input: vi.fn(),
    resize: vi.fn(),
    scroll: vi.fn(),
    observe: vi.fn(),
    close: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    exportRecording: vi.fn(),
  };
  const operations = {
    run: vi.fn(() => Promise.resolve(undefined as never)),
    observe: vi.fn(),
    close: vi.fn(),
    sessionIdForOperation: vi.fn(),
  };
  const presentation = {
    setPresentation: vi.fn(() =>
      Promise.resolve({ state: "headless" as const, windowVisible: false, windowFocused: false }),
    ),
    closeView: vi.fn(),
    rendererReady: vi.fn(),
    acknowledge: vi.fn(),
    rendererUnavailable: vi.fn(),
  };
  const service = createAgentTerminalService(
    sessions as unknown as TerminalSessionManager,
    operations as unknown as TerminalOperationManager,
    presentation,
  );
  return { service, sessions, operations, presentation };
}

function createSummary(): TerminalSessionSummary {
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "agent",
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    observationVersion: 1,
    presentation: { state: "headless", windowVisible: false, windowFocused: false },
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
