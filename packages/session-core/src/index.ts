import {
  createSessionId,
  createTerminalError,
  type AttachSessionRequest,
  type CreateSessionRequest,
  type DetachSessionRequest,
  type GetSessionRequest,
  type InputOrigin,
  type KillSessionRequest,
  type MouseInputRequest,
  type PasteInputRequest,
  type ReadRecentOutputRequest,
  type RecentOutputSnapshot,
  type RendererSessionEvent,
  type ReleaseSessionRequest,
  type SendKeyRequest,
  type ResizeSessionRequest,
  type SessionId,
  type TerminalError,
  type TerminalRecordingExport,
  type TerminalRecordingEvent,
  type TerminalSessionSnapshot,
  type Unsubscribe,
  type WriteInputRequest,
} from "@terminal/protocol";
import { resolveShell, type PtyHost, type PtySession } from "@terminal/pty-host";
import { encodeTerminalKey, normalizeTerminalInput } from "./input-router.js";

export { encodeTerminalKey, normalizeTerminalInput } from "./input-router.js";

type SessionRecord = {
  snapshot: TerminalSessionSnapshot;
  pty: PtySession | null;
  cleanup: Unsubscribe[];
  recentOutput: string;
  lastOutputAt: number;
};

export type TerminalSessionShutdownResult = {
  terminated: number;
  timedOut: number;
};

export type TerminalSessionManagerOptions = {
  onEventHandlerError?: (error: unknown, event: RendererSessionEvent) => void;
  recorder?: TerminalRecorder;
};

export type TerminalRecorder = {
  record(event: TerminalRecordingEvent): void | Promise<void>;
  start(session: TerminalSessionSnapshot): void | Promise<void>;
  stop(sessionId: SessionId): void | Promise<void>;
  export(sessionId: SessionId): Promise<TerminalRecordingExport>;
};

export class TerminalSessionManager {
  private readonly sessions = new Map<SessionId, SessionRecord>();
  private readonly eventHandlers = new Set<(event: RendererSessionEvent) => void>();

  constructor(
    private readonly ptyHost: PtyHost,
    private readonly options: TerminalSessionManagerOptions = {},
  ) {}

  onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async createSession(request: CreateSessionRequest): Promise<TerminalSessionSnapshot> {
    const sessionId = createSessionId();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      snapshot: {
        sessionId,
        state: "creating",
        shell: request.shell ?? "default",
        cwd: request.cwd ?? process.cwd(),
        cols: request.cols,
        rows: request.rows,
        title: null,
        createdBy: request.createdBy ?? "human",
        createdAt: now,
        updatedAt: now,
      },
      pty: null,
      cleanup: [],
      recentOutput: "",
      lastOutputAt: Date.now(),
    };
    this.sessions.set(sessionId, record);

    try {
      const shell = resolveShell({
        shell: request.shell,
        cwd: request.cwd,
        env: request.env,
      });
      record.snapshot = {
        ...record.snapshot,
        shell: shell.executable,
        cwd: shell.cwd,
      };
      const activeRecord = record;

      const pty = await this.ptyHost.spawn({
        sessionId,
        shell,
        cols: request.cols,
        rows: request.rows,
      });
      activeRecord.pty = pty;
      activeRecord.cleanup.push(
        pty.onData((data) => {
          activeRecord.recentOutput = appendRecentOutput(activeRecord.recentOutput, data);
          activeRecord.lastOutputAt = Date.now();
          void this.record({
            type: "pty.output",
            sessionId,
            at: new Date().toISOString(),
            data,
          });
          this.emit({ type: "session.output", payload: { sessionId, data } });
        }),
        pty.onExit((event) => {
          const exitedAt = new Date().toISOString();
          activeRecord.snapshot = {
            ...activeRecord.snapshot,
            state: "exited",
            updatedAt: exitedAt,
            exitedAt,
            exitCode: event.exitCode,
            signal: event.signal,
          };
          void this.record({
            type: "session.exited",
            sessionId,
            at: exitedAt,
            exitCode: event.exitCode,
            signal: event.signal,
          });
          this.emit({ type: "session.exited", payload: { sessionId, ...event } });
        }),
      );
      activeRecord.snapshot = {
        ...activeRecord.snapshot,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      void this.record({
        type: "session.created",
        sessionId,
        at: activeRecord.snapshot.updatedAt,
        metadata: activeRecord.snapshot,
      });
      this.emit({ type: "session.created", payload: activeRecord.snapshot });
      return activeRecord.snapshot;
    } catch (error: unknown) {
      const terminalError = normalizeTerminalError(error, sessionId, "pty_spawn_failed");
      record.snapshot = {
        ...record.snapshot,
        state: "failed",
        updatedAt: new Date().toISOString(),
        error: terminalError,
      };
      this.emit({ type: "session.error", payload: terminalError });
      throw terminalError;
    }
  }

