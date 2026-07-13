import type { AgentPolicy } from "@terminal/policy-engine";
import type {
  AgentActivityState,
  AgentAuditEvent,
  AgentGatewayDescriptor,
  CloseTerminalRequest,
  CloseTerminalResult,
  CreateTerminalRequest,
  GetTerminalRequest,
  ObserveTerminalRequest,
  ObserveTerminalResult,
  RecordingControlRequest,
  ResizeTerminalRequest,
  ResizeTerminalResult,
  ScrollTerminalRequest,
  ScrollTerminalResult,
  SessionId,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalRecordingExport,
  TerminalSessionSummary,
} from "@terminal/protocol";

export type AgentTerminalService = {
  list(): TerminalSessionSummary[];
  get(request: GetTerminalRequest): TerminalSessionSummary;
  create(request: CreateTerminalRequest): Promise<TerminalSessionSummary>;
  input(request: TerminalInputRequest): Promise<TerminalInputResult>;
  resize(request: ResizeTerminalRequest): Promise<ResizeTerminalResult>;
  scroll(request: ScrollTerminalRequest): ScrollTerminalResult;
  observe(request: ObserveTerminalRequest, signal: AbortSignal): Promise<ObserveTerminalResult>;
  close(request: CloseTerminalRequest): Promise<CloseTerminalResult>;
  startRecording(request: RecordingControlRequest): Promise<void>;
  stopRecording(request: RecordingControlRequest): Promise<void>;
  exportRecording(request: RecordingControlRequest): Promise<TerminalRecordingExport>;
};

export type AgentGatewayOptions = {
  descriptorPath: string;
  services: AgentTerminalService;
  policy: AgentPolicy;
  host?: string;
  port?: number;
  token?: string;
  tokenTtlMs?: number;
  tokenExpiresAt?: string;
  now?: () => Date;
  audit?: (event: AgentAuditEvent) => void;
  onActivity?: (state: AgentActivityState) => void;
};

export type AgentGateway = {
  descriptor: AgentGatewayDescriptor;
  descriptorPath: string;
  stop(): Promise<void>;
};

export type AttachmentRegistry = {
  attach(sessionId: SessionId, connectionId: string): boolean;
  detach(sessionId: SessionId, connectionId: string): void;
  detachConnection(connectionId: string): void;
};
