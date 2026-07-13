import {
  createSessionId,
  createTerminalError,
  type CloseTerminalRequest,
  type CloseTerminalResult,
  type ObserveTerminalRequest,
  type ObserveTerminalResult,
  type RecordingControlRequest,
  type RendererCreateTerminalRequest,
  type RendererSessionEvent,
  type RendererTerminalInputRequest,
  type ReportTerminalViewportRequest,
  type ResizeTerminalRequest,
  type ResizeTerminalResult,
  type ScrollTerminalRequest,
  type ScrollTerminalResult,
  type SessionId,
  type TerminalInputResult,
  type TerminalPresentation,
  type TerminalRecordingExport,
  type TerminalSessionSummary,
  type TerminalViewBootstrap,
  type Unsubscribe,
} from "@terminal/protocol";
import { resolveShell, type PtyHost } from "@terminal/pty-host";

import { ManagedTerminalSession, type TerminalRecorder } from "./managed-session.js";

export type TerminalSessionShutdownResult = {
  terminated: number;
  timedOut: number;
};

export type TerminalSessionManagerOptions = {
  defaultCwd?: () => string;
  onEventHandlerError?: (error: unknown, event: RendererSessionEvent) => void;
  recorder?: TerminalRecorder;
  scrollback?: number;
  closeTimeoutMs?: number;
};

export class TerminalSessionManager {
  private readonly sessions = new Map<SessionId, ManagedTerminalSession>();
  private readonly eventHandlers = new Set<(event: RendererSessionEvent) => void>();

  constructor(
    private readonly ptyHost: PtyHost,
    private readonly options: TerminalSessionManagerOptions = {},
  ) {}

  onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async createSession(request: RendererCreateTerminalRequest): Promise<TerminalSessionSummary> {
    const sessionId = createSessionId();
    const cwd = request.cwd ?? this.options.defaultCwd?.() ?? process.cwd();
    try {
      const shell = resolveShell({ shell: request.shell, cwd, env: request.env });
      const pty = await this.ptyHost.spawn({
        sessionId,
        shell,
        cols: request.cols ?? 80,
        rows: request.rows ?? 24,
      });
      const session = new ManagedTerminalSession({
        sessionId,
        shell: shell.executable,
        cwd: shell.cwd,
        cols: request.cols ?? 80,
        rows: request.rows ?? 24,
        scrollback: this.options.scrollback ?? 5_000,
        createdBy: request.createdBy ?? "human",
        pty,
        recorder: this.options.recorder,
        emit: (event) => this.emit(event),
        closeTimeoutMs: this.options.closeTimeoutMs ?? 5_000,
      });
      this.sessions.set(sessionId, session);
      this.emit({ type: "session.updated", payload: session.summary });
      return session.summary;
    } catch (error: unknown) {
      throw normalizeSpawnError(error, sessionId);
    }
  }

  listSessions(): TerminalSessionSummary[] {
    return [...this.sessions.values()].map((session) => session.summary);
  }

  getSession(request: { sessionId: SessionId }): TerminalSessionSummary {
    return this.get(request.sessionId).summary;
  }

  async input(request: RendererTerminalInputRequest): Promise<TerminalInputResult> {
    return await this.get(request.sessionId).input(request.input, request.origin ?? "human");
  }

  async resize(request: ResizeTerminalRequest): Promise<ResizeTerminalResult> {
    return await this.get(request.sessionId).resize(request);
  }

  scroll(request: ScrollTerminalRequest): ScrollTerminalResult {
    return this.get(request.sessionId).scroll(request);
  }

  reportViewport(request: ReportTerminalViewportRequest): boolean {
    return this.get(request.sessionId).reportViewport(request.viewportY);
  }

  observe(request: ObserveTerminalRequest, signal?: AbortSignal): Promise<ObserveTerminalResult> {
    return this.get(request.sessionId).observe(request, signal);
  }

  getViewBootstrap(request: { sessionId: SessionId }): TerminalViewBootstrap {
    return this.get(request.sessionId).getViewBootstrap();
  }

  setPresentation(sessionId: SessionId, presentation: TerminalPresentation): void {
    this.get(sessionId).setPresentation(presentation);
  }

  async close(request: CloseTerminalRequest): Promise<CloseTerminalResult> {
    const session = this.get(request.sessionId);
    const result = await session.close();
    if (result.status === "closed") {
      session.dispose();
      this.sessions.delete(request.sessionId);
    }
    return result;
  }

  async startRecording(request: RecordingControlRequest): Promise<void> {
    await this.get(request.sessionId).startRecording();
  }

  async stopRecording(request: RecordingControlRequest): Promise<void> {
    await this.get(request.sessionId).stopRecording();
  }

  async exportRecording(request: RecordingControlRequest): Promise<TerminalRecordingExport> {
    return await this.get(request.sessionId).exportRecording();
  }

  async shutdown(options: { timeoutMs: number }): Promise<TerminalSessionShutdownResult> {
    let terminated = 0;
    let timedOut = 0;
    const sessions = [...this.sessions.entries()];
    await Promise.all(
      sessions.map(async ([sessionId, session]) => {
        try {
          const result = await session.close(options.timeoutMs);
          if (result.status === "closed") {
            terminated += 1;
            session.dispose();
            this.sessions.delete(sessionId);
          } else {
            timedOut += 1;
          }
        } catch (error: unknown) {
          timedOut += 1;
          this.emit({
            type: "session.error",
            payload: normalizeSessionError(error, sessionId, "session_close_failed", "shutdown"),
          });
        }
      }),
    );
    return { terminated, timedOut };
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.eventHandlers.clear();
  }

  private get(sessionId: SessionId): ManagedTerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw createTerminalError("session_not_found", `Session ${sessionId} was not found.`, {
        sessionId,
      });
    }
    return session;
  }

  private emit(event: RendererSessionEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error: unknown) {
        this.options.onEventHandlerError?.(error, event);
      }
    }
  }
}

function normalizeSpawnError(error: unknown, sessionId: SessionId) {
  return normalizeSessionError(error, sessionId, "pty_spawn_failed", "terminal.create");
}

function normalizeSessionError(
  error: unknown,
  sessionId: SessionId,
  fallbackType: Parameters<typeof createTerminalError>[0],
  operation: string,
) {
  if (isTerminalError(error)) return error;
  return createTerminalError(fallbackType, error instanceof Error ? error.message : String(error), {
    sessionId,
    operation,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function isTerminalError(value: unknown): value is ReturnType<typeof createTerminalError> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "message" in value &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}
