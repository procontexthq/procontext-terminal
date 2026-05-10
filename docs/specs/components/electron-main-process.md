# Electron Main Process

## Status

Accepted component architecture.

## Purpose

The Electron main process is the trusted native backend for the desktop app. It starts first, owns native integration, creates windows, registers IPC, and wires long-lived services.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Create and manage `BrowserWindow` instances through the window manager.
- Configure secure renderer settings.
- Register typed IPC handlers.
- Start and stop the local agent gateway.
- Own Electron app lifecycle events.
- Own settings, logs, transcripts, recordings, and app data path resolution.
- Coordinate shutdown so PTY sessions are terminated, detached, or restored according to policy.
- Wire the session manager, PTY host, policy engine, recorder, settings store, app logger, and agent gateway.

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
- Phase 1 app shutdown terminates active sessions with a bounded timeout; later restore or detach policies must preserve the view/session distinction.
- Main-process services can be wired without renderer imports or circular dependencies.
