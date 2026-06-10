// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type {
  RendererTerminalApi,
  RendererSessionEvent,
  RequestId,
  SessionId,
  TerminalSessionSnapshot,
} from "@terminal/protocol";

import { createTerminalSession, type TerminalLike } from "../../src/renderer/terminal-controller";

class FakeTerminal implements TerminalLike {
  readonly writes: string[] = [];
  readonly open = vi.fn();
  readonly focus = vi.fn();
  readonly dispose = vi.fn();
  readonly dataSubscriptionDispose = vi.fn();
  readonly titleSubscriptionDispose = vi.fn();
  readonly bellSubscriptionDispose = vi.fn();
  private onDataHandler: ((data: string) => void) | null = null;
  private onTitleHandler: ((title: string) => void) | null = null;
  private onBellHandler: (() => void) | null = null;

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.onDataHandler = handler;
    return { dispose: this.dataSubscriptionDispose };
  }

  write(data: string): void {
    this.writes.push(data);
  }

  onTitleChange(handler: (title: string) => void): { dispose: () => void } {
    this.onTitleHandler = handler;
    return { dispose: this.titleSubscriptionDispose };
  }

  onBell(handler: () => void): { dispose: () => void } {
    this.onBellHandler = handler;
    return { dispose: this.bellSubscriptionDispose };
  }

  emitData(data: string): void {
    this.onDataHandler?.(data);
  }

  emitTitle(title: string): void {
    this.onTitleHandler?.(title);
  }

  emitBell(): void {
    this.onBellHandler?.();
  }
}

class ObservableFakeTerminal extends FakeTerminal {
  readonly cols = 80;
  readonly rows = 2;
  readonly buffer = {
    active: {
      type: "normal" as const,
      cursorX: 3,
      cursorY: 1,
      viewportY: 0,
      length: 2,
      getLine: (row: number) =>
        row === 0
          ? {
              isWrapped: false,
              translateToString: () => "first row",
            }
          : {
              isWrapped: false,
              translateToString: () => "second row",
            },
    },
  };
}

