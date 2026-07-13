import {
  createRendererCommand,
  isRendererSessionEvent,
  parseRendererCommandResult,
  unwrapRendererCommandResult,
  type AppShortcutAction,
  type RendererCommand,
  type RendererSessionEvent,
  type RendererTerminalApi,
  type SessionId,
  type Unsubscribe,
} from "@terminal/protocol";

export type RendererTerminalApiDependencies = {
  invoke: (command: RendererCommand) => Promise<unknown>;
  subscribe: (handler: (payload: unknown) => void) => Unsubscribe;
  subscribeAppShortcut: (handler: (payload: unknown) => void) => Unsubscribe;
};

export function createRendererTerminalApi({
  invoke,
  subscribe,
  subscribeAppShortcut,
}: RendererTerminalApiDependencies): RendererTerminalApi {
  return {
    createSession: (request) =>
      invokeCommand(invoke, createRendererCommand("session.create", request)),
    listSessions: () => invokeCommand(invoke, createRendererCommand("session.list", {})),
    getSession: (request) => invokeCommand(invoke, createRendererCommand("session.get", request)),
    input: (request) => invokeCommand(invoke, createRendererCommand("session.input", request)),
    resize: (request) => invokeCommand(invoke, createRendererCommand("session.resize", request)),
    scroll: (request) => invokeCommand(invoke, createRendererCommand("session.scroll", request)),
    close: (request) => invokeCommand(invoke, createRendererCommand("session.close", request)),
    openView: (request) =>
      invokeCommand(invoke, createRendererCommand("session.openView", request)),
    closeView: (request) =>
      invokeCommand(invoke, createRendererCommand("session.closeView", request)),
    reportViewport: (request) =>
      invokeCommand(invoke, createRendererCommand("session.reportViewport", request)),
    startRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.start", request)),
    stopRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.stop", request)),
    exportRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.export", request)),
    getConfig: () => invokeCommand(invoke, createRendererCommand("settings.get", {})),
    saveUiTheme: (theme) =>
      invokeCommand(invoke, createRendererCommand("settings.saveUiTheme", { theme })),
    presentationReady: () => invokeCommand(invoke, createRendererCommand("presentation.ready", {})),
    acknowledgePresentation: (request) =>
      invokeCommand(invoke, createRendererCommand("presentation.acknowledge", request)),
    onAppShortcut: (handler) =>
      subscribeAppShortcut((payload) => {
        if (isAppShortcutAction(payload)) handler(payload);
      }),
    onTerminalEvent: (handler) =>
      subscribe((payload) => {
        if (isRendererSessionEvent(payload)) handler(payload);
      }),
    onSessionEvent: (sessionId, handler) =>
      subscribe((payload) => {
        if (isRendererSessionEvent(payload) && eventMatchesSession(payload, sessionId)) {
          handler(payload);
        }
      }),
  };
}

async function invokeCommand<TValue>(
  invoke: RendererTerminalApiDependencies["invoke"],
  command: RendererCommand,
): Promise<TValue> {
  return unwrapRendererCommandResult(parseRendererCommandResult(await invoke(command))) as TValue;
}

function eventMatchesSession(event: RendererSessionEvent, sessionId: SessionId): boolean {
  switch (event.type) {
    case "session.output":
    case "session.viewport":
    case "session.updated":
    case "session.bell":
      return event.payload.sessionId === sessionId;
    case "session.error":
      return event.payload.sessionId === sessionId;
    case "agent.activity":
    case "presentation.command":
      return false;
  }
}

function isAppShortcutAction(value: unknown): value is AppShortcutAction {
  return (
    value === "newTab" || value === "closeTab" || value === "previousTab" || value === "nextTab"
  );
}
