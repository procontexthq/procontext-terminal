import { describe, expect, it, vi } from "vitest";

import {
  createRequestId,
  createSessionId,
  type RendererPresentationCommand,
  type TerminalPresentation,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  createTerminalPresentationController,
  type PresentationWindow,
  type TerminalPresentationController,
} from "../../src/main/presentation-controller";
import { createTerminalPresentationRegistry } from "../../src/main/presentation-registry";

const sessionId = createSessionId("session-presentation");

describe("terminal presentation controller", () => {
  it("opens a background view without focusing its window", async () => {
    const fixture = createFixture();
    fixture.acknowledgeCommands();

    await expect(
      fixture.controller.setPresentation({ sessionId, presentation: "background" }),
    ).resolves.toEqual({
      state: "background",
      windowVisible: true,
      windowFocused: false,
    });

    expect(fixture.actions()).toEqual(["open"]);
    expect(fixture.window.focus).not.toHaveBeenCalled();
    expect(fixture.sessions.setPresentation).toHaveBeenLastCalledWith(sessionId, {
      state: "background",
      windowVisible: true,
      windowFocused: false,
    });

    await fixture.controller.setPresentation({ sessionId, presentation: "background" });
    expect(fixture.actions()).toEqual(["open"]);
  });

  it("opens and focuses a foreground view after correlated acknowledgements", async () => {
    const fixture = createFixture();
    fixture.acknowledgeCommands();

    await expect(
      fixture.controller.setPresentation({ sessionId, presentation: "foreground" }),
    ).resolves.toEqual({
      state: "foreground",
      windowVisible: true,
      windowFocused: true,
    });

    expect(fixture.actions()).toEqual(["open", "focus"]);
    expect(fixture.window.show).toHaveBeenCalledOnce();
    expect(fixture.window.focus).toHaveBeenCalledOnce();
  });

  it("hides an existing view without closing its PTY session", async () => {
    const fixture = createFixture();
    fixture.registry.open(sessionId, fixture.window.webContents.id);
    fixture.sessions.presentation = {
      state: "background",
      windowVisible: true,
      windowFocused: false,
    };
    fixture.acknowledgeCommands();

    await expect(
      fixture.controller.setPresentation({ sessionId, presentation: "headless" }),
    ).resolves.toEqual({
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });

    expect(fixture.actions()).toEqual(["hide"]);
    expect(fixture.sessions.close).not.toHaveBeenCalled();

    await fixture.controller.setPresentation({ sessionId, presentation: "headless" });
    expect(fixture.actions()).toEqual(["hide"]);
  });

  it("finishes presentation transitions in request order for the same session", async () => {
    const fixture = createFixture();
    fixture.window.onSend = (command) => {
      if (command.action === "open") return;
      if (command.action === "hide") {
        fixture.registry.close(command.sessionId, fixture.window.webContents.id);
      }
      queueMicrotask(() => {
        fixture.controller.acknowledge(fixture.window.webContents.id, {
          ...command,
          status: "completed",
        });
      });
    };

    const foreground = fixture.controller.setPresentation({
      sessionId,
      presentation: "foreground",
    });
    await vi.waitFor(() => expect(fixture.actions()).toEqual(["open"]));

    const headless = fixture.controller.setPresentation({
      sessionId,
      presentation: "headless",
    });
    const openCommand = fixture.commands()[0];
    if (!openCommand) throw new Error("Expected the foreground transition to request a view.");
    fixture.registry.open(sessionId, fixture.window.webContents.id);
    fixture.controller.acknowledge(fixture.window.webContents.id, {
      ...openCommand,
      status: "completed",
    });

    await expect(foreground).resolves.toMatchObject({ state: "foreground" });
    await expect(headless).resolves.toEqual({
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });
    expect(fixture.actions()).toEqual(["open", "focus", "hide"]);
    expect(fixture.sessions.presentation).toEqual({
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });
  });

  it("keeps the session usable and marks presentation unavailable when no renderer can open", async () => {
    const fixture = createFixture({
      windows: [],
      createWindow: () => Promise.reject(new Error("DISPLAY unavailable")),
    });

    await expect(
      fixture.controller.setPresentation({ sessionId, presentation: "foreground" }),
    ).resolves.toEqual({
      state: "unavailable",
      windowVisible: false,
      windowFocused: false,
    });

    expect(fixture.sessions.getSession({ sessionId }).lifecycle).toBe("running");
    expect(fixture.sessions.setPresentation).toHaveBeenLastCalledWith(sessionId, {
      state: "unavailable",
      windowVisible: false,
      windowFocused: false,
    });
  });

  it("rejects a pending correlated command when its renderer disappears", async () => {
    const fixture = createFixture();
    const pending = fixture.controller.setPresentation({
      sessionId,
      presentation: "background",
    });
    await vi.waitFor(() => expect(fixture.actions()).toEqual(["open"]));

    fixture.controller.rendererUnavailable(fixture.window.webContents.id);

    await expect(pending).resolves.toMatchObject({ state: "unavailable" });
  });

  it("times out renderer readiness without losing the running session", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture({ rendererReady: false });
      const pending = fixture.controller.setPresentation({
        sessionId,
        presentation: "background",
      });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ state: "unavailable" });
      expect(fixture.actions()).toEqual([]);
      expect(fixture.sessions.getSession({ sessionId }).lifecycle).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out an unacknowledged renderer command", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createFixture();
      const pending = fixture.controller.setPresentation({
        sessionId,
        presentation: "background",
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(fixture.actions()).toEqual(["open"]);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ state: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to unavailable when the renderer rejects focus", async () => {
    const fixture = createFixture();
    fixture.acknowledgeCommands("focus");

    await expect(
      fixture.controller.setPresentation({ sessionId, presentation: "foreground" }),
    ).resolves.toMatchObject({ state: "unavailable" });

    expect(fixture.actions()).toEqual(["open", "focus"]);
    expect(fixture.sessions.getSession({ sessionId }).lifecycle).toBe("running");
  });
});

