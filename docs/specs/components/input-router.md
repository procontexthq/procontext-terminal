# Terminal Input

## Status

Accepted component architecture.

## Purpose

Every PTY receives one ordered raw input stream. The protocol does not model
text, keys, paste, mouse reports, or interrupts as separate terminal
operations.

## Contract

```ts
type TerminalInputRequest = {
  sessionId: SessionId;
  input: string;
};
```

xterm.js already produces the bytes required for human keyboard, paste, and
mouse interaction. Agents may send commands, control bytes, escape sequences,
paste data, or TUI input through the same field. SDKs may provide encoding
helpers, but helpers do not add protocol commands.

Input origin remains internal metadata with `human`, `agent`, and `system`
values for policy and recording. It is not encoded into PTY bytes or exposed as
multiple public methods.

Before accepted input is written, the shared viewport returns to the live
bottom. Input is rejected while the session is creating, exiting, exited, or
failed.

## Boundaries

The input path must not infer shell commands, detect prompts, rewrite bytes, or
interpret actions inside editors, pagers, REPLs, debuggers, or remote shells.

## Testing Expectations

- Human and agent bytes use the same session write path.
- Rapid mixed-origin input preserves accepted order.
- Control and mouse-reporting bytes are not altered.
- Input returns the viewport to the live bottom.
- Closed sessions reject input with typed errors.
