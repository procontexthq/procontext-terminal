import { describe, expect, it } from "vitest";

import {
  TerminalApiError,
  createRendererCommandFailure,
  createRendererCommandSuccess,
  createRequestId,
  createSessionId,
  createTerminalError,
  isRendererSessionEvent,
  parseCreateSessionRequest,
  parseDetachSessionRequest,
  parseRendererCommand,
  parseRendererCommandResult,
  parseKillSessionRequest,
  parseReadRecentOutputRequest,
  parseReleaseSessionRequest,
  parseResizeSessionRequest,
  parseSaveWorkspaceRequest,
  parseSendKeyRequest,
  parseTerminalRecordingExport,
  parseTerminalScreenSnapshot,
  parseWaitForQuietRequest,
  parseWaitForTextRequest,
  parseTerminalConfig,
  parseWriteInputRequest,
  unwrapRendererCommandResult,
} from "../src/index";

describe("protocol schemas", () => {
  it("accepts valid session lifecycle requests", () => {
    const sessionId = createSessionId("session-1");

    expect(parseCreateSessionRequest({ cwd: "/tmp", cols: 80, rows: 24 })).toEqual({
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    expect(parseWriteInputRequest({ sessionId, data: "echo ok\r" })).toEqual({
      sessionId,
      data: "echo ok\r",
    });
    expect(parseResizeSessionRequest({ sessionId, cols: 100, rows: 30 })).toEqual({
      sessionId,
      cols: 100,
      rows: 30,
    });
    expect(parseKillSessionRequest({ sessionId })).toEqual({ sessionId });
  });

  it("rejects invalid request payloads", () => {
    expect(() => parseCreateSessionRequest({ cols: 0, rows: 24 })).toThrow();
    expect(() => parseWriteInputRequest({ sessionId: "", data: "x" })).toThrow();
    expect(() => parseResizeSessionRequest({ sessionId: "s", cols: 80, rows: -1 })).toThrow();
    expect(() => parseKillSessionRequest({ sessionId: "" })).toThrow();
  });

  it("validates terminal config schema version 2 workspace state", () => {
    expect(
      parseTerminalConfig({
        schemaVersion: 2,
        terminal: {
          fontFamily: "monospace",
          fontSize: 13,
          scrollback: 5000,
          theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        },
        shell: {
          defaultProfile: null,
          profiles: [
            {
              id: "zsh",
              name: "Zsh",
              shell: "/bin/zsh",
              cwd: null,
              env: { TERM: "xterm-256color" },
            },
          ],
        },
        workspace: {
          tabs: [{ cwd: "/tmp", shell: null }],
          activeTabIndex: 0,
        },
        recording: { state: "disabled", redactedPatterns: [] },
      }),
    ).toMatchObject({
      schemaVersion: 2,
      workspace: {
        tabs: [{ cwd: "/tmp", shell: null }],
        activeTabIndex: 0,
      },
    });

    expect(() =>
      parseTerminalConfig({
        schemaVersion: 2,
        terminal: {
          fontFamily: "monospace",
          fontSize: 13,
          scrollback: 5000,
          theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        },
        shell: { defaultProfile: null, profiles: [] },
        workspace: { tabs: [], activeTabIndex: 0 },
        recording: { state: "disabled", redactedPatterns: [] },
      }),
    ).toThrow();
    expect(() =>
      parseTerminalConfig({
        schemaVersion: 2,
        terminal: {
          fontFamily: "monospace",
          fontSize: 13,
          scrollback: 5000,
          theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        },
        shell: { defaultProfile: null, profiles: [] },
        workspace: { tabs: [{ cwd: null, shell: null }], activeTabIndex: 1 },
        recording: { state: "disabled", redactedPatterns: [] },
      }),
    ).toThrow();
  });

  it("validates observation, wait, input, and recording contracts", () => {
    const requestId = createRequestId("request-2");
    const sessionId = createSessionId("session-2");
    const snapshot = {
      sessionId,
      cols: 80,
      rows: 24,
      cursor: { x: 3, y: 2, visible: true },
      alternateScreen: false,
      title: "Terminal",
      viewport: [{ row: 0, text: "hello", wrapped: false }],
      capturedAt: "2026-05-11T00:00:00.000Z",
    };

    expect(parseTerminalScreenSnapshot(snapshot)).toEqual(snapshot);
    expect(parseReadRecentOutputRequest({ sessionId, maxBytes: 1024 })).toEqual({
      sessionId,
      maxBytes: 1024,
    });
    expect(parseWaitForTextRequest({ sessionId, text: "ready", timeoutMs: 1000 })).toEqual({
      sessionId,
      text: "ready",
      timeoutMs: 1000,
    });
    expect(parseWaitForQuietRequest({ sessionId, quietMs: 200, timeoutMs: 1000 })).toEqual({
      sessionId,
      quietMs: 200,
      timeoutMs: 1000,
    });
    expect(parseSendKeyRequest({ sessionId, key: "Ctrl+C", origin: "agent" })).toEqual({
      sessionId,
      key: "Ctrl+C",
      origin: "agent",
    });
    expect(parseDetachSessionRequest({ sessionId })).toEqual({ sessionId });
    expect(
      parseTerminalRecordingExport({
        schemaVersion: 1,
        sessionId,
        exportedAt: "2026-05-11T00:00:00.000Z",
        events: [{ type: "pty.output", sessionId, at: "2026-05-11T00:00:00.000Z", data: "x" }],
      }),
    ).toMatchObject({ schemaVersion: 1, sessionId });
    expect(
      parseRendererCommand({
        type: "session.snapshot.response",
        requestId,
        payload: { requestId, snapshot },
      }),
    ).toMatchObject({ type: "session.snapshot.response" });
    expect(
      isRendererSessionEvent({
        type: "session.snapshot.request",
        requestId,
        payload: { sessionId },
      }),
    ).toBe(true);
  });

  it("creates branded ids from explicit values", () => {
    expect(createSessionId("abc")).toBe("abc");
    expect(createRequestId("request-1")).toBe("request-1");
  });

  it("serializes domain errors and narrows renderer events", () => {
    const error = createTerminalError("session_not_found", "Missing session", {
      sessionId: createSessionId("missing"),
    });

    expect(error).toEqual({
      type: "session_not_found",
      message: "Missing session",
      sessionId: "missing",
    });
    expect(
      isRendererSessionEvent({
        type: "session.error",
        payload: error,
      }),
    ).toBe(true);
    expect(isRendererSessionEvent({ type: "unknown", payload: {} })).toBe(false);
  });

  it("validates renderer command envelopes and typed command results", () => {
    const requestId = createRequestId("request-1");
    const sessionId = createSessionId("session-1");

    expect(
      parseRendererCommand({
        type: "session.write",
        requestId,
        payload: { sessionId, data: "echo ok\r" },
      }),
    ).toEqual({
      type: "session.write",
      requestId,
      payload: { sessionId, data: "echo ok\r" },
    });
    expect(() =>
      parseRendererCommand({
        type: "session.resize",
        requestId,
        payload: { sessionId, cols: 0, rows: 24 },
      }),
    ).toThrow();
    expect(
      parseRendererCommand({
        type: "session.release",
        requestId,
        payload: { sessionId },
      }),
    ).toMatchObject({
      type: "session.release",
      payload: { sessionId },
    });
    expect(
      parseRendererCommand({
        type: "settings.saveWorkspace",
        requestId,
        payload: {
          workspace: {
            tabs: [{ cwd: "/tmp", shell: null }],
            activeTabIndex: 0,
          },
        },
      }),
    ).toMatchObject({
      type: "settings.saveWorkspace",
      payload: {
        workspace: {
          tabs: [{ cwd: "/tmp", shell: null }],
          activeTabIndex: 0,
        },
      },
    });
    expect(parseReleaseSessionRequest({ sessionId })).toEqual({ sessionId });
    expect(() => parseReleaseSessionRequest({ sessionId: "" })).toThrow();
    expect(
      parseSaveWorkspaceRequest({
        workspace: {
          tabs: [{ cwd: null, shell: null }],
          activeTabIndex: 0,
        },
      }),
    ).toEqual({
      workspace: {
        tabs: [{ cwd: null, shell: null }],
        activeTabIndex: 0,
      },
    });

    const success = createRendererCommandSuccess(requestId, null);
    expect(parseRendererCommandResult(success)).toEqual(success);
    expect(unwrapRendererCommandResult(success)).toBeNull();

    const terminalError = createTerminalError("session_not_found", "Missing", { sessionId });
    const failure = createRendererCommandFailure(requestId, terminalError);
    expect(parseRendererCommandResult(failure)).toEqual(failure);
    expect(() => unwrapRendererCommandResult(failure)).toThrow(TerminalApiError);
    try {
      unwrapRendererCommandResult(failure);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(TerminalApiError);
      expect((error as TerminalApiError).terminalError).toEqual(terminalError);
      expect((error as TerminalApiError).requestId).toBe(requestId);
    }
  });
});
