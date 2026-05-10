import { describe, expect, it, vi } from "vitest";

import {
  createRendererCommandSuccess,
  createRequestId,
  createSessionId,
  type RendererCommand,
} from "@terminal/protocol";

import { createRendererTerminalApi } from "../../src/preload/terminal-api";

describe("renderer terminal api", () => {
  it("exposes releaseSession and saveWorkspace command helpers", async () => {
    const requestId = createRequestId("request-1");
    const invoke = vi.fn((command: RendererCommand) =>
      Promise.resolve(createRendererCommandSuccess(requestId, command.type)),
    );
    const api = createRendererTerminalApi({
      invoke,
      subscribe: vi.fn(),
    });
    const sessionId = createSessionId("session-1");

    await expect(api.releaseSession({ sessionId })).resolves.toBe("session.release");
    await expect(
      api.saveWorkspace({
        tabs: [{ cwd: "/tmp", shell: null }],
        activeTabIndex: 0,
      }),
    ).resolves.toBe("settings.saveWorkspace");

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.release",
        payload: { sessionId },
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settings.saveWorkspace",
        payload: {
          workspace: {
            tabs: [{ cwd: "/tmp", shell: null }],
            activeTabIndex: 0,
          },
        },
      }),
    );
  });
});
