# Agent Gateway

## Status

Accepted component architecture.

## Purpose

The agent gateway exposes the terminal domain through a local authenticated,
validated, policy-controlled request/response API. Long-poll observation is the
only agent synchronization primitive; raw PTY output is not streamed as a
second competing state channel.

## Transport

- Bind a WebSocket server to loopback only.
- Publish an ephemeral descriptor under Electron `userData`.
- The descriptor contains only the loopback `url`, process ID, and the single
  supported protocol version. It never contains the access key or an expiry.
- Authentication supplies the same fixed protocol version. Unsupported
  versions fail before terminal operations are accepted.
- Remove the descriptor during orderly shutdown.

## Authentication Credential

- The [Agent Access Key Store](./agent-access-key-store.md) supplies one
  persistent 256-bit access key for each Electron `userData` profile.
- The gateway does not generate, persist, publish, expire, or refresh access
  keys. A client supplies the human-provisioned key when authenticating.
- The key remains valid until the human regenerates it from Settings or removes
  the app profile.
- Regeneration persists and activates one replacement key, then immediately
  disconnects all agent connections so an already authenticated connection
  cannot retain authority from the old key.
- Connection cleanup after regeneration releases attachments and cancels
  pending requests without closing terminal sessions or PTYs.
- How an external client stores or injects the copied key is client-specific
  and outside the gateway contract.

## API Through Phase 2

```ts
terminal.list()
terminal.get({ sessionId })
terminal.run({ input, cwd?, env?, shell?, tty?, timeoutMs?, maxOutputBytesPerStream? })
terminal.create({ cwd?, env?, shell?, cols?, rows? })
terminal.attach({ sessionId, presentation? })
terminal.input({ sessionId, input })
terminal.resize({ sessionId, cols, rows })
terminal.scroll({ sessionId, scroll })
terminal.observe({ sessionId, afterVersion?, timeoutMs })
terminal.observe({ operationId, afterVersion?, timeoutMs })
terminal.setPresentation({ sessionId, presentation })
terminal.close({ sessionId })
terminal.close({ operationId })

terminal.recording.start({ sessionId })
terminal.recording.stop({ sessionId })
terminal.recording.export({ sessionId })
```

The gateway returns one validated result for each request. Observation may hold
the request until state changes or the timeout expires. It does not emit PTY
bytes, title updates, screen snapshots, or lifecycle events independently of
`terminal.observe`.

## Attachment And Ownership

- Authenticated local agents may list sessions and read session summaries.
- Creating a session grants the connection its exclusive agent attachment.
- Attaching succeeds only when no other agent connection controls the session.
- Agent-created sessions and temporary TTY runs default to headless
  presentation when the request omits it. Explicit create and run presentation
  always wins. Attach defaults to leaving presentation unchanged.
- Input, resize, scroll, observation, close, and recording require attachment.
- Presentation changes require attachment and remain independent from PTY
  lifecycle.
- `terminal.run({ tty: true })` automatically attaches its temporary session to
  the creating connection when the operation remains running.
- An authenticated local connection that possesses an unguessable operation ID
  may observe or close that operation without owning the originating
  connection. PTY session interaction still requires attachment.
- Human control is independent and may coexist with one attached agent.
- Connection loss releases agent attachment without closing the PTY.
- Operation-manager removal, including retention expiry, clears the gateway's
  operation-to-session index and releases any temporary-session attachment.
- Human revocation releases the current attachment, cancels pending
  session-scoped observation, and blocks every agent connection from attaching
  to that session until human control explicitly allows attachment again.
- The revocation check also applies atomically to automatic attachment after
  session creation or a running temporary PTY result, so an in-flight request
  cannot restore control after the human revokes it.
- Allowing agent control removes the session-level block but does not
  automatically attach a connection.

## Policy And Audit

Every request, including authentication, is authorized before side effects.
Policy and audit metadata may include operation kind, operation ID, session ID,
cwd, shell, dimensions, and coarse recording or observation categories. It
must not include access keys, terminal input, PTY output, run input, command
lines, clipboard data, environment values, or recording payloads.

## Boundaries

The gateway must not spawn processes, own canonical terminal state, call
Electron windows, interpret terminal content, or bypass the terminal service.

## Testing Expectations

- Authentication and protocol-version failures fail closed.
- Authentication remains available after arbitrary app uptime and does not
  depend on a time-limited token.
- The runtime descriptor contains no access key or expiry metadata.
- Regeneration rejects the old key, accepts the new key, disconnects existing
  clients, and leaves terminal sessions running.
- Invalid requests never reach services.
- Attachment is exclusive between agent connections.
- Disconnect releases attachment without closing sessions.
- Policy denial prevents side effects and produces a typed result.
- Pending observations are cancelled when their connection closes.
- Audit records contain safe metadata only.
- Temporary PTY runs grant session attachment only to the creating connection.
- Operation-ID observation and close work after reconnect.
- Run input is absent from policy and audit records.
- Failed renderer presentation does not fail session creation or remove
  headless agent control.
