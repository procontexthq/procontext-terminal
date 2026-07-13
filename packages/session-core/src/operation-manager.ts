import {
  DEFAULT_CAPTURED_OUTPUT_BYTES,
  DEFAULT_RUN_TIMEOUT_MS,
  createOperationId,
  createTerminalError,
  type CloseOperationRequest,
  type CloseTerminalRequest,
  type CloseTerminalResult,
  type ObserveCapturedOperationRequest,
  type ObserveCapturedOperationResult,
  type OperationId,
  type RunTerminalRequest,
  type RunTerminalResult,
  type SessionId,
  type TerminalPresentationMode,
} from "@terminal/protocol";
import { resolveCommandShell } from "@terminal/pty-host";

import { CapturedOperation } from "./captured-operation.js";
import type { CapturedProcessHost } from "./captured-process-host.js";
import type { TerminalSessionManager } from "./session-manager.js";
import { TemporaryPtyOperations } from "./temporary-pty-operations.js";

const DEFAULT_RETENTION_MS = 10 * 60 * 1000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export type TerminalOperationManagerOptions = {
  defaultCwd?: () => string;
  retentionMs?: number;
  closeTimeoutMs?: number;
  createOperationId?: () => OperationId;
  now?: () => number;
  onBackgroundError: (error: unknown) => void;
};

export type TerminalOperationShutdownResult = {
  closed: number;
  timedOut: number;
};

export type TerminalOperationRunHooks = {
  onTemporarySessionCreated?: (
    sessionId: SessionId,
    presentation: TerminalPresentationMode,
  ) => Promise<void>;
};

export class TerminalOperationManager {
  private readonly capturedOperations = new Map<OperationId, CapturedOperation>();
  private readonly expiryTimers = new Map<OperationId, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly temporaryOperations: TemporaryPtyOperations;

  constructor(
    private readonly capturedProcessHost: CapturedProcessHost,
    sessionManager: TerminalSessionManager,
    private readonly options: TerminalOperationManagerOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.temporaryOperations = new TemporaryPtyOperations(sessionManager, {
      retentionMs: options.retentionMs ?? DEFAULT_RETENTION_MS,
      createOperationId: options.createOperationId ?? createOperationId,
      now: this.now,
      onBackgroundError: options.onBackgroundError,
    });
  }

  async run(
    request: RunTerminalRequest,
    hooks: TerminalOperationRunHooks = {},
  ): Promise<RunTerminalResult> {
    return request.tty === true
      ? await this.temporaryOperations.run(request, hooks.onTemporarySessionCreated)
      : await this.runCaptured(request);
  }

  private async runCaptured(request: RunTerminalRequest): Promise<RunTerminalResult> {
    const operationId = this.options.createOperationId?.() ?? createOperationId();
    const startedAt = this.now();
    let shell;
    try {
      shell = resolveCommandShell({
        input: request.input,
        cwd: request.cwd ?? this.options.defaultCwd?.(),
        env: request.env,
        shell: request.shell,
      });
    } catch (error: unknown) {
      throw this.spawnError(error, operationId);
    }

    const operation = new CapturedOperation(
      operationId,
      request.maxOutputBytesPerStream ?? DEFAULT_CAPTURED_OUTPUT_BYTES,
      startedAt,
      () => this.scheduleCapturedExpiry(operationId),
      this.now,
    );
    this.capturedOperations.set(operationId, operation);
    try {
      operation.attach(
        await this.capturedProcessHost.spawn({ operationId, shell }, operation.observer),
      );
    } catch (error: unknown) {
      this.removeCaptured(operationId);
      throw this.spawnError(error, operationId);
    }

    return await operation.waitForInitialResult(request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  }

  async observe(
    request: ObserveCapturedOperationRequest,
    signal?: AbortSignal,
  ): Promise<ObserveCapturedOperationResult> {
    return await this.get(request.operationId).observe(
      request.afterVersion,
      request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      signal,
    );
  }

  sessionIdForOperation(operationId: OperationId): SessionId | undefined {
    return this.temporaryOperations.sessionIdFor(operationId);
  }

  async close(request: CloseOperationRequest | CloseTerminalRequest): Promise<CloseTerminalResult> {
    if ("sessionId" in request) {
      return await this.temporaryOperations.closeSession(request);
    }

    const captured = this.capturedOperations.get(request.operationId);
    if (captured) {
      const result = await captured.close(this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS);
      if (result.status === "closed") this.removeCaptured(request.operationId);
      return result;
    }

    const temporaryResult = await this.temporaryOperations.closeOperation(request.operationId);
    if (!temporaryResult) throw this.notFound(request.operationId);
    return temporaryResult;
  }

  dispose(): void {
    for (const operationId of [...this.capturedOperations.keys()]) {
      this.removeCaptured(operationId);
    }
    this.temporaryOperations.dispose();
  }

  async shutdown(): Promise<TerminalOperationShutdownResult> {
    const operationIds = [
      ...this.capturedOperations.keys(),
      ...this.temporaryOperations.operationIds,
    ];
    let closed = 0;
    let timedOut = 0;
    const results = await Promise.allSettled(
      operationIds.map(async (operationId) => {
        const result = await this.close({ operationId });
        if (result.status === "closed") closed += 1;
        else timedOut += 1;
      }),
    );
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason as unknown);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to shut down terminal operations.");
    }
    return { closed, timedOut };
  }

  private get(operationId: OperationId): CapturedOperation {
    const operation = this.capturedOperations.get(operationId);
    if (!operation) throw this.notFound(operationId);
    return operation;
  }

  private scheduleCapturedExpiry(operationId: OperationId): void {
    const timer = setTimeout(
      () => this.removeCaptured(operationId),
      this.options.retentionMs ?? DEFAULT_RETENTION_MS,
    );
    timer.unref?.();
    this.expiryTimers.set(operationId, timer);
  }

  private removeCaptured(operationId: OperationId): void {
    const timer = this.expiryTimers.get(operationId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(operationId);
    this.capturedOperations.get(operationId)?.dispose();
    this.capturedOperations.delete(operationId);
  }

  private notFound(operationId: OperationId) {
    return createTerminalError("operation_not_found", `Operation ${operationId} was not found.`, {
      operationId,
    });
  }

  private spawnError(error: unknown, operationId: OperationId) {
    if (isTerminalError(error)) return error;
    return createTerminalError(
      "process_spawn_failed",
      `Failed to start operation ${operationId}.`,
      {
        operationId,
        operation: "terminal.run",
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
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
