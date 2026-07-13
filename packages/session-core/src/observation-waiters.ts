import {
  createTerminalError,
  type ObserveTerminalResult,
  type SessionId,
  type TerminalObservation,
} from "@terminal/protocol";

type Waiter = {
  afterVersion: number;
  resolve: (result: ObserveTerminalResult) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortCleanup?: () => void;
};

export class ObservationWaiters {
  private readonly waiters = new Set<Waiter>();

  constructor(
    private readonly sessionId: SessionId,
    private readonly getObservation: () => TerminalObservation,
  ) {}

  wait(
    afterVersion: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ObserveTerminalResult> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.remove(waiter);
        resolve({
          status: "timeout",
          sessionId: this.sessionId,
          version: this.getObservation().version,
        });
      }, timeoutMs);
      const waiter: Waiter = { afterVersion, resolve, reject, timeout };
      if (signal) {
        const abort = () => {
          this.remove(waiter);
          reject(
            createTerminalError("observation_failed", "Terminal observation was cancelled.", {
              sessionId: this.sessionId,
              operation: "terminal.observe",
            }),
          );
        };
        signal.addEventListener("abort", abort, { once: true });
        waiter.abortCleanup = () => signal.removeEventListener("abort", abort);
      }
      this.waiters.add(waiter);
      if (signal?.aborted) {
        waiter.abortCleanup?.();
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        reject(
          createTerminalError("observation_failed", "Terminal observation was cancelled.", {
            sessionId: this.sessionId,
            operation: "terminal.observe",
          }),
        );
      }
    });
  }

  notify(): void {
    const observation = this.getObservation();
    for (const waiter of [...this.waiters]) {
      if (
        observation.version > waiter.afterVersion ||
        observation.lifecycle === "exited" ||
        observation.lifecycle === "failed"
      ) {
        this.remove(waiter);
        waiter.resolve({ status: "changed", observation });
      }
    }
  }

  dispose(): void {
    for (const waiter of [...this.waiters]) {
      this.remove(waiter);
      waiter.reject(
        createTerminalError("observation_failed", "Terminal session was disposed.", {
          sessionId: this.sessionId,
          operation: "terminal.observe",
        }),
      );
    }
  }

  private remove(waiter: Waiter): void {
    clearTimeout(waiter.timeout);
    waiter.abortCleanup?.();
    this.waiters.delete(waiter);
  }
}
