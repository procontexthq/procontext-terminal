# Policy Engine

## Status

Accepted component architecture.

## Purpose

The policy engine decides whether an operation is allowed. It is the explicit decision point for sensitive terminal, recording, and agent-control behavior.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Apply local trust policy.
- Distinguish human, agent, and system actions.
- Require confirmation for sensitive actions when configured.
- Restrict agent access by workspace, shell profile, session, command origin, or time.
- Prevent remote agent access unless explicitly enabled.
- Return structured denial reasons.

## Default Policy

The default local development policy permits local authenticated agent control
and local human desktop actions, but every sensitive operation still passes
through an explicit policy decision point.

Sensitive operations include:

- Creating terminals in protected directories.
- Sending input from agents.
- Sending paste blocks from agents.
- Enabling recording.
- Exporting transcripts.
- Enabling external agent gateway access.
- Killing sessions not owned by the caller.

## Boundaries

The policy engine must not:

- Spawn PTYs.
- Modify terminal state directly.
- Implement transport parsing.
- Render confirmation UI.
- Store terminal transcripts.

The policy engine returns decisions. Callers enforce those decisions.

Every agent command, including `agent.authenticate`, goes through a policy
decision before the gateway mutates connection authentication or terminal state.
Renderer-triggered sensitive operations, including recording start, stop, and
export, go through the same policy engine before main calls recorder/session
manager side-effect methods. When unauthenticated access is denied with
`auth_required`, callers surface an `auth_required` terminal error. Other denial
codes are surfaced as `policy_denied`.

## Decision Shape

Policy decisions should be structured and auditable:

```ts
type TerminalPolicyActor =
  | { kind: "human"; local: boolean }
  | { kind: "system"; local: boolean }
  | {
      kind: "agent";
      authenticated: boolean;
      local: boolean;
      ownedSessionIds: ReadonlySet<SessionId | string>;
    };

type TerminalPolicyOperation = {
  type: AgentCommandType | RendererCommandType;
  sessionId?: SessionId;
  cwd?: string;
  shell?: string;
  inputKind?: "text" | "key" | "resize" | "kill";
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

type PolicyDecision =
  | { type: "allow"; decisionId: string; reason?: string }
  | { type: "deny"; decisionId: string; reason: PolicyDenial };
```

Denial reasons must be machine-readable and include enough context for UI, logs, and agent responses.
Operation metadata is intentionally safe context only. It can include `cwd`,
`shell`, the session ID, and coarse operation kinds, but it must not include raw
terminal input text, PTY output, clipboard data, tokens, secrets, or transcript
payloads by default.

The agent gateway may expose an agent-specific wrapper over this generic
terminal policy surface, but it must preserve the same decision semantics for
agent authentication, ownership, and remote-control checks.

## Testing Expectations

- Sensitive operations route through policy checks.
- Authentication routes through policy before mutating auth state.
- Denials prevent side effects.
- Denial reasons are structured and stable.
- Human, agent, and system origins can be evaluated differently.
- Renderer recording start, stop, and export requests are authorized as local
  human operations before recorder side effects.
- Agent input policy checks receive safe input metadata, not raw terminal text.
- Default local policy allows intended development flows without skipping decision points.
