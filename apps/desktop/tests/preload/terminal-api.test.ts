import { describe, expect, it, vi } from "vitest";

import {
  createRendererCommandFailure,
  createRendererCommandSuccess,
  createSessionId,
  createTerminalError,
  type RendererCommand,
  type RendererSessionEvent,
} from "@terminal/protocol";

import { createRendererTerminalApi } from "../../src/preload/terminal-api";

describe("preload terminal api", () => {
  it("unwraps successful command results and rejects typed terminal errors", async () => {
    const sessionId = createSessionId("session-1");
    const terminalError = createTerminalError("session_not_found", "Missing", { sessionId });
    const invoke = vi
      .fn<(command: RendererCommand) => Promise<unknown>>()
      .mockImplementationOnce((command) =>
        Promise.resolve(
          createRendererCommandSuccess(command.requestId, {
            sessionId,
            state: "running",
            shell: "/bin/sh",
            cwd: "/tmp",
            cols: 80,
            rows: 24,
            title: null,
            createdBy: "human",
            createdAt: "2026-05-10T00:00:00.000Z",
            updatedAt: "2026-05-10T00:00:00.000Z",
          }),
        ),
      )
      .mockImplementationOnce((command) =>
        Promise.resolve(createRendererCommandFailure(command.requestId, terminalError)),
      );

    const api = createRendererTerminalApi({
      invoke,
      subscribe: () => () => undefined,
    });

    await expect(api.createSession({ cols: 80, rows: 24 })).resolves.toMatchObject({
      sessionId,
    });
    await expect(api.getSession({ sessionId })).rejects.toMatchObject({
      terminalError,
    });
  });

  it("filters session events and cleans up subscriptions", () => {
    const state: { eventHandler?: (payload: unknown) => void } = {};
    const cleanup = vi.fn();
    const sessionId = createSessionId("session-1");
    const api = createRendererTerminalApi({
      invoke: vi.fn(),
      subscribe: (handler) => {
        state.eventHandler = handler;
        return cleanup;
      },
    });
    const handler = vi.fn();
    const unsubscribe = api.onSessionEvent(sessionId, handler);
    const event: RendererSessionEvent = {
      type: "session.output",
      payload: { sessionId, data: "ok" },
    };

    const nextHandler = state.eventHandler;
    if (!nextHandler) {
      throw new Error("Missing event handler.");
    }
    nextHandler(event);
    unsubscribe();

    expect(handler).toHaveBeenCalledWith(event);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
