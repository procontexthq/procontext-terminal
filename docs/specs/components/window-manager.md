# Window Manager

## Status

Accepted component architecture.

## Purpose

The window manager owns desktop windows and maps renderer windows to visible terminal sessions. It is responsible for app-window behavior, not terminal process state.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Create the primary terminal window.
- Restore window size, position, display, and theme.
- Create additional windows for sessions that should be displayed outside the primary window.
- Keep renderer windows associated with the session IDs they display.
- Best-effort create a renderer window for agent-created sessions when no window is available.
- Create background presentation windows without stealing focus.
- Restore, show, and focus the owning window for foreground presentation.
- Wait for renderer readiness before sending correlated presentation commands.
- Coordinate close behavior with the terminal session manager and settings store.
- Surface user prompts for close, preserve, or terminate decisions when policy requires it.

## Boundaries

The window manager must not:

- Spawn PTYs.
- Own canonical terminal lifecycle state.
- Implement terminal input encoding.
- Decide agent permissions.
- Store terminal transcripts.

Window state is UI state. Terminal session state remains owned by the [Terminal Session Manager](./terminal-session-manager.md).

## Close Behavior

Window close handling must preserve the distinction between closing a view and ending a session.

- Closing the last visible window can terminate sessions, preserve sessions, or prompt according to settings.
- Closing a secondary window removes its renderer views without changing PTY
  lifecycle unless the user explicitly terminates those sessions.
- A preserved session becomes headless presentation state while remaining
  `running`.
- Forced app quit must still give the session manager a bounded chance to terminate or record final state.

## Testing Expectations

- Window creation uses secure Electron options.
- Agent-created sessions remain usable headlessly when renderer window creation fails.
- Renderer acknowledgement timeout or renderer loss returns a structured
  unavailable presentation result without terminating the session.
- Window-to-session associations are updated when views open, move, close, or
  their sessions exit.
- Closing a window does not implicitly terminate a session unless settings or
  explicit user action require it.
- Restored window state is validated before use.
