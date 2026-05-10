import { describe, expect, it, vi } from "vitest";

import { createSessionId, type CreateSessionRequest } from "@terminal/protocol";
import type { PtyHost, PtySession, PtySpawnRequest } from "@terminal/pty-host";

import { TerminalSessionManager } from "../src/index";

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

  it("reports a timed out shutdown when killing a session fails", async () => {
    const host = new FakePtyHost();
    host.pty.kill.mockImplementationOnce(() => {
      throw new Error("kill failed");
    });
    const manager = new TerminalSessionManager(host);
    const events: string[] = [];
    manager.onSessionEvent((event) => events.push(event.type));
    await manager.createSession(request);

    const result = await manager.shutdown({ timeoutMs: 50 });

    expect(result).toEqual({ terminated: 0, timedOut: 1 });
    expect(events).toContain("session.error");
  });
});
