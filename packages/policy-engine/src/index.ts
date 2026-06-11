import {
  createDecisionId,
  type AgentCommandType,
  type PolicyDecision,
  type PolicyDenial,
  type PolicyDenialCode,
  type RendererCommandType,
  type SessionId,
} from "@terminal/protocol";

export type HumanPolicyActor = {
  kind: "human";
  local: boolean;
};

export type SystemPolicyActor = {
  kind: "system";
  local: boolean;
};

export type AgentPolicyActor = {
  kind: "agent";
  authenticated: boolean;
  local: boolean;
  ownedSessionIds: ReadonlySet<SessionId | string>;
};

export type TerminalPolicyActor = HumanPolicyActor | SystemPolicyActor | AgentPolicyActor;

export type TerminalPolicyOperation = {
  type: AgentCommandType | RendererCommandType;
  sessionId?: SessionId;
  cwd?: string;
  shell?: string;
  inputKind?: "text" | "key" | "paste" | "mouse" | "interrupt" | "resize" | "kill";
  observationKind?:
    | "list"
    | "get"
    | "recentOutput"
    | "screen"
    | "waitText"
    | "waitScreenChange"
    | "waitQuiet"
    | "waitPrompt";
  recordingKind?: "start" | "stop" | "export";
};

export type AgentPolicyOperation = TerminalPolicyOperation & {
  type: AgentCommandType;
};

export type TerminalPolicyRequest = {
  actor: TerminalPolicyActor;
  operation: TerminalPolicyOperation;
};

export type AgentPolicyRequest = {
  actor: AgentPolicyActor;
  operation: AgentPolicyOperation;
};

export type TerminalPolicy = {
  authorize(request: TerminalPolicyRequest): PolicyDecision;
};

export type AgentPolicy = {
  authorize(request: AgentPolicyRequest): PolicyDecision;
};

export type DefaultTerminalPolicyOptions = {
  createDecisionId?: () => string;
};

export type DefaultAgentPolicyOptions = DefaultTerminalPolicyOptions;

export function createDefaultTerminalPolicy(
  options: DefaultTerminalPolicyOptions = {},
): TerminalPolicy {
  const nextDecisionId = options.createDecisionId ?? (() => createDecisionId());
  return {
    authorize({ actor, operation }) {
      const decisionId = nextDecisionId();
      if (!actor.local) {
        return deny(decisionId, "remote_control_disabled", operation);
      }

      if (actor.kind === "agent") {
        if (!actor.authenticated && operation.type !== "agent.authenticate") {
          return deny(decisionId, "auth_required", operation);
        }

        if (
          operation.sessionId &&
          operation.type !== "terminal.attach" &&
          !actor.ownedSessionIds.has(operation.sessionId)
        ) {
          return deny(decisionId, "session_not_owned", operation);
        }
      }

      return { type: "allow", decisionId };
    },
  };
}

export function createDefaultAgentPolicy(options: DefaultAgentPolicyOptions = {}): AgentPolicy {
  const terminalPolicy = createDefaultTerminalPolicy(options);
  return {
    authorize(request) {
      return terminalPolicy.authorize(request);
    },
  };
}

function deny(
  decisionId: string,
  code: PolicyDenialCode,
  operation: TerminalPolicyOperation,
): PolicyDecision {
  return {
    type: "deny",
    decisionId,
    reason: createPolicyDenial(decisionId, code, operation),
  };
}

function createPolicyDenial(
  decisionId: string,
  code: PolicyDenialCode,
  operation: TerminalPolicyOperation,
): PolicyDenial {
  return {
    decisionId,
    code,
    message: denialMessage(code),
    operation: operation.type,
    ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
  };
}

function denialMessage(code: PolicyDenialCode): string {
  switch (code) {
    case "auth_required":
      return "Agent authentication is required.";
    case "remote_control_disabled":
      return "Remote agent control is disabled.";
    case "session_not_owned":
      return "Agent connection does not own this terminal session.";
  }
}
