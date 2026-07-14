# PTY Host

## Status

Accepted component architecture.

## Purpose

The PTY host is the adapter around node-pty. It owns direct interaction with real pseudoterminal sessions and normalizes platform-specific PTY behavior.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Import `node-pty`.
- Spawn shells with correct executable, args, cwd, env, rows, and columns.
- Resolve persistent interactive launches separately from temporary
  command-shell launches.
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
The desktop app package may still declare `node-pty` as a runtime dependency
for Electron bundling and packaging, because the built main process resolves the
native module from the app package. That dependency declaration must not become
a direct app-code import.

## Platform Behavior

- macOS and Linux use Unix PTY behavior through node-pty.
- Windows uses ConPTY through node-pty.
- Windows selects node-pty's bundled ConPTY DLL backend so teardown does not
  depend on the separate console-process-list helper that can race with shell
  exit.
- Shell paths, arguments, environment handling, and newline behavior must be platform-aware.
- PTY termination is idempotent and becomes a no-op after an observed process
  exit.
- PTY spawn failures must preserve enough context for a domain error without leaking dependency-specific error types.

## Public Contract

The package boundary should expose terminal-domain operations, not node-pty implementation details:

- Spawn a PTY from a validated shell launch request.
- Spawn a temporary PTY command through the platform shell's command flag
  (`-c`, `-Command`, or `/d /s /c`) without leaving an interactive prompt.
- Write bytes to a PTY handle owned by the host.
- Resize a PTY by rows and columns.
- Kill a PTY with a controlled signal or platform equivalent.
- Subscribe to output and exit events.

## Testing Expectations

- A deterministic command can be spawned and observed through PTY output.
- Writes reach the child process.
- Resize events update the PTY dimensions.
- Exit events include exit code and signal when available.
- Temporary command launches use the resolved platform-specific invocation and
  exit when the supplied shell input finishes.
- Spawn failures are mapped to typed terminal-domain errors.
- Windows spawn options select the hardened ConPTY backend, and repeated or
  post-exit termination does not call the native PTY kill path again.
