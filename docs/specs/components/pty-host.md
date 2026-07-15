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
- Windows uses node-pty's bundled ConPTY backend so raw terminal control
  sequences, including alternate-buffer transitions, reach the canonical
  emulator. The PTY adapter answers and removes the bundled console's one-shot
  startup device-attribute query before forwarding output. This bounded
  transport handshake must not depend on a renderer window or allow a second
  terminal model to answer the same query.
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
- Windows spawn options select the bundled ConPTY DLL, and repeated or post-exit
  termination does not call the native PTY kill path again.
- The bundled ConPTY startup handshake handles a query split across output
  chunks, writes exactly one xterm-compatible response, removes only that
  initial query from forwarded output, and then becomes a transparent pass-
  through.
- Windows-only real PTY tests write to interactive PowerShell after spawn and
  verify output, OSC control sequences, alternate-buffer transitions, and clean
  exit through the selected ConPTY transport.
