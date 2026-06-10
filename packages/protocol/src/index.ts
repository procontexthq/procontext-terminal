import { z } from "zod";

type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand };

export type SessionId = Brand<string, "SessionId">;
export type RequestId = Brand<string, "RequestId">;
export type DecisionId = Brand<string, "DecisionId">;

export type SessionState = "creating" | "running" | "detached" | "exiting" | "exited" | "failed";
export type InputOrigin = "human" | "agent" | "system";
export type RecordingState = "disabled" | "enabled";
export type UiThemePreference = "default" | "coder" | "gamer" | "classic";

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
};

export type TerminalShellProfile = {
  id: string;
  name: string;
  shell: string;
  cwd: string | null;
  env: Record<string, string>;
};

export type RecordingConfig = {
  state: RecordingState;
  redactedPatterns: string[];
};

export type UiConfig = {
  theme: UiThemePreference;
};

export type TerminalConfig = {
  schemaVersion: 2;
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    theme: TerminalTheme;
  };
  shell: {
    defaultProfile: string | null;
    profiles: TerminalShellProfile[];
  };
  ui: UiConfig;
  recording: RecordingConfig;
};

export type TerminalErrorType =
  | "invalid_request"
  | "auth_required"
  | "auth_failed"
  | "policy_denied"
  | "observation_unavailable"
  | "gateway_failed"
  | "pty_spawn_failed"
  | "session_not_found"
  | "session_not_running"
  | "session_write_failed"
  | "session_resize_failed"
  | "session_kill_failed"
  | "session_release_failed"
  | "session_detach_failed"
  | "session_attach_failed"
  | "session_snapshot_failed"
  | "wait_timeout"
  | "recording_failed"
  | "settings_save_failed";

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
  createdBy?: InputOrigin;
};

export type WriteInputRequest = {
  sessionId: SessionId;
  data: string;
  origin?: InputOrigin;
};

export type SendKeyRequest = {
  sessionId: SessionId;
  key: TerminalKey;
  origin?: InputOrigin;
};

export type PasteInputRequest = {
  sessionId: SessionId;
  text: string;
  origin?: InputOrigin;
};

export type MouseInputRequest = {
  sessionId: SessionId;
  data: string;
  origin?: InputOrigin;
};

export type SetTitleRequest = {
  sessionId: SessionId;
  title: string;
};

