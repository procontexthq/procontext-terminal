# Policy Engine

## Status

Accepted component architecture.

## Purpose

The policy engine decides whether an operation is allowed. It is the explicit decision point for sensitive terminal, recording, and agent-control behavior.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Apply local trust policy.
- Distinguish human, agent, and system actions.
- Apply configured `allow`, `ask`, or `deny` modes to agent permission
  categories.
- Request human confirmation for sensitive agent actions when configured.
- Restrict agent access by workspace, shell profile, session, command origin, or time.
- Prevent remote agent access unless explicitly enabled.
- Return structured denial reasons.

## Default Policy

The default local development policy permits local authenticated agent control
and local human desktop actions, but every sensitive operation still passes
through an explicit policy decision point.

Sensitive operations include:

- Creating terminals in protected directories.
- Starting captured or temporary-PTY one-shot runs.
- Sending input from agents.
- Sending raw terminal input from agents.
- Enabling recording.
- Exporting transcripts.
- Enabling external agent gateway access.
- Closing sessions not controlled by the caller.

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
      attachedSessionIds: ReadonlySet<SessionId | string>;
    };

type TerminalPolicyOperation = {
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

type PolicyPrompt = {
  decisionId: string;
  category: AgentPermissionCategory;
  operation: string;
  sessionId?: SessionId;
};

type PolicyDecision =
  | { type: "allow"; decisionId: string; reason?: string }
  | { type: "deny"; decisionId: string; reason: PolicyDenial }
  | { type: "prompt"; decisionId: string; prompt: PolicyPrompt };
```

Denial reasons must be machine-readable and include enough context for UI,
logs, and agent responses. Agent operations are grouped into the coarse
`observation`, `execution`, `interaction`, `presentation`, `recording`, and
`termination` categories. An `ask` mode returns a `prompt` decision; the caller
must broker a time-bounded human response before performing the operation. A
denied, timed-out, cancelled, or unavailable prompt must not permit the
operation.

Operation metadata is intentionally safe context only. It can include `cwd`,
`shell`, operation and session IDs, and coarse operation kinds, but it must not
include raw terminal input text, one-shot run input, PTY output, clipboard data,
tokens, secrets, environment values, or transcript payloads by default.
Prompt metadata is narrower still: it contains only the decision ID, permission
category, operation name, and optional session ID. Prompt UI may add request and
expiry timestamps, but must not receive command text, terminal input or output,
environment values, transcript data, gateway connection IDs, or authentication
material.

The agent gateway may expose an agent-specific wrapper over this generic
terminal policy surface, but it must preserve the same decision semantics for
agent authentication, ownership, and remote-control checks.

## Testing Expectations

- Sensitive operations route through policy checks.
- Authentication routes through policy before mutating auth state.
- Denials prevent side effects.
- Denial reasons are structured and stable.
- Configured agent permission categories produce `allow`, privacy-safe
  `prompt`, or `permission_denied` decisions as configured.
- Prompt decisions contain only the decision ID, category, operation name, and
  optional session ID.
- Human, agent, and system origins can be evaluated differently.
- Renderer recording start, stop, and export requests are authorized as local
  human operations before recorder side effects.
- Agent input policy checks receive safe input metadata, not raw terminal text.
- Run policy checks receive execution kind and safe launch metadata, not the
  supplied shell input or environment values.
- Default local policy allows intended development flows without skipping decision points.
