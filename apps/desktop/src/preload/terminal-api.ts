import type {
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
};

export function createRendererTerminalApi({
  invoke,
  subscribe,
}: RendererTerminalApiDependencies): RendererTerminalApi {
  return {
    createSession: (request) =>
      invokeCommand(invoke, createRendererCommand("session.create", request)),
    write: (request) => invokeCommand(invoke, createRendererCommand("session.write", request)),
    resize: (request) => invokeCommand(invoke, createRendererCommand("session.resize", request)),
    kill: (request) => invokeCommand(invoke, createRendererCommand("session.kill", request)),
    getSession: (request) => invokeCommand(invoke, createRendererCommand("session.get", request)),
    getConfig: () => invokeCommand(invoke, createRendererCommand("settings.get", {})),
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

function eventMatchesSession(event: RendererSessionEvent, sessionId: SessionId): boolean {
  switch (event.type) {
    case "session.created":
    case "session.error":
    case "session.exited":
      return event.payload.sessionId === sessionId;
    case "session.output":
      return event.payload.sessionId === sessionId;
  }
}

function isRendererSessionEvent(value: unknown): value is RendererSessionEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.payload)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
    case "session.exited":
      return typeof value.payload.sessionId === "string";
    case "session.output":
      return typeof value.payload.sessionId === "string" && typeof value.payload.data === "string";
    case "session.error":
      return typeof value.payload.type === "string" && typeof value.payload.message === "string";
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
