import {
  createTerminalError,
  type CapturedOperationObservation,
  type CloseTerminalResult,
  type CompletedCapturedRun,
  type ObserveCapturedOperationResult,
  type OperationId,
  type RunningCapturedRun,
} from "@terminal/protocol";

import { BoundedOutputJournal } from "./bounded-output-journal.js";
import type {
  CapturedProcess,
  CapturedProcessExitEvent,
  CapturedProcessObserver,
} from "./captured-process-host.js";

type Waiter = {
  afterVersion: number;
  resolve: (result: ObserveCapturedOperationResult) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
};

export class CapturedOperation {
  readonly observer: CapturedProcessObserver;
  private readonly stdout: BoundedOutputJournal;
  private readonly stderr: BoundedOutputJournal;
  private readonly waiters = new Set<Waiter>();
  private readonly exitWaiters = new Set<() => void>();
  private process: CapturedProcess | undefined;
  private status: "running" | "completed" = "running";
  private version = 0;
  private exitCode: number | null | undefined;
  private signal: string | null | undefined;
  private disposed = false;

  constructor(
    readonly operationId: OperationId,
    maxOutputBytesPerStream: number,
    private readonly startedAt: number,
    private readonly onCompleted: () => void,
    private readonly now: () => number,
  ) {
    this.stdout = new BoundedOutputJournal(maxOutputBytesPerStream);
    this.stderr = new BoundedOutputJournal(maxOutputBytesPerStream);
    this.observer = {
      stdout: (data) => this.acceptOutput(this.stdout, data),
      stderr: (data) => this.acceptOutput(this.stderr, data),
      exit: (event) => this.acceptExit(event),
    };
  }

  attach(process: CapturedProcess): void {
    this.process = process;
  }

  async waitForInitialResult(
    timeoutMs: number,
  ): Promise<RunningCapturedRun | CompletedCapturedRun> {
    if (this.status === "running") {
      await this.waitForExit(timeoutMs);
    }
    return this.status === "completed" ? this.completedResult() : this.runningResult();
  }

  observe(
    afterVersion: number | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveCapturedOperationResult> {
    if (afterVersion === undefined || this.version > afterVersion || this.status === "completed") {
      return Promise.resolve({
        status: "changed",
        observation: this.observation(afterVersion),
      });
    }
    return this.wait(afterVersion, timeoutMs, signal);
  }

  async close(timeoutMs: number): Promise<CloseTerminalResult> {
    if (this.status === "running") {
      try {
        await this.process?.kill();
      } catch (error: unknown) {
        throw createTerminalError(
          "operation_close_failed",
          `Failed to terminate operation ${this.operationId}.`,
          {
            operationId: this.operationId,
            operation: "terminal.close",
            cause: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (!(await this.waitForExit(timeoutMs))) {
        return { status: "termination_pending" };
      }
    }
    return {
      status: "closed",
      exitCode: this.exitCode ?? null,
      signal: this.signal ?? null,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(
        createTerminalError("observation_failed", "Terminal operation was disposed.", {
          operationId: this.operationId,
          operation: "terminal.observe",
        }),
      );
    }
    this.exitWaiters.clear();
  }

  private acceptOutput(journal: BoundedOutputJournal, data: string): void {
    if (this.disposed || this.status !== "running") return;
    this.version += 1;
    journal.append(this.version, data);
    this.notify();
  }

  private acceptExit(event: CapturedProcessExitEvent): void {
    if (this.disposed || this.status === "completed") return;
    this.exitCode = event.exitCode;
    this.signal = event.signal;
    this.status = "completed";
    this.version += 1;
    this.notify();
    for (const resolve of this.exitWaiters) resolve();
    this.exitWaiters.clear();
    this.onCompleted();
  }

  private runningResult(): RunningCapturedRun {
    const stdout = this.stdout.read();
    const stderr = this.stderr.read();
    return {
      status: "running",
      operationId: this.operationId,
      tty: false,
      version: this.version,
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: stdout.truncated || stderr.truncated,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  private completedResult(): CompletedCapturedRun {
    const stdout = this.stdout.read();
    const stderr = this.stderr.read();
    return {
      status: "completed",
      operationId: this.operationId,
      tty: false,
      exitCode: this.exitCode ?? null,
      signal: this.signal ?? null,
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: stdout.truncated || stderr.truncated,
      durationMs: this.now() - this.startedAt,
    };
  }

  private observation(afterVersion?: number): CapturedOperationObservation {
    const stdout = this.stdout.read(afterVersion);
    const stderr = this.stderr.read(afterVersion);
    return {
      operationId: this.operationId,
      version: this.version,
      status: this.status,
      stdout: stdout.data,
      stderr: stderr.data,
      truncated: stdout.truncated || stderr.truncated,
      ...(this.status === "completed"
        ? { exitCode: this.exitCode ?? null, signal: this.signal ?? null }
        : {}),
    };
  }

  private wait(
    afterVersion: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveCapturedOperationResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(waiter);
        resolve({ status: "timeout", operationId: this.operationId, version: this.version });
      }, timeoutMs);
      const waiter: Waiter = { afterVersion, resolve, reject, timeout };
      if (signal) {
        const abort = () => {
          this.removeWaiter(waiter);
          reject(
            createTerminalError("observation_failed", "Terminal observation was cancelled.", {
              operationId: this.operationId,
              operation: "terminal.observe",
            }),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        waiter.abortCleanup = () => signal.removeEventListener("abort", abort);
      }
      this.waiters.add(waiter);
      if (signal?.aborted) {
        this.removeWaiter(waiter);
        reject(
          createTerminalError("observation_failed", "Terminal observation was cancelled.", {
            operationId: this.operationId,
            operation: "terminal.observe",
          }),
        );
      }
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      if (this.version <= waiter.afterVersion && this.status === "running") continue;
      this.removeWaiter(waiter);
      waiter.resolve({
        status: "changed",
        observation: this.observation(waiter.afterVersion),
      });
    }
  }

  private removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timeout);
    waiter.abortCleanup?.();
    this.waiters.delete(waiter);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.status === "completed") return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.exitWaiters.delete(onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      this.exitWaiters.add(onExit);
    });
  }
}
