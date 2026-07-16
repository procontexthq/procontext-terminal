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
- Serialize presentation transitions for each session in request order while
  allowing different sessions to transition independently.
- Preserve terminal sessions when native windows close and coordinate explicit
  termination with the terminal session manager.
- Surface confirmation before an explicit human action terminates a live session.

## Boundaries

The window manager must not:

- Spawn PTYs.
- Own canonical terminal lifecycle state.
- Implement terminal input encoding.
- Decide agent permissions.
- Store terminal transcripts.

Window state is UI state. Terminal session state remains owned by the [Terminal Session Manager](./terminal-session-manager.md).

Window restoration is limited to validated size, position, and display
placement. It must not restore terminal sessions, tabs, operations, PTY runtime
state, or workspace layouts.

The primary window restores schema-validated `x`, `y`, `width`, `height`, and
numeric display ID. Restored bounds are clamped to that display's work area. If
the recorded display is unavailable, the primary window uses centered,
work-area-clamped defaults on the current primary display. Move and resize
events are debounced before the main process writes geometry; window close
flushes the latest normal bounds. Secondary presentation windows neither
restore nor replace the primary-window geometry.

Direct app quit awaitably flushes and detaches the primary-window persistence
before the main process drains queued settings writes. A pending move or resize
debounce therefore cannot be lost during shutdown, and the later native window
close cannot enqueue a duplicate geometry write.

## Platform Window Chrome

The terminal header is the single in-window title and command surface. Native
window controls remain owned and rendered by the operating system.

- Every platform uses Electron's hidden titlebar style and a 44-pixel Window
  Controls Overlay safe area so the renderer header occupies the titlebar area.
  macOS retains its native traffic-light controls. Windows and Linux restore
  their native controls through the overlay rather than renderer-built
  minimize, maximize, or close buttons.
- Windows and Linux do not install an Electron application menu. This removes
  the redundant persistent menu row and prevents generic browser accelerators
  such as `Ctrl+W`, `Ctrl+Z`, `Ctrl+A`, and `Ctrl+R` from stealing terminal
  input. App-defined tab shortcuts continue through the typed shortcut event.
- macOS retains a native global application menu, limited to conventional app
  lifecycle actions, terminal-tab actions, clipboard selection actions, and
  native window actions, including fullscreen and multi-window registration.
  New Terminal restores a usable window when none is open. Generic File, View,
  development, reload, and browser zoom commands are not exposed.
- The renderer reserves the Window Controls Overlay safe area instead of
  assuming controls are on a particular side. The overlay and renderer header
  use the same height.
- The document and accessible window titles remain the product name for task
  switchers and assistive technology even though the visible native title is
  hidden.

Custom HTML window-control buttons and fully frameless windows are out of scope
because native controls preserve platform accessibility, snapping, resizing,
fullscreen, and window-manager behavior.

## Close Behavior

Window close handling must preserve the distinction between closing a view and ending a session.

- Native window close preserves sessions. Renderer destruction removes its
  views and returns those running sessions to headless presentation.
- Closing a secondary window removes its renderer views without changing PTY
  lifecycle unless the user explicitly terminates those sessions.
- A preserved session becomes headless presentation state while remaining
  `running`.
- On Windows and Linux, closing the last window then follows the platform app
  policy and requests a full app quit. On macOS, the app, gateway, operations,
  and sessions remain active so a new window can reveal preserved sessions.
- Full app quit owns bounded operation and PTY termination on every platform;
  per-window cleanup must not partially shut down those services.
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
- Move and resize persistence is debounced, close flushes the latest normal
  bounds, direct app quit awaits the same flush before settings shutdown, and
  unavailable displays fall back safely.
- Window chrome options preserve native controls on macOS, Windows, and Linux,
  and the renderer titlebar stays inside the operating-system-provided safe
  area at supported window widths.
- Windows and Linux have no application menu or generic menu accelerators;
  macOS exposes only the documented native menu groups.
