import type { AgentPolicy } from "@terminal/policy-engine";
import type {
  AgentActivityState,
  AgentAuditEvent,
  AgentGatewayDescriptor,
  AttachTerminalRequest,
  CloseOperationRequest,
  CloseTerminalRequest,
  CloseTerminalResult,
  CreateTerminalRequest,
  GetTerminalRequest,
  ObserveCapturedOperationRequest,
  ObserveCapturedOperationResult,
  ObserveTerminalRequest,
  ObserveTerminalResult,
  RecordingControlRequest,
  ResizeTerminalRequest,
  ResizeTerminalResult,
  RunTerminalRequest,
  RunTerminalResult,
  ScrollTerminalRequest,
  ScrollTerminalResult,
  SetTerminalPresentationRequest,
  SessionId,
  TerminalInputRequest,
  TerminalInputResult,
  TerminalPresentation,
  TerminalRecordingExport,
  TerminalSessionSummary,
} from "@terminal/protocol";

export type AgentTerminalService = {
  list(): TerminalSessionSummary[];
  get(request: GetTerminalRequest): TerminalSessionSummary;
  create(request: CreateTerminalRequest): Promise<TerminalSessionSummary>;
  attach(request: AttachTerminalRequest): Promise<TerminalSessionSummary>;
  run(request: RunTerminalRequest): Promise<RunTerminalResult>;
  input(request: TerminalInputRequest): Promise<TerminalInputResult>;
  resize(request: ResizeTerminalRequest): Promise<ResizeTerminalResult>;
  scroll(request: ScrollTerminalRequest): Promise<ScrollTerminalResult>;
  setPresentation(request: SetTerminalPresentationRequest): Promise<TerminalPresentation>;
  observe(
    request: ObserveTerminalRequest | ObserveCapturedOperationRequest,
    signal: AbortSignal,
  ): Promise<ObserveTerminalResult | ObserveCapturedOperationResult>;
  close(request: CloseTerminalRequest | CloseOperationRequest): Promise<CloseTerminalResult>;
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
  release(sessionId: SessionId): void;
  detachConnection(connectionId: string): void;
};
