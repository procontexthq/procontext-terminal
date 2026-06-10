# Agent Gateway

## Status

Accepted component architecture.

## Purpose

The agent gateway exposes terminal control to autonomous agents through a local, authenticated, validated, and audited API. It maps agent requests to session manager operations.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Accept local-only agent connections.
- Authenticate callers.
- Validate every request at runtime.
- Map agent requests to session manager commands.
- Enforce session ownership and policy.
- Emit audit events for agent actions.
- Stream observations and lifecycle events back to the agent.

## Transport

Primary transport:

- Local WebSocket over loopback with a short-lived auth token.
- The gateway writes an ephemeral JSON descriptor under the Electron `userData`
  directory. The descriptor contains only `{ url, token, tokenExpiresAt, pid }`
  and is removed during app shutdown.

Not allowed by default:

- Unauthenticated network binding.
- Remote network control without explicit configuration and policy support.

## API Categories

- Session: create, attach, list, get, kill.
- Input: send text, send key, send paste, send mouse, interrupt.
- Layout: resize, focus, open window, split pane.
- Observation: recent output, viewport, screen snapshot, cursor, title, bell, lifecycle.
- Synchronization: wait for text, wait for prompt, wait for quiet, wait for screen change.
- Recording: start, stop, export, replay metadata.

Phase 3 exposes the first external command set:

- `agent.authenticate`
- `terminal.list`
- `terminal.create`
- `terminal.attach`
- `terminal.sendText`
- `terminal.sendKey`
- `terminal.resize`
- `terminal.readRecentOutput`
- `terminal.captureScreen`
- `terminal.waitForText`
- `terminal.waitForQuiet`
- `terminal.waitForScreenChange`
- `terminal.waitForPrompt`
- `terminal.kill`

Owned session title and bell events are streamed as `terminal.title` and
`terminal.bell` observations. Title text is observation data, not app
diagnostics, and must not be written to diagnostic logs by default.

`terminal.attach` attaches an agent connection to an existing session for
ownership, event filtering, and subsequent control. It does not change the
renderer lifecycle state of that terminal.

The gateway authorizes every parsed command through the policy engine before
performing command-specific side effects. This includes `agent.authenticate`;
a policy denial for authentication prevents the connection from becoming
authenticated even if the token is valid. Non-authentication terminal commands
still require an authenticated connection even when a permissive policy returns
`allow`.

Policy requests include safe operation metadata such as `cwd`, `shell`,
`sessionId`, coarse input kind, coarse observation kind, or recording kind.
They intentionally exclude raw terminal input text, PTY output, tokens,
clipboard contents, and transcript payloads unless a future policy explicitly
opts into that sensitive data.

## Boundaries

The agent gateway must not:

- Spawn PTYs directly.
- Bypass the terminal session manager.
- Trust external messages without validation.
- Bind unauthenticated network control by default.
- Treat agent observations as application logs.
- Log descriptor tokens, terminal input, PTY output, or transcript data.

## Renderer-Dependent Observation

The gateway can always read recent output from session-core for existing
sessions. Screen snapshots and screen-based waits depend on a renderer window
responding with xterm.js buffer state. If no renderer can provide that state,
the gateway returns a structured `observation_unavailable` terminal error.
This includes both "no renderer window exists" and "a renderer exists but does
not own the requested session". Snapshot responses are correlated by request ID
and session ID; a mismatched renderer response is rejected as
`session_snapshot_failed` rather than being used as observation data.

When an agent creates a session, the gateway asks the desktop app to make a
renderer window available for the human-visible terminal surface. Renderer
display is best effort: if a window cannot be created, `terminal.create` still
returns the created PTY session, the session remains usable through headless
operations such as input and recent-output reads, and the agent receives a
non-fatal `terminal.error` with `operation: "terminal.display"`.
An existing desktop window is considered usable only when the window and its
renderer web contents are alive. Destroyed or crashed renderer contents do not
satisfy display availability; the desktop app must create another window or
report the same non-fatal display error.

## Testing Expectations

- Unauthenticated requests are rejected.
- Invalid payloads fail closed with typed errors.
- Allowed requests map to the expected session manager operation.
- Denied requests produce policy denial events without side effects.
- Authentication denial by policy leaves the connection unauthenticated.
- Input authorization includes only safe metadata by default.
- Event streams preserve session identity and lifecycle ordering.
