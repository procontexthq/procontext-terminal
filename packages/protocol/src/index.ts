import { z } from "zod";

type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand };

export type SessionId = Brand<string, "SessionId">;
export type RequestId = Brand<string, "RequestId">;

export type SessionState = "creating" | "running" | "exiting" | "exited" | "failed";
export type InputOrigin = "human" | "agent" | "system";

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
};

export type TerminalConfig = {
  schemaVersion: 1;
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    theme: TerminalTheme;
  };
  shell: {
    defaultProfile: string | null;
  };
};

export type TerminalErrorType =
  | "invalid_request"
  | "pty_spawn_failed"
  | "session_not_found"
  | "session_not_running"
  | "session_write_failed"
  | "session_resize_failed"
  | "session_kill_failed";

export type TerminalError = {
  type: TerminalErrorType;
  message: string;
  sessionId?: SessionId;
  operation?: string;
  cause?: string;
};

export type CreateSessionRequest = {
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
};

export type WriteInputRequest = {
  sessionId: SessionId;
  data: string;
};

export type ResizeSessionRequest = {
  sessionId: SessionId;
  cols: number;
  rows: number;
};

export type KillSessionRequest = {
  sessionId: SessionId;
};

export type GetSessionRequest = {
  sessionId: SessionId;
};

export type TerminalSessionSnapshot = {
  sessionId: SessionId;
  state: SessionState;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  title: string | null;
  createdBy: InputOrigin;
  createdAt: string;
  updatedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: TerminalError;
};

export type SessionExitEvent = {
  sessionId: SessionId;
  exitCode: number | null;
  signal: string | null;
};

export type RendererSessionEvent =
  | { type: "session.created"; payload: TerminalSessionSnapshot }
  | { type: "session.output"; payload: { sessionId: SessionId; data: string } }
  | { type: "session.exited"; payload: SessionExitEvent }
  | { type: "session.error"; payload: TerminalError };

export type RendererCommand =
  | { type: "session.create"; requestId: RequestId; payload: CreateSessionRequest }
  | { type: "session.write"; requestId: RequestId; payload: WriteInputRequest }
  | { type: "session.resize"; requestId: RequestId; payload: ResizeSessionRequest }
  | { type: "session.kill"; requestId: RequestId; payload: KillSessionRequest }
  | { type: "session.get"; requestId: RequestId; payload: GetSessionRequest }
  | { type: "settings.get"; requestId: RequestId; payload: Record<string, never> };

export type RendererCommandType = RendererCommand["type"];

export type RendererCommandPayload<TType extends RendererCommandType> = Extract<
  RendererCommand,
  { type: TType }
>["payload"];

export type RendererCommandResult<TValue = unknown> =
  | { ok: true; requestId: RequestId; value: TValue }
  | { ok: false; requestId: RequestId; error: TerminalError };

export type Unsubscribe = () => void;

export type RendererTerminalApi = {
  createSession(request: CreateSessionRequest): Promise<TerminalSessionSnapshot>;
  write(request: WriteInputRequest): Promise<void>;
  resize(request: ResizeSessionRequest): Promise<void>;
  kill(request: KillSessionRequest): Promise<void>;
  getSession(request: GetSessionRequest): Promise<TerminalSessionSnapshot>;
  getConfig(): Promise<TerminalConfig>;
  onSessionEvent(sessionId: SessionId, handler: (event: RendererSessionEvent) => void): Unsubscribe;
};

export class TerminalApiError extends Error {
  override readonly name = "TerminalApiError";

  constructor(
    readonly requestId: RequestId,
    readonly terminalError: TerminalError,
  ) {
    super(terminalError.message);
  }
}

export const sessionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as SessionId);
export const requestIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as RequestId);

const terminalDimensions = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};

export const terminalThemeSchema = z.object({
  background: z.string().min(1),
  foreground: z.string().min(1),
  cursor: z.string().min(1),
});

export const terminalConfigSchema = z.object({
  schemaVersion: z.literal(1),
  terminal: z.object({
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(8).max(40),
    scrollback: z.number().int().min(100).max(100000),
    theme: terminalThemeSchema,
  }),
  shell: z.object({
    defaultProfile: z.string().min(1).nullable(),
  }),
});

