# App Logger

## Status

Accepted component architecture.

## Purpose

The app logger records application diagnostics. It is separate from terminal PTY output, transcript recording, and agent observations.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Log app lifecycle events.
- Log session lifecycle events.
- Log policy decisions.
- Log gateway connections and authentication failures.
- Log internal errors with structured context.
- Respect redaction rules.
- Provide enough context to debug cross-process issues.

## Boundaries

The app logger must not:

- Write application logs into PTY output.
- Log terminal output by default.
- Store replay transcripts.
- Decide policy.
- Expose secrets or unredacted sensitive environment values.

## Recommended Fields

- timestamp
- level
- component
- event
- sessionId when relevant
- requestId when relevant
- origin: human, agent, system
- error type and cause when relevant

## Channel Separation

Observability has three separate outputs:

1. App logs for debugging the application.
2. Terminal transcripts for replaying PTY sessions.
3. Agent observations for real-time decision-making.

These outputs must not be mixed. Terminal output should not be logged as app diagnostics by default.

## Testing Expectations

- Logs include component and event names.
- Terminal output is excluded from app diagnostics unless explicitly enabled for a scoped debugging scenario.
- Redaction removes sensitive values before persistence or export.
- Error logs preserve domain error type and cause context.