export type BellRequest = {
  sessionId: SessionId;
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

export type ReleaseSessionRequest = {
  sessionId: SessionId;
};

export type DetachSessionRequest = {
  sessionId: SessionId;
};

export type AttachSessionRequest = {
  sessionId: SessionId;
};

export type ReadRecentOutputRequest = {
  sessionId: SessionId;
  maxBytes: number;
};

export type RecentOutputSnapshot = {
  sessionId: SessionId;
  data: string;
  maxBytes: number;
  capturedAt: string;
};

export type TerminalScreenRow = {
  row: number;
  text: string;
  wrapped: boolean;
};

export type TerminalScreenSnapshot = {
  sessionId: SessionId;
  cols: number;
  rows: number;
  cursor: { x: number; y: number; visible: boolean };
  alternateScreen: boolean;
  title: string | null;
  viewport: TerminalScreenRow[];
  capturedAt: string;
};

export type CaptureScreenRequest = {
  sessionId: SessionId;
  timeoutMs: number;
};

export type SnapshotResponseRequest = {
  requestId: RequestId;
  snapshot: TerminalScreenSnapshot;
};

export type SnapshotUnavailableRequest = {
  requestId: RequestId;
  sessionId: SessionId;
  reason: string;
};

export type WaitForTextRequest = {
  sessionId: SessionId;
  text: string;
  timeoutMs: number;
  includeRecentOutput?: boolean;
};

export type WaitForScreenChangeRequest = {
  sessionId: SessionId;
  timeoutMs: number;
  baselineHash?: string;
};

export type WaitForQuietRequest = {
  sessionId: SessionId;
  quietMs: number;
  timeoutMs: number;
};

export type WaitForPromptRequest = {
  sessionId: SessionId;
  timeoutMs: number;
};

export type TerminalWaitResult = {
  sessionId: SessionId;
  matchedAt: string;
  snapshot?: TerminalScreenSnapshot;
};

export type AgentGatewayDescriptor = {
  url: string;
  token: string;
  tokenExpiresAt: string;
  pid: number;
};

export type AgentAuthenticationResult = {
  authenticatedAt: string;
  tokenExpiresAt: string;
};

export type AgentActivityState = {
  activeConnections: number;
  authenticatedConnections: number;
  lastActiveAt: string | null;
};

export type PolicyDenialCode = "auth_required" | "remote_control_disabled" | "session_not_owned";

export type PolicyDenial = {
  decisionId: string;
  code: PolicyDenialCode;
  message: string;
  operation: string;
  sessionId?: SessionId;
};

export type PolicyDecision =
  | { type: "allow"; decisionId: string; reason?: string }
  | { type: "deny"; decisionId: string; reason: PolicyDenial };

export type AgentAuditEvent = {
  type: "agent.audit";
  at: string;
  connectionId: string;
  authenticated: boolean;
  action: AgentCommandType;
  outcome: "allow" | "deny" | "failure";
  requestId?: RequestId;
  sessionId?: SessionId;
  errorType?: TerminalErrorType;
  denialCode?: PolicyDenialCode;
};

export type AgentCommand =
  | { type: "agent.authenticate"; requestId: RequestId; payload: { token: string } }
  | { type: "terminal.list"; requestId: RequestId; payload: Record<string, never> }
  | { type: "terminal.create"; requestId: RequestId; payload: CreateSessionRequest }
  | { type: "terminal.attach"; requestId: RequestId; payload: AttachSessionRequest }
  | {
      type: "terminal.sendText";
      requestId: RequestId;
      payload: { sessionId: SessionId; text: string };
    }
  | { type: "terminal.sendKey"; requestId: RequestId; payload: SendKeyRequest }
  | { type: "terminal.resize"; requestId: RequestId; payload: ResizeSessionRequest }
  | {
      type: "terminal.readRecentOutput";
      requestId: RequestId;
      payload: ReadRecentOutputRequest;
    }
  | { type: "terminal.captureScreen"; requestId: RequestId; payload: CaptureScreenRequest }
  | { type: "terminal.waitForText"; requestId: RequestId; payload: WaitForTextRequest }
  | {
      type: "terminal.waitForScreenChange";
      requestId: RequestId;
      payload: WaitForScreenChangeRequest;
    }
  | { type: "terminal.waitForQuiet"; requestId: RequestId; payload: WaitForQuietRequest }
  | { type: "terminal.waitForPrompt"; requestId: RequestId; payload: WaitForPromptRequest }
  | { type: "terminal.kill"; requestId: RequestId; payload: KillSessionRequest };

export type AgentCommandType = AgentCommand["type"];

export type AgentCommandPayload<TType extends AgentCommandType> = Extract<
  AgentCommand,
  { type: TType }
>["payload"];

export type AgentCommandResult<TValue = unknown> =
  | { ok: true; requestId: RequestId; value: TValue }
  | { ok: false; requestId: RequestId; error: TerminalError };

export type AgentEvent =
  | { type: "agent.authenticated"; payload: AgentAuthenticationResult }
  | { type: "terminal.created"; payload: TerminalSessionSnapshot }
  | { type: "terminal.attached"; payload: TerminalSessionSnapshot }
  | { type: "terminal.output"; payload: { sessionId: SessionId; data: string } }
  | { type: "terminal.title"; payload: { sessionId: SessionId; title: string } }
  | { type: "terminal.bell"; payload: { sessionId: SessionId } }
  | { type: "terminal.exited"; payload: SessionExitEvent }
  | { type: "terminal.denied"; payload: PolicyDenial }
  | { type: "terminal.error"; payload: TerminalError };

export type TerminalKey =
  | "Enter"
  | "Tab"
  | "Backspace"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Delete"
  | "Ctrl+C"
  | "Ctrl+D"
  | "Ctrl+Z";

export type TerminalRecordingEvent =
  | { type: "session.created"; sessionId: SessionId; at: string; metadata: TerminalSessionSnapshot }
  | { type: "pty.output"; sessionId: SessionId; at: string; data: string }
  | { type: "terminal.input"; sessionId: SessionId; at: string; origin: InputOrigin; data: string }
  | { type: "terminal.resize"; sessionId: SessionId; at: string; cols: number; rows: number }
  | {
      type: "session.exited";
      sessionId: SessionId;
      at: string;
      exitCode: number | null;
      signal: string | null;
    };

export type RecordingControlRequest = {
  sessionId: SessionId;
};

export type RecordingExportRequest = {
  sessionId: SessionId;
};

export type TerminalRecordingExport = {
  schemaVersion: 1;
  sessionId: SessionId;
  exportedAt: string;
  events: TerminalRecordingEvent[];
};

export type SaveUiThemeRequest = {
  theme: UiThemePreference;
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
  | { type: "session.title"; payload: { sessionId: SessionId; title: string } }
  | { type: "session.bell"; payload: { sessionId: SessionId } }
  | { type: "session.detached"; payload: TerminalSessionSnapshot }
  | { type: "session.attached"; payload: TerminalSessionSnapshot }
  | { type: "session.exited"; payload: SessionExitEvent }
  | { type: "session.error"; payload: TerminalError }
  | {
      type: "session.snapshot.request";
      requestId: RequestId;
      payload: { sessionId: SessionId };
    }
  | { type: "agent.activity"; payload: AgentActivityState };

export type RendererCommand =
  | { type: "session.create"; requestId: RequestId; payload: CreateSessionRequest }
  | { type: "session.list"; requestId: RequestId; payload: Record<string, never> }
  | { type: "session.write"; requestId: RequestId; payload: WriteInputRequest }
  | { type: "session.sendKey"; requestId: RequestId; payload: SendKeyRequest }
  | { type: "session.paste"; requestId: RequestId; payload: PasteInputRequest }
  | { type: "session.mouse"; requestId: RequestId; payload: MouseInputRequest }
  | { type: "session.setTitle"; requestId: RequestId; payload: SetTitleRequest }
  | { type: "session.bell"; requestId: RequestId; payload: BellRequest }
  | { type: "session.interrupt"; requestId: RequestId; payload: KillSessionRequest }
  | { type: "session.resize"; requestId: RequestId; payload: ResizeSessionRequest }
  | { type: "session.kill"; requestId: RequestId; payload: KillSessionRequest }
  | { type: "session.detach"; requestId: RequestId; payload: DetachSessionRequest }
  | { type: "session.attach"; requestId: RequestId; payload: AttachSessionRequest }
  | { type: "session.release"; requestId: RequestId; payload: ReleaseSessionRequest }
  | { type: "session.get"; requestId: RequestId; payload: GetSessionRequest }
  | { type: "session.readRecentOutput"; requestId: RequestId; payload: ReadRecentOutputRequest }
  | { type: "session.captureScreen"; requestId: RequestId; payload: CaptureScreenRequest }
  | { type: "session.snapshot.response"; requestId: RequestId; payload: SnapshotResponseRequest }
  | {
      type: "session.snapshot.unavailable";
      requestId: RequestId;
      payload: SnapshotUnavailableRequest;
    }
  | { type: "session.waitForText"; requestId: RequestId; payload: WaitForTextRequest }
  | {
      type: "session.waitForScreenChange";
      requestId: RequestId;
      payload: WaitForScreenChangeRequest;
    }
  | { type: "session.waitForQuiet"; requestId: RequestId; payload: WaitForQuietRequest }
  | { type: "session.waitForPrompt"; requestId: RequestId; payload: WaitForPromptRequest }
  | { type: "recording.start"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.stop"; requestId: RequestId; payload: RecordingControlRequest }
  | { type: "recording.export"; requestId: RequestId; payload: RecordingExportRequest }
  | { type: "settings.get"; requestId: RequestId; payload: Record<string, never> }
  | { type: "settings.saveUiTheme"; requestId: RequestId; payload: SaveUiThemeRequest };

export type RendererCommandType = RendererCommand["type"];

export type RendererCommandPayload<TType extends RendererCommandType> = Extract<
  RendererCommand,
  { type: TType }
>["payload"];

export type RendererCommandResult<TValue = unknown> =
  | { ok: true; requestId: RequestId; value: TValue }
  | { ok: false; requestId: RequestId; error: TerminalError };

export type Unsubscribe = () => void;

export const appShortcutActions = ["newTab", "closeTab", "previousTab", "nextTab"] as const;
export type AppShortcutAction = (typeof appShortcutActions)[number];

export type RendererTerminalApi = {
  createSession(request: CreateSessionRequest): Promise<TerminalSessionSnapshot>;
  listSessions(): Promise<TerminalSessionSnapshot[]>;
  write(request: WriteInputRequest): Promise<void>;
  sendKey(request: SendKeyRequest): Promise<void>;
  paste(request: PasteInputRequest): Promise<void>;
  sendMouse(request: MouseInputRequest): Promise<void>;
  setTitle(request: SetTitleRequest): Promise<TerminalSessionSnapshot>;
  reportBell(request: BellRequest): Promise<void>;
  interrupt(request: KillSessionRequest): Promise<void>;
  resize(request: ResizeSessionRequest): Promise<void>;
  kill(request: KillSessionRequest): Promise<void>;
  detachSession(request: DetachSessionRequest): Promise<TerminalSessionSnapshot>;
  attachSession(request: AttachSessionRequest): Promise<TerminalSessionSnapshot>;
  releaseSession(request: ReleaseSessionRequest): Promise<void>;
  getSession(request: GetSessionRequest): Promise<TerminalSessionSnapshot>;
  readRecentOutput(request: ReadRecentOutputRequest): Promise<RecentOutputSnapshot>;
  captureScreen(request: CaptureScreenRequest): Promise<TerminalScreenSnapshot>;
  respondToSnapshot(request: SnapshotResponseRequest): Promise<void>;
  reportSnapshotUnavailable(request: SnapshotUnavailableRequest): Promise<void>;
  waitForText(request: WaitForTextRequest): Promise<TerminalWaitResult>;
  waitForScreenChange(request: WaitForScreenChangeRequest): Promise<TerminalWaitResult>;
  waitForQuiet(request: WaitForQuietRequest): Promise<TerminalWaitResult>;
  waitForPrompt(request: WaitForPromptRequest): Promise<TerminalWaitResult>;
  startRecording(request: RecordingControlRequest): Promise<void>;
  stopRecording(request: RecordingControlRequest): Promise<void>;
  exportRecording(request: RecordingExportRequest): Promise<TerminalRecordingExport>;
  getConfig(): Promise<TerminalConfig>;
  saveUiTheme(theme: UiThemePreference): Promise<TerminalConfig>;
  onAppShortcut(handler: (action: AppShortcutAction) => void): Unsubscribe;
  onTerminalEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe;
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
export const decisionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as DecisionId);

const terminalDimensions = {
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
};

export const terminalThemeSchema = z.object({
  background: z.string().min(1),
  foreground: z.string().min(1),
  cursor: z.string().min(1),
});

export const uiThemePreferenceSchema = z.enum(["default", "coder", "gamer", "classic"]);

export const terminalShellProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shell: z.string().min(1),
  cwd: z.string().min(1).nullable(),
  env: z.record(z.string(), z.string()),
});

export const recordingConfigSchema = z.object({
  state: z.enum(["disabled", "enabled"]),
  redactedPatterns: z.array(z.string()),
});

export const uiConfigSchema = z.object({
  theme: uiThemePreferenceSchema,
});

export const terminalConfigSchema = z.object({
  schemaVersion: z.literal(2),
  terminal: z.object({
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(8).max(40),
    scrollback: z.number().int().min(100).max(100000),
    theme: terminalThemeSchema,
  }),
  shell: z.object({
    defaultProfile: z.string().min(1).nullable(),
    profiles: z.array(terminalShellProfileSchema),
  }),
  ui: uiConfigSchema,
  recording: recordingConfigSchema,
});

export const terminalErrorTypeSchema = z.enum([
  "invalid_request",
  "auth_required",
  "auth_failed",
  "policy_denied",
  "observation_unavailable",
  "gateway_failed",
  "pty_spawn_failed",
  "session_not_found",
  "session_not_running",
  "session_write_failed",
  "session_resize_failed",
  "session_kill_failed",
  "session_release_failed",
  "session_detach_failed",
  "session_attach_failed",
  "session_snapshot_failed",
  "wait_timeout",
  "recording_failed",
  "settings_save_failed",
]);

export const terminalErrorSchema = z.object({
  type: terminalErrorTypeSchema,
  message: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
  operation: z.string().min(1).optional(),
  cause: z.string().optional(),
});

export const terminalSessionSnapshotSchema = z.object({
  sessionId: sessionIdSchema,
  state: z.enum(["creating", "running", "detached", "exiting", "exited", "failed"]),
  shell: z.string().min(1),
  cwd: z.string().min(1),
  ...terminalDimensions,
  title: z.string().nullable(),
  createdBy: z.enum(["human", "agent", "system"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  exitedAt: z.string().min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
  error: terminalErrorSchema.optional(),
});

export const createSessionRequestSchema = z.object({
  cwd: z.string().min(1).optional(),
  shell: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  ...terminalDimensions,
  createdBy: z.enum(["human", "agent", "system"]).optional(),
});

export const writeInputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  data: z.string(),
  origin: z.enum(["human", "agent", "system"]).optional(),
});

export const terminalKeySchema = z.enum([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Delete",
  "Ctrl+C",
  "Ctrl+D",
  "Ctrl+Z",
]);

export const sendKeyRequestSchema = z.object({
  sessionId: sessionIdSchema,
  key: terminalKeySchema,
  origin: z.enum(["human", "agent", "system"]).optional(),
});

export const pasteInputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  text: z.string(),
  origin: z.enum(["human", "agent", "system"]).optional(),
});

