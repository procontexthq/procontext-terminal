# Input Router

## Status

Accepted component architecture.

## Purpose

The input router converts human and agent intent into terminal input. All terminal input should flow through the same routing path before reaching the PTY.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Forward raw user input from xterm.js to the session manager.
- Encode high-level key commands such as `Enter`, `Tab`, `Ctrl+C`, arrows, function keys, and escape.
- Keep paste behavior distinct from keypress behavior.
- Support mouse event forwarding for TUI interactions.
- Mark input origin as `human`, `agent`, or `system` for audit and replay.
- Preserve input ordering for a session.

## Boundaries

The input router must not:

- Authorize agent operations directly.
- Spawn PTY sessions.
- Rewrite terminal output.
- Store transcripts.
- Guess semantic intent inside TUIs.

Authorization happens before agent input reaches the router. Encoding and routing happen after authorization.

## Input Origins

Input origin is part of the observable contract.

- `human`: keyboard, paste, or mouse action from a renderer window.
- `agent`: command issued through the local agent gateway.
- `system`: internal terminal operation such as a controlled restore or scripted setup action.

Origin must be available to the recorder, policy engine, audit log, and replay tooling.

## Encoding Requirements

- Raw data from xterm.js can pass through when xterm.js already produced terminal bytes.
- High-level key names must map to documented byte sequences.
- Paste input must be distinguishable from repeated keypress input.
- Mouse input must be forwarded only when terminal modes request or allow it.

## Testing Expectations

- Each supported key command maps to the expected terminal sequence.
- Paste events preserve content and origin.
- Human and agent input use the same session write path after authorization.
- Input ordering is stable under rapid key, paste, and agent writes.
