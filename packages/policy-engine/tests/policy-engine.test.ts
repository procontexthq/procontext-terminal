import { describe, expect, it } from "vitest";

import { createOperationId, createSessionId } from "@terminal/protocol";

import { createDefaultAgentPolicy, createDefaultTerminalPolicy } from "../src/index";

describe("default agent policy", () => {
  it("allows authenticated local agent list, create, and attach operations", () => {
    const policy = createDefaultAgentPolicy({ createDecisionId: () => "decision-1" });
    const actor = {
      kind: "agent" as const,
      authenticated: true,
      local: true,
      attachedSessionIds: new Set<string>(),
    };
    const sessionId = createSessionId("session-policy-1");

    expect(policy.authorize({ actor, operation: { type: "terminal.list" } })).toMatchObject({
      type: "allow",
      decisionId: "decision-1",
    });
    expect(policy.authorize({ actor, operation: { type: "terminal.create" } })).toMatchObject({
      type: "allow",
    });
    expect(
      policy.authorize({ actor, operation: { type: "terminal.attach", sessionId } }),
    ).toMatchObject({
      type: "allow",
    });
  });

  it("allows authentication and ignores safe operation metadata in the default local policy", () => {
    const policy = createDefaultAgentPolicy({ createDecisionId: () => "decision-auth" });
    const actor = {
      kind: "agent" as const,
      authenticated: false,
      local: true,
      attachedSessionIds: new Set<string>(),
    };
    const createOperation = {
      type: "terminal.create" as const,
      cwd: "/workspace",
      shell: "/bin/sh",
    };

    expect(policy.authorize({ actor, operation: { type: "agent.authenticate" } })).toMatchObject({
      type: "allow",
      decisionId: "decision-auth",
    });
    expect(
      policy.authorize({
        actor: { ...actor, authenticated: true },
        operation: createOperation,
      }),
    ).toMatchObject({ type: "allow" });
  });

  it("denies unauthenticated and non-local agent operations with stable reasons", () => {
    const policy = createDefaultAgentPolicy({ createDecisionId: () => "decision-deny" });
    const sessionId = createSessionId("session-policy-2");

    expect(
      policy.authorize({
        actor: {
          kind: "agent",
          authenticated: false,
          local: true,
          attachedSessionIds: new Set(),
        },
        operation: { type: "terminal.input", sessionId },
      }),
    ).toEqual({
      type: "deny",
      decisionId: "decision-deny",
      reason: {
        decisionId: "decision-deny",
        code: "auth_required",
        message: "Agent authentication is required.",
        operation: "terminal.input",
        sessionId,
      },
    });

    expect(
      policy.authorize({
        actor: {
          kind: "agent",
          authenticated: true,
          local: false,
          attachedSessionIds: new Set([sessionId]),
        },
        operation: { type: "terminal.input", sessionId },
      }),
    ).toMatchObject({
      type: "deny",
      reason: {
        code: "remote_control_disabled",
        operation: "terminal.input",
        sessionId,
      },
    });
  });

  it("requires ownership before controlling an attached or created session", () => {
    const policy = createDefaultAgentPolicy({ createDecisionId: () => "decision-owner" });
    const sessionId = createSessionId("session-owned");
    const otherSessionId = createSessionId("session-other");

    expect(
      policy.authorize({
        actor: {
          kind: "agent",
          authenticated: true,
          local: true,
          attachedSessionIds: new Set([sessionId]),
        },
        operation: { type: "terminal.close", sessionId: otherSessionId },
      }),
    ).toMatchObject({
      type: "deny",
      reason: {
        code: "session_not_owned",
        operation: "terminal.close",
        sessionId: otherSessionId,
      },
    });

    expect(
      policy.authorize({
        actor: {
          kind: "agent",
          authenticated: true,
          local: true,
          attachedSessionIds: new Set([sessionId]),
        },
        operation: { type: "terminal.close", sessionId },
      }),
    ).toMatchObject({ type: "allow" });
  });

  it("allows authenticated operation capability access without session attachment", () => {
    const policy = createDefaultAgentPolicy({ createDecisionId: () => "decision-operation" });
    const actor = {
      kind: "agent" as const,
      authenticated: true,
      local: true,
      attachedSessionIds: new Set<string>(),
    };
    const operationId = createOperationId("operation-policy");

    expect(
      policy.authorize({
        actor,
        operation: {
          type: "terminal.observe",
          operationId,
          observationKind: "observe",
        },
      }),
    ).toMatchObject({ type: "allow" });
    expect(
      policy.authorize({
        actor,
        operation: { type: "terminal.close", operationId, inputKind: "close" },
      }),
    ).toMatchObject({ type: "allow" });
  });
});

describe("default terminal policy", () => {
  it("allows local human and system recording operations through explicit decisions", () => {
    const policy = createDefaultTerminalPolicy({ createDecisionId: () => "decision-recording" });
    const sessionId = createSessionId("session-recording");

    expect(
      policy.authorize({
        actor: { kind: "human", local: true },
        operation: { type: "recording.start", sessionId, recordingKind: "start" },
      }),
    ).toEqual({ type: "allow", decisionId: "decision-recording" });

    expect(
      policy.authorize({
        actor: { kind: "system", local: true },
        operation: { type: "recording.export", sessionId, recordingKind: "export" },
      }),
    ).toEqual({ type: "allow", decisionId: "decision-recording" });
  });

  it("denies non-local human recording operations with structured reasons", () => {
    const policy = createDefaultTerminalPolicy({ createDecisionId: () => "decision-remote" });
    const sessionId = createSessionId("session-remote-recording");

    expect(
      policy.authorize({
        actor: { kind: "human", local: false },
        operation: { type: "recording.export", sessionId, recordingKind: "export" },
      }),
    ).toEqual({
      type: "deny",
      decisionId: "decision-remote",
      reason: {
        decisionId: "decision-remote",
        code: "remote_control_disabled",
        message: "Remote agent control is disabled.",
        operation: "recording.export",
        sessionId,
      },
    });
  });
});