function fakeApi(): RendererTerminalApi & {
  emit: (event: RendererSessionEvent) => void;
  unsubscribeSessionEvent: ReturnType<typeof vi.fn>;
  unsubscribeTerminalEvent: ReturnType<typeof vi.fn>;
} {
  let sessionHandler: ((event: RendererSessionEvent) => void) | null = null;
  let terminalHandler: ((event: RendererSessionEvent) => void) | null = null;
  const unsubscribeSessionEvent = vi.fn(() => {
    sessionHandler = null;
  });
  const unsubscribeTerminalEvent = vi.fn(() => {
    terminalHandler = null;
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
  const terminalConfig = {
    schemaVersion: 2 as const,
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
    shell: { defaultProfile: null, profiles: [] },
    workspace: {
      tabs: [{ cwd: null, shell: null }],
      activeTabIndex: 0,
    },
    recording: {
      state: "disabled" as const,
      redactedPatterns: [],
    },
  };
  return {
    createSession: vi.fn<RendererTerminalApi["createSession"]>(() => Promise.resolve(snapshot)),
    listSessions: vi.fn<RendererTerminalApi["listSessions"]>(() => Promise.resolve([snapshot])),
    write: vi.fn<RendererTerminalApi["write"]>(() => Promise.resolve()),
    sendKey: vi.fn<RendererTerminalApi["sendKey"]>(() => Promise.resolve()),
    paste: vi.fn<RendererTerminalApi["paste"]>(() => Promise.resolve()),
    sendMouse: vi.fn<RendererTerminalApi["sendMouse"]>(() => Promise.resolve()),
    interrupt: vi.fn<RendererTerminalApi["interrupt"]>(() => Promise.resolve()),
    resize: vi.fn<RendererTerminalApi["resize"]>(() => Promise.resolve()),
    kill: vi.fn<RendererTerminalApi["kill"]>(() => Promise.resolve()),
    detachSession: vi.fn<RendererTerminalApi["detachSession"]>(() =>
      Promise.resolve({ ...snapshot, state: "detached" }),
    ),
    attachSession: vi.fn<RendererTerminalApi["attachSession"]>(() => Promise.resolve(snapshot)),
    readRecentOutput: vi.fn<RendererTerminalApi["readRecentOutput"]>(() =>
      Promise.resolve({
        sessionId: snapshot.sessionId,
        data: "",
        maxBytes: 100_000,
        capturedAt: "2026-05-09T00:00:00.000Z",
      }),
    ),
    captureScreen: vi.fn<RendererTerminalApi["captureScreen"]>(() =>
      Promise.resolve({
        sessionId: snapshot.sessionId,
        cols: 80,
        rows: 24,
        cursor: { x: 0, y: 0, visible: true },
        alternateScreen: false,
        title: null,
        viewport: [],
        capturedAt: "2026-05-09T00:00:00.000Z",
      }),
    ),
    respondToSnapshot: vi.fn<RendererTerminalApi["respondToSnapshot"]>(() => Promise.resolve()),
    reportSnapshotUnavailable: vi.fn<RendererTerminalApi["reportSnapshotUnavailable"]>(() =>
      Promise.resolve(),
    ),
    setTitle: vi.fn<RendererTerminalApi["setTitle"]>(() => Promise.resolve(snapshot)),
    reportBell: vi.fn<RendererTerminalApi["reportBell"]>(() => Promise.resolve()),
    waitForText: vi.fn<RendererTerminalApi["waitForText"]>(() =>
      Promise.resolve({ sessionId: snapshot.sessionId, matchedAt: "2026-05-09T00:00:00.000Z" }),
    ),
    waitForScreenChange: vi.fn<RendererTerminalApi["waitForScreenChange"]>(() =>
      Promise.resolve({ sessionId: snapshot.sessionId, matchedAt: "2026-05-09T00:00:00.000Z" }),
    ),
    waitForQuiet: vi.fn<RendererTerminalApi["waitForQuiet"]>(() =>
      Promise.resolve({ sessionId: snapshot.sessionId, matchedAt: "2026-05-09T00:00:00.000Z" }),
    ),
    waitForPrompt: vi.fn<RendererTerminalApi["waitForPrompt"]>(() =>
      Promise.resolve({ sessionId: snapshot.sessionId, matchedAt: "2026-05-09T00:00:00.000Z" }),
    ),
    startRecording: vi.fn<RendererTerminalApi["startRecording"]>(() => Promise.resolve()),
    stopRecording: vi.fn<RendererTerminalApi["stopRecording"]>(() => Promise.resolve()),
    exportRecording: vi.fn<RendererTerminalApi["exportRecording"]>(() =>
      Promise.resolve({
        schemaVersion: 1,
        sessionId: snapshot.sessionId,
        exportedAt: "2026-05-09T00:00:00.000Z",
        events: [],
      }),
    ),
    getSession: vi.fn<RendererTerminalApi["getSession"]>(() => Promise.resolve(snapshot)),
    getConfig: vi.fn<RendererTerminalApi["getConfig"]>(() => Promise.resolve(terminalConfig)),
    saveWorkspace: vi.fn<RendererTerminalApi["saveWorkspace"]>((workspace) =>
      Promise.resolve({
        ...terminalConfig,
        workspace,
      }),
    ),
    releaseSession: vi.fn<RendererTerminalApi["releaseSession"]>(() => Promise.resolve()),
    onTerminalEvent: vi.fn<RendererTerminalApi["onTerminalEvent"]>((nextHandler) => {
      terminalHandler = nextHandler;
      return unsubscribeTerminalEvent;
    }),
    onSessionEvent: vi.fn<RendererTerminalApi["onSessionEvent"]>((_sessionId, nextHandler) => {
      sessionHandler = nextHandler;
      return unsubscribeSessionEvent;
    }),
    emit: (event) => {
      terminalHandler?.(event);
      sessionHandler?.(event);
    },
    unsubscribeSessionEvent,
    unsubscribeTerminalEvent,
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

  it("buffers startup output emitted before session creation resolves", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    let resolveCreateSession!: (snapshot: TerminalSessionSnapshot) => void;
    const pendingCreateSession = new Promise<TerminalSessionSnapshot>((resolve) => {
      resolveCreateSession = resolve;
    });
    const earlySnapshot: TerminalSessionSnapshot = {
      sessionId: "session-early" as SessionId,
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
    vi.mocked(api.createSession).mockReturnValueOnce(pendingCreateSession);

    const controllerPromise = createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });
    api.emit({
      type: "session.output",
      payload: { sessionId: earlySnapshot.sessionId, data: "startup prompt" },
    });
    resolveCreateSession(earlySnapshot);
    await controllerPromise;

    expect(terminal.writes).toEqual(["startup prompt"]);
  });

  it("passes launch options to session creation and focuses the terminal", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      session: { cwd: "/workspace", shell: "/bin/zsh" },
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 100, rows: 30 }),
      }),
    });

    controller.focus();

    expect(api.createSession).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
      cwd: "/workspace",
      shell: "/bin/zsh",
    });
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("reports title and bell events from xterm", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const onTitleChange = vi.fn();
    const onBell = vi.fn();

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
      onTitleChange,
      onBell,
    });

    terminal.emitTitle("vim package.json");
    terminal.emitBell();
    await Promise.resolve();
    api.emit({
      type: "session.title",
      payload: { sessionId: controller.sessionId, title: "vim package.json" },
    });
    api.emit({
      type: "session.bell",
      payload: { sessionId: controller.sessionId },
    });
    await controller.dispose();

    expect(api.setTitle).toHaveBeenCalledWith({
      sessionId: controller.sessionId,
      title: "vim package.json",
    });
    expect(api.reportBell).toHaveBeenCalledWith({ sessionId: controller.sessionId });
    expect(onTitleChange).toHaveBeenCalledWith("vim package.json");
    expect(onBell).toHaveBeenCalledOnce();
    expect(terminal.titleSubscriptionDispose).toHaveBeenCalledOnce();
    expect(terminal.bellSubscriptionDispose).toHaveBeenCalledOnce();
  });

  it("reattaches to an existing session and replays recent output", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const sessionId = "session-1" as SessionId;
    vi.mocked(api.readRecentOutput).mockResolvedValueOnce({
      sessionId,
      data: "replayed output",
      maxBytes: 100_000,
      capturedAt: "2026-05-09T00:00:00.000Z",
    });

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      attachSessionId: sessionId,
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });

    expect(controller.sessionId).toBe(sessionId);
    expect(api.createSession).not.toHaveBeenCalled();
    expect(api.attachSession).toHaveBeenCalledWith({ sessionId });
    expect(api.readRecentOutput).toHaveBeenCalledWith({ sessionId, maxBytes: 100_000 });
    expect(terminal.writes).toEqual(["replayed output"]);
  });

  it("responds to screen snapshot requests from observable xterm buffers", async () => {
    const terminal = new ObservableFakeTerminal();
    const api = fakeApi();
    const requestId = "request-1" as RequestId;

    const controller = await createTerminalSession({
      api,
      element: document.createElement("div"),
      createTerminal: () => terminal,
      createFitAddon: () => ({
        fit: vi.fn(),
        proposeDimensions: () => ({ cols: 80, rows: 24 }),
      }),
    });

    terminal.emitTitle("active title");
    await Promise.resolve();
    api.emit({
      type: "session.title",
      payload: { sessionId: controller.sessionId, title: "active title" },
    });
    api.emit({
      type: "session.snapshot.request",
      requestId,
      payload: { sessionId: controller.sessionId },
    });
    await Promise.resolve();

    expect(api.respondToSnapshot).toHaveBeenCalledOnce();
    const response = vi.mocked(api.respondToSnapshot).mock.calls[0]?.[0];
    expect(response).toMatchObject({
      requestId,
      snapshot: {
        sessionId: controller.sessionId,
        cols: 80,
        rows: 2,
        title: "active title",
        viewport: [
          { row: 0, text: "first row", wrapped: false },
          { row: 1, text: "second row", wrapped: false },
        ],
      },
    });
  });

  it("pauses renderer-originated input while detached and resumes after attach", async () => {
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

    api.emit({
      type: "session.detached",
      payload: {
        sessionId: controller.sessionId,
        state: "detached",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        title: null,
        createdBy: "human",
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:01.000Z",
      },
    });
    terminal.emitData("ignored while detached");

    api.emit({
      type: "session.attached",
      payload: {
        sessionId: controller.sessionId,
        state: "running",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        title: null,
        createdBy: "human",
        createdAt: "2026-05-09T00:00:00.000Z",
        updatedAt: "2026-05-09T00:00:02.000Z",
      },
    });
    terminal.emitData("forwarded after attach");
    await Promise.resolve();

    expect(api.write).toHaveBeenCalledTimes(1);
    expect(api.write).toHaveBeenCalledWith({
      sessionId: controller.sessionId,
      data: "forwarded after attach",
    });
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

  it("releases failed session records when PTY creation fails before a controller exists", async () => {
    const terminal = new FakeTerminal();
    const api = fakeApi();
    const sessionId = "failed-session" as SessionId;
    const expectedError = Object.assign(new Error("spawn failed"), {
      terminalError: {
        type: "pty_spawn_failed",
        message: "spawn failed",
        sessionId,
      },
    });
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

    expect(api.releaseSession).toHaveBeenCalledWith({ sessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
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
    expect(api.unsubscribeTerminalEvent).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.writes).toEqual([]);
    expect(api.detachSession).toHaveBeenCalledWith({ sessionId: controller.sessionId });
    expect(api.kill).not.toHaveBeenCalled();
  });

  it("keeps input and resize active after non-fatal session errors", async () => {
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
    vi.mocked(api.write).mockClear();
    vi.mocked(api.resize).mockClear();

    api.emit({
      type: "session.error",
      payload: {
        type: "recording_failed",
        message: "recording failed",
        sessionId: controller.sessionId,
      },
    });
    terminal.emitData("still live");
    await controller.resize();
    await Promise.resolve();

    expect(api.write).toHaveBeenCalledWith({
      sessionId: controller.sessionId,
      data: "still live",
    });
    expect(api.resize).toHaveBeenCalledWith({
      sessionId: controller.sessionId,
      cols: 80,
      rows: 24,
    });
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

  it("keeps renderer resources mounted when termination fails", async () => {
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
    expect(terminal.dispose).not.toHaveBeenCalled();
    terminal.emitData("still-mounted");
    await Promise.resolve();
    expect(api.write).toHaveBeenCalledWith({
      sessionId: controller.sessionId,
      data: "still-mounted",
    });
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
