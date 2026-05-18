# Renderer App Shell

## Status

Accepted component architecture.

## Purpose

The renderer app shell is the human-facing UI for terminal sessions. It manages visible layout and user workflow while treating the main process as the canonical owner of terminal state.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Layout the terminal surface.
- Manage tabs, panes, session list, status bar, settings, and command palette.
- Route focus between terminal instances.
- Show agent activity indicators and permission prompts.
- Display session status such as running, exited, disconnected, or blocked by policy.
- Keep UI state separate from terminal process state.
- Request terminal operations through the preload bridge.

## Boundaries

The renderer app shell must not:

- Import `node-pty`.
- Spawn shells or child processes.
- Import main-process modules.
- Treat UI state as canonical terminal lifecycle state.
- Persist terminal transcripts directly.

The renderer can store ephemeral UI state such as selected tab, pane sizing, local search text, and active command palette state.

## UI State vs Session State

UI state answers what the human is looking at. Session state answers what the terminal is doing.

Examples of UI state:

- Active tab.
- Focused pane.
- Sidebar visibility.
- Search query.
- Temporary command palette selection.

Examples of canonical session state:

- Session ID.
- Shell, cwd, rows, columns, title.
- Running, detached, exited, or failed lifecycle state.
- Exit code and signal.
- Session owner and creation origin.

Session status shown in the UI should follow session lifecycle events without
regressing from terminal states. For example, a trailing output event delivered
after an exit event must not flip an exited session back to running.

## Phase 2A Tabs

The first multi-session milestone supports tabs only.

- Each tab owns one terminal controller and one PTY session.
- Inactive tab terminals stay mounted and hidden so output, scrollback, and
  terminal renderer state continue to exist while the user views another tab.
- Closing a running tab requires user confirmation before termination.
- Closing an exited or failed tab releases the session record immediately.
- Closing the final tab creates a new default terminal tab.
- Tab labels prefer terminal title events and fall back to cwd, shell, or a
  numbered terminal label. Shell-provided titles are not restored after app
  restart.
- Bell events mark inactive tabs unread; activating the tab clears the unread
  indicator.
- Workspace restore persists tab order, active tab, shell, and launch cwd, then
  starts fresh PTY sessions on restart.

## Testing Expectations

- UI actions call the preload API rather than main-process or PTY modules.
- Session status renders from session snapshots and events.
- Agent activity and policy-denial states are visible to users.
- Closing a tab or pane follows the configured detach or terminate behavior.
