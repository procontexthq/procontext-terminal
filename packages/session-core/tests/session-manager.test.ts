import { describe, expect, it, vi } from "vitest";

import { createSessionId, type CreateSessionRequest } from "@terminal/protocol";
import type { PtyHost, PtySession, PtySpawnRequest } from "@terminal/pty-host";

import { TerminalSessionManager, encodeTerminalKey, type TerminalRecorder } from "../src/index";

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

const request: CreateSessionRequest = { shell: "/bin/sh", cols: 80, rows: 24 };

describe("TerminalSessionManager", () => {
  it("creates a running session and emits lifecycle events", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: string[] = [];
    manager.onSessionEvent((event) => events.push(event.type));

    const snapshot = await manager.createSession(request);

    expect(snapshot.state).toBe("running");
    expect(snapshot.cols).toBe(80);
    expect(host.spawn).toHaveBeenCalledOnce();
    expect(events).toContain("session.created");
  });

  it("uses resolved shell metadata for the snapshot and PTY spawn request", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);

    const snapshot = await manager.createSession({
      shell: "/bin/sh",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });

    expect(snapshot.shell).toBe("/bin/sh");
    expect(snapshot.cwd).toBe("/tmp");
    expect(host.spawnRequests[0]).toMatchObject({
      sessionId: snapshot.sessionId,
      shell: {
        executable: "/bin/sh",
        args: [],
        cwd: "/tmp",
      },
      cols: 80,
      rows: 24,
    });
  });

  it("broadcasts PTY output with the session id", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: unknown[] = [];
    manager.onSessionEvent((event) => events.push(event));
    const snapshot = await manager.createSession(request);

    host.pty.emitData("hello");

    expect(events).toContainEqual({
      type: "session.output",
      payload: { sessionId: snapshot.sessionId, data: "hello" },
    });
  });

  it("isolates failing event subscribers from session lifecycle and other subscribers", async () => {
    const host = new FakePtyHost();
    const onEventHandlerError = vi.fn();
    const manager = new TerminalSessionManager(host, { onEventHandlerError });
    const events: string[] = [];
    const expectedError = new Error("subscriber failed");
    manager.onSessionEvent(() => {
      throw expectedError;
    });
    manager.onSessionEvent((event) => events.push(event.type));

    const snapshot = await manager.createSession(request);
    host.pty.emitData("hello");

    expect(snapshot.state).toBe("running");
    expect(events).toContain("session.created");
    expect(events).toContain("session.output");
    expect(onEventHandlerError).toHaveBeenCalledWith(
      expectedError,
      expect.objectContaining({ type: "session.created" }),
    );
  });

  it("routes write, resize, and kill to the PTY session", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    await manager.write({ sessionId: snapshot.sessionId, data: "echo ok\r" });
    await manager.resize({ sessionId: snapshot.sessionId, cols: 100, rows: 30 });
    await manager.kill({ sessionId: snapshot.sessionId });

    expect(host.pty.write).toHaveBeenCalledWith("echo ok\r");
    expect(host.pty.resize).toHaveBeenCalledWith(100, 30);
    expect(host.pty.kill).toHaveBeenCalledOnce();
    expect(manager.getSession({ sessionId: snapshot.sessionId }).state).toBe("exited");
  });

  it("routes key, paste, interrupt, and mouse input with origin metadata", async () => {
    const host = new FakePtyHost();
    const recorder: TerminalRecorder = {
      record: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      export: vi.fn<TerminalRecorder["export"]>((sessionId) =>
        Promise.resolve({
          schemaVersion: 1,
          sessionId,
          exportedAt: "2026-05-11T00:00:00.000Z",
          events: [],
        }),
      ),
    };
    const manager = new TerminalSessionManager(host, { recorder });
    const snapshot = await manager.createSession(request);

    await manager.sendKey({ sessionId: snapshot.sessionId, key: "ArrowUp", origin: "agent" });
    await manager.paste({ sessionId: snapshot.sessionId, text: "pasted", origin: "agent" });
    await manager.interrupt({ sessionId: snapshot.sessionId });
    await manager.sendMouse({ sessionId: snapshot.sessionId, data: "\x1b[M", origin: "agent" });

    expect(host.pty.write).toHaveBeenCalledWith(encodeTerminalKey("ArrowUp"));
    expect(host.pty.write).toHaveBeenCalledWith("pasted");
    expect(host.pty.write).toHaveBeenCalledWith(encodeTerminalKey("Ctrl+C"));
    expect(host.pty.write).toHaveBeenCalledWith("\x1b[M");
    expect(recorder.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "terminal.input", origin: "agent", data: "pasted" }),
    );
  });

  it("detaches, continues buffering output, and reattaches active PTY sessions", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const events: string[] = [];
    manager.onSessionEvent((event) => events.push(event.type));
    const snapshot = await manager.createSession(request);

    expect(manager.detachSession({ sessionId: snapshot.sessionId }).state).toBe("detached");
    await manager.write({
      sessionId: snapshot.sessionId,
      data: "echo detached\r",
      origin: "agent",
    });
    host.pty.emitData("detached output");
    expect(manager.readRecentOutput({ sessionId: snapshot.sessionId, maxBytes: 100 }).data).toBe(
      "detached output",
    );

    expect(manager.attachSession({ sessionId: snapshot.sessionId }).state).toBe("running");
    expect(events).toContain("session.detached");
    expect(events).toContain("session.attached");
    expect(host.pty.write).toHaveBeenCalledWith("echo detached\r");
  });

  it("refuses detach and attach requests for invalid lifecycle states", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    expect(() => manager.attachSession({ sessionId: snapshot.sessionId })).toThrow(
      expect.objectContaining({ type: "session_attach_failed" }),
    );
    host.pty.emitExit({ exitCode: 0, signal: null });
    expect(() => manager.detachSession({ sessionId: snapshot.sessionId })).toThrow(
      expect.objectContaining({ type: "session_detach_failed" }),
    );
  });

  it("releases exited sessions and disposes their PTY subscriptions", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    host.pty.emitExit({ exitCode: 0, signal: null });
    await manager.releaseSession({ sessionId: snapshot.sessionId });

    expect(() => manager.getSession({ sessionId: snapshot.sessionId })).toThrow();
    expect(host.pty.onDataHandlers.size).toBe(0);
    expect(host.pty.onExitHandlers.size).toBe(0);
  });

  it("releases failed sessions without requiring a PTY handle", async () => {
    const host = new FakePtyHost();
    host.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    const manager = new TerminalSessionManager(host);
    let failedSessionId = createSessionId("missing");
    manager.onSessionEvent((event) => {
      if (event.type === "session.error" && event.payload.sessionId) {
        failedSessionId = event.payload.sessionId;
      }
    });

    await expect(manager.createSession(request)).rejects.toMatchObject({
      type: "pty_spawn_failed",
    });
    await manager.releaseSession({ sessionId: failedSessionId });

    expect(() => manager.getSession({ sessionId: failedSessionId })).toThrow();
  });

  it("refuses to release active sessions without killing them", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    await expect(manager.releaseSession({ sessionId: snapshot.sessionId })).rejects.toMatchObject({
      type: "session_release_failed",
      sessionId: snapshot.sessionId,
    });

    expect(host.pty.kill).not.toHaveBeenCalled();
    expect(manager.getSession({ sessionId: snapshot.sessionId }).state).toBe("running");
  });

  it("marks a session failed when spawn fails", async () => {
    const host = new FakePtyHost();
    host.spawn.mockRejectedValueOnce(new Error("spawn failed"));
    const manager = new TerminalSessionManager(host);

    await expect(manager.createSession(request)).rejects.toMatchObject({
      type: "pty_spawn_failed",
    });
  });

  it("returns typed errors for missing sessions", async () => {
    const manager = new TerminalSessionManager(new FakePtyHost());
    const sessionId = createSessionId("missing");

    await expect(manager.write({ sessionId, data: "x" })).rejects.toMatchObject({
      type: "session_not_found",
      sessionId,
    });
  });

  it("wraps recorder control failures as recording errors and preserves missing-session errors", async () => {
    const host = new FakePtyHost();
    const recorder: TerminalRecorder = {
      record: vi.fn(),
      start: vi.fn(() => {
        throw new Error("start failed");
      }),
      stop: vi.fn(() => {
        throw new Error("stop failed");
      }),
      export: vi.fn(() => Promise.reject(new Error("export failed"))),
    };
    const manager = new TerminalSessionManager(host, { recorder });
    const snapshot = await manager.createSession(request);

    await expect(manager.startRecording({ sessionId: snapshot.sessionId })).rejects.toMatchObject({
      type: "recording_failed",
      sessionId: snapshot.sessionId,
      cause: "start failed",
    });
    await expect(manager.stopRecording({ sessionId: snapshot.sessionId })).rejects.toMatchObject({
      type: "recording_failed",
      sessionId: snapshot.sessionId,
      cause: "stop failed",
    });
    await expect(manager.exportRecording({ sessionId: snapshot.sessionId })).rejects.toMatchObject({
      type: "recording_failed",
      sessionId: snapshot.sessionId,
      cause: "export failed",
    });
    await expect(
      manager.startRecording({ sessionId: createSessionId("missing") }),
    ).rejects.toMatchObject({
      type: "session_not_found",
      sessionId: createSessionId("missing"),
    });
  });

  it("keeps a session running when a kill request fails before reaching the PTY", async () => {
    const host = new FakePtyHost();
    host.pty.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    await expect(manager.kill({ sessionId: snapshot.sessionId })).rejects.toMatchObject({
      type: "session_kill_failed",
      sessionId: snapshot.sessionId,
    });

    expect(manager.getSession({ sessionId: snapshot.sessionId }).state).toBe("running");
    await expect(
      manager.write({ sessionId: snapshot.sessionId, data: "echo still-running\r" }),
    ).resolves.toBeUndefined();
  });

  it("kills running sessions during bounded shutdown and clears session records", async () => {
    const host = new FakePtyHost();
    const manager = new TerminalSessionManager(host);
    const snapshot = await manager.createSession(request);

    const result = await manager.shutdown({ timeoutMs: 50 });

    expect(result).toEqual({ terminated: 1, timedOut: 0 });
    expect(host.pty.kill).toHaveBeenCalledOnce();
    expect(() => manager.getSession({ sessionId: snapshot.sessionId })).toThrow();
  });

  it("keeps a session running when shutdown kill fails before reaching the PTY", async () => {
    const host = new FakePtyHost();
    host.pty.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });
    const manager = new TerminalSessionManager(host);
    const events: string[] = [];
    manager.onSessionEvent((event) => events.push(event.type));
    const snapshot = await manager.createSession(request);

    const result = await manager.shutdown({ timeoutMs: 50 });

    expect(result).toEqual({ terminated: 0, timedOut: 1 });
    expect(events).toContain("session.error");
    expect(manager.getSession({ sessionId: snapshot.sessionId }).state).toBe("running");
    await expect(
      manager.write({ sessionId: snapshot.sessionId, data: "echo still-running\r" }),
    ).resolves.toBeUndefined();
  });
});
