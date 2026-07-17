import { z } from "zod";

import {
  agentPermissionCategories,
  saveAgentPolicyRequestSchema,
  saveFocusedSettingsRequestSchema,
  saveUiThemeRequestSchema,
  type AgentPermissionCategory,
  type AgentPolicyConfig,
  type FocusedTerminalSettings,
  type SaveFocusedSettingsRequest,
  type SaveAgentPolicyRequest,
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
  decisionIdSchema,
  requestIdSchema,
  sessionIdSchema,
  type RequestId,
  type SessionId,
} from "./ids.js";
import {
  terminalLinkTargetSchema,
  type TerminalLinkOpenResult,
  type TerminalLinkTarget,
} from "./links.js";
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
import type { PolicyDenialCode } from "./agent.js";
import type { AgentAccessKeyMetadata } from "./agent-access.js";

export type TerminalViewBootstrap = {
  session: TerminalSessionSummary;
  serialized: string;
  sequence: number;
  viewportY: number;
};

export type OpenTerminalViewRequest = { sessionId: SessionId };
export type CloseTerminalViewRequest = { sessionId: SessionId };
export type ReportTerminalViewportRequest = {
  sessionId: SessionId;
  viewportY: number;
  atBottom: boolean;
};
export type ReportTerminalViewFocusRequest = { sessionId: SessionId; focused: boolean };
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

export type AgentSessionControlState = {
  sessionId: SessionId;
  state: "attached" | "detached" | "revoked";
  attachedAt: string | null;
};

export type RevokeAgentControlRequest = { sessionId: SessionId };
export type AllowAgentControlRequest = { sessionId: SessionId };

export type RecordingExportFileResult =
  | { status: "saved"; fileName: string }
  | { status: "cancelled" };

export type PolicyDenialNotice = {
  decisionId: string;
  at: string;
  actor: "agent" | "human";
  operation: string;
  sessionId?: SessionId;
  code: PolicyDenialCode;
  message: string;
};

export type AgentPermissionRequest = {
  permissionId: string;
  category: AgentPermissionCategory;
  operation: string;
  sessionId?: SessionId;
  requestedAt: string;
  expiresAt: string;
};

export type PermissionResolutionDecision = "allow" | "deny";
export type PermissionResolutionOutcome = PermissionResolutionDecision | "timeout" | "cancelled";
export type ResolvePermissionRequest = {
  permissionId: string;
  decision: PermissionResolutionDecision;
};
export type PermissionResolvedEvent = {
  permissionId: string;
  outcome: PermissionResolutionOutcome;
};

export type TerminalResponseResult = {
  data: string;
  status: "returned" | "failed";
};

