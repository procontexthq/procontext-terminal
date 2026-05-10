import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import {
  createRendererCommand,
  createSessionId,
  createTerminalError,
  type TerminalConfig,
  type TerminalSessionSnapshot,
} from "@terminal/protocol";

import {
  handleRendererCommandPayload,
  type TerminalCommandServices,
} from "../../src/main/terminal-command-handler";
import { MemoryLogSink, createAppLogger } from "../../src/main/logger";

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

function services(
  overrides: {
    createSession?: TerminalCommandServices["sessionManager"]["createSession"];
    releaseSession?: TerminalCommandServices["sessionManager"]["releaseSession"];
    getSession?: TerminalCommandServices["sessionManager"]["getSession"];
    getConfig?: () => TerminalConfig;
    saveConfig?: (config: TerminalConfig) => Promise<TerminalConfig>;
  } = {},
): TerminalCommandServices {
  return {
    sessionManager: {
      createSession:
        overrides.createSession ??
        vi.fn<TerminalCommandServices["sessionManager"]["createSession"]>(() =>
          Promise.resolve(snapshot),
        ),
      write: vi.fn<TerminalCommandServices["sessionManager"]["write"]>(() => Promise.resolve()),
      resize: vi.fn<TerminalCommandServices["sessionManager"]["resize"]>(() => Promise.resolve()),
      kill: vi.fn<TerminalCommandServices["sessionManager"]["kill"]>(() => Promise.resolve()),
      getSession: overrides.getSession ?? vi.fn(() => snapshot),
      releaseSession:
        overrides.releaseSession ??
        vi.fn<TerminalCommandServices["sessionManager"]["releaseSession"]>(() => Promise.resolve()),
    },
    getConfig: overrides.getConfig ?? defaultTerminalConfig,
    saveConfig:
      overrides.saveConfig ??
      ((config: TerminalConfig) => {
        return Promise.resolve(config);
      }),
  };
}

describe("terminal command handler", () => {
  it("returns typed success results and applies configured default shell", async () => {
    const createSession = vi.fn(() => Promise.resolve(snapshot));
    const result = await handleRendererCommandPayload(
      createRendererCommand("session.create", { cols: 80, rows: 24 }),
      services({
        createSession,
        getConfig: () => ({
          ...defaultTerminalConfig(),
          shell: { defaultProfile: "/bin/zsh" },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith({ cols: 80, rows: 24, shell: "/bin/zsh" });
  });

  it("handles session release and workspace persistence commands", async () => {
    const sessionId = createSessionId("session-1");
    const releaseSession = vi.fn(() => Promise.resolve());
    const saveConfig = vi.fn((config: TerminalConfig) => Promise.resolve(config));
    const result = await handleRendererCommandPayload(
      createRendererCommand("session.release", { sessionId }),
      services({ releaseSession, saveConfig }),
    );

    expect(result).toMatchObject({ ok: true, value: null });
    expect(releaseSession).toHaveBeenCalledWith({ sessionId });

    const saved = await handleRendererCommandPayload(
      createRendererCommand("settings.saveWorkspace", {
        workspace: {
          tabs: [{ cwd: "/tmp", shell: null }],
          activeTabIndex: 0,
        },
      }),
      services({ releaseSession, saveConfig }),
    );

    expect(saved).toMatchObject({
      ok: true,
      value: {
        schemaVersion: 2,
        workspace: {
          tabs: [{ cwd: "/tmp", shell: null }],
          activeTabIndex: 0,
        },
      },
    });
    expect(saveConfig).toHaveBeenCalledWith({
      ...defaultTerminalConfig(),
      workspace: {
        tabs: [{ cwd: "/tmp", shell: null }],
        activeTabIndex: 0,
      },
    });
  });

  it("returns typed error results for invalid payloads and thrown domain errors", async () => {
    const logs = new MemoryLogSink();
    const logger = createAppLogger({
      isDevelopment: false,
      sink: logs,
      level: "debug",
      now: () => "2026-05-10T00:00:00.000Z",
    });
    const invalid = await handleRendererCommandPayload(
      { type: "wat", payload: { token: "do-not-log" } },
      {
        ...services(),
        logger,
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
        ...services({
          getSession: vi.fn(() => {
            throw terminalError;
          }),
        }),
        logger,
      },
    );

    expect(failed).toMatchObject({
      ok: false,
      error: terminalError,
    });
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        component: "ipc",
        event: "command.invalid",
        errorType: "invalid_request",
      }),
    );
    const failedLog = logs.records.find((record) => record.event === "command.failed");
    expect(failedLog).toMatchObject({
      level: "warn",
      component: "ipc",
      commandType: "session.get",
      errorType: "session_not_found",
    });
    expect(typeof failedLog?.requestId).toBe("string");
    expect(JSON.stringify(logs.records)).not.toContain("do-not-log");
  });
});
