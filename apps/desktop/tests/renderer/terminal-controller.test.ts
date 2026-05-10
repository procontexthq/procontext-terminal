// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type {
  RendererTerminalApi,
  RendererSessionEvent,
  SessionId,
  TerminalSessionSnapshot,
} from "@terminal/protocol";

import { createTerminalSession, type TerminalLike } from "../../src/renderer/terminal-controller";

class FakeTerminal implements TerminalLike {
  readonly writes: string[] = [];
  readonly open = vi.fn();
  readonly dispose = vi.fn();
  readonly dataSubscriptionDispose = vi.fn();
  private onDataHandler: ((data: string) => void) | null = null;

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.onDataHandler = handler;
    return { dispose: this.dataSubscriptionDispose };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  emitData(data: string): void {
    this.onDataHandler?.(data);
  }
}

function fakeApi(): RendererTerminalApi & {
  emit: (event: RendererSessionEvent) => void;
  unsubscribeSessionEvent: ReturnType<typeof vi.fn>;
} {
  let handler: ((event: RendererSessionEvent) => void) | null = null;
  const unsubscribeSessionEvent = vi.fn(() => {
    handler = null;
  });
  const snapshot: TerminalSessionSnapshot = {
    sessionId: "session-1" as SessionId,
    state: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    title: null,
    createdBy: "human",
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
  return {
    createSession: vi.fn<RendererTerminalApi["createSession"]>(() => Promise.resolve(snapshot)),
    write: vi.fn<RendererTerminalApi["write"]>(() => Promise.resolve()),
    resize: vi.fn<RendererTerminalApi["resize"]>(() => Promise.resolve()),
    kill: vi.fn<RendererTerminalApi["kill"]>(() => Promise.resolve()),
    getSession: vi.fn<RendererTerminalApi["getSession"]>(() => Promise.resolve(snapshot)),
    getConfig: vi.fn<RendererTerminalApi["getConfig"]>(() =>
      Promise.resolve({
        schemaVersion: 1,
        terminal: {
          fontFamily: "monospace",
          fontSize: 13,
          scrollback: 5000,
          theme: {
            background: "#000",
            foreground: "#fff",
            cursor: "#fff",
          },
        },
        shell: { defaultProfile: null },
      }),
    ),
    onSessionEvent: vi.fn<RendererTerminalApi["onSessionEvent"]>((_sessionId, nextHandler) => {
      handler = nextHandler;
      return unsubscribeSessionEvent;
    }),
    emit: (event) => handler?.(event),
    unsubscribeSessionEvent,
  };
}

describe("terminal controller", () => {
  it("creates a terminal session, forwards input, writes output, and resizes", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const element = document.createElement("div");

    const controller = await createTerminalSession({
      api,
      element,
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });

    terminal.emitData("echo ok\r");
    api.emit({
      type: "session.output",
      payload: { sessionId: controller.sessionId, data: "ok" },
    });
    await controller.resize();

    const createSession = vi.mocked(api.createSession);
    const write = vi.mocked(api.write);
    const resize = vi.mocked(api.resize);
    expect(createSession).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(write).toHaveBeenCalledWith({ sessionId: controller.sessionId, data: "echo ok\r" });
    expect(terminal.writes).toEqual(["ok"]);
    expect(resize).toHaveBeenCalledWith({ sessionId: controller.sessionId, cols: 80, rows: 24 });
  });

  it("reports terminal write and resize failures through onError", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const expectedError = new Error("write failed");
    vi.mocked(api.write).mockRejectedValueOnce(expectedError);
    vi.mocked(api.resize).mockRejectedValueOnce(new Error("resize failed"));
    const onError = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onError,
    });

    terminal.emitData("x");
    await Promise.resolve();
    await controller.resize();

    expect(onError).toHaveBeenCalledWith(expectedError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "resize failed" }));
  });

  it("stops forwarding input after the session exits", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const onError = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onError,
    });

    api.emit({
      type: "session.exited",
      payload: { sessionId: controller.sessionId, exitCode: 0, signal: null },
    });
    terminal.emitData("ignored after exit");
    await controller.resize();
    await Promise.resolve();

    expect(api.write).not.toHaveBeenCalled();
    expect(api.resize).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("disposes renderer resources when session creation fails", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const expectedError = new Error("create failed");
    vi.mocked(api.createSession).mockRejectedValueOnce(expectedError);

    await expect(
      createTerminalSession({
        api,
        element: document.createElement("div"),
        createTerminal: () => terminal,
        createFitAddon: () => ({
          fit: vi.fn(),
          proposeDimensions: () => ({ cols: 80, rows: 24 }),
        }),
      }),
    ).rejects.toBe(expectedError);

    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.dataSubscriptionDispose).not.toHaveBeenCalled();
    expect(api.unsubscribeSessionEvent).not.toHaveBeenCalled();
  });

  it("detaches the renderer view by default when disposed", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });

    await controller.dispose();
    api.emit({
      type: "session.output",
      payload: { sessionId: controller.sessionId, data: "after-dispose" },
    });

    expect(terminal.dataSubscriptionDispose).toHaveBeenCalledOnce();
    expect(api.unsubscribeSessionEvent).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.writes).toEqual([]);
    expect(api.kill).not.toHaveBeenCalled();
  });

  it("ignores resize and skips termination after disposal or session exit", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const onError = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onError,
    });

    api.emit({
      type: "session.exited",
      payload: { sessionId: controller.sessionId, exitCode: 0, signal: null },
    });
    await controller.dispose({ sessionLifecycle: "terminate" });
    await controller.resize();

    expect(api.kill).not.toHaveBeenCalled();
    expect(api.resize).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("terminates the PTY session when disposal requests termination", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });

    await controller.dispose({ sessionLifecycle: "terminate" });

    expect(api.kill).toHaveBeenCalledWith({ sessionId: controller.sessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it("reports termination failures while still disposing renderer resources", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const expectedError = new Error("kill failed");
    vi.mocked(api.kill).mockRejectedValueOnce(expectedError);
    const onError = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onError,
    });

    await controller.dispose({ sessionLifecycle: "terminate" });

    expect(onError).toHaveBeenCalledWith(expectedError);
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it("reports renderer cleanup failures while still terminating the PTY session", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const expectedError = new Error("dispose failed");
    terminal.dispose.mockImplementationOnce(() => {
      throw expectedError;
    });
    const onError = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onError,
    });

    await controller.dispose({ sessionLifecycle: "terminate" });

    expect(onError).toHaveBeenCalledWith(expectedError);
    expect(api.kill).toHaveBeenCalledWith({ sessionId: controller.sessionId });
  });
});
