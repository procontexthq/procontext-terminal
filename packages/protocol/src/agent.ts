import { z } from "zod";

import {
  commandResultSchema,
  createCommandFailure,
  createCommandSuccess,
  type CommandResult,
  type TerminalErrorType,
} from "./errors.js";
import {
  createRequestId,
  decisionIdSchema,
  operationIdSchema,
  requestIdSchema,
  sessionIdSchema,
  type OperationId,
  type RequestId,
  type SessionId,
} from "./ids.js";
import { observeTerminalRequestSchema, type ObserveTerminalRequest } from "./observation.js";
import {
  closeOperationRequestSchema,
  observeCapturedOperationRequestSchema,
  runTerminalRequestSchema,
  type CloseOperationRequest,
  type ObserveCapturedOperationRequest,
  type RunTerminalRequest,
} from "./operations.js";
import { recordingControlRequestSchema, type RecordingControlRequest } from "./recording.js";
import {
  attachTerminalRequestSchema,
  closeTerminalRequestSchema,
  createTerminalRequestSchema,
  getTerminalRequestSchema,
  resizeTerminalRequestSchema,
  setTerminalPresentationRequestSchema,
  scrollTerminalRequestSchema,
  terminalInputRequestSchema,
  type AttachTerminalRequest,
  type CloseTerminalRequest,
  type CreateTerminalRequest,
  type GetTerminalRequest,
  type ResizeTerminalRequest,
  type SetTerminalPresentationRequest,
  type ScrollTerminalRequest,
  type TerminalInputRequest,
} from "./sessions.js";

export const TERMINAL_PROTOCOL_VERSION = 1 as const;
export type TerminalProtocolVersion = typeof TERMINAL_PROTOCOL_VERSION;

export type AgentGatewayDescriptor = {
  url: string;
  token: string;
  tokenExpiresAt: string;
  pid: number;
  protocolVersion: TerminalProtocolVersion;
};

export type AgentAuthenticationResult = {
  authenticatedAt: string;
  tokenExpiresAt: string;
  protocolVersion: TerminalProtocolVersion;
};

export type PolicyDenialCode =
  | "auth_required"
  | "remote_control_disabled"
  | "session_not_owned"
  | "session_in_use";

export type PolicyDenial = {
  decisionId: string;
  code: PolicyDenialCode;
  message: string;
  operation: string;
  sessionId?: SessionId;
  operationId?: OperationId;
};

export type PolicyDecision =
  | { type: "allow"; decisionId: string; reason?: string }
  | { type: "deny"; decisionId: string; reason: PolicyDenial };

export type AgentCommand =
  | {
      type: "agent.authenticate";
      requestId: RequestId;
      payload: { token: string; protocolVersion: TerminalProtocolVersion };
    }
  | { type: "terminal.list"; requestId: RequestId; payload: Record<string, never> }
  | { type: "terminal.get"; requestId: RequestId; payload: GetTerminalRequest }
  | { type: "terminal.run"; requestId: RequestId; payload: RunTerminalRequest }
  | { type: "terminal.create"; requestId: RequestId; payload: CreateTerminalRequest }
  | { type: "terminal.attach"; requestId: RequestId; payload: AttachTerminalRequest }
  | { type: "terminal.input"; requestId: RequestId; payload: TerminalInputRequest }
  | { type: "terminal.resize"; requestId: RequestId; payload: ResizeTerminalRequest }
  | { type: "terminal.scroll"; requestId: RequestId; payload: ScrollTerminalRequest }
  | {
      type: "terminal.setPresentation";
      requestId: RequestId;
      payload: SetTerminalPresentationRequest;
    }
  | {
      type: "terminal.observe";
      requestId: RequestId;
      payload: ObserveTerminalRequest | ObserveCapturedOperationRequest;
    }
  | {
      type: "terminal.close";
      requestId: RequestId;
      payload: CloseTerminalRequest | CloseOperationRequest;
    }
  | {
      type: "terminal.recording.start";
      requestId: RequestId;
      payload: RecordingControlRequest;
    }
  | {
      type: "terminal.recording.stop";
      requestId: RequestId;
      payload: RecordingControlRequest;
    }
  | {
      type: "terminal.recording.export";
      requestId: RequestId;
      payload: RecordingControlRequest;
    };