export const mouseInputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  data: z.string(),
  origin: z.enum(["human", "agent", "system"]).optional(),
});

export const setTitleRequestSchema = z.object({
  sessionId: sessionIdSchema,
  title: z.string(),
});

export const bellRequestSchema = z.object({
  sessionId: sessionIdSchema,
});

export const resizeSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
  ...terminalDimensions,
});

export const killSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
});

export const getSessionRequestSchema = killSessionRequestSchema;

export const releaseSessionRequestSchema = killSessionRequestSchema;

export const detachSessionRequestSchema = killSessionRequestSchema;

export const attachSessionRequestSchema = killSessionRequestSchema;

export const readRecentOutputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  maxBytes: z.number().int().min(1).max(1_000_000),
});

export const terminalScreenRowSchema = z.object({
  row: z.number().int().min(0),
  text: z.string(),
  wrapped: z.boolean(),
});

export const terminalScreenSnapshotSchema = z.object({
  sessionId: sessionIdSchema,
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
  cursor: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    visible: z.boolean(),
  }),
  alternateScreen: z.boolean(),
  title: z.string().nullable(),
  viewport: z.array(terminalScreenRowSchema),
  capturedAt: z.string().min(1),
});

export const captureScreenRequestSchema = z.object({
  sessionId: sessionIdSchema,
  timeoutMs: z.number().int().min(1).max(120_000),
});