  getSession(request: GetSessionRequest): TerminalSessionSnapshot {
    return { ...this.getRecord(request.sessionId).snapshot };
  }

  listSessions(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()].map((record) => ({ ...record.snapshot }));
  }

  write(request: WriteInputRequest): Promise<void> {
    try {
      const input = normalizeTerminalInput(request.data, request.origin);
      this.writeToActivePty(request.sessionId, input.data, input.origin);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_write_failed"),
      );
    }
  }

  sendKey(request: SendKeyRequest): Promise<void> {
    return this.write({
      sessionId: request.sessionId,
      data: encodeTerminalKey(request.key),
      origin: request.origin,
    });
  }

  paste(request: PasteInputRequest): Promise<void> {
    return this.write({
      sessionId: request.sessionId,
      data: request.text,
      origin: request.origin,
    });
  }

  sendMouse(request: MouseInputRequest): Promise<void> {
    return this.write({
      sessionId: request.sessionId,
      data: request.data,
      origin: request.origin,
    });
  }

  interrupt(request: KillSessionRequest): Promise<void> {
    return this.write({
      sessionId: request.sessionId,
      data: encodeTerminalKey("Ctrl+C"),
      origin: "agent",
    });
  }

  resize(request: ResizeSessionRequest): Promise<void> {
    try {
      const record = this.getActivePtyRecord(request.sessionId);
      record.pty.resize(request.cols, request.rows);
      record.snapshot = {
        ...record.snapshot,
        cols: request.cols,
        rows: request.rows,
        updatedAt: new Date().toISOString(),
      };
      void this.record({
        type: "terminal.resize",
        sessionId: request.sessionId,
        at: record.snapshot.updatedAt,
        cols: request.cols,
        rows: request.rows,
      });
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_resize_failed"),
      );
    }
  }

  kill(request: KillSessionRequest): Promise<void> {
    try {
      const record = this.getKillablePtyRecord(request.sessionId);
      record.pty.kill();
      if (record.snapshot.state === "running" || record.snapshot.state === "detached") {
        record.snapshot = {
          ...record.snapshot,
          state: "exiting",
          updatedAt: new Date().toISOString(),
        };
      }
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_kill_failed"),
      );
    }
  }

  detachSession(request: DetachSessionRequest): TerminalSessionSnapshot {
    try {
      const record = this.getRecord(request.sessionId);
      if (!record.pty || record.snapshot.state !== "running") {
        throw createTerminalError(
          "session_detach_failed",
          `Session ${request.sessionId} cannot be detached while ${record.snapshot.state}.`,
          { sessionId: request.sessionId },
        );
      }
      record.snapshot = {
        ...record.snapshot,
        state: "detached",
        updatedAt: new Date().toISOString(),
      };
      this.emit({ type: "session.detached", payload: record.snapshot });
      return { ...record.snapshot };
    } catch (error: unknown) {
      throw normalizeTerminalError(error, request.sessionId, "session_detach_failed");
    }
  }

  attachSession(request: AttachSessionRequest): TerminalSessionSnapshot {
    try {
      const record = this.getRecord(request.sessionId);
      if (!record.pty || record.snapshot.state !== "detached") {
        throw createTerminalError(
          "session_attach_failed",
          `Session ${request.sessionId} cannot be attached while ${record.snapshot.state}.`,
          { sessionId: request.sessionId },
        );
      }
      record.snapshot = {
        ...record.snapshot,
        state: "running",
        updatedAt: new Date().toISOString(),
      };
      this.emit({ type: "session.attached", payload: record.snapshot });
      return { ...record.snapshot };
    } catch (error: unknown) {
      throw normalizeTerminalError(error, request.sessionId, "session_attach_failed");
    }
  }

  readRecentOutput(request: ReadRecentOutputRequest): RecentOutputSnapshot {
    const record = this.getRecord(request.sessionId);
    return {
      sessionId: request.sessionId,
      data: sliceRecentOutput(record.recentOutput, request.maxBytes),
      maxBytes: request.maxBytes,
      capturedAt: new Date().toISOString(),
    };
  }

  getLastActivityAt(sessionId: SessionId): number {
    return this.getRecord(sessionId).lastOutputAt;
  }

  async startRecording(request: { sessionId: SessionId }): Promise<void> {
    try {
      await this.options.recorder?.start(this.getRecord(request.sessionId).snapshot);
    } catch (error: unknown) {
      throw normalizeTerminalError(error, request.sessionId, "recording_failed");
    }
  }

  async stopRecording(request: { sessionId: SessionId }): Promise<void> {
    try {
      this.getRecord(request.sessionId);
      await this.options.recorder?.stop(request.sessionId);
    } catch (error: unknown) {
      throw normalizeTerminalError(error, request.sessionId, "recording_failed");
    }
  }

  async exportRecording(request: { sessionId: SessionId }): Promise<TerminalRecordingExport> {
    try {
      this.getRecord(request.sessionId);
      if (!this.options.recorder) {
        return {
          schemaVersion: 1,
          sessionId: request.sessionId,
          exportedAt: new Date().toISOString(),
          events: [],
        };
      }
      return await this.options.recorder.export(request.sessionId);
    } catch (error: unknown) {
      throw normalizeTerminalError(error, request.sessionId, "recording_failed");
    }
  }

  releaseSession(request: ReleaseSessionRequest): Promise<void> {
    try {
      const record = this.getRecord(request.sessionId);
      if (record.snapshot.state !== "exited" && record.snapshot.state !== "failed") {
        throw createTerminalError(
          "session_release_failed",
          `Session ${request.sessionId} cannot be released while ${record.snapshot.state}.`,
          {
            sessionId: request.sessionId,
          },
        );
      }
      this.disposeRecord(record);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(
        normalizeTerminalError(error, request.sessionId, "session_release_failed"),
      );
    }
  }

  async shutdown(options: { timeoutMs: number }): Promise<TerminalSessionShutdownResult> {
    const waits: Array<{
      record: SessionRecord & { pty: PtySession };
      result: Promise<"exited" | "timed_out">;
    }> = [];
    const recordsToDispose = new Set<SessionRecord>();

    for (const record of this.sessions.values()) {
      if (!record.pty || !isActive(record.snapshot.state)) {
        recordsToDispose.add(record);
        continue;
      }

      const activeRecord = record as SessionRecord & { pty: PtySession };
      waits.push({
        record: activeRecord,
        result: this.killForShutdown(activeRecord, options.timeoutMs),
      });
    }

    const results = await Promise.allSettled(waits.map((wait) => wait.result));
    results.forEach((result, index) => {
      const wait = waits[index];
      if (!wait) {
        return;
      }
      if (result.status === "fulfilled" && result.value === "exited") {
        recordsToDispose.add(wait.record);
      }
    });
    for (const record of recordsToDispose) {
      this.disposeRecord(record);
    }
    if (this.sessions.size === 0) {
      this.eventHandlers.clear();
    }
    return summarizeShutdown(results);
  }

  dispose(): void {
    for (const record of this.sessions.values()) {
      for (const cleanup of record.cleanup) cleanup();
    }
    this.sessions.clear();
    this.eventHandlers.clear();
  }

  private disposeRecord(record: SessionRecord): void {
    for (const cleanup of record.cleanup) cleanup();
    this.sessions.delete(record.snapshot.sessionId);
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

  private getActivePtyRecord(sessionId: SessionId): SessionRecord & { pty: PtySession } {
    const record = this.getRecord(sessionId);
    if (!record.pty || !acceptsPtyOperations(record.snapshot.state)) {
      throw createTerminalError("session_not_running", `Session ${sessionId} is not running.`, {
        sessionId,
      });
    }
    return record as SessionRecord & { pty: PtySession };
  }

  private getKillablePtyRecord(sessionId: SessionId): SessionRecord & { pty: PtySession } {
    const record = this.getRecord(sessionId);
    if (!record.pty || !canRequestKill(record.snapshot.state)) {
      throw createTerminalError("session_not_running", `Session ${sessionId} is not running.`, {
        sessionId,
      });
    }
    return record as SessionRecord & { pty: PtySession };
  }

  private writeToActivePty(sessionId: SessionId, data: string, origin: InputOrigin): void {
    const record = this.getActivePtyRecord(sessionId);
    record.pty.write(data);
    void this.record({
      type: "terminal.input",
      sessionId,
      at: new Date().toISOString(),
      origin,
      data,
    });
  }

  private async record(event: TerminalRecordingEvent): Promise<void> {
    try {
      await this.options.recorder?.record(event);
    } catch (error: unknown) {
      this.emit({
        type: "session.error",
        payload: normalizeTerminalError(error, event.sessionId, "recording_failed"),
      });
    }
  }

  private emit(event: RendererSessionEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error: unknown) {
        this.reportEventHandlerError(error, event);
      }
    }
  }

  private reportEventHandlerError(error: unknown, event: RendererSessionEvent): void {
    try {
      this.options.onEventHandlerError?.(error, event);
    } catch {
      // Keep terminal lifecycle events isolated from observer failures.
    }
  }

  private async killForShutdown(
    record: SessionRecord & { pty: PtySession },
    timeoutMs: number,
  ): Promise<"exited" | "timed_out"> {
    let cleanup: Unsubscribe = () => undefined;
    let cleanedUp = false;
    const cleanupOnce = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      cleanup();
    };
    const exited = new Promise<"exited">((resolve) => {
      cleanup = record.pty.onExit(() => {
        cleanupOnce();
        resolve("exited");
      });
    });

    try {
      record.pty.kill();
      if (record.snapshot.state === "running" || record.snapshot.state === "detached") {
        record.snapshot = {
          ...record.snapshot,
          state: "exiting",
          updatedAt: new Date().toISOString(),
        };
      }
    } catch (error: unknown) {
      cleanupOnce();
      this.emit({
        type: "session.error",
        payload: normalizeTerminalError(error, record.snapshot.sessionId, "session_kill_failed"),
      });
      return "timed_out";
    }

    const result = await Promise.race([exited, delay(timeoutMs).then(() => "timed_out" as const)]);
    cleanupOnce();
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
  return state === "running" || state === "detached" || state === "exiting";
}

function acceptsPtyOperations(state: TerminalSessionSnapshot["state"]): boolean {
  return state === "running" || state === "detached";
}

function canRequestKill(state: TerminalSessionSnapshot["state"]): boolean {
  return state === "running" || state === "detached" || state === "exiting";
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

const maxRecentOutputBytes = 100_000;

function appendRecentOutput(current: string, data: string): string {
  return sliceRecentOutput(`${current}${data}`, maxRecentOutputBytes);
}

function sliceRecentOutput(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const characters = Array.from(value);
  const output: string[] = [];
  let usedBytes = 0;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    if (!character) {
      continue;
    }
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) {
      break;
    }
    output.push(character);
    usedBytes += characterBytes;
  }
  return output.reverse().join("");
}