export type RendererSessionEvent =
  | {
      type: "session.output";
      payload: {
        sessionId: SessionId;
        sequence: number;
        data: string;
        terminalResponses?: TerminalResponseResult[];
      };
    }
  | {
      type: "session.viewport";
      payload: { sessionId: SessionId; viewportY: number; observationVersion: number };
    }
  | { type: "session.updated"; payload: TerminalSessionSummary }
  | { type: "session.removed"; payload: { sessionId: SessionId } }
  | { type: "session.bell"; payload: { sessionId: SessionId } }
  | { type: "session.error"; payload: TerminalError }
  | { type: "agent.activity"; payload: AgentActivityState }
  | { type: "agent.control.changed"; payload: AgentSessionControlState }
  | { type: "policy.denied"; payload: PolicyDenialNotice }
  | { type: "permission.requested"; payload: AgentPermissionRequest }
  | { type: "permission.resolved"; payload: PermissionResolvedEvent }
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
  | {
      type: "session.reportViewFocus";
      requestId: RequestId;
      payload: ReportTerminalViewFocusRequest;
    }
  | { type: "recording.start"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.stop"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.export"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.exportFile"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "agent.control.list"; requestId: RequestId; payload: Record<string, never> }
  | {
      type: "agent.control.revoke";
      requestId: RequestId;
      payload: RevokeAgentControlRequest;
    }
  | {
      type: "agent.control.allow";
      requestId: RequestId;
      payload: AllowAgentControlRequest;
    }
  | {
      type: "agent.accessKey.getMetadata";
      requestId: RequestId;
      payload: Record<string, never>;
    }
  | { type: "agent.accessKey.copy"; requestId: RequestId; payload: Record<string, never> }
  | {
      type: "agent.accessKey.regenerate";
      requestId: RequestId;
      payload: Record<string, never>;
    }
  | { type: "permission.list"; requestId: RequestId; payload: Record<string, never> }
  | {
      type: "permission.resolve";
      requestId: RequestId;
      payload: ResolvePermissionRequest;
    }
  | { type: "settings.get"; requestId: RequestId; payload: Record<string, never> }
  | { type: "link.open"; requestId: RequestId; payload: TerminalLinkTarget }
  | { type: "settings.saveUiTheme"; requestId: RequestId; payload: SaveUiThemeRequest }
  | {
      type: "settings.saveFocused";
      requestId: RequestId;
      payload: SaveFocusedSettingsRequest;
    }
  | {
      type: "settings.saveAgentPolicy";
      requestId: RequestId;
      payload: SaveAgentPolicyRequest;
    }
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
export const agentSessionControlStateSchema = z
  .object({
    sessionId: sessionIdSchema,
    state: z.enum(["attached", "detached", "revoked"]),
    attachedAt: z.string().min(1).nullable(),
  })
  .strict();
export const policyDenialNoticeSchema = z
  .object({
    decisionId: z.string().min(1),
    at: z.string().min(1),
    actor: z.enum(["agent", "human"]),
    operation: z.string().min(1),
    sessionId: sessionIdSchema.optional(),
    code: z.enum([
      "auth_required",
      "remote_control_disabled",
      "session_not_owned",
      "session_in_use",
      "agent_control_revoked",
      "permission_denied",
      "permission_timeout",
      "permission_unavailable",
    ]),
    message: z.string().min(1),
  })
  .strict();
export const agentPermissionRequestSchema = z
  .object({
    permissionId: decisionIdSchema,
    category: z.enum(agentPermissionCategories),
    operation: z.string().min(1),
    sessionId: sessionIdSchema.optional(),
    requestedAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .strict();
export const permissionResolutionOutcomeSchema = z.enum(["allow", "deny", "timeout", "cancelled"]);
export const permissionResolvedEventSchema = z
  .object({
    permissionId: decisionIdSchema,
    outcome: permissionResolutionOutcomeSchema,
  })
  .strict();
export const resolvePermissionRequestSchema = z
  .object({
    permissionId: decisionIdSchema,
    decision: z.enum(["allow", "deny"]),
  })
  .strict();

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
    payload: z.object({
      sessionId: sessionIdSchema,
      viewportY: z.number().int().nonnegative(),
      atBottom: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("session.reportViewFocus"),
    requestId: requestIdSchema,
    payload: z.object({ sessionId: sessionIdSchema, focused: z.boolean() }),
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
  z.object({
    type: z.literal("recording.exportFile"),
    requestId: requestIdSchema,
    payload: recordingControlRequestSchema,
  }),
  z.object({
    type: z.literal("agent.control.list"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("agent.control.revoke"),
    requestId: requestIdSchema,
    payload: viewRequestSchema,
  }),
  z.object({
    type: z.literal("agent.control.allow"),
    requestId: requestIdSchema,
    payload: viewRequestSchema,
  }),
  z.object({
    type: z.literal("agent.accessKey.getMetadata"),
    requestId: requestIdSchema,
    payload: z.object({}).strict(),
  }),
  z.object({
    type: z.literal("agent.accessKey.copy"),
    requestId: requestIdSchema,
    payload: z.object({}).strict(),
  }),
  z.object({
    type: z.literal("agent.accessKey.regenerate"),
    requestId: requestIdSchema,
    payload: z.object({}).strict(),
  }),
  z.object({
    type: z.literal("permission.list"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("permission.resolve"),
    requestId: requestIdSchema,
    payload: resolvePermissionRequestSchema,
  }),
  z.object({ type: z.literal("settings.get"), requestId: requestIdSchema, payload: z.object({}) }),
  z.object({
    type: z.literal("link.open"),
    requestId: requestIdSchema,
    payload: terminalLinkTargetSchema,
  }),
  z.object({
    type: z.literal("settings.saveUiTheme"),
    requestId: requestIdSchema,
    payload: saveUiThemeRequestSchema,
  }),
  z.object({
    type: z.literal("settings.saveFocused"),
    requestId: requestIdSchema,
    payload: saveFocusedSettingsRequestSchema,
  }),
  z.object({
    type: z.literal("settings.saveAgentPolicy"),
    requestId: requestIdSchema,
    payload: saveAgentPolicyRequestSchema,
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
  reportViewFocus(request: ReportTerminalViewFocusRequest): Promise<void>;
  startRecording(request: RecordingControlRequest): Promise<void>;
  stopRecording(request: RecordingControlRequest): Promise<void>;
  exportRecording(request: RecordingControlRequest): Promise<TerminalRecordingExport>;
  exportRecordingFile(request: RecordingControlRequest): Promise<RecordingExportFileResult>;
  listAgentControls(): Promise<AgentSessionControlState[]>;
  revokeAgentControl(request: RevokeAgentControlRequest): Promise<AgentSessionControlState>;
  allowAgentControl(request: AllowAgentControlRequest): Promise<AgentSessionControlState>;
  getAgentAccessKeyMetadata(): Promise<AgentAccessKeyMetadata>;
  copyAgentAccessKey(): Promise<void>;
  regenerateAgentAccessKey(): Promise<AgentAccessKeyMetadata>;
  listPermissions(): Promise<AgentPermissionRequest[]>;
  resolvePermission(request: ResolvePermissionRequest): Promise<boolean>;
  getConfig(): Promise<TerminalConfig>;
  openLink(target: TerminalLinkTarget): Promise<TerminalLinkOpenResult>;
  saveUiTheme(theme: UiThemePreference): Promise<TerminalConfig>;
  saveFocusedSettings(settings: FocusedTerminalSettings): Promise<TerminalConfig>;
  saveAgentPolicy(policy: AgentPolicyConfig): Promise<TerminalConfig>;
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
        typeof value.payload.data === "string" &&
        (value.payload.terminalResponses === undefined ||
          (Array.isArray(value.payload.terminalResponses) &&
            value.payload.terminalResponses.every(
              (response) =>
                isObject(response) &&
                typeof response.data === "string" &&
                (response.status === "returned" || response.status === "failed"),
            )))
      );
    case "session.viewport":
      return (
        typeof value.payload.sessionId === "string" &&
        typeof value.payload.viewportY === "number" &&
        typeof value.payload.observationVersion === "number"
      );
    case "session.updated":
      return terminalSessionSummarySchema.safeParse(value.payload).success;
    case "session.removed":
      return sessionIdSchema.safeParse(value.payload.sessionId).success;
    case "session.bell":
      return typeof value.payload.sessionId === "string";
    case "session.error":
      return typeof value.payload.type === "string" && typeof value.payload.message === "string";
    case "agent.activity":
      return (
        typeof value.payload.activeConnections === "number" &&
        typeof value.payload.authenticatedConnections === "number"
      );
    case "agent.control.changed":
      return agentSessionControlStateSchema.safeParse(value.payload).success;
    case "policy.denied":
      return policyDenialNoticeSchema.safeParse(value.payload).success;
    case "permission.requested":
      return agentPermissionRequestSchema.safeParse(value.payload).success;
    case "permission.resolved":
      return permissionResolvedEventSchema.safeParse(value.payload).success;
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