export const snapshotResponseRequestSchema = z.object({
  requestId: requestIdSchema,
  snapshot: terminalScreenSnapshotSchema,
});

export const snapshotUnavailableRequestSchema = z.object({
  requestId: requestIdSchema,
  sessionId: sessionIdSchema,
  reason: z.string().min(1),
});

export const waitForTextRequestSchema = z.object({
  sessionId: sessionIdSchema,
  text: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(120_000),
  includeRecentOutput: z.boolean().optional(),
});

export const waitForScreenChangeRequestSchema = z.object({
  sessionId: sessionIdSchema,
  timeoutMs: z.number().int().min(1).max(120_000),
  baselineHash: z.string().min(1).optional(),
});

export const waitForQuietRequestSchema = z.object({
  sessionId: sessionIdSchema,
  quietMs: z.number().int().min(1).max(120_000),
  timeoutMs: z.number().int().min(1).max(120_000),
});

export const waitForPromptRequestSchema = z.object({
  sessionId: sessionIdSchema,
  timeoutMs: z.number().int().min(1).max(120_000),
});

export const terminalRecordingEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.created"),
    sessionId: sessionIdSchema,
    at: z.string().min(1),
    metadata: terminalSessionSnapshotSchema,
  }),
  z.object({
    type: z.literal("pty.output"),
    sessionId: sessionIdSchema,
    at: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    type: z.literal("terminal.input"),
    sessionId: sessionIdSchema,
    at: z.string().min(1),
    origin: z.enum(["human", "agent", "system"]),
    data: z.string(),
  }),
  z.object({
    type: z.literal("terminal.resize"),
    sessionId: sessionIdSchema,
    at: z.string().min(1),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({
    type: z.literal("session.exited"),
    sessionId: sessionIdSchema,
    at: z.string().min(1),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
  }),
]);

