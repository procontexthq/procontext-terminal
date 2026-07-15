import {
  createTerminalError,
  type CloseTerminalResult,
  type InputOrigin,
  type ObserveTerminalRequest,
  type ObserveTerminalResult,
  type RendererSessionEvent,
  type ResizeTerminalRequest,
  type ScrollTerminalRequest,
  type ScrollTerminalResult,
  type SessionId,
  type TerminalInputResult,
  type TerminalPresentation,
  type TerminalResponseResult,
  type TerminalSessionSummary,
  type TerminalViewBootstrap,
} from "@terminal/protocol";
import type { PtyExitEvent, PtySession } from "@terminal/pty-host";

import { BoundedOutputJournal } from "./bounded-output-journal.js";
import { ObservationWaiters } from "./observation-waiters.js";
import { SessionRecording, type TerminalRecorder } from "./session-recording.js";
import { TerminalModel } from "./terminal-model.js";

export type { TerminalRecorder } from "./session-recording.js";

export type ManagedSessionOptions = {
  sessionId: SessionId;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  scrollback: number;
  createdBy: InputOrigin;
  pty: PtySession;
  recorder?: TerminalRecorder;
  emit: (event: RendererSessionEvent) => void;
  closeTimeoutMs: number;
  outputLimitBytes?: number;
  shellIntegrationNonce?: string;
  shellIntegrationInitializationTimeoutMs?: number;
  cleanupShellIntegration?: () => void;
  now?: () => Date;
};

export class ManagedTerminalSession {
  private readonly model: TerminalModel;
  private readonly waiters: ObservationWaiters;
  private readonly cleanup: Array<() => void> = [];
  private readonly exitWaiters = new Set<() => void>();
  private readonly now: () => Date;
  private readonly recording: SessionRecording;
  private readonly runOutput: BoundedOutputJournal | undefined;
  private operationQueue = Promise.resolve();
  private shellIntegrationTimeout: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private createdAt: string;
  private updatedAt: string;
  private exitedAt: string | undefined;
  private exitCode: number | null | undefined;
  private signal: string | null | undefined;
  private error: TerminalSessionSummary["error"];

