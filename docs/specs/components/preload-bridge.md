# Preload Bridge

## Status

Accepted component architecture.

## Purpose

The preload bridge exposes the renderer's narrow typed terminal API while
hiding Electron IPC and all native capabilities.

## Foundation Surface

```ts
type RendererTerminalApi = {
  createSession(request: RendererCreateSessionRequest): Promise<TerminalSessionSummary>;
  getSession(request: GetTerminalRequest): Promise<TerminalSessionSummary>;
  listSessions(): Promise<TerminalSessionSummary[]>;
  input(request: RendererTerminalInputRequest): Promise<TerminalInputResult>;
  resize(request: ResizeTerminalRequest): Promise<ResizeTerminalResult>;
  scroll(request: ScrollTerminalRequest): Promise<ScrollTerminalResult>;
  close(request: CloseTerminalRequest): Promise<CloseTerminalResult>;
  openView(request: OpenTerminalViewRequest): Promise<TerminalViewBootstrap>;
  reportViewport(request: ReportTerminalViewportRequest): Promise<void>;
  getConfig(): Promise<TerminalConfig>;
  getAgentAccessKeyMetadata(): Promise<AgentAccessKeyMetadata>;
  copyAgentAccessKey(): Promise<void>;
  regenerateAgentAccessKey(): Promise<AgentAccessKeyMetadata>;
  presentationReady(): Promise<void>;
  acknowledgePresentation(request: RendererPresentationAcknowledgement): Promise<void>;
  onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe;
};
```

The renderer bootstrap contains serialized terminal state and an output
sequence fence. Session output events carry monotonically increasing sequence
numbers. Renderer-only view registration is not agent attachment and does not
change lifecycle.

Main-to-renderer presentation commands carry a command ID. The renderer
acknowledges completion or failure through the typed command API only after the
requested tab/view mutation settles.

## Boundaries

The bridge must not expose raw `ipcRenderer`, filesystem, process, shell,
node-pty, recorder, or unrestricted Electron APIs. It contains no business
logic. Agent access-key methods expose metadata and action results only; no
method returns the raw key or clipboard contents.

## Testing Expectations

- Every method sends a validated renderer command.
- Access-key copy and regeneration use narrow commands whose responses contain
  no credential material.
- Invalid payloads fail closed.
- Event narrowing rejects unknown messages.
- Subscription cleanup is idempotent.
- No obsolete snapshot or renderer lifecycle operations are exposed.
