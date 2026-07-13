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
- The descriptor contains `url`, token metadata, process ID, and the single
  supported protocol version.
- Authentication supplies the same fixed protocol version. Unsupported
  versions fail before terminal operations are accepted.
- Remove the descriptor during orderly shutdown.

## API Through Phase 2

```ts
terminal.list()
terminal.get({ sessionId })
terminal.run({ input, cwd?, env?, shell?, tty?, timeoutMs?, maxOutputBytesPerStream? })
terminal.create({ cwd?, env?, shell?, cols?, rows? })
terminal.attach({ sessionId })
terminal.input({ sessionId, input })
terminal.resize({ sessionId, cols, rows })
terminal.scroll({ sessionId, scroll })
terminal.observe({ sessionId, afterVersion?, timeoutMs })
terminal.observe({ operationId, afterVersion?, timeoutMs })
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
- Input, resize, scroll, observation, close, and recording require attachment.
- `terminal.run({ tty: true })` automatically attaches its temporary session to
  the creating connection when the operation remains running.
- An authenticated local connection that possesses an unguessable operation ID
  may observe or close that operation without owning the originating
  connection. PTY session interaction still requires attachment.
- Human control is independent and may coexist with one attached agent.
- Connection loss releases agent attachment without closing the PTY.

## Policy And Audit

Every request, including authentication, is authorized before side effects.
Policy and audit metadata may include operation kind, operation ID, session ID,
cwd, shell, dimensions, and coarse recording or observation categories. It
must not include tokens, terminal input, PTY output, run input, command lines,
clipboard data, environment values, or recording payloads.

## Boundaries

The gateway must not spawn processes, own canonical terminal state, call
Electron windows, interpret terminal content, or bypass the terminal service.

## Testing Expectations

- Authentication and protocol-version failures fail closed.
- Invalid requests never reach services.
- Attachment is exclusive between agent connections.
- Disconnect releases attachment without closing sessions.
- Policy denial prevents side effects and produces a typed result.
- Pending observations are cancelled when their connection closes.
- Audit records contain safe metadata only.
- Temporary PTY runs grant session attachment only to the creating connection.
- Operation-ID observation and close work after reconnect.
- Run input is absent from policy and audit records.
