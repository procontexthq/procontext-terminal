import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import {
  createRendererCommand,
  createSessionId,
  createTerminalError,
  type TerminalSessionSnapshot,
} from "@terminal/protocol";

import { handleRendererCommandPayload } from "../../src/main/terminal-command-handler";

const snapshot: TerminalSessionSnapshot = {
  sessionId: createSessionId("session-1"),
  state: "running",
  shell: "/bin/sh",
  cwd: "/tmp",
  cols: 80,
  rows: 24,
  title: null,
  createdBy: "human",
  createdAt: "2026-05-10T00:00:00.000Z",
  updatedAt: "2026-05-10T00:00:00.000Z",
};

describe("terminal command handler", () => {
  it("returns typed success results and applies configured default shell", async () => {
    const createSession = vi.fn(() => Promise.resolve(snapshot));
    const result = await handleRendererCommandPayload(
      createRendererCommand("session.create", { cols: 80, rows: 24 }),
      {
        sessionManager: {
          createSession,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          getSession: vi.fn(),
        },
        getConfig: () => ({
          ...defaultTerminalConfig(),
          shell: { defaultProfile: "/bin/zsh" },
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith({ cols: 80, rows: 24, shell: "/bin/zsh" });
  });

  it("returns typed error results for invalid payloads and thrown domain errors", async () => {
    const invalid = await handleRendererCommandPayload(
      { type: "wat" },
      {
        sessionManager: {
          createSession: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          getSession: vi.fn(),
        },
        getConfig: defaultTerminalConfig,
      },
    );
    expect(invalid).toMatchObject({
      ok: false,
      error: { type: "invalid_request" },
    });

    const terminalError = createTerminalError("session_not_found", "Missing", {
      sessionId: createSessionId("missing"),
    });
    const failed = await handleRendererCommandPayload(
      createRendererCommand("session.get", { sessionId: createSessionId("missing") }),
      {
        sessionManager: {
          createSession: vi.fn(),
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          getSession: vi.fn(() => {
            throw terminalError;
          }),
        },
        getConfig: defaultTerminalConfig,
      },
    );

    expect(failed).toMatchObject({
      ok: false,
      error: terminalError,
    });
  });
});
