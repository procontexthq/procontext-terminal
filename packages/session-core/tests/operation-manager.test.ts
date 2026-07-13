import { describe, expect, it, vi } from "vitest";

import { createOperationId, type OperationId, type RunTerminalRequest } from "@terminal/protocol";
import type { PtyHost, PtySession } from "@terminal/pty-host";

import {
  TerminalOperationManager,
  TerminalSessionManager,
  type CapturedProcess,
  type CapturedProcessHost,
  type CapturedProcessObserver,
  type CapturedProcessSpawnRequest,
} from "../src/index";

describe("TerminalOperationManager captured runs", () => {
  it("returns separate stdout and stderr after process completion", async () => {
    const host = new FakeCapturedProcessHost((_request, observer) => {
      queueMicrotask(() => {
        observer.stdout("out");
        observer.stderr("err");
        observer.exit({ exitCode: 7, signal: null });
      });
    });
    const manager = createManager(host);

    await expect(manager.run(runRequest())).resolves.toMatchObject({
      status: "completed",
      tty: false,
      exitCode: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
      truncated: false,
    });
  });

  it("returns a running result when the initial wait expires", async () => {
    const host = new FakeCapturedProcessHost((_request, observer) => {
      queueMicrotask(() => observer.stdout("partial"));
    });
    const manager = createManager(host);

    await expect(manager.run(runRequest({ timeoutMs: 2 }))).resolves.toMatchObject({
      status: "running",
      tty: false,
      version: 1,
      stdout: "partial",
      stderr: "",
      truncated: false,
    });
  });

  it("returns only output newer than the caller's operation version", async () => {
    const host = new FakeCapturedProcessHost((_request, observer) => {
      queueMicrotask(() => observer.stdout("first"));
    });
    const manager = createManager(host);
    const initial = await manager.run(runRequest({ timeoutMs: 2 }));
    if (initial.status !== "running" || initial.tty) {
      throw new Error("Expected a running captured operation.");
    }

    host.observer?.stdout("second");
    host.observer?.stderr("error");
    host.observer?.exit({ exitCode: 0, signal: null });

    await expect(
      manager.observe({
        operationId: initial.operationId,
        afterVersion: initial.version,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      status: "changed",
      observation: {
        operationId: initial.operationId,
        version: 4,
        status: "completed",
        stdout: "second",
        stderr: "error",
        truncated: false,
        exitCode: 0,
        signal: null,
      },
    });
  });

  it("cancels pending captured-operation observations", async () => {
    const manager = createManager(new FakeCapturedProcessHost());
    const initial = await manager.run(runRequest({ timeoutMs: 2 }));
    if (initial.status !== "running" || initial.tty) {
      throw new Error("Expected a running captured operation.");
    }
    const abortController = new AbortController();

    const observation = manager.observe(
      {
        operationId: initial.operationId,
        afterVersion: initial.version,
        timeoutMs: 1_000,
      },
      abortController.signal,
    );
    abortController.abort();

    await expect(observation).rejects.toMatchObject({
      type: "observation_failed",
      operationId: initial.operationId,
    });
  });

  it("retains stream tails and marks evicted observations truncated", async () => {
    const host = new FakeCapturedProcessHost((_request, observer) => {
      queueMicrotask(() => {
        observer.stdout("abcdef");
        observer.exit({ exitCode: 0, signal: null });
      });
    });
    const manager = createManager(host);

    await expect(manager.run(runRequest({ maxOutputBytesPerStream: 4 }))).resolves.toMatchObject({
      status: "completed",
      stdout: "cdef",
      truncated: true,
    });
  });

  it("maps spawn failure without retaining an operation record", async () => {
    const operationId = createOperationId("failed-operation");
    const host = new FakeCapturedProcessHost();
    host.spawn.mockRejectedValueOnce(new Error("spawn unavailable"));
    const manager = createManager(host, { createOperationId: () => operationId });

    await expect(manager.run(runRequest())).rejects.toMatchObject({
      type: "process_spawn_failed",
      operationId,
    });
    await expect(manager.observe({ operationId, timeoutMs: 1 })).rejects.toMatchObject({
      type: "operation_not_found",
      operationId,
    });
  });

  it("terminates and removes a captured operation on close", async () => {
    const host = new FakeCapturedProcessHost();
    host.kill.mockImplementation(() => {
      host.observer?.exit({ exitCode: null, signal: "SIGTERM" });
    });
    const manager = createManager(host);
    const initial = await manager.run(runRequest({ timeoutMs: 2 }));
    if (initial.status !== "running" || initial.tty) {
      throw new Error("Expected a running captured operation.");
    }

    await expect(manager.close({ operationId: initial.operationId })).resolves.toEqual({
      status: "closed",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(host.kill).toHaveBeenCalledOnce();
    await expect(
      manager.observe({ operationId: initial.operationId, timeoutMs: 1 }),
    ).rejects.toMatchObject({ type: "operation_not_found" });
  });

  it("expires completed records but never active operations", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeCapturedProcessHost((_request, observer) => {
        observer.exit({ exitCode: 0, signal: null });
      });
      const manager = createManager(host, { retentionMs: 50 });
      const completed = await manager.run(runRequest());

      await vi.advanceTimersByTimeAsync(50);
      await expect(
        manager.observe({ operationId: completed.operationId, timeoutMs: 1 }),
      ).rejects.toMatchObject({ type: "operation_not_found" });

      const activeHost = new FakeCapturedProcessHost();
      const activeManager = createManager(activeHost, { retentionMs: 50 });
      const runningPromise = activeManager.run(runRequest({ timeoutMs: 1 }));
      await vi.advanceTimersByTimeAsync(1);
      const running = await runningPromise;
      await vi.advanceTimersByTimeAsync(500);

      const observation = activeManager.observe({
        operationId: running.operationId,
        afterVersion: 0,
        timeoutMs: 1,
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(observation).resolves.toMatchObject({ status: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes temporary PTY runs after output and canonical state settle", async () => {
    const ptyHost = new FakePtyHost();
    const sessions = new TerminalSessionManager(ptyHost);
    const manager = createManager(new FakeCapturedProcessHost(), {}, sessions);
    const resultPromise = manager.run(
      runRequest({ input: platformPrintCommand("tty-output"), tty: true, timeoutMs: 100 }),
    );
    await vi.waitFor(() => expect(sessions.listSessions()).toHaveLength(1));

    ptyHost.pty.emitData("tty-output");
    ptyHost.pty.emitExit({ exitCode: 5, signal: null });
    const result = await resultPromise;

    expect(result).toMatchObject({
      status: "completed",
      tty: true,
      exitCode: 5,
      output: "tty-output",
      truncated: false,
    });
    if (result.tty !== true) throw new Error("Expected a terminal run.");
    expect(sessions.getSession({ sessionId: result.sessionId }).lifecycle).toBe("exited");
  });

  it("keeps running temporary PTYs interactive and closes them by operation ID", async () => {
    const ptyHost = new FakePtyHost();
    const sessions = new TerminalSessionManager(ptyHost);
    const manager = createManager(new FakeCapturedProcessHost(), {}, sessions);
    const result = await manager.run(runRequest({ input: "vim", tty: true, timeoutMs: 2 }));
    if (result.status !== "running" || !result.tty) {
      throw new Error("Expected a running terminal operation.");
    }

    await sessions.input({ sessionId: result.sessionId, input: "\u001b", origin: "agent" });
    expect(ptyHost.pty.write).toHaveBeenCalledWith("\u001b");
    await expect(manager.close({ operationId: result.operationId })).resolves.toEqual({
      status: "closed",
      exitCode: 0,
      signal: null,
    });
    expect(() => sessions.getSession({ sessionId: result.sessionId })).toThrow(
      expect.objectContaining({ type: "session_not_found" }),
    );
  });

  it("resizes running temporary PTYs through the shared session boundary", async () => {
    const ptyHost = new FakePtyHost();
    const sessions = new TerminalSessionManager(ptyHost);
    const manager = createManager(new FakeCapturedProcessHost(), {}, sessions);
    const result = await manager.run(runRequest({ input: "watch", tty: true, timeoutMs: 2 }));
    if (result.status !== "running" || !result.tty) {
      throw new Error("Expected a running terminal operation.");
    }

    await expect(
      sessions.resize({ sessionId: result.sessionId, cols: 120, rows: 40 }),
    ).resolves.toEqual({ observationVersion: 2 });
    expect(ptyHost.pty.resize).toHaveBeenCalledWith(120, 40);
    expect(sessions.getSession({ sessionId: result.sessionId }).dimensions).toEqual({
      cols: 120,
      rows: 40,
    });

    await expect(manager.close({ operationId: result.operationId })).resolves.toMatchObject({
      status: "closed",
    });
  });

  it("expires completed headless temporary PTY sessions", async () => {
    vi.useFakeTimers();
    try {
      const ptyHost = new FakePtyHost();
      const sessions = new TerminalSessionManager(ptyHost);
      const manager = createManager(new FakeCapturedProcessHost(), { retentionMs: 50 }, sessions);
      const runningPromise = manager.run(runRequest({ input: "watch", tty: true, timeoutMs: 1 }));
      await vi.advanceTimersByTimeAsync(1);
      const running = await runningPromise;
      if (!running.tty) throw new Error("Expected a terminal run.");

      ptyHost.pty.emitExit({ exitCode: 0, signal: null });
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(50);

      expect(() => sessions.getSession({ sessionId: running.sessionId })).toThrow(
        expect.objectContaining({ type: "session_not_found" }),
      );
      await expect(manager.close({ operationId: running.operationId })).rejects.toMatchObject({
        type: "operation_not_found",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains completed presented temporary PTYs until explicit close", async () => {
    vi.useFakeTimers();
    try {
      const ptyHost = new FakePtyHost();
      const sessions = new TerminalSessionManager(ptyHost);
      const onTemporarySessionCreated = vi.fn(() => Promise.resolve());
      const manager = createManager(new FakeCapturedProcessHost(), { retentionMs: 50 }, sessions);
      const runningPromise = manager.run(
        runRequest({
          input: "watch",
          tty: true,
          timeoutMs: 1,
          presentation: "background",
        }),
        { onTemporarySessionCreated },
      );
      await vi.advanceTimersByTimeAsync(1);
      const running = await runningPromise;
      if (!running.tty) throw new Error("Expected a terminal run.");

      expect(onTemporarySessionCreated).toHaveBeenCalledWith(running.sessionId, "background");
      ptyHost.pty.emitExit({ exitCode: 0, signal: null });
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(500);

      expect(sessions.getSession({ sessionId: running.sessionId }).lifecycle).toBe("exited");
      await expect(manager.close({ operationId: running.operationId })).resolves.toMatchObject({
        status: "closed",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeCapturedProcessHost implements CapturedProcessHost {
  readonly kill = vi.fn();
  readonly process: CapturedProcess = { kill: this.kill };
  observer: CapturedProcessObserver | undefined;
  readonly spawn = vi.fn<CapturedProcessHost["spawn"]>((request, observer) => {
    this.observer = observer;
    this.onSpawn?.(request, observer);
    return Promise.resolve(this.process);
  });

  constructor(
    private readonly onSpawn?: (
      request: CapturedProcessSpawnRequest,
      observer: CapturedProcessObserver,
    ) => void,
  ) {}
}

function createManager(
  capturedProcessHost: CapturedProcessHost,
  options: {
    retentionMs?: number;
    createOperationId?: () => OperationId;
  } = {},
  sessionManager = new TerminalSessionManager(new UnusedPtyHost()),
): TerminalOperationManager {
  return new TerminalOperationManager(capturedProcessHost, sessionManager, {
    ...options,
    defaultCwd: () => process.cwd(),
    onBackgroundError: vi.fn(),
  });
}

class UnusedPtyHost implements PtyHost {
  spawn(): Promise<PtySession> {
    return Promise.reject(new Error("PTY host should not be used by this test."));
  }
}

class FakePtySession implements PtySession {
  private readonly dataHandlers = new Set<(data: string) => void>();
  private readonly exitHandlers = new Set<
    (event: { exitCode: number | null; signal: string | null }) => void
  >();
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn(() => this.emitExit({ exitCode: 0, signal: null }));

  onData(handler: (data: string) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onExit(handler: (event: { exitCode: number | null; signal: string | null }) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  emitData(data: string): void {
    for (const handler of this.dataHandlers) handler(data);
  }

  emitExit(event: { exitCode: number | null; signal: string | null }): void {
    for (const handler of this.exitHandlers) handler(event);
  }
}

class FakePtyHost implements PtyHost {
  readonly pty = new FakePtySession();
  readonly spawn = vi.fn<PtyHost["spawn"]>(() => Promise.resolve(this.pty));
}

function runRequest(overrides: Partial<RunTerminalRequest> = {}): RunTerminalRequest {
  return {
    input: "echo test",
    tty: false,
    shell: platformShell(),
    ...overrides,
  };
}

function platformShell(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  }
  return "/bin/sh";
}

function platformPrintCommand(text: string): string {
  if (process.platform === "win32") {
    return `echo ${text}`;
  }
  return `printf '${text}'`;
}
