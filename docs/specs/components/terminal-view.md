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
- Forward xterm-generated input bytes through the preload bridge.
- Fit the terminal and request canonical resize.
- Report human viewport scrolling.
- Apply canonical viewport changes requested by an agent.
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
- Human input reaches the shared raw input operation.
- Human and agent scrolling remain synchronized without feedback loops.
- Exited sessions stay visible and reject input.
