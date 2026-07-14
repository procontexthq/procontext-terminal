# Canonical Terminal Observation

## Status

Accepted component architecture.

## Purpose

Every PTY-backed session owns a headless xterm.js emulator outside the renderer.
It is the canonical source for agent observation, renderer bootstrap, terminal
dimensions, scrollback, cursor state, title, alternate-screen state, integrated
working directory, and shared viewport position.

## Observation Contract

`terminal.observe` returns the current observation immediately when no
`afterVersion` is supplied. With `afterVersion`, it waits for a newer settled
version, lifecycle completion, cancellation, or timeout. A timeout returns only
the current version and never repeats the viewport.

Versions advance after an observable operation settles:

- PTY output has been parsed by the canonical emulator.
- Resize has reached both PTY and emulator.
- Shared viewport position changes.
- Cursor visibility, title, buffer, presentation, recording, shell integration,
  command state, current cwd, or lifecycle changes.

Several fields changed by one parsed output chunk commit as one new version.

## Viewport

The viewport contains the rendered terminal rows currently shared by human and
agent controllers. It includes row text, wrapping, dimensions, cursor,
normal/alternate buffer identity, offset from the live bottom, boundaries,
retained scrollback, and unseen-row count. It is not raw ANSI output or a full
transcript.

Normal-buffer scrolling mutates the shared viewport. Alternate-screen
applications normally have no local scrollback, so local scroll requests are
unchanged; input intended for the application still uses terminal input.

## Reliability

- PTY output is processed in arrival order.
- Exit is committed only after all earlier output writes settle.
- Cursor show/hide sequences are tracked explicitly.
- Title and bell originate from the canonical parser, not renderer callbacks.
- Headless observation works without a window or terminal tab.
- A newly attached renderer receives a serialized framebuffer and an output
  sequence fence before live output resumes.

## Testing Expectations

- ANSI, Unicode, wrapping, cursor visibility, title, and alternate buffer state
  are represented accurately.
- Observation versions settle after parser callbacks.
- Headless sessions remain observable.
- Timeout and cancellation do not leak waiters.
- Renderer bootstrap cannot lose or duplicate concurrent output.
