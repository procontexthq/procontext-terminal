import { describe, expect, it, vi } from "vitest";

import { createSessionId, type TerminalSessionSummary } from "@terminal/protocol";

import { attachWindowCloseSessionCleanup } from "../../src/main/window-lifecycle";

type CloseEventHandler = (event: { preventDefault(): void }) => void;

class FakeWindow {
  readonly id = 7;
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });
  private closeHandler: CloseEventHandler | null = null;
  private destroyed = false;

  on(event: "close", handler: CloseEventHandler): void {
    this.closeHandler = handler;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  emitClose(): { prevented: boolean } {
    let prevented = false;
    this.closeHandler?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    return { prevented };
  }
}

const runningSession: TerminalSessionSummary = {
  sessionId: createSessionId("session-running"),
  lifecycle: "running",
  shell: "/bin/sh",
  cwd: "/tmp",
  dimensions: { cols: 80, rows: 24 },
  title: null,
  createdBy: "human",
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
  observationVersion: 1,
  presentation: {
    state: "background",
    windowVisible: true,
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

describe("window lifecycle", () => {
  it("keeps a closing window open until main-process session cleanup completes", async () => {
    const window = new FakeWindow();
    const shutdown = vi.fn(() => Promise.resolve({ terminated: 1, timedOut: 0 }));

    attachWindowCloseSessionCleanup({
      window,
      sessionManager: {
        listSessions: () => [runningSession],
        shutdown,
      },
      logger: fakeLogger(),
      getIsAppQuitting: () => false,
      shutdownTimeoutMs: 1500,
    });

    const closeResult = window.emitClose();

    expect(closeResult.prevented).toBe(true);
    expect(shutdown).toHaveBeenCalledWith({ timeoutMs: 1500 });
    expect(window.destroy).not.toHaveBeenCalled();

    await waitForMicrotasks();

    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it("does not intercept window close during app quit because app shutdown owns cleanup", () => {
    const window = new FakeWindow();
    const shutdown = vi.fn(() => Promise.resolve({ terminated: 1, timedOut: 0 }));

    attachWindowCloseSessionCleanup({
      window,
      sessionManager: {
        listSessions: () => [runningSession],
        shutdown,
      },
      logger: fakeLogger(),
      getIsAppQuitting: () => true,
      shutdownTimeoutMs: 1500,
    });

    const closeResult = window.emitClose();

    expect(closeResult.prevented).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expect(window.destroy).not.toHaveBeenCalled();
  });

  it("keeps the window visible when bounded cleanup times out", async () => {
    const window = new FakeWindow();
    const logger = fakeLogger();
    const shutdown = vi.fn(() => Promise.resolve({ terminated: 0, timedOut: 1 }));

    attachWindowCloseSessionCleanup({
      window,
      sessionManager: {
        listSessions: () => [runningSession],
        shutdown,
      },
      logger,
      getIsAppQuitting: () => false,
      shutdownTimeoutMs: 1500,
    });

    const closeResult = window.emitClose();
    await waitForMicrotasks();

    expect(closeResult.prevented).toBe(true);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "window",
      "close_session_cleanup_timed_out",
      expect.objectContaining({ timedOut: 1, windowId: 7 }),
    );
  });

  it("does not start duplicate cleanup for repeated close events", () => {
    const window = new FakeWindow();
    const shutdown = vi.fn(
      () => new Promise<{ terminated: number; timedOut: number }>(() => undefined),
    );

    attachWindowCloseSessionCleanup({
      window,
      sessionManager: {
        listSessions: () => [runningSession],
        shutdown,
      },
      logger: fakeLogger(),
      getIsAppQuitting: () => false,
      shutdownTimeoutMs: 1500,
    });

    expect(window.emitClose().prevented).toBe(true);
    expect(window.emitClose().prevented).toBe(true);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("allows close immediately when there are no session records", () => {
    const window = new FakeWindow();
    const shutdown = vi.fn(() => Promise.resolve({ terminated: 0, timedOut: 0 }));

    attachWindowCloseSessionCleanup({
      window,
      sessionManager: {
        listSessions: () => [],
        shutdown,
      },
      logger: fakeLogger(),
      getIsAppQuitting: () => false,
      shutdownTimeoutMs: 1500,
    });

    const closeResult = window.emitClose();

    expect(closeResult.prevented).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
  });
});

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function waitForMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
