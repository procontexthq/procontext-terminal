import {
  createDecisionId,
  type AgentPermissionCategory,
  type AgentPermissionMode,
  type AgentCommandType,
  type OperationId,
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
  attachedSessionIds: ReadonlySet<SessionId | string>;
};

export type TerminalPolicyActor = HumanPolicyActor | SystemPolicyActor | AgentPolicyActor;

export type TerminalPolicyOperation = {
  type: AgentCommandType | RendererCommandType;
  operationId?: OperationId;
  sessionId?: SessionId;
  cwd?: string;
  shell?: string;
  inputKind?: "input" | "resize" | "scroll" | "close";
  runKind?: "captured" | "pty";
  presentationKind?: "headless" | "background" | "foreground" | "unchanged";
  observationKind?: "list" | "get" | "observe";
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

export type DefaultAgentPolicyOptions = DefaultTerminalPolicyOptions & {
  getPermissionMode?: (category: AgentPermissionCategory) => AgentPermissionMode;
};

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
          operation.type !== "terminal.get" &&
          !actor.attachedSessionIds.has(operation.sessionId)
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
  const getPermissionMode = options.getPermissionMode ?? (() => "allow");
  return {
    authorize(request) {
      const baseDecision = terminalPolicy.authorize(request);
      if (baseDecision.type !== "allow" || request.operation.type === "agent.authenticate") {
        return baseDecision;
      }

      const category = agentPermissionCategory(request.operation.type);
      const mode = getPermissionMode(category);
      if (mode === "deny") {
        return deny(baseDecision.decisionId, "permission_denied", request.operation);
      }
      if (mode === "ask") {
        return {
          type: "prompt",
          decisionId: baseDecision.decisionId,
          prompt: {
            decisionId: baseDecision.decisionId,
            category,
            operation: request.operation.type,
            ...(request.operation.sessionId ? { sessionId: request.operation.sessionId } : {}),
          },
        };
      }
      return baseDecision;
    },
  };
}

function agentPermissionCategory(type: AgentCommandType): AgentPermissionCategory {
  switch (type) {
    case "terminal.list":
    case "terminal.get":
    case "terminal.observe":
      return "observation";
    case "terminal.create":
    case "terminal.run":
      return "execution";
    case "terminal.attach":
    case "terminal.input":
    case "terminal.resize":
    case "terminal.scroll":
      return "interaction";
    case "terminal.setPresentation":
      return "presentation";
    case "terminal.recording.start":
    case "terminal.recording.stop":
    case "terminal.recording.export":
      return "recording";
    case "terminal.close":
      return "termination";
    case "agent.authenticate":
      return "observation";
  }
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
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
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
      return "Agent connection is not attached to this terminal session.";
    case "session_in_use":
      return "Another agent connection controls this terminal session.";
    case "agent_control_revoked":
      return "Agent control has been revoked for this terminal session.";
    case "permission_denied":
      return "Agent operation is denied by the configured permission policy.";
    case "permission_timeout":
      return "Agent permission request timed out.";
    case "permission_unavailable":
      return "Agent permission approval is unavailable.";
  }
}
