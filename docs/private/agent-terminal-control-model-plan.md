# Agent Terminal Control Model Plan

## Status

Private working note. This captures current observations and a proposed plan; it
is not yet an accepted public spec.

## Context

The current product goal is a desktop terminal that agents can operate like a
human while sharing the same real PTY sessions as the UI. The existing external
agent gateway already provides a strong product boundary: local WebSocket
transport, short-lived token authentication, runtime validation, policy checks,
audit events, typed errors, human-visible sessions, screen snapshots, and
recording controls.

The private reference note `persistent-remote-terminal-interfaces.md` describes
a simpler terminal model:

```text
start a command in a PTY
keep it alive
get a session id
write more input later
read returned output
```

This note compares that model with the current gateway and lays out a plan to
borrow the useful parts without losing product safety.

## Current Gateway Model

Agents currently connect to the app through an authenticated local WebSocket
gateway, then send typed command envelopes:

```ts
agent.authenticate({ token });
terminal.create({ cwd, shell, cols, rows });
terminal.attach({ sessionId });
terminal.sendText({ sessionId, text });
terminal.sendKey({ sessionId, key });
terminal.paste({ sessionId, text });
terminal.sendMouse({ sessionId, data });
terminal.interrupt({ sessionId });
terminal.readRecentOutput({ sessionId, maxBytes });
terminal.captureScreen({ sessionId });
terminal.waitForText({ sessionId, text, timeoutMs });
terminal.waitForQuiet({ sessionId, quietMs, timeoutMs });
terminal.waitForPrompt({ sessionId, timeoutMs });
```

The important implementation detail is that `terminal.sendText` writes the
provided string directly to the PTY. It can carry printable text, newline or
carriage-return command submission, escape sequences, and control bytes.
`terminal.sendKey` is a named-key convenience over the same byte stream.
`terminal.interrupt` is a semantic Ctrl+C alias.

This means the current gateway can already do the low-level input part of the
persistent terminal model. The friction is mostly naming, command startup, and
output reading.

## Persistent Terminal Reference Model

The reference model exposes two primitives:

```ts
exec_command({
  cmd: string,
  workdir?: string,
  tty?: boolean,
  yield_time_ms?: number,
  max_output_tokens?: number,
});

write_stdin({
  session_id: number,
  chars?: string,
  yield_time_ms?: number,
  max_output_tokens?: number,
});
```

Remote terminals are not a separate abstraction. A persistent remote terminal is
created by running `ssh` inside a persistent local PTY. Future `write_stdin`
calls send bytes into the same still-running SSH process, and SSH forwards those
bytes to the remote shell.

Examples:

```ts
exec_command({ cmd: "ssh user@host", tty: true });
write_stdin({ session_id, chars: "cd /tmp\n" });
write_stdin({ session_id, chars: "\x03" });
```

The model is agent-friendly because the center is small and direct: run or spawn
a process, write raw characters, read output.

## Comparison

### Where The Current Gateway Is Stronger

- Authenticated local transport instead of unrestricted command execution.
- Policy and audit hooks before terminal side effects.
- Explicit session ownership and event filtering.
- Shared human and agent terminal sessions.
- Runtime protocol validation and typed errors.
- Structured terminal observations such as screen snapshots.
- Clear separation between PTY bytes, app logs, agent observations, and
  recording data.

### Where The Reference Model Is Stronger

- The common path is much simpler for agents.
- One call can run a command in a working directory and return a result.
- One call can start an arbitrary persistent process such as `ssh`, a REPL,
  watcher, pager, or TUI.
- Raw input is named clearly as `chars`, not `sendText`.
- Polling output is simple and naturally incremental from the tool call.
- Remote terminal access falls out naturally from `ssh` running in the PTY.

## Main Gaps In The Current Gateway

### `terminal.sendText` Is Misnamed

The method writes raw terminal input, not just text. It can send:

```ts
"\x03"; // Ctrl+C
"\x04"; // Ctrl+D
"\x1b"; // Escape
"ls -la\r"; // Command plus Enter-like submission
```

The name should be `terminal.write({ sessionId, data })`. Keep
`terminal.sendText` as a compatibility alias during migration.

### No One-Shot Command API

The current workflow for "run a command in this directory and give me the
result" is:

```text
terminal.create({ cwd })
terminal.sendText({ text: "pnpm test\r" })
terminal.waitForText / waitForQuiet / waitForPrompt
terminal.readRecentOutput
```

