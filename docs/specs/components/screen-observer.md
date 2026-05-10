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
- Normal buffer and alternate-screen snapshots both work.
- Cursor, title, row wrapping, and viewport dimensions are represented accurately.
- Wait helpers resolve on matching state and reject on timeout.
