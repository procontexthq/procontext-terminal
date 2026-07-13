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
- Handle correlated presentation open, focus, hide, and close commands from
  main and acknowledge them after the requested tab/view action settles.

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
- Running, exiting, exited, or failed lifecycle state plus independent
  presentation state.
- Exit code and signal.
- Session owner and creation origin.

Session status shown in the UI should follow session lifecycle events without
regressing from terminal states. For example, a trailing output event delivered
after an exit event must not flip an exited session back to running.

Development-only render behavior must not create extra PTY sessions. The app
shell should avoid React lifecycle modes that intentionally double-mount
side-effectful terminal views unless terminal creation is made idempotent.

## Phase 2A Tabs

The first multi-session milestone supports tabs only.

- Each tab owns one terminal controller and one PTY session.
- Inactive tab terminals stay mounted and hidden so output, scrollback, and
  terminal renderer state continue to exist while the user views another tab.
- Closing a running tab requires user confirmation before termination.
- Closing an exited or failed tab releases the session record immediately.
- Closing the final tab from the tab close button closes the app window instead
  of silently replacing it with another terminal. The tab model can still create
  a fallback tab as an internal invalid-state guard.
- Tab keyboard shortcuts must operate on the renderer tab model, not on the
  Electron window. On macOS, `Cmd+T` creates a tab, `Cmd+W` closes the active
  tab, and `Cmd+Shift+[` / `Cmd+Shift+]` switch to the previous/next tab. On
  Windows and Linux, `Ctrl+Shift+T` creates a tab, `Ctrl+Shift+W` closes the
  active tab, and `Ctrl+PageUp` / `Ctrl+PageDown` switch tabs. Plain `Ctrl+W`
  must remain terminal input on Windows and Linux.
- Exited and failed tabs must remain visible with an explicit terminal message
  so the user can tell that blinking cursor state no longer maps to a live PTY.
- Tab labels prefer canonical session title events and fall back to cwd, shell,
  or a numbered terminal label. Shell-provided titles are not restored after
  app restart.
- Canonical bell events mark inactive tabs unread; activating the tab clears
  the unread indicator.
- The renderer may expose UI themes for chrome and terminal framing. The
  selected UI theme is persisted through typed settings and must not affect PTY
  launch semantics or terminal transcript data. Theme fonts may change renderer
  chrome and xterm rendering fonts, but only through bundled renderer assets
  with normal system font fallbacks so missing font assets never block startup.
  The renderer waits briefly for selected theme fonts before xterm's first
  open/fit and remeasures after late font loading so cold startup and theme
  switching use stable terminal cell metrics.
  The visible terminal frame, padding, scroll area, and xterm theme background
  must use the same resolved theme background so theme switching does not leave
  mismatched gutter colors.
- Startup reconciliation may create visible views for live headless sessions
  according to presentation policy. A missing renderer view never changes PTY
  lifecycle.
- Background presentation opens a tab without selecting it. Foreground
  presentation selects the tab and focuses its xterm instance. Headless
  presentation removes the view without terminating the PTY.
- Startup creates one default human terminal tab. Human tab count, tab order,
  active tab, cwd, and shell launch metadata are not persisted or restored from
  settings across app restarts.
- The default human terminal tab does not synthesize a working directory in the
  renderer. When no tab launch metadata provides `cwd`, main/session-core
  launches the shell from the platform user home directory, matching native
  terminal startup behavior for packaged apps.

## Testing Expectations

- UI actions call the preload API rather than main-process or PTY modules.
- Session status renders from canonical session summaries and observations.
- Agent activity and policy-denial states are visible to users.
- Closing a tab or pane follows the configured detach or terminate behavior.
