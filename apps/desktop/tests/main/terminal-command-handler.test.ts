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
    readRecentOutput?: TerminalCommandServices["sessionManager"]["readRecentOutput"];
    requestScreenSnapshot?: TerminalCommandServices["requestScreenSnapshot"];
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
      sendKey: vi.fn<TerminalCommandServices["sessionManager"]["sendKey"]>(() => Promise.resolve()),
      paste: vi.fn<TerminalCommandServices["sessionManager"]["paste"]>(() => Promise.resolve()),
      sendMouse: vi.fn<TerminalCommandServices["sessionManager"]["sendMouse"]>(() =>
        Promise.resolve(),
      ),
      interrupt: vi.fn<TerminalCommandServices["sessionManager"]["interrupt"]>(() =>
        Promise.resolve(),
      ),
      resize: vi.fn<TerminalCommandServices["sessionManager"]["resize"]>(() => Promise.resolve()),
      kill: vi.fn<TerminalCommandServices["sessionManager"]["kill"]>(() => Promise.resolve()),
      detachSession: vi.fn<TerminalCommandServices["sessionManager"]["detachSession"]>(() => ({
        ...snapshot,
        state: "detached",
      })),
      attachSession: vi.fn<TerminalCommandServices["sessionManager"]["attachSession"]>(() => ({
        ...snapshot,
        state: "running",
      })),
      getSession: overrides.getSession ?? vi.fn(() => snapshot),
      releaseSession:
        overrides.releaseSession ??
        vi.fn<TerminalCommandServices["sessionManager"]["releaseSession"]>(() => Promise.resolve()),
      readRecentOutput:
        overrides.readRecentOutput ??
        vi.fn<TerminalCommandServices["sessionManager"]["readRecentOutput"]>(() => ({
          sessionId: snapshot.sessionId,
          data: "",
          maxBytes: 100_000,
          capturedAt: "2026-05-10T00:00:00.000Z",
        })),
      getLastActivityAt: vi.fn<TerminalCommandServices["sessionManager"]["getLastActivityAt"]>(() =>
        Date.now(),
      ),
      startRecording: vi.fn<TerminalCommandServices["sessionManager"]["startRecording"]>(() =>
        Promise.resolve(),
      ),
      stopRecording: vi.fn<TerminalCommandServices["sessionManager"]["stopRecording"]>(() =>
        Promise.resolve(),
      ),
      exportRecording: vi.fn<TerminalCommandServices["sessionManager"]["exportRecording"]>(() =>
        Promise.resolve({
          schemaVersion: 1,
          sessionId: snapshot.sessionId,
          exportedAt: "2026-05-10T00:00:00.000Z",
          events: [],
        }),
      ),
    },
    requestScreenSnapshot:
      overrides.requestScreenSnapshot ??
      vi.fn<TerminalCommandServices["requestScreenSnapshot"]>(() =>
        Promise.resolve({
          sessionId: snapshot.sessionId,
          cols: 80,
          rows: 24,
          cursor: { x: 0, y: 0, visible: true },
          alternateScreen: false,
          title: null,
          viewport: [],
          capturedAt: "2026-05-10T00:00:00.000Z",
        }),
      ),
    resolveSnapshotResponse: vi.fn(),
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
          shell: { ...defaultTerminalConfig().shell, defaultProfile: "/bin/zsh" },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    expect(createSession).toHaveBeenCalledWith({ cols: 80, rows: 24, shell: "/bin/zsh" });
  });

  it("applies named shell profile launch metadata before creating sessions", async () => {
    const createSession = vi.fn(() => Promise.resolve(snapshot));
    await handleRendererCommandPayload(
      createRendererCommand("session.create", { cols: 80, rows: 24 }),
      services({
        createSession,
        getConfig: () => ({
          ...defaultTerminalConfig(),
          shell: {
            defaultProfile: "agent-profile",
            profiles: [
              {
                id: "agent-profile",
                name: "Agent profile",
                shell: "/bin/zsh",
                cwd: "/workspace",
                env: { TERM_PROGRAM: "procontext" },
              },
            ],
          },
        }),
      }),
    );

    expect(createSession).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      shell: "/bin/zsh",
      cwd: "/workspace",
      env: { TERM_PROGRAM: "procontext" },
    });
  });

  it("handles observation and recording commands", async () => {
    const sessionId = createSessionId("session-1");
    const requestScreenSnapshot = vi.fn<TerminalCommandServices["requestScreenSnapshot"]>(() =>
      Promise.resolve({
        sessionId,
        cols: 80,
        rows: 24,
        cursor: { x: 0, y: 0, visible: true },
        alternateScreen: false,
        title: null,
        viewport: [{ row: 0, text: "hello agent", wrapped: false }],
        capturedAt: "2026-05-10T00:00:00.000Z",
      }),
    );
    const base = services({ requestScreenSnapshot });
    const startRecording = vi.mocked(base.sessionManager.startRecording);
    const exportRecording = vi.mocked(base.sessionManager.exportRecording);

    const snapshotResult = await handleRendererCommandPayload(
      createRendererCommand("session.captureScreen", { sessionId, timeoutMs: 1000 }),
      base,
    );
    const waitResult = await handleRendererCommandPayload(
      createRendererCommand("session.waitForText", {
        sessionId,
        text: "hello agent",
        timeoutMs: 1000,
      }),
      base,
    );
    await handleRendererCommandPayload(
      createRendererCommand("recording.start", { sessionId }),
      base,
    );
    await handleRendererCommandPayload(
      createRendererCommand("recording.export", { sessionId }),
      base,
    );

    expect(snapshotResult).toMatchObject({
      ok: true,
      value: { viewport: [{ text: "hello agent" }] },
    });
    expect(waitResult).toMatchObject({ ok: true, value: { sessionId } });
    expect(startRecording).toHaveBeenCalledWith({ sessionId });
    expect(exportRecording).toHaveBeenCalledWith({ sessionId });
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
