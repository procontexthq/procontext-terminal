import {
  DEFAULT_RUN_TIMEOUT_MS,
  TEMPORARY_PTY_OUTPUT_BYTES,
  createTerminalError,
  type CloseTerminalRequest,
  type CloseTerminalResult,
  type CompletedTerminalRun,
  type OperationId,
  type RunTerminalRequest,
  type RunningTerminalRun,
  type SessionId,
} from "@terminal/protocol";

import type { TerminalSessionManager } from "./session-manager.js";

type TemporaryPtyOperation = {
  operationId: OperationId;
  sessionId: SessionId;
  startedAt: number;
};

export class TemporaryPtyOperations {
  private readonly operations = new Map<OperationId, TemporaryPtyOperation>();
  private readonly operationIdsBySession = new Map<SessionId, OperationId>();
  private readonly expiryTimers = new Map<OperationId, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly sessions: TerminalSessionManager,
    private readonly options: {
      retentionMs: number;
      createOperationId: () => OperationId;
      now: () => number;
      onBackgroundError: (error: unknown) => void;
    },
  ) {}

  get operationIds(): OperationId[] {
    return [...this.operations.keys()];
  }

  async run(request: RunTerminalRequest): Promise<RunningTerminalRun | CompletedTerminalRun> {
    validateTemporaryRun(request);
    const operationId = this.options.createOperationId();
    const startedAt = this.options.now();
    const session = await this.sessions.createCommandSession({
      input: request.input,
      cwd: request.cwd,
      env: request.env,
      shell: request.shell,
      createdBy: "agent",
      outputLimitBytes: TEMPORARY_PTY_OUTPUT_BYTES,
    });
    const operation = { operationId, sessionId: session.sessionId, startedAt };
    this.operations.set(operationId, operation);
    this.operationIdsBySession.set(session.sessionId, operationId);
    void this.monitor(operation);

    const completed = await this.sessions.waitForExit(
      session.sessionId,
      request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    );
    const summary = this.sessions.getSession({ sessionId: session.sessionId });
    if (!completed) {
      return {
        status: "running",
        operationId,
        sessionId: session.sessionId,
        tty: true,
        observationVersion: summary.observationVersion,
        elapsedMs: this.options.now() - startedAt,
      };
    }
    const output = this.sessions.getRunOutput(session.sessionId);
    return {
      status: "completed",
      operationId,
      sessionId: session.sessionId,
      tty: true,
      exitCode: summary.exitCode ?? null,
      signal: summary.signal ?? null,
      output: output.output,
      truncated: output.truncated,
      observationVersion: summary.observationVersion,
      durationMs: this.options.now() - startedAt,
    };
  }

  async closeOperation(operationId: OperationId): Promise<CloseTerminalResult | null> {
    const operation = this.operations.get(operationId);
    if (!operation) return null;
    const result = await this.sessions.close({ sessionId: operation.sessionId });
    if (result.status === "closed") this.remove(operation);
    return result;
  }

  async closeSession(request: CloseTerminalRequest): Promise<CloseTerminalResult> {
    const operationId = this.operationIdsBySession.get(request.sessionId);
    const result = await this.sessions.close(request);
    if (result.status === "closed" && operationId) {
      const operation = this.operations.get(operationId);
      if (operation) this.remove(operation);
    }
    return result;
  }

  dispose(): void {
    for (const operation of this.operations.values()) this.remove(operation);
  }

  private async monitor(operation: TemporaryPtyOperation): Promise<void> {
    try {
      if (await this.sessions.waitForExit(operation.sessionId)) {
        this.scheduleExpiry(operation);
      }
    } catch (error: unknown) {
      this.options.onBackgroundError(error);
    }
  }

  private scheduleExpiry(operation: TemporaryPtyOperation): void {
    if (this.operations.get(operation.operationId) !== operation) return;
    const timer = setTimeout(() => {
      void this.expire(operation);
    }, this.options.retentionMs);
    timer.unref?.();
    this.expiryTimers.set(operation.operationId, timer);
  }

  private async expire(operation: TemporaryPtyOperation): Promise<void> {
    try {
      const result = await this.sessions.close({ sessionId: operation.sessionId });
      if (result.status === "closed") this.remove(operation);
    } catch (error: unknown) {
      this.options.onBackgroundError(error);
    }
  }

  private remove(operation: TemporaryPtyOperation): void {
    const timer = this.expiryTimers.get(operation.operationId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(operation.operationId);
    this.operations.delete(operation.operationId);
    this.operationIdsBySession.delete(operation.sessionId);
  }
}

function validateTemporaryRun(request: RunTerminalRequest): void {
  if (request.maxOutputBytesPerStream !== undefined) {
    throw createTerminalError(
      "invalid_request",
      "maxOutputBytesPerStream is supported only when tty is false.",
      { operation: "terminal.run" },
    );
  }
  if (request.presentation === "background" || request.presentation === "foreground") {
    throw createTerminalError(
      "view_unavailable",
      "Only headless one-shot PTY runs are available.",
      { operation: "terminal.run" },
    );
  }
}
