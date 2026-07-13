import { z } from "zod";

import {
  saveUiThemeRequestSchema,
  type SaveUiThemeRequest,
  type TerminalConfig,
  type UiThemePreference,
} from "./config.js";
import {
  commandResultSchema,
  createCommandFailure,
  createCommandSuccess,
  unwrapCommandResult,
  type CommandResult,
  type TerminalError,
} from "./errors.js";
import {
  createRequestId,
  requestIdSchema,
  sessionIdSchema,
  type RequestId,
  type SessionId,
} from "./ids.js";
import {
  recordingControlRequestSchema,
  type RecordingControlRequest,
  type TerminalRecordingExport,
} from "./recording.js";
import {
  closeTerminalRequestSchema,
  getTerminalRequestSchema,
  rendererCreateTerminalRequestSchema,
  rendererTerminalInputRequestSchema,
  resizeTerminalRequestSchema,
  scrollTerminalRequestSchema,
  terminalSessionSummarySchema,
  type CloseTerminalRequest,
  type CloseTerminalResult,
  type GetTerminalRequest,
  type RendererCreateTerminalRequest,
  type RendererTerminalInputRequest,
  type ResizeTerminalRequest,
  type ResizeTerminalResult,
  type ScrollTerminalRequest,
  type ScrollTerminalResult,
  type TerminalInputResult,
  type TerminalSessionSummary,
} from "./sessions.js";

export type TerminalViewBootstrap = {
  session: TerminalSessionSummary;
  serialized: string;
  sequence: number;
  viewportY: number;
};

export type OpenTerminalViewRequest = { sessionId: SessionId };
export type CloseTerminalViewRequest = { sessionId: SessionId };
export type ReportTerminalViewportRequest = { sessionId: SessionId; viewportY: number };
export type RendererPresentationAction = "open" | "focus" | "hide" | "close";
export type RendererPresentationCommand = {
  commandId: RequestId;
  sessionId: SessionId;
  action: RendererPresentationAction;
};
export type RendererPresentationAcknowledgement = RendererPresentationCommand & {
  status: "completed" | "failed";
  message?: string;
};

export type RendererSessionEvent =
  | {
      type: "session.output";
      payload: { sessionId: SessionId; sequence: number; data: string };
    }
  | {
      type: "session.viewport";
      payload: { sessionId: SessionId; viewportY: number; observationVersion: number };
    }
  | { type: "session.updated"; payload: TerminalSessionSummary }
  | { type: "session.bell"; payload: { sessionId: SessionId } }
  | { type: "session.error"; payload: TerminalError }
  | { type: "agent.activity"; payload: AgentActivityState }
  | { type: "presentation.command"; payload: RendererPresentationCommand };

export type AgentActivityState = {
  activeConnections: number;
  authenticatedConnections: number;
  lastActiveAt: string | null;
};

export type RendererCommand =
  | { type: "session.create"; requestId: RequestId; payload: RendererCreateTerminalRequest }
  | { type: "session.list"; requestId: RequestId; payload: Record<string, never> }
  | { type: "session.get"; requestId: RequestId; payload: GetTerminalRequest }
  | { type: "session.input"; requestId: RequestId; payload: RendererTerminalInputRequest }
  | { type: "session.resize"; requestId: RequestId; payload: ResizeTerminalRequest }
  | { type: "session.scroll"; requestId: RequestId; payload: ScrollTerminalRequest }
  | { type: "session.close"; requestId: RequestId; payload: CloseTerminalRequest }
  | { type: "session.openView"; requestId: RequestId; payload: OpenTerminalViewRequest }
  | { type: "session.closeView"; requestId: RequestId; payload: CloseTerminalViewRequest }
  | {
      type: "session.reportViewport";
      requestId: RequestId;
      payload: ReportTerminalViewportRequest;
    }
  | { type: "recording.start"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.stop"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.export"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "settings.get"; requestId: RequestId; payload: Record<string, never> }
  | { type: "settings.saveUiTheme"; requestId: RequestId; payload: SaveUiThemeRequest }
  | { type: "presentation.ready"; requestId: RequestId; payload: Record<string, never> }
  | {
      type: "presentation.acknowledge";
      requestId: RequestId;
      payload: RendererPresentationAcknowledgement;
    };

export type RendererCommandType = RendererCommand["type"];
export type RendererCommandPayload<TType extends RendererCommandType> = Extract<
  RendererCommand,
  { type: TType }
>["payload"];
export type RendererCommandResult<TValue = unknown> = CommandResult<TValue>;
export type Unsubscribe = () => void;

const viewRequestSchema = z.object({ sessionId: sessionIdSchema });
const rendererPresentationActionSchema = z.enum(["open", "focus", "hide", "close"]);
const rendererPresentationAcknowledgementSchema = z.object({
  commandId: requestIdSchema,
  sessionId: sessionIdSchema,
  action: rendererPresentationActionSchema,
  status: z.enum(["completed", "failed"]),
  message: z.string().min(1).optional(),
});