export type AgentCommandType = AgentCommand["type"];
export type AgentCommandPayload<TType extends AgentCommandType> = Extract<
  AgentCommand,
  { type: TType }
>["payload"];
export type AgentCommandResult<TValue = unknown> = CommandResult<TValue>;

export type AgentAuditEvent = {
  type: "agent.audit";
  at: string;
  connectionId: string;
  authenticated: boolean;
  action: AgentCommandType;
  outcome: "allow" | "deny" | "failure";
  requestId?: RequestId;
  sessionId?: SessionId;
  operationId?: OperationId;
  errorType?: TerminalErrorType;
  denialCode?: PolicyDenialCode;
};

export const agentGatewayDescriptorSchema = z
  .object({
    url: z.string().url(),
    token: z.string().min(1),
    tokenExpiresAt: z.string().min(1),
    pid: z.number().int().positive(),
    protocolVersion: z.literal(TERMINAL_PROTOCOL_VERSION),
  })
  .refine((value) => isLoopbackWebSocketUrl(value.url), {
    message: "Agent gateway URL must use loopback WebSocket transport.",
  });

export const policyDenialSchema = z.object({
  decisionId: decisionIdSchema,
  code: z.enum(["auth_required", "remote_control_disabled", "session_not_owned", "session_in_use"]),
  message: z.string().min(1),
  operation: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
  operationId: operationIdSchema.optional(),
});

export const policyDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("allow"),
    decisionId: decisionIdSchema,
    reason: z.string().optional(),
  }),
  z.object({ type: z.literal("deny"), decisionId: decisionIdSchema, reason: policyDenialSchema }),
]);

export const agentCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.authenticate"),
    requestId: requestIdSchema,
    payload: z.object({
      token: z.string().min(1),
      protocolVersion: z.literal(TERMINAL_PROTOCOL_VERSION),
    }),
  }),
  z.object({ type: z.literal("terminal.list"), requestId: requestIdSchema, payload: z.object({}) }),
  z.object({
    type: z.literal("terminal.get"),
    requestId: requestIdSchema,
    payload: getTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.run"),
    requestId: requestIdSchema,
    payload: runTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.create"),
    requestId: requestIdSchema,
    payload: createTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.attach"),
    requestId: requestIdSchema,
    payload: attachTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.input"),
    requestId: requestIdSchema,
    payload: terminalInputRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.resize"),
    requestId: requestIdSchema,
    payload: resizeTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.scroll"),
    requestId: requestIdSchema,
    payload: scrollTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.setPresentation"),
    requestId: requestIdSchema,
    payload: setTerminalPresentationRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.observe"),
    requestId: requestIdSchema,
    payload: z.union([
      observeTerminalRequestSchema.strict(),
      observeCapturedOperationRequestSchema,
    ]),
  }),
  z.object({
    type: z.literal("terminal.close"),
    requestId: requestIdSchema,
    payload: z.union([closeTerminalRequestSchema.strict(), closeOperationRequestSchema]),
  }),
  z.object({
    type: z.literal("terminal.recording.start"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.recording.stop"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.recording.export"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
]);

export function createAgentCommand<TType extends AgentCommandType>(
  type: TType,
  payload: AgentCommandPayload<TType>,
  requestId = createRequestId(),
): Extract<AgentCommand, { type: TType }> {
  return parseAgentCommand({ type, requestId, payload }) as Extract<AgentCommand, { type: TType }>;
}

export function parseAgentCommand(value: unknown): AgentCommand {
  return agentCommandSchema.parse(value);
}

export function parseAgentCommandResult(value: unknown): AgentCommandResult<unknown> {
  return commandResultSchema.parse(value);
}

export function parseAgentGatewayDescriptor(value: unknown): AgentGatewayDescriptor {
  return agentGatewayDescriptorSchema.parse(value);
}

export function parsePolicyDenial(value: unknown): PolicyDenial {
  return policyDenialSchema.parse(value);
}

export function parsePolicyDecision(value: unknown): PolicyDecision {
  return policyDecisionSchema.parse(value);
}

export const createAgentCommandSuccess = createCommandSuccess;
export const createAgentCommandFailure = createCommandFailure;

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "ws:" || url.protocol === "wss:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}
