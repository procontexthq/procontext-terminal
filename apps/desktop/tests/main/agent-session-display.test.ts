import { describe, expect, it, vi } from "vitest";

import { createSessionId, type TerminalSessionSnapshot } from "@terminal/protocol";

import { createAgentSessionDisplayService } from "../../src/main/agent-session-display";

const snapshot: TerminalSessionSnapshot = {
  sessionId: createSessionId("session-agent"),
  state: "detached",
  shell: "/bin/sh",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  title: null,
  createdBy: "agent",
  createdAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z",
};

describe("agent session display service", () => {
  it("creates a renderer window before displaying an agent-created session", async () => {
    const windows: Array<{ isDestroyed?: () => boolean }> = [];
    const createWindow = vi.fn(() => {
      windows.push({});
      return Promise.resolve();
    });

    const service = createAgentSessionDisplayService({
      getWindows: () => windows,
      createWindow,
      logger: fakeLogger(),
    });

    await expect(service.displaySession(snapshot)).resolves.toBeUndefined();

    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("uses an existing renderer window without creating another one", async () => {
    const createWindow = vi.fn(() => Promise.resolve());

    const service = createAgentSessionDisplayService({
      getWindows: () => [{}],
      createWindow,
      logger: fakeLogger(),
    });

    await service.displaySession(snapshot);

    expect(createWindow).not.toHaveBeenCalled();
  });

  it("does not treat destroyed or crashed renderer web contents as usable", async () => {
    const windows = [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => true,
        },
      },
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => true,
          isCrashed: () => false,
        },
      },
    ];
    const createWindow = vi.fn(() => {
      windows.push({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => false,
        },
      });
      return Promise.resolve();
    });

    const service = createAgentSessionDisplayService({
      getWindows: () => windows,
      createWindow,
      logger: fakeLogger(),
    });

    await service.displaySession(snapshot);

    expect(createWindow).toHaveBeenCalledOnce();
  });

  it("reports display unavailable when window creation leaves only unusable renderers", async () => {
    const service = createAgentSessionDisplayService({
      getWindows: () => [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            isCrashed: () => true,
          },
        },
      ],
      createWindow: vi.fn(() => Promise.resolve()),
      logger: fakeLogger(),
    });

    await expect(service.displaySession(snapshot)).rejects.toMatchObject({
      type: "observation_unavailable",
      sessionId: snapshot.sessionId,
      operation: "terminal.display",
      cause: "Window creation completed without a usable renderer window.",
    });
  });

  it("throws a structured observation error when a renderer window cannot be created", async () => {
    const logger = fakeLogger();
    const service = createAgentSessionDisplayService({
      getWindows: () => [],
      createWindow: vi.fn(() => Promise.reject(new Error("DISPLAY is not set"))),
      logger,
    });

    await expect(service.displaySession(snapshot)).rejects.toMatchObject({
      type: "observation_unavailable",
      sessionId: snapshot.sessionId,
      operation: "terminal.display",
      cause: "DISPLAY is not set",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "agent",
      "display_window_unavailable",
      expect.objectContaining({
        sessionId: snapshot.sessionId,
        errorType: "observation_unavailable",
      }),
    );
  });

  it("times out renderer window creation instead of hanging agent create", async () => {
    vi.useFakeTimers();
    try {
      const service = createAgentSessionDisplayService({
        getWindows: () => [],
        createWindow: vi.fn(() => new Promise(() => undefined)),
        logger: fakeLogger(),
        windowCreationTimeoutMs: 100,
      });

      const result = expect(service.displaySession(snapshot)).rejects.toMatchObject({
        type: "observation_unavailable",
        sessionId: snapshot.sessionId,
        operation: "terminal.display",
        cause: "Timed out after 100ms while creating a renderer window.",
      });
      await vi.advanceTimersByTimeAsync(100);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("deduplicates concurrent renderer window creation attempts", async () => {
    const windows: Array<{ isDestroyed?: () => boolean }> = [];
    let resolveCreateWindow = (): void => {
      throw new Error("Window creation was not started.");
    };
    const createWindow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCreateWindow = () => {
            windows.push({});
            resolve();
          };
        }),
    );
    const service = createAgentSessionDisplayService({
      getWindows: () => windows,
      createWindow,
      logger: fakeLogger(),
    });

    const first = service.displaySession(snapshot);
    const second = service.displaySession({ ...snapshot, sessionId: createSessionId("session-2") });
    resolveCreateWindow?.();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    expect(createWindow).toHaveBeenCalledOnce();
  });
});

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