export const recordingControlRequestSchema = killSessionRequestSchema;

export const recordingExportRequestSchema = killSessionRequestSchema;

export const terminalRecordingExportSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: sessionIdSchema,
  exportedAt: z.string().min(1),
  events: z.array(terminalRecordingEventSchema),
});

export const saveUiThemeRequestSchema = z.object({
  theme: uiThemePreferenceSchema,
});

export const agentGatewayDescriptorSchema = z.object({
  url: z.string().url().refine(isLoopbackWebSocketUrl, {
    message: "Agent gateway descriptor URL must use a loopback WebSocket address.",
  }),
  token: z.string().min(1),
  tokenExpiresAt: z.string().min(1),
  pid: z.number().int().positive(),
});

export const agentAuthenticationResultSchema = z.object({
  authenticatedAt: z.string().min(1),
  tokenExpiresAt: z.string().min(1),
});

export const agentActivityStateSchema = z.object({
  activeConnections: z.number().int().min(0),
  authenticatedConnections: z.number().int().min(0),
  lastActiveAt: z.string().min(1).nullable(),
});

export const policyDenialCodeSchema = z.enum([
  "auth_required",
  "remote_control_disabled",
  "session_not_owned",
]);

export const policyDenialSchema = z.object({
  decisionId: z.string().min(1),
  code: policyDenialCodeSchema,
  message: z.string().min(1),
  operation: z.string().min(1),
  sessionId: sessionIdSchema.optional(),
});

