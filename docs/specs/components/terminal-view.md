# Terminal View

## Status

Accepted component architecture.

## Purpose

The renderer terminal view is a human-visible projection of canonical
main-process terminal state. It uses xterm.js for rendering and input capture
but does not define terminal truth.

## Responsibilities

- Create and dispose a renderer xterm.js instance.
- Bootstrap from a serialized canonical framebuffer and output sequence.
- Apply later output events in sequence without duplication.
- Forward xterm input bytes through the preload bridge except for responses
  identified as already returned by the canonical model.
- While applying sequenced output, consume an answered terminal query by query
  type so temporary projection-size differences cannot produce a second,
  conflicting response. Preserve ordered returned-or-failed outcomes when an
  output chunk contains multiple queries; a failed occurrence may use the
  projection response without shifting later successful occurrences. Unmatched
  input remains ordinary terminal input.
- Fit the terminal and request canonical resize.
- Report a viewport at the live bottom semantically as bottom, rather than as
  an absolute row that can become stale while output is in flight. Report an
  absolute row only for a historical viewport selected by the human.
- Apply canonical viewport changes requested by an agent.
- Follow live output when the viewport is at the bottom while preserving a
  human-selected historical viewport.
- Preserve selection, copy, paste, mouse reporting, accessibility, and focus.

The canonical model derives title, bell, cursor, wrapping, and alternate-screen
state from PTY output. The renderer does not report those values back to main.

## Lifecycle And Disposal

A renderer view may appear or disappear without changing PTY lifecycle.
Programmatic presentation changes may remove a view while leaving the session
headless. A human close action on a live terminal uses the confirmed session
close path.

Exited terminals retain their final rendered state while their presented view
exists, but do not forward input or PTY resize operations.

## Testing Expectations

- Bootstrap and live output produce the same visible state as the canonical
  model.
- Attach races lose and duplicate no output.
- Output-driven scrolling does not feed stale absolute viewport positions back
  into the canonical model, and a live-bottom viewport follows bursty output to
  its settled bottom.
- Human input reaches the shared raw input operation.
- Canonical terminal responses are not echoed by the renderer when projection
  dimensions differ, and matching keyboard bytes remain forwardable while the
  answered output query is being applied and after it settles.
- Mixed canonical response-write outcomes suppress and fall back at their
  original query occurrences.
- Human and agent scrolling remain synchronized without feedback loops.
- Exited sessions stay visible and reject input.
