# Terminal View

## Status

Accepted component architecture.

## Purpose

The terminal view wraps xterm.js and owns terminal rendering behavior in the renderer. It displays PTY output, captures terminal input, and exposes observable screen state to the screen observer.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Create and dispose xterm.js `Terminal` instances.
- Load required xterm.js addons.
- Render PTY output using `terminal.write`.
- Capture user input using xterm.js input events.
- Support copy, paste, selection, links, search, bell, title changes, and accessibility settings.
- Fit terminal rows and columns to container size.
- Report terminal resize events to the main process.
- Surface visible buffer state to the [Screen Observer](./screen-observer.md).

## Boundaries

The terminal view must not:

- Call `node-pty`.
- Spawn child processes.
- Own session lifecycle policy.
- Interpret agent permissions.
- Treat output bytes as application logs.

## Terminal Behavior

The terminal view must preserve xterm.js behavior for:

- ANSI parsing and rendering.
- Cursor rendering.
- Scrollback.
- Selection.
- Alternate screen.
- Mouse reporting modes.
- Terminal title and bell events.
- Raw keyboard and paste input.

## Resize Behavior

Resize must update both visible terminal geometry and the PTY session.

- Container resize updates xterm.js rows and columns.
- The calculated rows and columns are sent through the preload API.
- The session manager forwards resize to the PTY host.
- Resize events are recorded when recording is enabled.

## Testing Expectations

- PTY output is rendered through xterm.js.
- User input flows through the input router and preload API.
- Resize changes produce stable rows and columns.
- Alternate-screen content is observable.
- Copy, paste, selection, title, bell, and link behavior are covered through renderer or E2E tests.
