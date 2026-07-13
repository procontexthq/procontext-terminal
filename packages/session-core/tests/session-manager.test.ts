import { describe, expect, it, vi } from "vitest";

import { createSessionId, type RendererSessionEvent } from "@terminal/protocol";
import type { PtyHost, PtySession, PtySpawnRequest } from "@terminal/pty-host";

import { TerminalSessionManager, type TerminalRecorder } from "../src/index";

class FakePtySession implements PtySession {
  readonly onDataHandlers = new Set<(data: string) => void>();
  readonly onExitHandlers = new Set<
    (event: { exitCode: number | null; signal: string | null }) => void
  >();
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn(() => {
    this.emitExit({ exitCode: 0, signal: null });
  });

  onData(handler: (data: string) => void): () => void {
    this.onDataHandlers.add(handler);
    return () => this.onDataHandlers.delete(handler);
  }

  onExit(handler: (event: { exitCode: number | null; signal: string | null }) => void): () => void {
    this.onExitHandlers.add(handler);
    return () => this.onExitHandlers.delete(handler);
  }

  emitData(data: string): void {
    for (const handler of this.onDataHandlers) handler(data);
  }

  emitExit(event: { exitCode: number | null; signal: string | null }): void {
    for (const handler of this.onExitHandlers) handler(event);
  }
}

class FakePtyHost implements PtyHost {
  readonly pty = new FakePtySession();
  readonly spawnRequests: PtySpawnRequest[] = [];
  readonly spawn = vi.fn<PtyHost["spawn"]>((request) => {
    this.spawnRequests.push(request);
    return Promise.resolve(this.pty);
  });
}

const testShell = platformShell();
const request = { shell: testShell, cols: 80, rows: 24 };

