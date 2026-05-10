# Preload Bridge

## Status

Accepted component architecture.

## Purpose

The preload bridge is the only API exposed to renderer application code. It hides raw Electron IPC behind a narrow typed terminal API.

This component is part of the [Terminal Architecture Spec](../terminal-architecture.md).

## Responsibilities

- Expose a typed `window.terminalApi` surface.
- Hide raw `ipcRenderer`.
- Validate outbound renderer requests before they leave the renderer boundary when practical.
- Normalize subscription cleanup for output, exit, title, bell, error, resize, and snapshot events.
- Prevent renderer code from importing Node.js modules directly.
- Convert IPC responses into typed success or domain error results.

## Exposed Surface

```ts
type RendererTerminalApi = {
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  write(request: WriteInputRequest): Promise<void>;
  resize(request: ResizeSessionRequest): Promise<void>;
  kill(request: KillSessionRequest): Promise<void>;
  getSession(request: GetSessionRequest): Promise<TerminalSessionSnapshot>;
  getConfig(): Promise<TerminalConfig>;
  onSessionEvent(
    sessionId: SessionId,
    handler: (event: RendererSessionEvent) => void,
  ): Unsubscribe;
};
```

The concrete API can evolve, but it must remain explicit, typed, and minimal.

## Boundaries

The preload bridge must not:

- Spawn processes.
- Store business logic.
- Own UI state.
- Expose unrestricted filesystem, process, or shell APIs.
- Leak Electron IPC channel names as the renderer's primary programming model.

## Subscription Rules

- Every long-lived subscription must return an `Unsubscribe` function.
- Event handlers must be scoped by session ID or an explicit global event type.
- Cleanup must be idempotent.
- Events from the main process must be narrowed to known renderer event types before delivery.
- Command calls must use the typed IPC result envelope internally and expose ergonomic resolved values or typed terminal errors to renderer code.

## Testing Expectations

- Renderer code cannot access raw `ipcRenderer`.
- Each preload method sends the expected typed command.
- Invalid request payloads fail closed.
- Subscription cleanup removes listeners and can be called more than once.
