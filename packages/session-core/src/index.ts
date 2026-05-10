import {
  createSessionId,
  createTerminalError,
  type CreateSessionRequest,
  type GetSessionRequest,
  type KillSessionRequest,
  type RendererSessionEvent,
  type ResizeSessionRequest,
  type SessionId,
  type TerminalError,
  type TerminalSessionSnapshot,
  type Unsubscribe,
  type WriteInputRequest,
} from "@terminal/protocol";
import { resolveShell, type PtyHost, type PtySession } from "@terminal/pty-host";

type SessionRecord = {
  snapshot: TerminalSessionSnapshot;
  pty: PtySession | null;
  cleanup: Unsubscribe[];
};

export type TerminalSessionShutdownResult = {
  terminated: number;
  timedOut: number;
};

export class TerminalSessionManager {
  private readonly sessions = new Map<SessionId, SessionRecord>();
  private readonly eventHandlers = new Set<(event: RendererSessionEvent) => void>();

  constructor(private readonly ptyHost: PtyHost) {}

  onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async createSession(request: CreateSessionRequest): Promise<TerminalSessionSnapshot> {
    const sessionId = createSessionId();
    const now = new Date().toISOString();
    let record: SessionRecord | null = null;

    try {
      const shell = resolveShell({
        shell: request.shell,
        cwd: request.cwd,
        env: request.env,
      });
      const snapshot: TerminalSessionSnapshot = {
        sessionId,
        state: "creating",
        shell: shell.executable,
        cwd: shell.cwd,
        cols: request.cols,
        rows: request.rows,
        title: null,
        createdBy: "human",
        createdAt: now,
        updatedAt: now,
      };
      record = { snapshot, pty: null, cleanup: [] };
      const activeRecord = record;
      this.sessions.set(sessionId, record);

      const pty = await this.ptyHost.spawn({
        sessionId,
        shell,
        cols: request.cols,
        rows: request.rows,
      });
      activeRecord.pty = pty;
      activeRecord.cleanup.push(
        pty.onData((data) => {
          this.emit({ type: "session.output", payload: { sessionId, data } });
        }),
        pty.onExit((event) => {
          activeRecord.snapshot = {
            ...activeRecord.snapshot,
            state: "exited",
            updatedAt: new Date().toISOString(),
            exitedAt: new Date().toISOString(),
            exitCode: event.exitCode,
            signal: event.signal,
          };
          this.emit({ type: "session.exited", payload: { sessionId, ...event } });
        }),
      );
      activeRecord.snapshot = {
        ...activeRecord.snapshot,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      this.emit({ type: "session.created", payload: activeRecord.snapshot });
      return activeRecord.snapshot;
    } catch (error: unknown) {
      const terminalError = normalizeTerminalError(error, sessionId, "pty_spawn_failed");
      if (record) {
        record.snapshot = {
          ...record.snapshot,
          state: "failed",
          updatedAt: new Date().toISOString(),
          error: terminalError,
        };
      }
      this.emit({ type: "session.error", payload: terminalError });
      throw terminalError;
    }
  }

  getSession(request: GetSessionRequest): TerminalSessionSnapshot {
    return { ...this.getRecord(request.sessionId).snapshot };
  }

  write(request: WriteInputRequest): Promise<void> {
    try {
      const record = this.getRunningRecord(request.sessionId);
      record.pty.write(request.data);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_write_failed"),
      );
    }
  }

  resize(request: ResizeSessionRequest): Promise<void> {
    try {
      const record = this.getRunningRecord(request.sessionId);
      record.pty.resize(request.cols, request.rows);
      record.snapshot = {
        ...record.snapshot,
        cols: request.cols,
        rows: request.rows,
        updatedAt: new Date().toISOString(),
      };
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_resize_failed"),
      );
    }
  }

  kill(request: KillSessionRequest): Promise<void> {
    try {
      const record = this.getRunningRecord(request.sessionId);
      record.snapshot = {
        ...record.snapshot,
        state: "exiting",
        updatedAt: new Date().toISOString(),
      };
      record.pty.kill();
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_kill_failed"),
      );
    }
  }

  async shutdown(options: { timeoutMs: number }): Promise<TerminalSessionShutdownResult> {
    const waits: Array<Promise<"exited" | "timed_out">> = [];

    for (const record of this.sessions.values()) {
      if (!record.pty || !isActive(record.snapshot.state)) {
        continue;
      }

      waits.push(
        this.killForShutdown(record as SessionRecord & { pty: PtySession }, options.timeoutMs),
      );
    }

    const results = await Promise.allSettled(waits);
    this.dispose();
    return summarizeShutdown(results);
  }

  dispose(): void {
    for (const record of this.sessions.values()) {
      for (const cleanup of record.cleanup) cleanup();
    }
    this.sessions.clear();
    this.eventHandlers.clear();
  }

  private getRecord(sessionId: SessionId): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw createTerminalError("session_not_found", `Session ${sessionId} was not found.`, {
        sessionId,
      });
    }
    return record;
  }

  private getRunningRecord(sessionId: SessionId): SessionRecord & { pty: PtySession } {
    const record = this.getRecord(sessionId);
    if (!record.pty || record.snapshot.state !== "running") {
      throw createTerminalError("session_not_running", `Session ${sessionId} is not running.`, {
        sessionId,
      });
    }
    return record as SessionRecord & { pty: PtySession };
  }

  private emit(event: RendererSessionEvent): void {
    for (const handler of this.eventHandlers) handler(event);
  }

  private async killForShutdown(
    record: SessionRecord & { pty: PtySession },
    timeoutMs: number,
  ): Promise<"exited" | "timed_out"> {
    let cleanup: Unsubscribe = () => undefined;
    const exited = new Promise<"exited">((resolve) => {
      cleanup = record.pty.onExit(() => {
        cleanup();
        resolve("exited");
      });
    });

    try {
      record.snapshot = {
        ...record.snapshot,
        state: "exiting",
        updatedAt: new Date().toISOString(),
      };
      record.pty.kill();
    } catch (error: unknown) {
      cleanup();
      this.emit({
        type: "session.error",
        payload: normalizeTerminalError(error, record.snapshot.sessionId, "session_kill_failed"),
      });
      return "timed_out";
    }

    const result = await Promise.race([exited, delay(timeoutMs).then(() => "timed_out" as const)]);
    cleanup();
    return result;
  }
}

function summarizeShutdown(
  results: Array<PromiseSettledResult<"exited" | "timed_out">>,
): TerminalSessionShutdownResult {
  let terminated = 0;
  let timedOut = 0;

  for (const result of results) {
    if (result.status !== "fulfilled") {
      continue;
    }

    if (result.value === "timed_out") {
      timedOut += 1;
    } else {
      terminated += 1;
    }
  }

  return { terminated, timedOut };
}

function isActive(state: TerminalSessionSnapshot["state"]): boolean {
  return state === "running" || state === "exiting";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTerminalError(
  error: unknown,
  sessionId: SessionId,
  fallbackType: TerminalError["type"],
): TerminalError {
  if (isTerminalError(error)) {
    return error;
  }

  return createTerminalError(fallbackType, error instanceof Error ? error.message : String(error), {
    sessionId,
    cause: error instanceof Error ? error.message : String(error),
  });
}

function isTerminalError(value: unknown): value is TerminalError {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "message" in value &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}
