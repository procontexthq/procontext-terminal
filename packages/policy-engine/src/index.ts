import {
  createDecisionId,
  type AgentCommandType,
  type PolicyDecision,
  type PolicyDenial,
  type PolicyDenialCode,
  type SessionId,
} from "@terminal/protocol";

export type AgentPolicyActor = {
  kind: "agent";
  authenticated: boolean;
  local: boolean;
  ownedSessionIds: ReadonlySet<SessionId | string>;
};

export type AgentPolicyOperation = {
  type: AgentCommandType;
  sessionId?: SessionId;
};

export type AgentPolicyRequest = {
  actor: AgentPolicyActor;
  operation: AgentPolicyOperation;
};

export type AgentPolicy = {
  authorize(request: AgentPolicyRequest): PolicyDecision;
};

export type DefaultAgentPolicyOptions = {
  createDecisionId?: () => string;
};

export function createDefaultAgentPolicy(options: DefaultAgentPolicyOptions = {}): AgentPolicy {
  const nextDecisionId = options.createDecisionId ?? (() => createDecisionId());
  return {
    authorize({ actor, operation }) {
      const decisionId = nextDecisionId();
      if (!actor.local) {
        return deny(decisionId, "remote_control_disabled", operation);
      }

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

      return { type: "allow", decisionId };
    },
  };
}

function deny(
  decisionId: string,
  code: PolicyDenialCode,
  operation: AgentPolicyOperation,
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
  operation: AgentPolicyOperation,
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
