import { describe, expect, it, vi } from "vitest";

import {
  createRendererCommandSuccess,
  createRequestId,
  createSessionId,
  type RendererCommand,
} from "@terminal/protocol";

import { createRendererTerminalApi } from "../../src/preload/terminal-api";

describe("renderer terminal api", () => {
  it("exposes only the new terminal, view, recording, and settings helpers", async () => {
    const requestId = createRequestId("request-1");
    const invoke = vi.fn((command: RendererCommand) =>
      Promise.resolve(createRendererCommandSuccess(requestId, command.type)),
    );
    const api = createRendererTerminalApi({
      invoke,
      subscribe: vi.fn(),
      subscribeAppShortcut: vi.fn(),
    });
    const sessionId = createSessionId("session-1");

    await expect(api.listSessions()).resolves.toBe("session.list");
    await expect(api.getSession({ sessionId })).resolves.toBe("session.get");
    await expect(api.input({ sessionId, input: "\u0003" })).resolves.toBe("session.input");
    await expect(api.openView({ sessionId })).resolves.toBe("session.openView");
    await expect(api.reportViewport({ sessionId, viewportY: 4 })).resolves.toBe(
      "session.reportViewport",
    );
    await expect(api.closeView({ sessionId })).resolves.toBe("session.closeView");
    await expect(api.startRecording({ sessionId })).resolves.toBe("recording.start");
    await expect(api.saveUiTheme("gamer")).resolves.toBe("settings.saveUiTheme");

    expect(Object.keys(api)).not.toEqual(
      expect.arrayContaining([
        "sendText",
        "sendKey",
        "paste",
        "interrupt",
        "captureScreen",
        "readRecentOutput",
        "kill",
        "releaseSession",
      ]),
    );
  });

  it("filters terminal events and app shortcuts at the preload boundary", () => {
    let terminalSubscriber: (payload: unknown) => void = () => undefined;
    let shortcutSubscriber: (payload: unknown) => void = () => undefined;
    const api = createRendererTerminalApi({
      invoke: vi.fn(),
      subscribe: (handler) => {
        terminalSubscriber = handler;
        return vi.fn();
      },
      subscribeAppShortcut: (handler) => {
        shortcutSubscriber = handler;
        return vi.fn();
      },
    });
    const eventHandler = vi.fn();
    const shortcutHandler = vi.fn();
    api.onTerminalEvent(eventHandler);
    api.onAppShortcut(shortcutHandler);

    terminalSubscriber({
      type: "session.output",
      payload: { sessionId: createSessionId("session-1"), sequence: 1, data: "hello" },
    });
    terminalSubscriber({ type: "session.output", payload: { data: 42 } });
    shortcutSubscriber("nextTab");
    shortcutSubscriber("invalid");

    expect(eventHandler).toHaveBeenCalledOnce();
    expect(shortcutHandler).toHaveBeenCalledOnce();
    expect(shortcutHandler).toHaveBeenCalledWith("nextTab");
  });
});
