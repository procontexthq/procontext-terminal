import { z } from "zod";

import {
  operationIdSchema,
  requestIdSchema,
  sessionIdSchema,
  type OperationId,
  type RequestId,
  type SessionId,
} from "./ids.js";

export const terminalErrorTypes = [
  "invalid_request",
  "auth_required",
  "auth_failed",
  "protocol_version_unsupported",
  "policy_denied",
  "gateway_failed",
  "process_spawn_failed",
  "pty_spawn_failed",
  "operation_not_found",
  "operation_close_failed",
  "session_not_found",
  "session_not_running",
  "session_in_use",
  "session_input_failed",
  "session_resize_failed",
  "session_scroll_failed",
  "session_close_failed",
  "observation_failed",
  "recording_failed",
  "view_unavailable",
  "settings_save_failed",
] as const;

export type TerminalErrorType = (typeof terminalErrorTypes)[number];

export type TerminalError = {
  type: TerminalErrorType;
  message: string;
  sessionId?: SessionId;
  operationId?: OperationId;
  operation?: string;
  cause?: string;
};

export const terminalErrorSchema = z.object({
  type: z.enum(terminalErrorTypes),
  message: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
  operationId: operationIdSchema.optional(),
  operation: z.string().min(1).optional(),
  cause: z.string().optional(),
});

export type CommandResult<TValue = unknown> =
  | { ok: true; requestId: RequestId; value: TValue }
  | { ok: false; requestId: RequestId; error: TerminalError };

export const commandResultSchema = z.union([
  z.object({ ok: z.literal(true), requestId: requestIdSchema, value: z.unknown() }),
  z.object({ ok: z.literal(false), requestId: requestIdSchema, error: terminalErrorSchema }),
]);

export class TerminalApiError extends Error {
  override readonly name = "TerminalApiError";

  constructor(
    readonly requestId: RequestId,
    readonly terminalError: TerminalError,
  ) {
    super(terminalError.message);
  }
}

export function createTerminalError(
  type: TerminalErrorType,
  message: string,
  details: Omit<TerminalError, "type" | "message"> = {},
): TerminalError {
  return { type, message, ...details };
}

export function createCommandSuccess<TValue>(
  requestId: RequestId,
  value: TValue,
): CommandResult<TValue> {
  return { ok: true, requestId, value };
}

export function createCommandFailure(
  requestId: RequestId,
  error: TerminalError,
): CommandResult<never> {
  return { ok: false, requestId, error };
}

export function unwrapCommandResult<TValue>(result: CommandResult<TValue>): TValue {
  if (result.ok) return result.value;
  throw new TerminalApiError(result.requestId, result.error);
}