export const rendererCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.create"),
    requestId: requestIdSchema,
    payload: rendererCreateTerminalRequestSchema,
  }),
  z.object({ type: z.literal("session.list"), requestId: requestIdSchema, payload: z.object({}) }),
  z.object({
    type: z.literal("session.get"),
    requestId: requestIdSchema,
    payload: getTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("session.input"),
    requestId: requestIdSchema,
    payload: rendererTerminalInputRequestSchema,
  }),
  z.object({
    type: z.literal("session.resize"),
    requestId: requestIdSchema,
    payload: resizeTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("session.scroll"),
    requestId: requestIdSchema,
    payload: scrollTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("session.close"),
    requestId: requestIdSchema,
    payload: closeTerminalRequestSchema,
  }),
  z.object({
    type: z.literal("session.openView"),
    requestId: requestIdSchema,
    payload: viewRequestSchema,
  }),
  z.object({
    type: z.literal("session.closeView"),
    requestId: requestIdSchema,
    payload: viewRequestSchema,
  }),
  z.object({
    type: z.literal("session.reportViewport"),
    requestId: requestIdSchema,
    payload: z.object({ sessionId: sessionIdSchema, viewportY: z.number().int().nonnegative() }),
  }),
  z.object({
    type: z.literal("recording.start"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({
    type: z.literal("recording.stop"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({
    type: z.literal("recording.export"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({ type: z.literal("settings.get"), requestId: requestIdSchema, payload: z.object({}) }),
  z.object({
    type: z.literal("settings.saveUiTheme"),
    requestId: requestIdSchema,
    payload: saveUiThemeRequestSchema,
  }),
  z.object({
    type: z.literal("presentation.ready"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("presentation.acknowledge"),
    requestId: requestIdSchema,
    payload: rendererPresentationAcknowledgementSchema,
  }),
]);

export const appShortcutActions = ["newTab", "closeTab", "previousTab", "nextTab"] as const;
export type AppShortcutAction = (typeof appShortcutActions)[number];

export type RendererTerminalApi = {
  createSession(request: RendererCreateTerminalRequest): Promise<TerminalSessionSummary>;
  listSessions(): Promise<TerminalSessionSummary[]>;
  getSession(request: GetTerminalRequest): Promise<TerminalSessionSummary>;
  input(request: RendererTerminalInputRequest): Promise<TerminalInputResult>;
  resize(request: ResizeTerminalRequest): Promise<ResizeTerminalResult>;
  scroll(request: ScrollTerminalRequest): Promise<ScrollTerminalResult>;
  close(request: CloseTerminalRequest): Promise<CloseTerminalResult>;
  openView(request: OpenTerminalViewRequest): Promise<TerminalViewBootstrap>;
  closeView(request: CloseTerminalViewRequest): Promise<void>;
  reportViewport(request: ReportTerminalViewportRequest): Promise<void>;
  startRecording(request: RecordingControlRequest): Promise<void>;
  stopRecording(request: RecordingControlRequest): Promise<void>;
  exportRecording(request: RecordingControlRequest): Promise<TerminalRecordingExport>;
  getConfig(): Promise<TerminalConfig>;
  saveUiTheme(theme: UiThemePreference): Promise<TerminalConfig>;
  presentationReady(): Promise<void>;
  acknowledgePresentation(request: RendererPresentationAcknowledgement): Promise<void>;
  onAppShortcut(handler: (action: AppShortcutAction) => void): Unsubscribe;
  onTerminalEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe;
  onSessionEvent(sessionId: SessionId, handler: (event: RendererSessionEvent) => void): Unsubscribe;
};

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

export function parseRendererCommand(value: unknown): RendererCommand {
  return rendererCommandSchema.parse(value);
}

export function parseRendererCommandResult(value: unknown): RendererCommandResult<unknown> {
  return commandResultSchema.parse(value);
}

export const createRendererCommandSuccess = createCommandSuccess;
export const createRendererCommandFailure = createCommandFailure;
export const unwrapRendererCommandResult = unwrapCommandResult;

export function isRendererSessionEvent(value: unknown): value is RendererSessionEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.payload)) return false;
  switch (value.type) {
    case "session.output":
      return (
        typeof value.payload.sessionId === "string" &&
        typeof value.payload.sequence === "number" &&
        typeof value.payload.data === "string"
      );
    case "session.viewport":
      return (
        typeof value.payload.sessionId === "string" &&
        typeof value.payload.viewportY === "number" &&
        typeof value.payload.observationVersion === "number"
      );
    case "session.updated":
      return terminalSessionSummarySchema.safeParse(value.payload).success;
    case "session.bell":
      return typeof value.payload.sessionId === "string";
    case "session.error":
      return typeof value.payload.type === "string" && typeof value.payload.message === "string";
    case "agent.activity":
      return (
        typeof value.payload.activeConnections === "number" &&
        typeof value.payload.authenticatedConnections === "number"
      );
    case "presentation.command":
      return (
        typeof value.payload.commandId === "string" &&
        typeof value.payload.sessionId === "string" &&
        (value.payload.action === "open" ||
          value.payload.action === "focus" ||
          value.payload.action === "hide" ||
          value.payload.action === "close")
      );
    default:
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