That does not provide a reliable command result. Completion is inferred from
terminal behavior rather than process exit status.

### Session Creation Is Shell-Oriented

`terminal.create` creates a terminal session using a configured shell. It is
useful for human-like shell interaction, but it does not directly express:

```ts
terminal.spawn({ command: "ssh", args: ["user@host"], pty: true });
terminal.spawn({ command: "python", args: ["-i"], pty: true });
```

Agents need both shell sessions and arbitrary persistent process sessions.

### Output Reads Are Tail-Based

`terminal.readRecentOutput` returns a bounded recent tail. Repeated calls can
return overlapping data, so the agent must deduplicate. Agents need cursor-based
incremental reads.

### Specialized Waits Are Too Opinionated

`waitForText`, `waitForQuiet`, `waitForScreenChange`, and `waitForPrompt` are
useful, but they are not a clean core protocol. `waitForPrompt` in particular
assumes shell prompt shape and is weak for remote shells, REPLs, and TUIs.

## Recommended Target Model

Keep the current gateway's security and observation model, but add a smaller
agent-centered core:

```ts
terminal.run({
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty?: boolean;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxOutputBytes?: number;
});

terminal.spawn({
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  pty: boolean;
  cols?: number;
  rows?: number;
});

terminal.createSession({
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
});

terminal.write({
  sessionId: string;
  data: string;
});

terminal.read({
  sessionId: string;
  cursor?: string;
  maxBytes?: number;
});

terminal.captureScreen({ sessionId: string });
terminal.resize({ sessionId: string; cols: number; rows: number });
terminal.interrupt({ sessionId: string });
terminal.kill({ sessionId: string });
terminal.list({});
terminal.get({ sessionId: string });
terminal.attach({ sessionId: string });
terminal.detach({ sessionId: string });
terminal.release({ sessionId: string });
```

Layer convenience APIs above those primitives:

```ts
terminal.key({ sessionId, key, modifiers });
terminal.paste({ sessionId, text, bracketed });
terminal.mouse({ sessionId, event });
terminal.wait({ sessionId, condition, timeoutMs });
```

## Migration Plan

1. Add `terminal.write` as an alias for `terminal.sendText`.
   - Same validation as `sendText`, but payload should be `{ sessionId, data }`.
   - Gateway should force `origin: "agent"` just like `sendText`.
   - Keep `sendText` until consumers and tests migrate.

2. Add cursor-based `terminal.read`.
   - Return `{ sessionId, cursor, data }`.
   - Cursor should advance monotonically over PTY output events.
   - Keep `readRecentOutput` as a compatibility helper.

3. Add `terminal.run` for one-shot commands.
   - Support `cwd`, `env`, timeout, max output, and optional PTY mode.
   - Return process completion data, not a terminal prompt heuristic.
   - Use this for non-interactive commands such as tests, builds, and scripts.

4. Add `terminal.spawn` for persistent arbitrary commands.
   - This is the direct equivalent of starting `ssh`, a REPL, watcher, pager, or
     TUI in a PTY and receiving a session id.
   - Preserve policy checks for command, cwd, env, and PTY use.

5. Rename/document session lifecycle commands.
   - Keep `terminal.create` initially, but introduce `terminal.createSession` for
     shell sessions.
   - Clarify that agent `attach` means ownership/event subscription, not renderer
     attach.

6. Add a generic `terminal.wait`.
   - Conditions should include text, quiet, screen changed, exit, and prompt with
     caller-provided pattern.
   - Treat existing specialized waits as compatibility helpers or SDK-level
     conveniences over time.

7. Keep screen snapshots and recording as product advantages.
   - Do not remove `captureScreen`; it is important for TUI work.
   - Keep recording behind explicit policy because transcripts can contain
     secrets.

## Near-Term Recommendation

Do not replace the current gateway with the raw reference model. Instead, adopt
the reference model's core vocabulary and workflow:

```text
run or spawn a process
write raw input
read incremental output
observe screen when needed
```

The best next implementation slice is:

1. `terminal.write` alias.
2. `terminal.read` with cursors.
3. `terminal.run` for one-shot commands.
4. `terminal.spawn` for persistent arbitrary commands.

That gives agents the simple control loop they need while keeping the app's
authentication, policy, audit, human-visible session, and TUI observation
advantages.
