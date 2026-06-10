# Screen Observer

## Status

Accepted component architecture.

## Purpose

The screen observer turns rendered terminal state into structured observations for agents. It preserves terminal truth without pretending to semantically understand every TUI.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Read visible rows from xterm.js buffer state.
- Track cursor position.
- Track viewport dimensions.
- Track alternate-screen mode.
- Track selection state when useful.
- Produce snapshots for agent use.
- Support `waitForText`, `waitForPrompt`, and `waitForScreenChange`.

## Snapshot Shape

```ts
type TerminalScreenSnapshot = {
  sessionId: SessionId;
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  alternateScreen: boolean;
  title: string | null;
  viewport: Array<{
    row: number;
    text: string;
    wrapped: boolean;
  }>;
  capturedAt: string;
};
```

## Availability And Correlation

Screen snapshots are renderer-dependent. Main tracks which renderer owns each
session and only sends snapshot requests to renderer owners for that session.
If no renderer owns the session, snapshot capture fails immediately with a
structured `observation_unavailable` error instead of waiting for a timeout.

Renderer ownership is tied to the renderer web contents. When a renderer is
destroyed or its render process is lost and it was the last renderer owner for
a live session, main detaches that session so a replacement renderer can
rediscover and reattach it during startup reconciliation instead of leaving a
running session with no observable owner. Pending snapshot requests for a
session whose last renderer owner disappears fail immediately with
`observation_unavailable`.

Snapshot responses must match both the request ID and requested session ID. A
response for the wrong session is a protocol failure and must reject the pending
request with `session_snapshot_failed`.

## Boundaries

The screen observer must not:

- Spawn processes.
- Own PTY lifecycle.
- Claim semantic knowledge of arbitrary TUI widgets.
- Mutate terminal state while observing it.
- Mix snapshots with transcript storage.

Higher-level interpretation can exist above snapshots, but it must not change the base observation contract.

## Wait Helpers

Wait helpers must avoid fixed sleeps and indefinite hangs.

- `waitForText` resolves when visible or recent observed text matches the requested condition.
- `waitForPrompt` is a best-effort helper with documented heuristics.
- `waitForScreenChange` resolves when the visible snapshot changes.
- Every wait accepts an explicit timeout.

## Testing Expectations

- Snapshot shape is stable and serializable.
- Snapshot requests fail with `observation_unavailable` when no renderer owns
  the requested session.
- Destroying or crashing the last renderer owner detaches live sessions for
  reattachment and rejects pending snapshot requests for those sessions.
- Snapshot responses for the wrong session fail with `session_snapshot_failed`.
- Normal buffer and alternate-screen snapshots both work.
- Cursor, title, row wrapping, and viewport dimensions are represented accurately.
- Wait helpers resolve on matching state and reject on timeout.