export const terminalErrorTypeSchema = z.enum([
  "invalid_request",
  "pty_spawn_failed",
  "session_not_found",
  "session_not_running",
  "session_write_failed",
  "session_resize_failed",
  "session_kill_failed",
]);

export const terminalErrorSchema = z.object({
  type: terminalErrorTypeSchema,
  message: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
  operation: z.string().min(1).optional(),
  cause: z.string().optional(),
});

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  ...terminalDimensions,
});

export const writeInputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  data: z.string(),
});

export const resizeSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  ...terminalDimensions,
});

export const killSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
});

export const getSessionRequestSchema = killSessionRequestSchema;

export const rendererCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.create"),
    requestId: requestIdSchema,
    payload: createSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.write"),
    requestId: requestIdSchema,
    payload: writeInputRequestSchema,
  }),
  z.object({
    type: z.literal("session.resize"),
    requestId: requestIdSchema,
    payload: resizeSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.kill"),
    requestId: requestIdSchema,
    payload: killSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.get"),
    requestId: requestIdSchema,
    payload: getSessionRequestSchema,
  }),
  z.object({
    type: z.literal("settings.get"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
]);

export const rendererCommandResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    requestId: requestIdSchema,
    value: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    requestId: requestIdSchema,
    error: terminalErrorSchema,
  }),
]);

export function createSessionId(value = randomId("session")): SessionId {
  return sessionIdSchema.parse(value);
}

export function createRequestId(value = randomId("request")): RequestId {
  return requestIdSchema.parse(value);
}

export function createRendererCommand<TType extends RendererCommandType>(
  type: TType,
  payload: RendererCommandPayload<TType>,
  requestId = createRequestId(),
): Extract<RendererCommand, { type: TType }> {
  return parseRendererCommand({ type, requestId, payload }) as Extract<
    RendererCommand,
    { type: TType }
  >;
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  return createSessionRequestSchema.parse(value);
}

export function parseWriteInputRequest(value: unknown): WriteInputRequest {
  return writeInputRequestSchema.parse(value);
}

export function parseResizeSessionRequest(value: unknown): ResizeSessionRequest {
  return resizeSessionRequestSchema.parse(value);
}

export function parseKillSessionRequest(value: unknown): KillSessionRequest {
  return killSessionRequestSchema.parse(value);
}

export function parseGetSessionRequest(value: unknown): GetSessionRequest {
  return getSessionRequestSchema.parse(value);
}

export function parseTerminalConfig(value: unknown): TerminalConfig {
  return terminalConfigSchema.parse(value);
}

export function parseRendererCommand(value: unknown): RendererCommand {
  return rendererCommandSchema.parse(value);
}

export function parseRendererCommandResult(value: unknown): RendererCommandResult<unknown> {
  return rendererCommandResultSchema.parse(value);
}

export function createTerminalError(
  type: TerminalErrorType,
  message: string,
  details: Omit<TerminalError, "type" | "message"> = {},
): TerminalError {
  return { type, message, ...details };
}

export function createRendererCommandSuccess<TValue>(
  requestId: RequestId,
  value: TValue,
): RendererCommandResult<TValue> {
  return { ok: true, requestId, value };
}

export function createRendererCommandFailure(
  requestId: RequestId,
  error: TerminalError,
): RendererCommandResult<never> {
  return { ok: false, requestId, error };
}

export function unwrapRendererCommandResult<TValue>(result: RendererCommandResult<TValue>): TValue {
  if (result.ok) {
    return result.value;
  }

  throw new TerminalApiError(result.requestId, result.error);
}

export function isRendererSessionEvent(value: unknown): value is RendererSessionEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.payload)) {
    return false;
  }

  switch (value.type) {
    case "session.created":
      return typeof value.payload.sessionId === "string";
    case "session.output":
      return typeof value.payload.sessionId === "string" && typeof value.payload.data === "string";
    case "session.exited":
      return typeof value.payload.sessionId === "string";
    case "session.error":
      return typeof value.payload.type === "string" && typeof value.payload.message === "string";
    default:
      return false;
  }
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