export const policyDecisionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("allow"),
    decisionId: z.string().min(1),
    reason: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("deny"),
    decisionId: z.string().min(1),
    reason: policyDenialSchema,
  }),
]);

export const agentAuditEventSchema = z.object({
  type: z.literal("agent.audit"),
  at: z.string().min(1),
  connectionId: z.string().min(1),
  authenticated: z.boolean(),
  action: z.string().min(1),
  outcome: z.enum(["allow", "deny", "failure"]),
  requestId: requestIdSchema.optional(),
  sessionId: sessionIdSchema.optional(),
  errorType: terminalErrorTypeSchema.optional(),
  denialCode: policyDenialCodeSchema.optional(),
});

export const agentCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.authenticate"),
    requestId: requestIdSchema,
    payload: z.object({ token: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("terminal.list"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("terminal.create"),
    requestId: requestIdSchema,
    payload: createSessionRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.attach"),
    requestId: requestIdSchema,
    payload: attachSessionRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.sendText"),
    requestId: requestIdSchema,
    payload: z.object({ sessionId: sessionIdSchema, text: z.string() }),
  }),
  z.object({
    type: z.literal("terminal.sendKey"),
    requestId: requestIdSchema,
    payload: sendKeyRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.resize"),
    requestId: requestIdSchema,
    payload: resizeSessionRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.readRecentOutput"),
    requestId: requestIdSchema,
    payload: readRecentOutputRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.captureScreen"),
    requestId: requestIdSchema,
    payload: captureScreenRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.waitForText"),
    requestId: requestIdSchema,
    payload: waitForTextRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.waitForScreenChange"),
    requestId: requestIdSchema,
    payload: waitForScreenChangeRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.waitForQuiet"),
    requestId: requestIdSchema,
    payload: waitForQuietRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.waitForPrompt"),
    requestId: requestIdSchema,
    payload: waitForPromptRequestSchema,
  }),
  z.object({
    type: z.literal("terminal.kill"),
    requestId: requestIdSchema,
    payload: killSessionRequestSchema,
  }),
]);

