import {
  createTerminalError,
  type SessionId,
  type TerminalError,
  type TerminalRecordingEvent,
  type TerminalRecordingExport,
  type TerminalRecordingStatus,
  type TerminalSessionSummary,
} from "@terminal/protocol";

export type TerminalRecorder = {
  record(event: TerminalRecordingEvent): void | Promise<void>;
  start(session: TerminalSessionSummary): void | Promise<void>;
  stop(sessionId: SessionId): void | Promise<void>;
  export(sessionId: SessionId): Promise<TerminalRecordingExport>;
};

type SessionRecordingOptions = {
  sessionId: SessionId;
  recorder?: TerminalRecorder;
  now: () => Date;
  getSummary: () => TerminalSessionSummary;
  getStatus: () => TerminalRecordingStatus;
  updateStatus: (status: TerminalRecordingStatus) => void;
  emitError: (error: TerminalError) => void;
};

export class SessionRecording {
  constructor(private readonly options: SessionRecordingOptions) {}

  async start(): Promise<void> {
    if (this.options.getStatus().state === "active") return;
    if (!this.options.recorder) {
      throw this.failure(
        createTerminalError("recording_failed", "Terminal recording is unavailable.", {
          sessionId: this.options.sessionId,
          operation: "terminal.recording.start",
        }),
        "terminal.recording.start",
      );
    }
    try {
      await this.options.recorder.start(this.options.getSummary());
      this.options.updateStatus({ state: "active" });
    } catch (error: unknown) {
      throw this.failure(error, "terminal.recording.start");
    }
  }

  async stop(): Promise<void> {
    if (this.options.getStatus().state === "inactive") return;
    if (!this.options.recorder) return;
    try {
      await this.options.recorder.stop(this.options.sessionId);
      this.options.updateStatus({ state: "inactive" });
    } catch (error: unknown) {
      throw this.failure(error, "terminal.recording.stop");
    }
  }

  async finalize(): Promise<void> {
    const state = this.options.getStatus().state;
    if (state !== "active" && state !== "failed") return;
    await this.stop();
  }

  async export(): Promise<TerminalRecordingExport> {
    if (!this.options.recorder) {
      return {
        schemaVersion: 1,
        sessionId: this.options.sessionId,
        exportedAt: this.options.now().toISOString(),
        events: [],
      };
    }
    try {
      return await this.options.recorder.export(this.options.sessionId);
    } catch (error: unknown) {
      throw this.failure(error, "terminal.recording.export");
    }
  }

  async append(event: TerminalRecordingEvent): Promise<void> {
    if (!this.options.recorder) return;
    try {
      await this.options.recorder.record(event);
    } catch (error: unknown) {
      const terminalError = this.failure(error, "recording.append");
      this.options.emitError(terminalError);
    }
  }

  private failure(error: unknown, operation: string): TerminalError {
    const terminalError = isTerminalError(error)
      ? error
      : createTerminalError(
          "recording_failed",
          error instanceof Error ? error.message : String(error),
          {
            sessionId: this.options.sessionId,
            operation,
            cause: error instanceof Error ? error.message : String(error),
          },
        );
    this.options.updateStatus({ state: "failed", error: terminalError });
    return terminalError;
  }
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
