import type {
  AppShortcutAction,
  RendererCommand,
  RendererCommandPayload,
  RendererCommandResult,
  RendererCommandType,
  RendererSessionEvent,
  RendererTerminalApi,
  RequestId,
  SessionId,
  TerminalError,
  Unsubscribe,
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
    write: (request) => invokeCommand(invoke, createRendererCommand("session.write", request)),
    sendKey: (request) => invokeCommand(invoke, createRendererCommand("session.sendKey", request)),
    paste: (request) => invokeCommand(invoke, createRendererCommand("session.paste", request)),
    sendMouse: (request) => invokeCommand(invoke, createRendererCommand("session.mouse", request)),
    setTitle: (request) =>
      invokeCommand(invoke, createRendererCommand("session.setTitle", request)),
    reportBell: (request) => invokeCommand(invoke, createRendererCommand("session.bell", request)),
    interrupt: (request) =>
      invokeCommand(invoke, createRendererCommand("session.interrupt", request)),
    resize: (request) => invokeCommand(invoke, createRendererCommand("session.resize", request)),
    kill: (request) => invokeCommand(invoke, createRendererCommand("session.kill", request)),
    detachSession: (request) =>
      invokeCommand(invoke, createRendererCommand("session.detach", request)),
    attachSession: (request) =>
      invokeCommand(invoke, createRendererCommand("session.attach", request)),
    releaseSession: (request) =>
      invokeCommand(invoke, createRendererCommand("session.release", request)),
    getSession: (request) => invokeCommand(invoke, createRendererCommand("session.get", request)),
    readRecentOutput: (request) =>
      invokeCommand(invoke, createRendererCommand("session.readRecentOutput", request)),
    captureScreen: (request) =>
      invokeCommand(invoke, createRendererCommand("session.captureScreen", request)),
    respondToSnapshot: (request) =>
      invokeCommand(invoke, createRendererCommand("session.snapshot.response", request)),
    reportSnapshotUnavailable: (request) =>
      invokeCommand(invoke, createRendererCommand("session.snapshot.unavailable", request)),
    waitForText: (request) =>
      invokeCommand(invoke, createRendererCommand("session.waitForText", request)),
    waitForScreenChange: (request) =>
      invokeCommand(invoke, createRendererCommand("session.waitForScreenChange", request)),
    waitForQuiet: (request) =>
      invokeCommand(invoke, createRendererCommand("session.waitForQuiet", request)),
    waitForPrompt: (request) =>
      invokeCommand(invoke, createRendererCommand("session.waitForPrompt", request)),
    startRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.start", request)),
    stopRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.stop", request)),
    exportRecording: (request) =>
      invokeCommand(invoke, createRendererCommand("recording.export", request)),
    getConfig: () => invokeCommand(invoke, createRendererCommand("settings.get", {})),
    saveUiTheme: (theme) =>
      invokeCommand(invoke, createRendererCommand("settings.saveUiTheme", { theme })),
    onAppShortcut: (handler) =>
      subscribeAppShortcut((payload) => {
        if (isAppShortcutAction(payload)) {
          handler(payload);
        }
      }),
    onTerminalEvent: (handler) =>
      subscribe((payload) => {
        if (isRendererSessionEvent(payload)) {
          handler(payload);
        }
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
  const result = parseRendererCommandResult(await invoke(command));
  return unwrapRendererCommandResult(result) as TValue;
}

function createRendererCommand<TType extends RendererCommandType>(
  type: TType,
  payload: RendererCommandPayload<TType>,
): Extract<RendererCommand, { type: TType }> {
  return { type, requestId: createRequestId(), payload } as Extract<
    RendererCommand,
    { type: TType }
  >;
}

function createRequestId(): RequestId {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) {
    return `request-${cryptoApi.randomUUID()}` as RequestId;
  }
  return `request-${Date.now()}-${Math.random().toString(16).slice(2)}` as RequestId;
}

function parseRendererCommandResult(value: unknown): RendererCommandResult<unknown> {
  if (!isObject(value) || typeof value.ok !== "boolean" || typeof value.requestId !== "string") {
    throw new PreloadTerminalApiError(createRequestId(), {
      type: "invalid_request",
      message: "Invalid renderer command result.",
      operation: "ipc",
    });
  }

  if (value.ok) {
    return {
      ok: true,
      requestId: value.requestId as RequestId,
      value: value.value,
    };
  }

  if (isTerminalError(value.error)) {
    return {
      ok: false,
      requestId: value.requestId as RequestId,
      error: value.error,
    };
  }

  throw new PreloadTerminalApiError(value.requestId as RequestId, {
    type: "invalid_request",
    message: "Invalid renderer command error result.",
    operation: "ipc",
  });
}

function unwrapRendererCommandResult<TValue>(result: RendererCommandResult<TValue>): TValue {
  if (result.ok) {
    return result.value;
  }

  throw new PreloadTerminalApiError(result.requestId, result.error);
}

class PreloadTerminalApiError extends Error {
  override readonly name = "TerminalApiError";

  constructor(
    readonly requestId: RequestId,
    readonly terminalError: TerminalError,
  ) {
    super(terminalError.message);
  }
}

function isAppShortcutAction(value: unknown): value is AppShortcutAction {
  return (
    value === "newTab" || value === "closeTab" || value === "previousTab" || value === "nextTab"
  );
}

function eventMatchesSession(event: RendererSessionEvent, sessionId: SessionId): boolean {
  switch (event.type) {
    case "session.created":
    case "session.attached":
    case "session.detached":
    case "session.error":
    case "session.exited":
    case "session.title":
    case "session.bell":
      return event.payload.sessionId === sessionId;
    case "session.output":
      return event.payload.sessionId === sessionId;
    case "session.snapshot.request":
      return event.payload.sessionId === sessionId;
    case "agent.activity":
      return false;
  }
}

function isRendererSessionEvent(value: unknown): value is RendererSessionEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.payload)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
    case "session.attached":
    case "session.detached":
    case "session.exited":
      return typeof value.payload.sessionId === "string";
    case "session.output":
      return typeof value.payload.sessionId === "string" && typeof value.payload.data === "string";
    case "session.title":
      return typeof value.payload.sessionId === "string" && typeof value.payload.title === "string";
    case "session.bell":
      return typeof value.payload.sessionId === "string";
    case "session.error":
      return typeof value.payload.type === "string" && typeof value.payload.message === "string";
    case "session.snapshot.request":
      return typeof value.requestId === "string" && typeof value.payload.sessionId === "string";
    case "agent.activity":
      return (
        typeof value.payload.activeConnections === "number" &&
        typeof value.payload.authenticatedConnections === "number" &&
        (!("lastActiveAt" in value.payload) ||
          typeof value.payload.lastActiveAt === "string" ||
          value.payload.lastActiveAt === null)
      );
    default:
      return false;
  }
}

function isTerminalError(value: unknown): value is TerminalError {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    typeof value.message === "string" &&
    (!("sessionId" in value) || typeof value.sessionId === "string") &&
    (!("operation" in value) || typeof value.operation === "string") &&
    (!("cause" in value) || typeof value.cause === "string")
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
