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

The default local development policy permits local authenticated agent control, but every sensitive operation still passes through an explicit policy decision point.

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

## Decision Shape

Policy decisions should be structured and auditable:

```ts
type PolicyDecision =
  | { type: "allow"; decisionId: string; reason?: string }
  | { type: "deny"; decisionId: string; reason: PolicyDenial };
```

Denial reasons must be machine-readable and include enough context for UI, logs, and agent responses.

## Testing Expectations

- Sensitive operations route through policy checks.
- Denials prevent side effects.
- Denial reasons are structured and stable.
- Human, agent, and system origins can be evaluated differently.
- Default local policy allows intended development flows without skipping decision points.
