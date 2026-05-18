import { describe, expect, it, vi } from "vitest";

import {
  createRendererCommandSuccess,
  createRequestId,
  createSessionId,
  type RendererCommand,
} from "@terminal/protocol";

import { createRendererTerminalApi } from "../../src/preload/terminal-api";

describe("renderer terminal api", () => {
  it("exposes lifecycle, observation, recording, and settings command helpers", async () => {
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
    await expect(api.sendKey({ sessionId, key: "Ctrl+C", origin: "agent" })).resolves.toBe(
      "session.sendKey",
    );
    await expect(api.detachSession({ sessionId })).resolves.toBe("session.detach");
    await expect(api.attachSession({ sessionId })).resolves.toBe("session.attach");
    await expect(api.captureScreen({ sessionId, timeoutMs: 1000 })).resolves.toBe(
      "session.captureScreen",
    );
    await expect(api.startRecording({ sessionId })).resolves.toBe("recording.start");
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
