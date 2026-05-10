# Recorder and Transcript Store

## Status

Accepted component architecture.

## Purpose

The recorder captures enough data to debug and replay terminal sessions. It stores replayable terminal events without mixing them with app diagnostics or agent observations.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Record session lifecycle events.
- Record input events with origin.
- Record output chunks with timestamps.
- Record resize events.
- Record exit events and errors.
- Store transcript metadata separately from raw PTY bytes.
- Redact or disable recording according to policy.
- Export replayable session files.

## Recording Format

Recording format should be append-only and versioned.

```ts
type RecordingEvent =
  | { type: "session.created"; sessionId: SessionId; at: string; metadata: SessionMetadata }
  | { type: "pty.output"; sessionId: SessionId; at: string; data: string }
  | { type: "terminal.input"; sessionId: SessionId; at: string; origin: InputOrigin; data: string }
  | { type: "terminal.resize"; sessionId: SessionId; at: string; cols: number; rows: number }
  | { type: "session.exited"; sessionId: SessionId; at: string; exitCode: number | null; signal: string | null };
```

## Boundaries

The recorder must not:

- Log application diagnostics.
- Decide whether an agent may control a session.
- Mutate terminal state.
- Treat app logs as transcript events.
- Persist secrets when recording policy disables or redacts them.

## Persistence Rules

- Full transcripts are not persisted by default unless recording is enabled.
- Recording files must include schema versions.
- Transcript indexes must not duplicate raw terminal output unnecessarily.
- Redaction policy must apply before data is written.
- Exported files must preserve event ordering.

## Testing Expectations

- Recording events are append-only and ordered.
- Input origin is preserved.
- Resize and exit events are captured.
- Redaction rules apply before persistence.
- Exported replay metadata can be validated against its schema version.
