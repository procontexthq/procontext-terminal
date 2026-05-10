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
  parseRendererCommand,
  parseRendererCommandResult,
  parseKillSessionRequest,
  parseResizeSessionRequest,
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
