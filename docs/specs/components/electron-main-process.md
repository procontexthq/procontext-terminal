# Electron Main Process

## Status

Accepted component architecture.

## Purpose

The Electron main process is the trusted native backend for the desktop app. It starts first, owns native integration, creates windows, registers IPC, and wires long-lived services.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Create and manage `BrowserWindow` instances through the window manager.
- Use packaged app icon resources for BrowserWindow and desktop shell branding
  when those resources are available.
- Set the internal product name before resolving app-specific data and log paths.
- On macOS, rely on the native bundle icon for packaged apps. Development may
  replace the stock Electron Dock image as soon as the app is ready, but must
  not override the packaged multi-resolution `.icns` resource at runtime.
- Configure secure renderer settings.
- Register typed IPC handlers.
- Start and stop the local agent gateway.
- Own Electron app lifecycle events.
- Own settings, logs, transcripts, recordings, and app data path resolution.
- Coordinate shutdown so active PTY sessions are terminated or retained for
  explicit cleanup when termination times out.
- Wire the session manager, PTY host, policy engine, recorder, settings store, app logger, and agent gateway.
- Authorize renderer-triggered sensitive operations such as recording control
  before invoking recorder or session-manager side effects.

## Boundaries

The main process must not:

- Render UI.
- Contain xterm.js terminal rendering logic.
- Expose broad native APIs to renderer code.
- Mix terminal PTY output with application diagnostics.
- Let agent requests bypass the same session manager used by the UI.

## Security Requirements

- Use context isolation for renderer windows.
- Keep direct Node.js access disabled in renderer windows unless a specific documented exception exists.
- Enable renderer sandboxing when the preload bridge can provide the required typed API.
- Expose native operations only through typed IPC and the preload bridge.
- Treat renderer requests, agent requests, settings files, and recordings as untrusted runtime input.
- Delegate authorization decisions to the policy engine before sensitive terminal operations.
- Log policy decisions with structured safe metadata such as request ID, session
  ID, origin, decision ID, outcome, and denial code, without terminal input,
  PTY output, or transcript payloads.
- Treat destroyed or crashed renderer web contents as unavailable for
  renderer-dependent display and observation.
- Remove renderer ownership when a renderer is destroyed and return preserved
  sessions to headless presentation without changing PTY lifecycle.

## Collaborators

- [Window Manager](./window-manager.md) for desktop window lifecycle.
- [Preload Bridge](./preload-bridge.md) for the renderer-facing API.
- [Terminal Session Manager](./terminal-session-manager.md) for canonical terminal lifecycle.
- [PTY Host](./pty-host.md) for real pseudoterminal operations.
- [Agent Gateway](./agent-gateway.md) for external agent control.
- [Settings Store](./settings-store.md) for persisted configuration.
- [App Logger](./app-logger.md) for diagnostics.

## Testing Expectations

- App startup creates the expected secure window configuration.
- IPC handlers validate request payloads and return typed domain errors.
- IPC recording start, stop, and export handlers deny cleanly without recorder
  side effects when policy denies the request.
- Renderer destruction removes renderer ownership and leaves preserved running
  sessions headless without terminating their PTYs.
- Phase 1 app shutdown terminates active sessions with a bounded timeout; later
  restore or presentation policies must preserve the view/session distinction.
- Main-process services can be wired without renderer imports or circular dependencies.
- Packaged app verification checks native product name, identifier, executable,
  and icon metadata in addition to checking that icon files exist.
