import { describe, expect, it } from "vitest";

import {
  TERMINAL_PROTOCOL_VERSION,
  TerminalApiError,
  createAgentCommand,
  createAgentCommandFailure,
  createAgentCommandSuccess,
  createOperationId,
  createRendererCommand,
  createRendererCommandFailure,
  createRendererCommandSuccess,
  createRequestId,
  createSessionId,
  createTerminalError,
  isRendererSessionEvent,
  parseAgentCommand,
  parseAgentCommandResult,
  parseAgentGatewayDescriptor,
  parseCreateTerminalRequest,
  parseObserveTerminalRequest,
  parseObserveCapturedOperationRequest,
  parseRendererCommand,
  parseRendererCommandResult,
  parseScrollTerminalRequest,
  parseRunTerminalRequest,
  parseTerminalConfig,
  parseTerminalInputRequest,
  parseTerminalObservation,
  parseTerminalRecordingExport,
  unwrapRendererCommandResult,
} from "../src/index";

describe("terminal protocol", () => {
  it("validates the foundation session requests", () => {
    const sessionId = createSessionId("session-1");

    expect(parseCreateTerminalRequest({ cwd: "/tmp", presentation: "foreground" })).toEqual({
      cwd: "/tmp",
      presentation: "foreground",
    });
    expect(parseTerminalInputRequest({ sessionId, input: "echo ok\r" })).toEqual({
      sessionId,
      input: "echo ok\r",
    });
    expect(
      parseScrollTerminalRequest({
        sessionId,
        scroll: { type: "page", direction: "up" },
      }),
    ).toEqual({
      sessionId,
      scroll: { type: "page", direction: "up" },
    });
    expect(parseObserveTerminalRequest({ sessionId, afterVersion: 3, timeoutMs: 1_000 })).toEqual({
      sessionId,
      afterVersion: 3,
      timeoutMs: 1_000,
    });

    expect(() => parseCreateTerminalRequest({ cols: 0 })).toThrow();
    expect(() => parseTerminalInputRequest({ sessionId: "", input: "x" })).toThrow();
    expect(() =>
      parseScrollTerminalRequest({ sessionId, scroll: { type: "lines", delta: 0 } }),
    ).toThrow();
    expect(() => parseObserveTerminalRequest({ sessionId, timeoutMs: 0 })).toThrow();
  });

  it("validates canonical observations", () => {
    const sessionId = createSessionId("session-observation");
    const observation = {
      sessionId,
      version: 7,
      lifecycle: "running",
      cwd: "/workspace",
      dimensions: { cols: 80, rows: 24 },
      viewport: {
        rows: [{ row: 0, text: "hello", wrapped: false }],
        offsetFromBottom: 0,
        atTop: true,
        atBottom: true,
        scrollbackRows: 0,
        unseenRows: 0,
      },
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      title: "Terminal",
      shellIntegration: {
        status: "unavailable",
        capabilities: {
          prompt: false,
          commandStart: false,
          commandFinish: false,
          commandLine: false,
          exitCode: false,
          cwd: false,
        },
      },
      command: { state: "unknown" },
      presentation: {
        state: "headless",
        windowVisible: false,
        windowFocused: false,
      },
      recording: { state: "inactive" },
    } as const;

    expect(parseTerminalObservation(observation)).toEqual(observation);
    expect(() => parseTerminalObservation({ ...observation, cwd: "" })).toThrow();
    expect(() => parseTerminalObservation({ ...observation, version: -1 })).toThrow();
    expect(() =>
      parseTerminalObservation({
        ...observation,
        viewport: { ...observation.viewport, offsetFromBottom: -1 },
      }),
    ).toThrow();
  });

  it("accepts only the new agent command surface and fixed protocol version", () => {
    const requestId = createRequestId("request-agent");
    const sessionId = createSessionId("session-agent");

    expect(
      parseAgentCommand({
        type: "agent.authenticate",
        requestId,
        payload: { token: "token", protocolVersion: TERMINAL_PROTOCOL_VERSION },
      }),
    ).toMatchObject({
      type: "agent.authenticate",
      payload: { protocolVersion: TERMINAL_PROTOCOL_VERSION },
    });
    expect(createAgentCommand("terminal.input", { sessionId, input: "\u0003" }, requestId)).toEqual(
      {
        type: "terminal.input",
        requestId,
        payload: { sessionId, input: "\u0003" },
      },
    );
    expect(
      createAgentCommand(
        "terminal.observe",
        { sessionId, afterVersion: 4, timeoutMs: 500 },
        requestId,
      ),
    ).toMatchObject({ type: "terminal.observe" });
    expect(createAgentCommand("terminal.recording.export", { sessionId }, requestId)).toMatchObject(
      { type: "terminal.recording.export" },
    );
    expect(
      createAgentCommand("terminal.attach", { sessionId, presentation: "unchanged" }, requestId),
    ).toMatchObject({
      type: "terminal.attach",
      payload: { sessionId, presentation: "unchanged" },
    });

    expect(() =>
      parseAgentCommand({
        type: "agent.authenticate",
        requestId,
        payload: { token: "token", protocolVersion: 2 },
      }),
    ).toThrow();
    expect(() =>
      parseAgentCommand({
        type: "terminal.sendText",
        requestId,
        payload: { sessionId, text: "echo old\r" },
      }),
    ).toThrow();
  });

  it("validates one-shot run and operation-target requests", () => {
    const requestId = createRequestId("request-operation");
    const operationId = createOperationId("operation-1");
    const sessionId = createSessionId("session-presentation");

    expect(
      parseRunTerminalRequest({
        input: "pnpm test",
        tty: false,
        timeoutMs: 10_000,
        maxOutputBytesPerStream: 2 * 1024 * 1024,
      }),
    ).toEqual({
      input: "pnpm test",
      tty: false,
      timeoutMs: 10_000,
      maxOutputBytesPerStream: 2 * 1024 * 1024,
    });
    expect(
      createAgentCommand(
        "terminal.run",
        { input: "vim", tty: true, presentation: "foreground" },
        requestId,
      ),
    ).toMatchObject({ type: "terminal.run", payload: { tty: true } });
    expect(
      createAgentCommand(
        "terminal.setPresentation",
        { sessionId, presentation: "background" },
        requestId,
      ),
    ).toMatchObject({
      type: "terminal.setPresentation",
      payload: { sessionId, presentation: "background" },
    });
    expect(
      createAgentCommand(
        "terminal.observe",
        { operationId, afterVersion: 4, timeoutMs: 500 },
        requestId,
      ),
    ).toMatchObject({ type: "terminal.observe", payload: { operationId } });
    expect(createAgentCommand("terminal.close", { operationId }, requestId)).toMatchObject({
      type: "terminal.close",
      payload: { operationId },
    });
    expect(parseObserveCapturedOperationRequest({ operationId })).toEqual({ operationId });

    expect(() => parseRunTerminalRequest({ input: "", tty: false })).toThrow();
    expect(() => parseRunTerminalRequest({ input: "x", timeoutMs: 0 })).toThrow();
    expect(() => parseRunTerminalRequest({ input: "x", timeoutMs: 120_001 })).toThrow();
    expect(() =>
      parseRunTerminalRequest({
        input: "x",
        maxOutputBytesPerStream: 16 * 1024 * 1024 + 1,
      }),
    ).toThrow();
    expect(() =>
      parseRunTerminalRequest({
        input: "x",
        tty: true,
        maxOutputBytesPerStream: 1024,
      }),
    ).toThrow();
    expect(
      parseRunTerminalRequest({
        input: "x",
        tty: true,
        presentation: "foreground",
      }),
    ).toMatchObject({ presentation: "foreground" });
    expect(() =>
      parseRunTerminalRequest({
        input: "x",
        tty: false,
        presentation: "foreground",
      }),
    ).toThrow();
    expect(() =>
      parseAgentCommand({
        type: "terminal.observe",
        requestId,
        payload: {
          sessionId: createSessionId("ambiguous-session"),
          operationId,
          timeoutMs: 10,
        },
      }),
    ).toThrow();
  });

  it("validates result envelopes and loopback descriptors", () => {
    const requestId = createRequestId("request-result");
    const descriptor = {
      url: "ws://127.0.0.1:34567",
      token: "short-lived-token",
      tokenExpiresAt: "2026-05-11T00:05:00.000Z",
      pid: 1234,
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
    };

    expect(parseAgentGatewayDescriptor(descriptor)).toEqual(descriptor);
    expect(() =>
      parseAgentGatewayDescriptor({ ...descriptor, url: "ws://0.0.0.0:34567" }),
    ).toThrow();
    expect(
      parseAgentCommandResult(createAgentCommandSuccess(requestId, { accepted: true })),
    ).toEqual({
      ok: true,
      requestId,
      value: { accepted: true },
    });
    expect(
      parseAgentCommandResult(
        createAgentCommandFailure(
          requestId,
          createTerminalError("auth_required", "Authentication is required."),
        ),
      ),
    ).toMatchObject({ ok: false, error: { type: "auth_required" } });
  });

  it("validates renderer bootstrap and sequenced events", () => {
    const requestId = createRequestId("request-renderer");
    const sessionId = createSessionId("session-renderer");
    const commandId = createRequestId("presentation-command");

    expect(createRendererCommand("session.openView", { sessionId }, requestId)).toMatchObject({
      type: "session.openView",
    });
    expect(
      parseRendererCommand({
        type: "session.reportViewport",
        requestId,
        payload: { sessionId, viewportY: 12, atBottom: true },
      }),
    ).toMatchObject({
      type: "session.reportViewport",
      payload: { sessionId, viewportY: 12, atBottom: true },
    });
    expect(
      createRendererCommand("session.reportViewFocus", { sessionId, focused: true }, requestId),
    ).toMatchObject({ type: "session.reportViewFocus" });
    expect(
      isRendererSessionEvent({
        type: "session.output",
        payload: {
          sessionId,
          sequence: 4,
          data: "output\u001b[6n",
          terminalResponses: [{ data: "\u001b[1;7R", status: "returned" }],
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "session.output",
        payload: {
          sessionId,
          sequence: 4,
          data: "output\u001b[6n",
          terminalResponses: [{ data: "\u001b[1;7R", status: "failed" }],
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "session.output",
        payload: {
          sessionId,
          sequence: 4,
          data: "output",
          terminalResponses: [{ data: "\u001b[1;7R", status: "unknown" }],
        },
      }),
    ).toBe(false);
    expect(
      isRendererSessionEvent({
        type: "session.output",
        payload: {
          sessionId,
          sequence: 4,
          data: "output",
          terminalResponses: [{ data: 42, status: "returned" }],
        },
      }),
    ).toBe(false);
    expect(
      isRendererSessionEvent({
        type: "session.viewport",
        payload: { sessionId, viewportY: 2, observationVersion: 8 },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "presentation.command",
        payload: { commandId, sessionId, action: "focus" },
      }),
    ).toBe(true);
    expect(
      createRendererCommand(
        "presentation.acknowledge",
        { commandId, sessionId, action: "focus", status: "completed" },
        requestId,
      ),
    ).toMatchObject({ type: "presentation.acknowledge" });
    expect(createRendererCommand("agent.control.list", {}, requestId)).toMatchObject({
      type: "agent.control.list",
    });
    expect(createRendererCommand("agent.control.revoke", { sessionId }, requestId)).toMatchObject({
      type: "agent.control.revoke",
    });
    expect(createRendererCommand("agent.control.allow", { sessionId }, requestId)).toMatchObject({
      type: "agent.control.allow",
    });
    expect(createRendererCommand("recording.exportFile", { sessionId }, requestId)).toMatchObject({
      type: "recording.exportFile",
    });
    expect(createRendererCommand("permission.list", {}, requestId)).toMatchObject({
      type: "permission.list",
    });
    expect(
      createRendererCommand(
        "permission.resolve",
        { permissionId: "decision-permission", decision: "allow" },
        requestId,
      ),
    ).toMatchObject({ type: "permission.resolve" });
    expect(
      createRendererCommand(
        "settings.saveAgentPolicy",
        {
          policy: {
            observation: "allow",
            execution: "ask",
            interaction: "allow",
            presentation: "deny",
            recording: "ask",
            termination: "deny",
          },
        },
        requestId,
      ),
    ).toMatchObject({ type: "settings.saveAgentPolicy" });
    expect(
      isRendererSessionEvent({
        type: "permission.requested",
        payload: {
          permissionId: "decision-permission",
          category: "termination",
          operation: "terminal.close",
          sessionId,
          requestedAt: "2026-07-14T00:00:00.000Z",
          expiresAt: "2026-07-14T00:00:30.000Z",
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "permission.resolved",
        payload: { permissionId: "decision-permission", outcome: "deny" },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "agent.control.changed",
        payload: {
          sessionId,
          state: "attached",
          attachedAt: "2026-07-14T00:00:00.000Z",
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "policy.denied",
        payload: {
          decisionId: "decision-renderer",
          at: "2026-07-14T00:00:00.000Z",
          actor: "agent",
          operation: "terminal.input",
          sessionId,
          code: "session_not_owned",
          message: "Agent connection is not attached to this terminal session.",
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "session.removed",
        payload: { sessionId },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "agent.control.changed",
        payload: {
          sessionId,
          state: "attached",
          attachedAt: null,
          connectionId: "private",
        },
      }),
    ).toBe(false);
    expect(
      isRendererSessionEvent({
        type: "agent.control.changed",
        payload: {
          sessionId,
          state: "revoked",
          attachedAt: null,
        },
      }),
    ).toBe(true);
    expect(
      isRendererSessionEvent({
        type: "policy.denied",
        payload: {
          decisionId: "decision-revoked",
          at: "2026-07-14T00:00:00.000Z",
          actor: "agent",
          operation: "terminal.attach",
          sessionId,
          code: "agent_control_revoked",
          message: "Agent control has been revoked for this terminal session.",
        },
      }),
    ).toBe(true);
  });

  it("keeps configuration and recording formats compatible", () => {
    const sessionId = createSessionId("session-recording");
    expect(
      parseTerminalConfig({
        schemaVersion: 3,
        terminal: {
          fontFamily: "monospace",
          fontSize: 13,
          scrollback: 5000,
          theme: { background: "#000", foreground: "#fff", cursor: "#fff" },
        },
        shell: { defaultProfile: null, profiles: [] },
        recording: { state: "disabled", redactedPatterns: [] },
        ui: { theme: "default" },
        agentPolicy: {
          observation: "allow",
          execution: "allow",
          interaction: "allow",
          presentation: "ask",
          recording: "ask",
          termination: "ask",
        },
      }),
    ).toMatchObject({ schemaVersion: 3, agentPolicy: { presentation: "ask" } });
    expect(
      parseTerminalRecordingExport({
        schemaVersion: 1,
        sessionId,
        exportedAt: "2026-05-11T00:00:00.000Z",
        events: [
          {
            type: "pty.output",
            sessionId,
            at: "2026-05-11T00:00:00.000Z",
            data: "x",
          },
        ],
      }),
    ).toMatchObject({ schemaVersion: 1, sessionId });
  });

  it("unwraps renderer results into values or typed errors", () => {
    const requestId = createRequestId("request-renderer-result");
    expect(unwrapRendererCommandResult(createRendererCommandSuccess(requestId, 42))).toBe(42);

    const failure = createRendererCommandFailure(
      requestId,
      createTerminalError("session_not_found", "Missing."),
    );
    expect(() => unwrapRendererCommandResult(failure)).toThrow(TerminalApiError);
    expect(parseRendererCommandResult(failure)).toEqual(failure);
  });
});
