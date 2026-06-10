import { describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import { createDefaultTerminalPolicy, type TerminalPolicy } from "@terminal/policy-engine";
import {
  createRendererCommand,
  createRequestId,
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
    listSessions?: TerminalCommandServices["sessionManager"]["listSessions"];
    getSession?: TerminalCommandServices["sessionManager"]["getSession"];
    readRecentOutput?: TerminalCommandServices["sessionManager"]["readRecentOutput"];
    setTitle?: TerminalCommandServices["sessionManager"]["setTitle"];
    reportBell?: TerminalCommandServices["sessionManager"]["reportBell"];
    requestScreenSnapshot?: TerminalCommandServices["requestScreenSnapshot"];
    rejectSnapshotResponse?: TerminalCommandServices["rejectSnapshotResponse"];
    getConfig?: () => TerminalConfig;
    policy?: TerminalPolicy;
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
      listSessions: overrides.listSessions ?? vi.fn(() => [snapshot]),
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
      setTitle:
        overrides.setTitle ??
        vi.fn<TerminalCommandServices["sessionManager"]["setTitle"]>(({ title }) => ({
          ...snapshot,
          title,
        })),
      reportBell:
        overrides.reportBell ??
        vi.fn<TerminalCommandServices["sessionManager"]["reportBell"]>(() => undefined),
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
    rejectSnapshotResponse: overrides.rejectSnapshotResponse ?? vi.fn(),
    getConfig: overrides.getConfig ?? defaultTerminalConfig,
    policy: overrides.policy ?? createDefaultTerminalPolicy(),
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
    await handleRendererCommandPayload(
      createRendererCommand("session.snapshot.unavailable", {
        requestId: createRequestId("snapshot-request-1"),
        sessionId,
        reason: "No terminal view owns this session.",
      }),
      base,
    );

    expect(snapshotResult).toMatchObject({
      ok: true,
      value: { viewport: [{ text: "hello agent" }] },
    });
    expect(waitResult).toMatchObject({ ok: true, value: { sessionId } });
    expect(base.rejectSnapshotResponse).toHaveBeenCalledWith(
      expect.any(String),
      sessionId,
      "No terminal view owns this session.",
    );
    expect(startRecording).toHaveBeenCalledWith({ sessionId });
    expect(exportRecording).toHaveBeenCalledWith({ sessionId });
  });

  it("handles session release and rejects removed workspace persistence commands", async () => {
    const sessionId = createSessionId("session-1");
    const releaseSession = vi.fn(() => Promise.resolve());
    const result = await handleRendererCommandPayload(
      createRendererCommand("session.release", { sessionId }),
      services({ releaseSession }),
    );

    expect(result).toMatchObject({ ok: true, value: null });
    expect(releaseSession).toHaveBeenCalledWith({ sessionId });

    const removed = await handleRendererCommandPayload(
      {
        type: "settings.saveWorkspace",
        requestId: createRequestId("removed-workspace-save"),
        payload: {
          workspace: {
            tabs: [{ cwd: "/tmp", shell: null }],
            activeTabIndex: 0,
          },
        },
      },
      services({ releaseSession }),
    );

    expect(removed).toMatchObject({
      ok: false,
      error: {
        type: "invalid_request",
        operation: "ipc",
      },
    });
  });

  it("routes renderer title and bell reports through session-core", async () => {
    const setTitle = vi.fn(() => ({ ...snapshot, title: "vim package.json" }));
    const reportBell = vi.fn();
    const base = services({ setTitle, reportBell });

    const titleResult = await handleRendererCommandPayload(
      createRendererCommand("session.setTitle", {
        sessionId: snapshot.sessionId,
        title: "vim package.json",
      }),
      base,
    );
    const bellResult = await handleRendererCommandPayload(
      createRendererCommand("session.bell", { sessionId: snapshot.sessionId }),
      base,
    );

    expect(titleResult).toMatchObject({ ok: true, value: { title: "vim package.json" } });
    expect(bellResult).toMatchObject({ ok: true, value: null });
    expect(setTitle).toHaveBeenCalledWith({
      sessionId: snapshot.sessionId,
      title: "vim package.json",
    });
    expect(reportBell).toHaveBeenCalledWith({ sessionId: snapshot.sessionId });
  });

  it("authorizes and audits renderer recording commands before recorder side effects", async () => {
    const sessionId = createSessionId("session-recording-policy");
    const logs = new MemoryLogSink();
    const logger = createAppLogger({
      isDevelopment: false,
      sink: logs,
      level: "debug",
      now: () => "2026-05-10T00:00:00.000Z",
    });
    const policy: TerminalPolicy = {
      authorize: vi.fn<TerminalPolicy["authorize"]>(() => ({
        type: "allow",
        decisionId: "decision-recording",
      })),
    };
    const base = {
      ...services({ policy }),
      logger,
    };
    const startRecording = vi.mocked(base.sessionManager.startRecording);
    const stopRecording = vi.mocked(base.sessionManager.stopRecording);
    const exportRecording = vi.mocked(base.sessionManager.exportRecording);

    await handleRendererCommandPayload(
      createRendererCommand("recording.start", { sessionId }),
      base,
    );
    await handleRendererCommandPayload(
      createRendererCommand("recording.stop", { sessionId }),
      base,
    );
    await handleRendererCommandPayload(
      createRendererCommand("recording.export", { sessionId }),
      base,
    );

    expect(policy.authorize).toHaveBeenCalledWith({
      actor: { kind: "human", local: true },
      operation: { type: "recording.start", sessionId, recordingKind: "start" },
    });
    expect(policy.authorize).toHaveBeenCalledWith({
      actor: { kind: "human", local: true },
      operation: { type: "recording.stop", sessionId, recordingKind: "stop" },
    });
    expect(policy.authorize).toHaveBeenCalledWith({
      actor: { kind: "human", local: true },
      operation: { type: "recording.export", sessionId, recordingKind: "export" },
    });
    expect(startRecording).toHaveBeenCalledWith({ sessionId });
    expect(stopRecording).toHaveBeenCalledWith({ sessionId });
    expect(exportRecording).toHaveBeenCalledWith({ sessionId });
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        component: "policy",
        event: "decision",
        commandType: "recording.start",
        decisionId: "decision-recording",
        outcome: "allow",
        origin: "human",
        sessionId,
      }),
    );
    expect(JSON.stringify(logs.records)).not.toContain("events");
  });

  it("stops renderer recording side effects when policy denies the request", async () => {
    const sessionId = createSessionId("session-recording-denied");
    const logs = new MemoryLogSink();
    const logger = createAppLogger({
      isDevelopment: false,
      sink: logs,
      level: "debug",
      now: () => "2026-05-10T00:00:00.000Z",
    });
    const policy: TerminalPolicy = {
      authorize: vi.fn<TerminalPolicy["authorize"]>(() => ({
        type: "deny",
        decisionId: "decision-denied",
        reason: {
          decisionId: "decision-denied",
          code: "remote_control_disabled",
          message: "Recording export is disabled by policy.",
          operation: "recording.export",
          sessionId,
        },
      })),
    };
    const base = {
      ...services({ policy }),
      logger,
    };
    const exportRecording = vi.mocked(base.sessionManager.exportRecording);

    const result = await handleRendererCommandPayload(
      createRendererCommand("recording.export", { sessionId }),
      base,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        type: "policy_denied",
        message: "Recording export is disabled by policy.",
        operation: "recording.export",
        sessionId,
        cause: "remote_control_disabled",
      },
    });
    expect(exportRecording).not.toHaveBeenCalled();
    expect(logs.records).toContainEqual(
      expect.objectContaining({
        component: "policy",
        event: "decision",
        commandType: "recording.export",
        decisionId: "decision-denied",
        outcome: "deny",
        denialCode: "remote_control_disabled",
        origin: "human",
        sessionId,
      }),
    );
  });

  it("lists current sessions for renderer startup reconciliation", async () => {
    const listSessions = vi.fn(() => [snapshot]);
    const result = await handleRendererCommandPayload(
      createRendererCommand("session.list", {}),
      services({ listSessions }),
    );

    expect(result).toMatchObject({ ok: true, value: [snapshot] });
    expect(listSessions).toHaveBeenCalledOnce();
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
