# PTY Host

## Status

Accepted component architecture.

## Purpose

The PTY host is the adapter around node-pty. It owns direct interaction with real pseudoterminal sessions and normalizes platform-specific PTY behavior.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Import `node-pty`.
- Spawn shells with correct executable, args, cwd, env, rows, and columns.
- Write bytes to PTY sessions.
- Resize PTY sessions.
- Receive output bytes.
- Receive process exit events.
- Normalize platform differences between Unix PTYs and Windows ConPTY.
- Convert node-pty errors into domain errors.
- Accept resolved shell launch requests so session metadata and PTY spawn behavior share one shell resolution source.

## Boundaries

The PTY host must not:

- Know about renderer UI.
- Expose node-pty types across package boundaries.
- Own session lifecycle policy.
- Own agent authentication.
- Store recordings directly.

The PTY host should be the only module that imports `node-pty` directly.

## Platform Behavior

- macOS and Linux use Unix PTY behavior through node-pty.
- Windows uses ConPTY through node-pty.
- Shell paths, arguments, environment handling, and newline behavior must be platform-aware.
- PTY spawn failures must preserve enough context for a domain error without leaking dependency-specific error types.

## Public Contract

The package boundary should expose terminal-domain operations, not node-pty implementation details:

- Spawn a PTY from a validated shell launch request.
- Write bytes to a PTY handle owned by the host.
- Resize a PTY by rows and columns.
- Kill a PTY with a controlled signal or platform equivalent.
- Subscribe to output and exit events.

## Testing Expectations

- A deterministic command can be spawned and observed through PTY output.
- Writes reach the child process.
- Resize events update the PTY dimensions.
- Exit events include exit code and signal when available.
- Spawn failures are mapped to typed terminal-domain errors.