  constructor(private readonly options: ManagedSessionOptions) {
    this.now = options.now ?? (() => new Date());
    this.createdAt = this.now().toISOString();
    this.updatedAt = this.createdAt;
    this.model = new TerminalModel({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      cwd: options.cwd,
      ...(options.shellIntegrationNonce
        ? { shellIntegrationNonce: options.shellIntegrationNonce }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      onBell: () =>
        options.emit({ type: "session.bell", payload: { sessionId: options.sessionId } }),
    });
    this.waiters = new ObservationWaiters(options.sessionId, () =>
      this.model.observe(options.sessionId),
    );
    this.runOutput =
      options.outputLimitBytes === undefined
        ? undefined
        : new BoundedOutputJournal(options.outputLimitBytes);
    this.recording = new SessionRecording({
      sessionId: options.sessionId,
      recorder: options.recorder,
      now: this.now,
      getSummary: () => this.summary,
      getStatus: () => this.model.currentRecording,
      updateStatus: (status) => {
        this.model.setRecording(status);
        this.touch();
        this.notifyState();
      },
      emitError: (error) => options.emit({ type: "session.error", payload: error }),
    });
    this.cleanup.push(
      options.pty.onData((data) => this.acceptOutput(data)),
      options.pty.onExit((event) => this.acceptExit(event)),
    );
    if (options.cleanupShellIntegration) {
      this.cleanup.push(options.cleanupShellIntegration);
    }
    this.model.setLifecycle("running");
    if (options.shellIntegrationNonce) {
      this.shellIntegrationTimeout = setTimeout(() => {
        if (!this.model.markShellIntegrationTimedOut()) return;
        this.touch();
        this.notifyState();
      }, options.shellIntegrationInitializationTimeoutMs ?? 10_000);
    }
    void this.recording.append({
      type: "session.created",
      sessionId: options.sessionId,
      at: this.updatedAt,
      metadata: { ...this.summary },
    });
  }

  get summary(): TerminalSessionSummary {
    return {
      sessionId: this.options.sessionId,
      lifecycle: this.model.currentLifecycle,
      shell: this.options.shell,
      cwd: this.model.currentCwd,
      dimensions: this.model.dimensions,
      title: this.model.currentTitle,
      createdBy: this.options.createdBy,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      ...(this.exitedAt ? { exitedAt: this.exitedAt } : {}),
      ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
      ...(this.error ? { error: this.error } : {}),
      observationVersion: this.model.version,
      presentation: this.model.currentPresentation,
      shellIntegration: this.model.currentShellIntegration,
      command: this.model.currentCommand,
      recording: this.model.currentRecording,
    };
  }

  async input(input: string, origin: InputOrigin): Promise<TerminalInputResult> {
    return await this.enqueue(async () => {
      this.requireRunning("terminal.input");
      if (this.model.scrollToBottomForInput()) this.notifyState();
      try {
        this.options.pty.write(input);
        await this.recording.append({
          type: "terminal.input",
          sessionId: this.options.sessionId,
          at: this.now().toISOString(),
          origin,
          data: input,
        });
        return { accepted: true, observationVersion: this.model.version };
      } catch (error: unknown) {
        throw this.wrap(error, "session_input_failed", "terminal.input");
      }
    });
  }

  async resize(request: ResizeTerminalRequest): Promise<{ observationVersion: number }> {
    return await this.enqueue(async () => {
      this.requireRunning("terminal.resize");
      try {
        this.options.pty.resize(request.cols, request.rows);
        this.model.resize(request.cols, request.rows);
        this.touch();
        await this.recording.append({
          type: "terminal.resize",
          sessionId: this.options.sessionId,
          at: this.updatedAt,
          cols: request.cols,
          rows: request.rows,
        });
        this.notifyState();
        return { observationVersion: this.model.version };
      } catch (error: unknown) {
        throw this.wrap(error, "session_resize_failed", "terminal.resize");
      }
    });
  }

  async scroll(request: ScrollTerminalRequest): Promise<ScrollTerminalResult> {
    return await this.enqueue(() => {
      this.requireRunningOrExited("terminal.scroll");
      try {
        const changed = this.model.scroll(request.scroll);
        if (changed) this.notifyViewport();
        return {
          status: changed ? ("changed" as const) : ("unchanged" as const),
          observationVersion: this.model.version,
        };
      } catch (error: unknown) {
        throw this.wrap(error, "session_scroll_failed", "terminal.scroll");
      }
    });
  }

  async reportViewport(viewportY: number, atBottom: boolean): Promise<boolean> {
    return await this.enqueue(() => {
      this.requireRunningOrExited("session.reportViewport");
      const changed = this.model.reportViewport(viewportY, atBottom);
      if (changed) this.notifyViewport();
      return changed;
    });
  }

  async setPresentation(presentation: TerminalPresentation): Promise<void> {
    await this.enqueue(() => {
      const previousVersion = this.model.version;
      this.model.setPresentation(presentation);
      if (this.model.version !== previousVersion) {
        this.touch();
        this.notifyState();
      }
    });
  }

  observe(request: ObserveTerminalRequest, signal?: AbortSignal): Promise<ObserveTerminalResult> {
    const observation = this.model.observe(this.options.sessionId);
    if (
      request.afterVersion === undefined ||
      observation.version > request.afterVersion ||
      observation.lifecycle === "exited" ||
      observation.lifecycle === "failed"
    ) {
      return Promise.resolve({ status: "changed", observation });
    }
    return this.waiters.wait(request.afterVersion, request.timeoutMs, signal);
  }

  getViewBootstrap(): TerminalViewBootstrap {
    return {
      session: this.summary,
      serialized: this.model.serialize(),
      sequence: this.sequence,
      viewportY: this.model.viewportY,
    };
  }

  getRunOutput(): { output: string; truncated: boolean } {
    if (!this.runOutput) {
      throw createTerminalError(
        "invalid_request",
        `Session ${this.options.sessionId} is not a temporary command session.`,
        { sessionId: this.options.sessionId, operation: "terminal.run" },
      );
    }
    const output = this.runOutput.read();
    return { output: output.data, truncated: output.truncated };
  }

  waitForExit(timeoutMs?: number): Promise<boolean> {
    if (this.model.currentLifecycle === "exited") return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.exitWaiters.delete(onExit);
        resolve(value);
      };
      const onExit = () => finish(true);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => finish(false), timeoutMs);
      }
      this.exitWaiters.add(onExit);
    });
  }

  async close(timeoutMs = this.options.closeTimeoutMs): Promise<CloseTerminalResult> {
    await this.enqueue(() => {
      if (this.model.currentLifecycle !== "running") return;
      this.model.setLifecycle("exiting");
      this.touch();
      this.notifyState();
      try {
        this.options.pty.kill();
      } catch (error: unknown) {
        this.model.setLifecycle("running");
        this.touch();
        this.notifyState();
        throw this.wrap(error, "session_close_failed", "terminal.close");
      }
    });
    if (this.model.currentLifecycle === "exiting") {
      const exited = await this.waitForExit(timeoutMs);
      if (!exited) return { status: "termination_pending" };
    }
    if (this.model.currentLifecycle !== "exited" && this.model.currentLifecycle !== "failed") {
      return { status: "termination_pending" };
    }
    await this.enqueue(() => this.recording.finalize());
    return {
      status: "closed",
      exitCode: this.exitCode ?? null,
      signal: this.signal ?? null,
    };
  }

  async startRecording(): Promise<void> {
    await this.enqueue(async () => {
      this.requireRunningOrExited("terminal.recording.start");
      await this.recording.start();
    });
  }

  async stopRecording(): Promise<void> {
    await this.enqueue(() => this.recording.stop());
  }

  async exportRecording() {
    await this.operationQueue;
    return await this.recording.export();
  }

  dispose(): void {
    if (this.shellIntegrationTimeout) clearTimeout(this.shellIntegrationTimeout);
    for (const cleanup of this.cleanup) cleanup();
    this.waiters.dispose();
    this.model.dispose();
  }

  private acceptOutput(data: string): void {
    void this.enqueue(async () => {
      const { titleChanged, shellIntegrationChanged, terminalResponses } =
        await this.model.write(data);
      const terminalResponseResults = this.returnTerminalResponses(terminalResponses);
      if (
        shellIntegrationChanged &&
        this.model.currentShellIntegration.status !== "initializing" &&
        this.shellIntegrationTimeout
      ) {
        clearTimeout(this.shellIntegrationTimeout);
        this.shellIntegrationTimeout = undefined;
      }
      this.sequence += 1;
      this.runOutput?.append(this.sequence, data);
      this.touch();
      await this.recording.append({
        type: "pty.output",
        sessionId: this.options.sessionId,
        at: this.updatedAt,
        data,
      });
      this.options.emit({
        type: "session.output",
        payload: {
          sessionId: this.options.sessionId,
          sequence: this.sequence,
          data,
          ...(terminalResponseResults.length > 0
            ? { terminalResponses: terminalResponseResults }
            : {}),
        },
      });
      if (titleChanged || shellIntegrationChanged) {
        this.options.emit({ type: "session.updated", payload: this.summary });
      }
      this.waiters.notify();
    }).catch((error: unknown) => {
      this.options.emit({
        type: "session.error",
        payload: this.wrap(error, "observation_failed", "processTerminalOutput"),
      });
    });
  }

  private returnTerminalResponses(responses: string[]): TerminalResponseResult[] {
    const results: TerminalResponseResult[] = [];
    for (const response of responses) {
      try {
        this.options.pty.write(response);
        results.push({ data: response, status: "returned" });
      } catch (error: unknown) {
        results.push({ data: response, status: "failed" });
        this.options.emit({
          type: "session.error",
          payload: this.wrap(error, "session_input_failed", "terminal.response"),
        });
      }
    }
    return results;
  }

  private acceptExit(event: PtyExitEvent): void {
    void this.enqueue(async () => {
      if (this.shellIntegrationTimeout) {
        clearTimeout(this.shellIntegrationTimeout);
        this.shellIntegrationTimeout = undefined;
      }
      const exitedAt = this.now().toISOString();
      this.exitedAt = exitedAt;
      this.exitCode = event.exitCode;
      this.signal = event.signal;
      this.updatedAt = exitedAt;
      this.model.setLifecycle("exited");
      await this.recording.append({
        type: "session.exited",
        sessionId: this.options.sessionId,
        at: exitedAt,
        exitCode: event.exitCode,
        signal: event.signal,
      });
      this.notifyState();
      for (const resolve of this.exitWaiters) resolve();
      this.exitWaiters.clear();
    }).catch((error: unknown) => {
      this.options.emit({
        type: "session.error",
        payload: this.wrap(error, "observation_failed", "processTerminalExit"),
      });
    });
  }

  private notifyState(): void {
    this.options.emit({ type: "session.updated", payload: this.summary });
    this.waiters.notify();
  }

  private notifyViewport(): void {
    this.options.emit({
      type: "session.viewport",
      payload: {
        sessionId: this.options.sessionId,
        viewportY: this.model.viewportY,
        observationVersion: this.model.version,
      },
    });
    this.waiters.notify();
  }

  private touch(): void {
    this.updatedAt = this.now().toISOString();
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private requireRunning(operation: string): void {
    if (this.model.currentLifecycle !== "running") {
      throw createTerminalError(
        "session_not_running",
        `Session ${this.options.sessionId} is not running.`,
        { sessionId: this.options.sessionId, operation },
      );
    }
  }

  private requireRunningOrExited(operation: string): void {
    if (this.model.currentLifecycle !== "running" && this.model.currentLifecycle !== "exited") {
      throw createTerminalError(
        "session_not_running",
        `Session ${this.options.sessionId} cannot perform ${operation}.`,
        { sessionId: this.options.sessionId, operation },
      );
    }
  }

  private wrap(error: unknown, type: Parameters<typeof createTerminalError>[0], operation: string) {
    if (isTerminalError(error)) return error;
    return createTerminalError(type, error instanceof Error ? error.message : String(error), {
      sessionId: this.options.sessionId,
      operation,
      cause: error instanceof Error ? error.message : String(error),
    });
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