export const agentCommandResultSchema = z.union([
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

export const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("agent.authenticated"),
    payload: agentAuthenticationResultSchema,
  }),
  z.object({
    type: z.literal("terminal.created"),
    payload: terminalSessionSnapshotSchema,
  }),
  z.object({
    type: z.literal("terminal.attached"),
    payload: terminalSessionSnapshotSchema,
  }),
  z.object({
    type: z.literal("terminal.output"),
    payload: z.object({ sessionId: sessionIdSchema, data: z.string() }),
  }),
  z.object({
    type: z.literal("terminal.title"),
    payload: z.object({ sessionId: sessionIdSchema, title: z.string() }),
  }),
  z.object({
    type: z.literal("terminal.bell"),
    payload: z.object({ sessionId: sessionIdSchema }),
  }),
  z.object({
    type: z.literal("terminal.exited"),
    payload: z.object({
      sessionId: sessionIdSchema,
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
    }),
  }),
  z.object({
    type: z.literal("terminal.denied"),
    payload: policyDenialSchema,
  }),
  z.object({
    type: z.literal("terminal.error"),
    payload: terminalErrorSchema,
  }),
]);

export const rendererCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.create"),
    requestId: requestIdSchema,
    payload: createSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.list"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("session.write"),
    requestId: requestIdSchema,
    payload: writeInputRequestSchema,
  }),
  z.object({
    type: z.literal("session.sendKey"),
    requestId: requestIdSchema,
    payload: sendKeyRequestSchema,
  }),
  z.object({
    type: z.literal("session.paste"),
    requestId: requestIdSchema,
    payload: pasteInputRequestSchema,
  }),
  z.object({
    type: z.literal("session.mouse"),
    requestId: requestIdSchema,
    payload: mouseInputRequestSchema,
  }),
  z.object({
    type: z.literal("session.setTitle"),
    requestId: requestIdSchema,
    payload: setTitleRequestSchema,
  }),
  z.object({
    type: z.literal("session.bell"),
    requestId: requestIdSchema,
    payload: bellRequestSchema,
  }),
  z.object({
    type: z.literal("session.interrupt"),
    requestId: requestIdSchema,
    payload: killSessionRequestSchema,
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
    type: z.literal("session.detach"),
    requestId: requestIdSchema,
    payload: detachSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.attach"),
    requestId: requestIdSchema,
    payload: attachSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.release"),
    requestId: requestIdSchema,
    payload: releaseSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.get"),
    requestId: requestIdSchema,
    payload: getSessionRequestSchema,
  }),
  z.object({
    type: z.literal("session.readRecentOutput"),
    requestId: requestIdSchema,
    payload: readRecentOutputRequestSchema,
  }),
  z.object({
    type: z.literal("session.captureScreen"),
    requestId: requestIdSchema,
    payload: captureScreenRequestSchema,
  }),
  z.object({
    type: z.literal("session.snapshot.response"),
    requestId: requestIdSchema,
    payload: snapshotResponseRequestSchema,
  }),
  z.object({
    type: z.literal("session.snapshot.unavailable"),
    requestId: requestIdSchema,
    payload: snapshotUnavailableRequestSchema,
  }),
  z.object({
    type: z.literal("session.waitForText"),
    requestId: requestIdSchema,
    payload: waitForTextRequestSchema,
  }),
  z.object({
    type: z.literal("session.waitForScreenChange"),
    requestId: requestIdSchema,
    payload: waitForScreenChangeRequestSchema,
  }),
  z.object({
    type: z.literal("session.waitForQuiet"),
    requestId: requestIdSchema,
    payload: waitForQuietRequestSchema,
  }),
  z.object({
    type: z.literal("session.waitForPrompt"),
    requestId: requestIdSchema,
    payload: waitForPromptRequestSchema,
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
    payload: recordingExportRequestSchema,
  }),
  z.object({
    type: z.literal("settings.get"),
    requestId: requestIdSchema,
    payload: z.object({}),
  }),
  z.object({
    type: z.literal("settings.saveUiTheme"),
    requestId: requestIdSchema,
    payload: saveUiThemeRequestSchema,
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

export function createDecisionId(value = randomId("decision")): DecisionId {
  return decisionIdSchema.parse(value);
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

export function createAgentCommand<TType extends AgentCommandType>(
  type: TType,
  payload: AgentCommandPayload<TType>,
  requestId = createRequestId(),
): Extract<AgentCommand, { type: TType }> {
  return parseAgentCommand({ type, requestId, payload }) as Extract<AgentCommand, { type: TType }>;
}

export function parseCreateSessionRequest(value: unknown): CreateSessionRequest {
  return createSessionRequestSchema.parse(value);
}

export function parseWriteInputRequest(value: unknown): WriteInputRequest {
  return writeInputRequestSchema.parse(value);
}

export function parseSendKeyRequest(value: unknown): SendKeyRequest {
  return sendKeyRequestSchema.parse(value);
}

export function parsePasteInputRequest(value: unknown): PasteInputRequest {
  return pasteInputRequestSchema.parse(value);
}

export function parseMouseInputRequest(value: unknown): MouseInputRequest {
  return mouseInputRequestSchema.parse(value);
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

export function parseReleaseSessionRequest(value: unknown): ReleaseSessionRequest {
  return releaseSessionRequestSchema.parse(value);
}

export function parseDetachSessionRequest(value: unknown): DetachSessionRequest {
  return detachSessionRequestSchema.parse(value);
}

export function parseAttachSessionRequest(value: unknown): AttachSessionRequest {
  return attachSessionRequestSchema.parse(value);
}

export function parseReadRecentOutputRequest(value: unknown): ReadRecentOutputRequest {
  return readRecentOutputRequestSchema.parse(value);
}

export function parseTerminalScreenSnapshot(value: unknown): TerminalScreenSnapshot {
  return terminalScreenSnapshotSchema.parse(value);
}

export function parseCaptureScreenRequest(value: unknown): CaptureScreenRequest {
  return captureScreenRequestSchema.parse(value);
}

export function parseWaitForTextRequest(value: unknown): WaitForTextRequest {
  return waitForTextRequestSchema.parse(value);
}

export function parseWaitForScreenChangeRequest(value: unknown): WaitForScreenChangeRequest {
  return waitForScreenChangeRequestSchema.parse(value);
}

export function parseWaitForQuietRequest(value: unknown): WaitForQuietRequest {
  return waitForQuietRequestSchema.parse(value);
}

export function parseTerminalRecordingExport(value: unknown): TerminalRecordingExport {
  return terminalRecordingExportSchema.parse(value);
}

export function parseSaveUiThemeRequest(value: unknown): SaveUiThemeRequest {
  return saveUiThemeRequestSchema.parse(value);
}

export function parseTerminalConfig(value: unknown): TerminalConfig {
  return terminalConfigSchema.parse(value);
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

export function parseAgentCommand(value: unknown): AgentCommand {
  return agentCommandSchema.parse(value);
}

export function parseAgentCommandResult(value: unknown): AgentCommandResult<unknown> {
  return agentCommandResultSchema.parse(value);
}

export function parseAgentEvent(value: unknown): AgentEvent {
  return agentEventSchema.parse(value);
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

export function createAgentCommandSuccess<TValue>(
  requestId: RequestId,
  value: TValue,
): AgentCommandResult<TValue> {
  return { ok: true, requestId, value };
}

export function createAgentCommandFailure(
  requestId: RequestId,
  error: TerminalError,
): AgentCommandResult<never> {
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
    case "session.detached":
    case "session.attached":
      return typeof value.payload.sessionId === "string";
    case "session.output":
      return typeof value.payload.sessionId === "string" && typeof value.payload.data === "string";
    case "session.title":
      return typeof value.payload.sessionId === "string" && typeof value.payload.title === "string";
    case "session.bell":
      return typeof value.payload.sessionId === "string";
    case "session.exited":
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

export function isAgentEvent(value: unknown): value is AgentEvent {
  return agentEventSchema.safeParse(value).success;
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