function createFixture(
  options: {
    windows?: PresentationWindow[];
    createWindow?: () => Promise<PresentationWindow>;
    rendererReady?: boolean;
  } = {},
) {
  const registry = createTerminalPresentationRegistry();
  const session = createSummary();
  const sessions = {
    presentation: session.presentation,
    getSession: vi.fn((request: { sessionId: typeof sessionId }) => {
      expect(request.sessionId).toBe(sessionId);
      return { ...session, presentation: sessions.presentation };
    }),
    setPresentation: vi.fn((_sessionId, presentation: TerminalPresentation) => {
      sessions.presentation = presentation;
      return Promise.resolve();
    }),
    close: vi.fn(),
  };
  const sent: RendererPresentationCommand[] = [];
  const window = createWindow(sent);
  const windows = options.windows ?? [window];
  const controller: TerminalPresentationController = createTerminalPresentationController({
    sessions,
    registry,
    getWindows: () => windows,
    createWindow: options.createWindow ?? (() => Promise.resolve(window)),
    logger: { info: vi.fn(), warn: vi.fn() },
    commandTimeoutMs: 100,
    createCommandId: () => createRequestId(`presentation-${sent.length + 1}`),
  });
  if (options.rendererReady ?? true) {
    controller.rendererReady(window.webContents.id);
  }

  return {
    controller,
    registry,
    sessions,
    window,
    actions: () => sent.map((command) => command.action),
    commands: () => [...sent],
    acknowledgeCommands(failedAction?: RendererPresentationCommand["action"]) {
      window.onSend = (command) => {
        if (command.action === "open") {
          registry.open(command.sessionId, window.webContents.id);
        } else if (command.action === "hide" || command.action === "close") {
          registry.close(command.sessionId, window.webContents.id);
        }
        queueMicrotask(() => {
          controller.acknowledge(window.webContents.id, {
            ...command,
            status: command.action === failedAction ? "failed" : "completed",
            ...(command.action === failedAction
              ? { message: `Renderer rejected ${command.action}.` }
              : {}),
          });
        });
      };
    },
  };
}

type TestPresentationWindow = PresentationWindow & {
  onSend?: (command: RendererPresentationCommand) => void;
};

function createWindow(sent: RendererPresentationCommand[]): TestPresentationWindow {
  let visible = true;
  let focused = false;
  const window: TestPresentationWindow = {
    id: 7,
    webContents: {
      id: 11,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn((_channel: string, event: { payload: RendererPresentationCommand }) => {
        sent.push(event.payload);
        window.onSend?.(event.payload);
      }),
    },
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focused,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(() => {
      focused = true;
    }),
  };
  return window;
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
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
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