describe("TerminalSessionManager", () => {
  it("creates a running headless session with canonical state", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);

    const summary = await manager.createSession(request);
    const observation = await manager.observe({
      sessionId: summary.sessionId,
      timeoutMs: 100,
    });

    expect(summary).toMatchObject({
      lifecycle: "running",
      dimensions: { cols: 80, rows: 24 },
      presentation: { state: "headless" },
      observationVersion: 1,
    });
    expect(observation).toMatchObject({
      status: "changed",
      observation: {
        lifecycle: "running",
        alternateScreen: false,
        shellIntegration: { status: "unavailable" },
        command: { state: "unknown" },
      },
    });
  });

  it("uses resolved shell and default working-directory metadata", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host, { defaultCwd: () => "/Users/tester" });

    const summary = await manager.createSession(request);

    expect(summary.cwd).toBe("/Users/tester");
    expect(host.spawnRequests[0]).toMatchObject({
      sessionId: summary.sessionId,
      shell: { executable: testShell, args: [], cwd: "/Users/tester" },
      cols: 80,
      rows: 24,
    });
  });

  it("creates temporary command sessions and retains their bounded output tail", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);

    const summary = await manager.createCommandSession({
      input: platformPrintCommand("abcdef"),
      shell: testShell,
      outputLimitBytes: 4,
      createdBy: "agent",
    });

    expect(host.spawnRequests[0]?.shell.args.length).toBeGreaterThan(0);
    host.pty.emitData("abcdef");
    host.pty.emitExit({ exitCode: 3, signal: null });
    await expect(manager.waitForExit(summary.sessionId, 100)).resolves.toBe(true);

    expect(manager.getRunOutput(summary.sessionId)).toEqual({
      output: "cdef",
      truncated: true,
    });
    expect(manager.getSession({ sessionId: summary.sessionId })).toMatchObject({
      lifecycle: "exited",
      exitCode: 3,
    });
  });

  it("commits parsed output before emitting its sequence and observation version", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: RendererSessionEvent[] = [];
    manager.onSessionEvent((event) => events.push(event));
    const summary = await manager.createSession(request);

    host.pty.emitData("hello");
    const observation = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(observation).toMatchObject({ status: "changed", observation: { version: 2 } });
    if (observation.status !== "changed") throw new Error("Expected changed observation.");
    expect(observation.observation.viewport.rows[0]).toMatchObject({ text: "hello" });
    expect(events).toContainEqual({
      type: "session.output",
      payload: { sessionId: summary.sessionId, sequence: 1, data: "hello" },
    });
  });

  it("tracks title, cursor visibility, and alternate-screen state headlessly", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);

    host.pty.emitData("\u001b]0;Editor\u0007\u001b[?25l\u001b[?1049hvim");
    const result = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(result).toMatchObject({
      status: "changed",
      observation: {
        title: "Editor",
        alternateScreen: true,
        cursor: { visible: false },
      },
    });
  });

  it("routes one raw input stream and records its origin", async () => {
    const host = new FakePtyHost();
    const recorder = createRecorder();
    const manager = new TerminalSessionManager(host, { recorder });
    const summary = await manager.createSession(request);

    const result = await manager.input({
      sessionId: summary.sessionId,
      input: "\u0003",
      origin: "agent",
    });

    expect(result.accepted).toBe(true);
    expect(host.pty.write).toHaveBeenCalledWith("\u0003");
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal.input", origin: "agent", data: "\u0003" }),
    );
  });

  it("preserves accepted mixed-origin input order", async () => {
    const host = new FakePtyHost();
    const recorder = createRecorder();
    const manager = new TerminalSessionManager(host, { recorder });
    const summary = await manager.createSession(request);

    await Promise.all([
      manager.input({ sessionId: summary.sessionId, input: "human", origin: "human" }),
      manager.input({ sessionId: summary.sessionId, input: "agent", origin: "agent" }),
      manager.input({ sessionId: summary.sessionId, input: "system", origin: "system" }),
    ]);

    expect(host.pty.write.mock.calls).toEqual([["human"], ["agent"], ["system"]]);
    expect(
      recorder.record.mock.calls
        .map(([event]) => event)
        .filter((event) => event.type === "terminal.input")
        .map((event) => ({ origin: event.origin, data: event.data })),
    ).toEqual([
      { origin: "human", data: "human" },
      { origin: "agent", data: "agent" },
      { origin: "system", data: "system" },
    ]);
  });

  it("resizes the PTY and canonical emulator before publishing the version", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);

    const result = await manager.resize({ sessionId: summary.sessionId, cols: 100, rows: 30 });
    const observation = await manager.observe({
      sessionId: summary.sessionId,
      timeoutMs: 100,
    });

    expect(host.pty.resize).toHaveBeenCalledWith(100, 30);
    expect(result.observationVersion).toBe(2);
    expect(observation).toMatchObject({
      status: "changed",
      observation: { dimensions: { cols: 100, rows: 30 }, version: 2 },
    });
  });

  it("supports shared scroll and viewport reporting", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host, { scrollback: 5_000 });
    const summary = await manager.createSession({ ...request, rows: 2 });
    host.pty.emitData("one\r\ntwo\r\nthree\r\nfour");
    await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    const scrolled = manager.scroll({
      sessionId: summary.sessionId,
      scroll: { type: "lines", delta: -1 },
    });
    const reported = manager.reportViewport({
      sessionId: summary.sessionId,
      viewportY: 0,
    });

    expect(scrolled.status).toBe("changed");
    expect(reported).toBe(true);
    expect((await currentObservation(manager, summary.sessionId)).viewport.atBottom).toBe(false);
  });

  it("times out observation without repeating the viewport", async () => {
    const manager = new TerminalSessionManager(new FakePtyHost());
    const summary = await manager.createSession(request);

    await expect(
      manager.observe({
        sessionId: summary.sessionId,
        afterVersion: summary.observationVersion,
        timeoutMs: 5,
      }),
    ).resolves.toEqual({
      status: "timeout",
      sessionId: summary.sessionId,
      version: summary.observationVersion,
    });
  });

  it("cancels observation waiters without affecting later observations", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);
    const abortController = new AbortController();

    const pending = manager.observe(
      {
        sessionId: summary.sessionId,
        afterVersion: summary.observationVersion,
        timeoutMs: 1_000,
      },
      abortController.signal,
    );
    abortController.abort();

    await expect(pending).rejects.toMatchObject({
      type: "observation_failed",
      sessionId: summary.sessionId,
    });

    host.pty.emitData("after-cancel");
    const nextObservation = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });
    expect(nextObservation).toMatchObject({
      status: "changed",
      observation: { version: summary.observationVersion + 1 },
    });
    if (nextObservation.status !== "changed") {
      throw new Error("Expected a changed observation after cancellation.");
    }
    expect(nextObservation.observation.viewport.rows[0]).toMatchObject({
      text: "after-cancel",
    });
  });

  it("flushes trailing output before committing exit", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);

    host.pty.emitData("tail");
    host.pty.emitExit({ exitCode: 7, signal: null });

    const result = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });
    await waitForLifecycle(manager, summary.sessionId, "exited");
    const final = await currentObservation(manager, summary.sessionId);

    expect(result.status).toBe("changed");
    expect(final.lifecycle).toBe("exited");
    expect(final.viewport.rows[0]).toMatchObject({ text: "tail" });
    expect(manager.getSession({ sessionId: summary.sessionId })).toMatchObject({
      lifecycle: "exited",
      exitCode: 7,
    });
  });

  it("serializes canonical state for renderer bootstrap", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);
    host.pty.emitData("bootstrap");
    await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    const bootstrap = manager.getViewBootstrap({ sessionId: summary.sessionId });

    expect(bootstrap.sequence).toBe(1);
    expect(bootstrap.serialized).toContain("bootstrap");
    expect(bootstrap.session.sessionId).toBe(summary.sessionId);
  });

  it("closes, finalizes recording, and releases the session", async () => {
    const host = new FakePtyHost();
    const recorder = createRecorder();
    const manager = new TerminalSessionManager(host, { recorder });
    const summary = await manager.createSession(request);
    await manager.startRecording({ sessionId: summary.sessionId });

    await expect(manager.close({ sessionId: summary.sessionId })).resolves.toEqual({
      status: "closed",
      exitCode: 0,
      signal: null,
    });

    expect(recorder.stop).toHaveBeenCalledWith(summary.sessionId);
    expect(() => manager.getSession({ sessionId: summary.sessionId })).toThrow(
      expect.objectContaining({ type: "session_not_found" }),
    );
  });

  it("preserves an exited record when recording finalization fails", async () => {
    const host = new FakePtyHost();
    const recorder = createRecorder();
    recorder.stop.mockRejectedValueOnce(new Error("disk unavailable"));
    const manager = new TerminalSessionManager(host, { recorder });
    const summary = await manager.createSession(request);
    await manager.startRecording({ sessionId: summary.sessionId });

    await expect(manager.close({ sessionId: summary.sessionId })).rejects.toMatchObject({
      type: "recording_failed",
      sessionId: summary.sessionId,
    });
    expect(manager.getSession({ sessionId: summary.sessionId })).toMatchObject({
      lifecycle: "exited",
      recording: { state: "failed" },
    });
  });

  it("retries failed recording finalization before disposing the exited record", async () => {
    const host = new FakePtyHost();
    const recorder = createRecorder();
    recorder.stop
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValueOnce(undefined);
    const manager = new TerminalSessionManager(host, { recorder });
    const summary = await manager.createSession(request);
    await manager.startRecording({ sessionId: summary.sessionId });

    await expect(manager.close({ sessionId: summary.sessionId })).rejects.toMatchObject({
      type: "recording_failed",
    });
    await expect(manager.close({ sessionId: summary.sessionId })).resolves.toMatchObject({
      status: "closed",
    });

    expect(recorder.stop).toHaveBeenCalledTimes(2);
    expect(() => manager.getSession({ sessionId: summary.sessionId })).toThrow(
      expect.objectContaining({ type: "session_not_found" }),
    );
  });

  it("keeps timed-out close records available for retry", async () => {
    const host = new FakePtyHost();
    host.pty.kill.mockImplementation(() => undefined);
    const manager = new TerminalSessionManager(host, { closeTimeoutMs: 2 });
    const summary = await manager.createSession(request);

    await expect(manager.close({ sessionId: summary.sessionId })).resolves.toEqual({
      status: "termination_pending",
    });
    expect(manager.getSession({ sessionId: summary.sessionId }).lifecycle).toBe("exiting");
  });

  it("uses the caller-provided bounded timeout during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePtyHost();
      host.pty.kill.mockImplementation(() => undefined);
      const manager = new TerminalSessionManager(host, { closeTimeoutMs: 60_000 });
      await manager.createSession(request);

      const shutdown = manager.shutdown({ timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);

      await expect(shutdown).resolves.toEqual({ terminated: 0, timedOut: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates failing event subscribers", async () => {
    const host = new FakePtyHost();
    const onEventHandlerError = vi.fn();
    const manager = new TerminalSessionManager(host, { onEventHandlerError });
    const events: string[] = [];
    manager.onSessionEvent(() => {
      throw new Error("subscriber failed");
    });
    manager.onSessionEvent((event) => events.push(event.type));

    await manager.createSession(request);

    expect(events).toContain("session.updated");
    expect(onEventHandlerError).toHaveBeenCalled();
  });

  it("returns typed errors for missing sessions", async () => {
    const manager = new TerminalSessionManager(new FakePtyHost());
    const sessionId = createSessionId("missing");

    await expect(manager.input({ sessionId, input: "x", origin: "agent" })).rejects.toMatchObject({
      type: "session_not_found",
      sessionId,
    });
  });
});

async function currentObservation(
  manager: TerminalSessionManager,
  sessionId: ReturnType<typeof createSessionId>,
) {
  const result = await manager.observe({ sessionId, timeoutMs: 100 });
  if (result.status !== "changed") throw new Error("Expected an observation.");
  return result.observation;
}

async function waitForLifecycle(
  manager: TerminalSessionManager,
  sessionId: ReturnType<typeof createSessionId>,
  lifecycle: "exited",
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (manager.getSession({ sessionId }).lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Session did not reach ${lifecycle}.`);
}

function createRecorder() {
  return {
    record: vi.fn<TerminalRecorder["record"]>(() => Promise.resolve()),
    start: vi.fn<TerminalRecorder["start"]>(() => Promise.resolve()),
    stop: vi.fn<TerminalRecorder["stop"]>(() => Promise.resolve()),
    export: vi.fn<TerminalRecorder["export"]>((sessionId) =>
      Promise.resolve({
        schemaVersion: 1,
        sessionId,
        exportedAt: "2026-05-11T00:00:00.000Z",
        events: [],
      }),
    ),
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
