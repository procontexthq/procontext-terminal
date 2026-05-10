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

## Testing Expectations

- UI actions call the preload API rather than main-process or PTY modules.
- Session status renders from session snapshots and events.
- Agent activity and policy-denial states are visible to users.
- Closing a tab or pane follows the configured detach or terminate behavior.
