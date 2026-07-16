import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSessionId, type RendererSessionEvent } from "@terminal/protocol";
import type { PtyHost, PtySession, PtySpawnRequest } from "@terminal/pty-host";
import {
  encodeShellIntegrationMarker,
  formatShellIntegrationOsc,
  fullShellIntegrationCapabilities,
} from "@terminal/shell-integration";

import { TerminalModel, TerminalSessionManager, type TerminalRecorder } from "../src/index";

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
  it("starts recording newly created sessions only when configured by default", async () => {
    const recorder = createRecorder();
    const enabledManager = new TerminalSessionManager(new FakePtyHost(), {
      recorder,
      startRecordingByDefault: () => true,
    });

    const enabled = await enabledManager.createSession(request);

    expect(recorder.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: enabled.sessionId }),
    );
    expect(enabled.recording).toEqual({ state: "active" });

    const agent = await enabledManager.createSession({ ...request, createdBy: "agent" });
    const temporary = await enabledManager.createCommandSession({
      input: "echo ready",
      shell: testShell,
      createdBy: "system",
      outputLimitBytes: 1_024,
    });
    expect(agent.recording).toEqual({ state: "active" });
    expect(temporary.recording).toEqual({ state: "active" });
    expect(recorder.start).toHaveBeenCalledTimes(3);

    const disabledRecorder = createRecorder();
    const disabledManager = new TerminalSessionManager(new FakePtyHost(), {
      recorder: disabledRecorder,
      startRecordingByDefault: () => false,
    });
    const disabled = await disabledManager.createSession(request);

    expect(disabledRecorder.start).not.toHaveBeenCalled();
    expect(disabled.recording).toEqual({ state: "inactive" });
  });

  it("keeps a new session observable when default recording cannot start", async () => {
    const manager = new TerminalSessionManager(new FakePtyHost(), {
      startRecordingByDefault: () => true,
    });
    const events: RendererSessionEvent[] = [];
    manager.onSessionEvent((event) => events.push(event));

    const summary = await manager.createSession(request);

    expect(summary.recording).toMatchObject({
      state: "failed",
      error: { type: "recording_failed", sessionId: summary.sessionId },
    });
    expect(manager.getSession({ sessionId: summary.sessionId })).toEqual(summary);
    expect(
      events.some(
        (event) =>
          event.type === "session.error" &&
          event.payload.type === "recording_failed" &&
          event.payload.sessionId === summary.sessionId,
      ),
    ).toBe(true);
  });

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

  it("resolves configured canonical scrollback when a session is created", async () => {
    const host = new FakePtyHost();
    const getScrollback = vi.fn(() => 100);
    const manager = new TerminalSessionManager(host, { getScrollback });
    const summary = await manager.createSession({ ...request, rows: 2 });

    host.pty.emitData(
      Array.from({ length: 110 }, (_, index) => `line-${String(index)}`).join("\r\n"),
    );
    const result = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(getScrollback).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "changed",
      observation: { viewport: { scrollbackRows: 100 } },
    });
  });

  it("returns canonical terminal protocol responses to the PTY", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: RendererSessionEvent[] = [];
    const unsubscribe = manager.onSessionEvent((event) => events.push(event));
    const summary = await manager.createSession(request);

    host.pty.emitData("abc\u001b[6n");
    await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(host.pty.write).toHaveBeenCalledExactlyOnceWith("\u001b[1;4R");
    expect(events).toContainEqual({
      type: "session.output",
      payload: {
        sessionId: summary.sessionId,
        sequence: 1,
        data: "abc\u001b[6n",
        terminalResponses: [{ data: "\u001b[1;4R", status: "returned" }],
      },
    });
    unsubscribe();
  });

  it("marks a terminal response as failed when the PTY write fails", async () => {
    const host = new FakePtyHost();
    host.pty.write.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    const manager = new TerminalSessionManager(host);
    const events: RendererSessionEvent[] = [];
    const unsubscribe = manager.onSessionEvent((event) => events.push(event));
    const summary = await manager.createSession(request);

    host.pty.emitData("\u001b[6n");
    await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(events).toContainEqual({
      type: "session.output",
      payload: {
        sessionId: summary.sessionId,
        sequence: 1,
        data: "\u001b[6n",
        terminalResponses: [{ data: "\u001b[1;1R", status: "failed" }],
      },
    });
    const errorEvent = events.find((event) => event.type === "session.error");
    expect(errorEvent?.payload).toMatchObject({ type: "session_input_failed" });
    unsubscribe();
  });

  it("preserves response positions when only a later PTY write succeeds", async () => {
    const host = new FakePtyHost();
    host.pty.write
      .mockImplementationOnce(() => {
        throw new Error("write failed");
      })
      .mockImplementationOnce(() => undefined);
    const manager = new TerminalSessionManager(host);
    const events: RendererSessionEvent[] = [];
    const unsubscribe = manager.onSessionEvent((event) => events.push(event));
    const summary = await manager.createSession(request);

    host.pty.emitData("\u001b[6n\r\nx\u001b[6n");
    await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });

    expect(events).toContainEqual({
      type: "session.output",
      payload: {
        sessionId: summary.sessionId,
        sequence: 1,
        data: "\u001b[6n\r\nx\u001b[6n",
        terminalResponses: [
          { data: "\u001b[1;1R", status: "failed" },
          { data: "\u001b[2;2R", status: "returned" },
        ],
      },
    });
    unsubscribe();
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

  it("prepares supported persistent shells and exposes trusted semantic state", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession({
      shell: supportedInteractiveShell(),
      cwd: process.cwd(),
    });
    const nonce = shellIntegrationNonce(host.spawnRequests[0]);
    expect(summary.shellIntegration.status).toBe("initializing");
    expect(host.spawnRequests[0]?.shell.env.PCT_SHELL_INTEGRATION_NONCE).toBeUndefined();
    expect(host.spawnRequests[0]?.shell.args.length).toBeGreaterThan(0);

    host.pty.emitData(
      [
        shellOsc(nonce, "ready", "", JSON.stringify(fullShellIntegrationCapabilities)),
        shellOsc(nonce, "prompt", "", process.cwd()),
        shellOsc(nonce, "command-start", "command-1", "echo ok"),
      ].join(""),
    );
    const running = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });
    expect(running).toMatchObject({
      status: "changed",
      observation: {
        cwd: process.cwd(),
        shellIntegration: { status: "available" },
        command: { state: "running", commandId: "command-1", commandLine: "echo ok" },
      },
    });

    host.pty.emitData(shellOsc(nonce, "command-finish", "command-1", "0"));
    await waitForCommandState(manager, summary.sessionId, "idle");
    expect(manager.getSession({ sessionId: summary.sessionId })).toMatchObject({
      command: { state: "idle", lastCommand: { commandId: "command-1", exitCode: 0 } },
    });
  });

  it("degrades supported sessions after the initialization timeout and permits recovery", async () => {
    vi.useFakeTimers();
    try {
      const host = new FakePtyHost();
      const manager = new TerminalSessionManager(host, {
        shellIntegrationInitializationTimeoutMs: 50,
      });
      const summary = await manager.createSession({
        shell: supportedInteractiveShell(),
        cwd: process.cwd(),
      });
      const nonce = shellIntegrationNonce(host.spawnRequests[0]);
      await vi.advanceTimersByTimeAsync(50);
      expect(manager.getSession({ sessionId: summary.sessionId })).toMatchObject({
        shellIntegration: { status: "degraded" },
        command: { state: "unknown" },
      });

      host.pty.emitData(
        shellOsc(nonce, "ready", "", JSON.stringify(fullShellIntegrationCapabilities)),
      );
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(0);
      expect(manager.getSession({ sessionId: summary.sessionId }).shellIntegration.status).toBe(
        "available",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inject shell integration into temporary command sessions", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);

    const summary = await manager.createCommandSession({
      input: platformPrintCommand("ok"),
      shell: testShell,
      outputLimitBytes: 1024,
      createdBy: "agent",
    });

    expect(host.spawnRequests[0]?.shell.env.PCT_SHELL_INTEGRATION_NONCE).toBeUndefined();
    expect(summary.shellIntegration.status).toBe("unavailable");
  });

  it.skipIf(process.platform === "win32")(
    "cleans generated shell startup files after close",
    async () => {
      const host = new FakePtyHost();
      const manager = new TerminalSessionManager(host);
      const summary = await manager.createSession({
        shell: "/bin/bash",
        cwd: process.cwd(),
      });
      const rcfile = host.spawnRequests[0]?.shell.args[1];
      if (!rcfile) throw new Error("Expected a generated Bash rcfile.");
      const temporaryPath = dirname(rcfile);

      expect(existsSync(temporaryPath)).toBe(true);
      await manager.close({ sessionId: summary.sessionId });
      expect(existsSync(temporaryPath)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans generated shell startup files after spawn failure",
    async () => {
      let startupPath: string | null = null;
      const host: PtyHost = {
        spawn: vi.fn<PtyHost["spawn"]>((spawnRequest) => {
          const rcfile = spawnRequest.shell.args[1];
          startupPath = rcfile ? dirname(rcfile) : null;
          return Promise.reject(new Error("spawn failed"));
        }),
      };
      const manager = new TerminalSessionManager(host);

      await expect(
        manager.createSession({ shell: "/bin/bash", cwd: process.cwd() }),
      ).rejects.toMatchObject({ type: "pty_spawn_failed" });
      expect(startupPath).not.toBeNull();
      expect(existsSync(startupPath!)).toBe(false);
    },
  );

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

  it("waits for earlier PTY output parsing before applying a resize", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const summary = await manager.createSession(request);
    const originalWrite = TerminalModel.prototype.write;
    let releaseWrite: () => void = () => undefined;
    let markWriteStarted: () => void = () => undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const continueWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const write = vi
      .spyOn(TerminalModel.prototype, "write")
      .mockImplementationOnce(async function (data) {
        markWriteStarted();
        await continueWrite;
        return await originalWrite.call(this, data);
      });

    try {
      host.pty.emitData("before-resize");
      await writeStarted;
      const resize = manager.resize({
        sessionId: summary.sessionId,
        cols: 100,
        rows: 30,
      });
      await Promise.resolve();

      expect(host.pty.resize).not.toHaveBeenCalled();

      releaseWrite();
      await resize;

      expect(host.pty.resize).toHaveBeenCalledWith(100, 30);
    } finally {
      write.mockRestore();
    }
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

    const scrolled = await manager.scroll({
      sessionId: summary.sessionId,
      scroll: { type: "lines", delta: -1 },
    });
    const reported = await manager.reportViewport({
      sessionId: summary.sessionId,
      viewportY: 0,
      atBottom: false,
    });

    expect(scrolled.status).toBe("changed");
    expect(reported).toBe(true);
    expect((await currentObservation(manager, summary.sessionId)).viewport.atBottom).toBe(false);
  });

  it("resolves a stale renderer bottom report against the current canonical bottom", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host, { scrollback: 5_000 });
    const summary = await manager.createSession({ ...request, rows: 2 });
    host.pty.emitData("one\r\ntwo\r\nthree");
    const first = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: summary.observationVersion,
      timeoutMs: 100,
    });
    if (first.status !== "changed") throw new Error("Expected initial terminal output.");
    const staleBottomY = first.observation.viewport.scrollbackRows;

    host.pty.emitData("\r\nfour\r\nfive\r\nsix");
    const advanced = await manager.observe({
      sessionId: summary.sessionId,
      afterVersion: first.observation.version,
      timeoutMs: 100,
    });
    if (advanced.status !== "changed") throw new Error("Expected advanced terminal output.");
    expect(advanced.observation.viewport).toMatchObject({ atBottom: true });
    expect(advanced.observation.viewport.scrollbackRows).toBeGreaterThan(staleBottomY);

    const reported = await manager.reportViewport({
      sessionId: summary.sessionId,
      viewportY: staleBottomY,
      atBottom: true,
    });

    expect(reported).toBe(false);
    expect((await currentObservation(manager, summary.sessionId)).viewport.atBottom).toBe(true);
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

  it("emits session removal only after a completed close releases the record", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: RendererSessionEvent[] = [];
    manager.onSessionEvent((event) => events.push(event));
    const summary = await manager.createSession(request);

    await manager.close({ sessionId: summary.sessionId });

    expect(events.at(-1)).toEqual({
      type: "session.removed",
      payload: { sessionId: summary.sessionId },
    });
    expect(manager.listSessions()).toEqual([]);
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

async function waitForCommandState(
  manager: TerminalSessionManager,
  sessionId: ReturnType<typeof createSessionId>,
  state: "idle" | "running" | "unknown",
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (manager.getSession({ sessionId }).command.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Session did not reach command state ${state}.`);
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

function supportedInteractiveShell(): string {
  return process.platform === "win32" ? "powershell.exe" : "/bin/bash";
}

function shellOsc(
  nonce: string,
  event: "ready" | "prompt" | "command-start" | "command-finish",
  commandId: string,
  payload: string,
): string {
  return formatShellIntegrationOsc(
    encodeShellIntegrationMarker({ nonce, event, commandId, payload }),
  );
}

function shellIntegrationNonce(request: PtySpawnRequest | undefined): string {
  if (!request) throw new Error("Expected a PTY spawn request.");
  const sources = [...request.shell.args];
  for (const argument of request.shell.args) {
    if (existsSync(argument)) sources.push(readFileSync(argument, "utf8"));
    const dotSourcedPath = argument.match(/^\. '((?:[^']|'')+)'$/)?.[1]?.replaceAll("''", "'");
    if (dotSourcedPath && existsSync(dotSourcedPath)) {
      sources.push(readFileSync(dotSourcedPath, "utf8"));
    }
  }
  const match = sources
    .join("\n")
    .match(/(?:__pct_nonce=|__PctNonce = |__pct_nonce )'([A-Za-z0-9_-]{22})'/);
  if (!match?.[1]) throw new Error("Expected a generated shell integration nonce.");
  return match[1];
}

function platformPrintCommand(text: string): string {
  if (process.platform === "win32") {
    return `echo ${text}`;
  }
  return `printf '${text}'`;
}
