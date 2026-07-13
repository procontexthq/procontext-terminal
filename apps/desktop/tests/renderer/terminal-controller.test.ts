import { describe, expect, it, vi } from "vitest";

import {
  createSessionId,
  type RendererSessionEvent,
  type RendererTerminalApi,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  createTerminalSession,
  type FitAddonLike,
  type TerminalLike,
} from "../../src/renderer/terminal-controller";

const sessionId = createSessionId("session-1");

describe("terminal controller", () => {
  it("subscribes before bootstrap and applies only output newer than its sequence fence", async () => {
    const terminal = new FakeTerminal();
    const { api, emit } = createApi();
    vi.mocked(api.openView).mockImplementationOnce(() => {
      emit(outputEvent(7, "duplicate"));
      emit(outputEvent(8, "live"));
      return Promise.resolve({
        session: createSummary(),
        serialized: "bootstrap",
        sequence: 7,
        viewportY: 3,
      });
    });

    await createController(api, terminal);

    expect(terminal.writes).toEqual(["bootstrap", "live"]);
    expect(terminal.scrollToLine).toHaveBeenCalledWith(3);
  });

  it("forwards keyboard, paste, control, and TUI bytes through one raw input call", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    await createController(api, terminal);

    terminal.emitData("\u001b[A\u0003pasted text");

    expect(api.input).toHaveBeenCalledWith({
      sessionId,
      input: "\u001b[A\u0003pasted text",
    });
  });

  it("reports human scrolling and applies canonical agent scrolling without feedback", async () => {
    const terminal = new FakeTerminal();
    const { api, emit } = createApi();
    await createController(api, terminal);

    terminal.emitScroll(5);
    emit({
      type: "session.viewport",
      payload: { sessionId, viewportY: 2, observationVersion: 4 },
    });
    terminal.emitScroll(2);
    await Promise.resolve();

    expect(api.reportViewport).toHaveBeenCalledTimes(1);
    expect(api.reportViewport).toHaveBeenCalledWith({ sessionId, viewportY: 5 });
    expect(terminal.scrollToLine).toHaveBeenCalledWith(2);
  });

  it("stops accepting input when canonical lifecycle exits", async () => {
    const terminal = new FakeTerminal();
    const { api, emit } = createApi();
    await createController(api, terminal);

    emit({
      type: "session.updated",
      payload: { ...createSummary(), lifecycle: "exited" },
    });
    terminal.emitData("ignored");

    expect(api.input).not.toHaveBeenCalled();
  });

  it("disposes a view without terminating its session by default", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    const controller = await createController(api, terminal);

    await expect(controller.dispose()).resolves.toBe(true);

    expect(api.close).not.toHaveBeenCalled();
    expect(api.closeView).toHaveBeenCalledWith({ sessionId });
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });

  it("terminates before closing a user-requested tab", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    const controller = await createController(api, terminal);

    await expect(controller.dispose({ sessionLifecycle: "terminate" })).resolves.toBe(true);

    expect(api.close).toHaveBeenCalledWith({ sessionId });
    expect(api.closeView).toHaveBeenCalledWith({ sessionId });
  });

  it("keeps the view alive while termination remains pending", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    vi.mocked(api.close).mockResolvedValueOnce({ status: "termination_pending" });
    const controller = await createController(api, terminal);

    await expect(controller.dispose({ sessionLifecycle: "terminate" })).resolves.toBe(false);

    expect(api.closeView).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });
});

class FakeTerminal implements TerminalLike {
  readonly writes: string[] = [];
  readonly scrollToLine = vi.fn<(line: number) => void>();
  readonly dispose = vi.fn();
  readonly focus = vi.fn();
  readonly refresh = vi.fn();
  options = {};
  rows = 24;
  private dataHandler: (data: string) => void = () => undefined;
  private scrollHandler: (viewportY: number) => void = () => undefined;

  open(): void {}

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    callback?.();
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

  onScroll(handler: (viewportY: number) => void): { dispose: () => void } {
    this.scrollHandler = handler;
    return { dispose: vi.fn() };
  }

  loadAddon(): void {}

  emitData(data: string): void {
    this.dataHandler(data);
  }

  emitScroll(viewportY: number): void {
    this.scrollHandler(viewportY);
  }
}

async function createController(api: RendererTerminalApi, terminal: FakeTerminal) {
  const fitAddon: FitAddonLike = {
    fit: vi.fn(),
    proposeDimensions: vi.fn(() => ({ cols: 80, rows: 24 })),
  };
  return await createTerminalSession({
    api,
    element: {} as HTMLElement,
    attachSessionId: sessionId,
    createTerminal: () => terminal,
    createFitAddon: () => fitAddon,
  });
}

function createApi(): {
  api: RendererTerminalApi;
  emit: (event: RendererSessionEvent) => void;
} {
  let subscriber: (event: RendererSessionEvent) => void = () => undefined;
  const summary = createSummary();
  const api: RendererTerminalApi = {
    createSession: vi.fn(() => Promise.resolve(summary)),
    listSessions: vi.fn(() => Promise.resolve([summary])),
    getSession: vi.fn(() => Promise.resolve(summary)),
    input: vi.fn(() => Promise.resolve({ accepted: true as const, observationVersion: 1 })),
    resize: vi.fn(() => Promise.resolve({ observationVersion: 1 })),
    scroll: vi.fn(() => Promise.resolve({ status: "unchanged" as const, observationVersion: 1 })),
    close: vi.fn(() => Promise.resolve({ status: "closed" as const, exitCode: 0, signal: null })),
    openView: vi.fn(() =>
      Promise.resolve({
        session: summary,
        serialized: "bootstrap",
        sequence: 0,
        viewportY: 0,
      }),
    ),
    closeView: vi.fn(() => Promise.resolve()),
    reportViewport: vi.fn(() => Promise.resolve()),
    startRecording: vi.fn(() => Promise.resolve()),
    stopRecording: vi.fn(() => Promise.resolve()),
    exportRecording: vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        sessionId,
        exportedAt: "2026-07-13T00:00:00.000Z",
        events: [],
      }),
    ),
    getConfig: vi.fn(),
    saveUiTheme: vi.fn(),
    presentationReady: vi.fn(() => Promise.resolve()),
    acknowledgePresentation: vi.fn(() => Promise.resolve()),
    onAppShortcut: vi.fn(() => vi.fn()),
    onTerminalEvent: vi.fn((handler: (event: RendererSessionEvent) => void) => {
      subscriber = handler;
      return vi.fn();
    }),
    onSessionEvent: vi.fn(() => vi.fn()),
  };
  return { api, emit: (event) => subscriber(event) };
}

function outputEvent(sequence: number, data: string): RendererSessionEvent {
  return {
    type: "session.output",
    payload: { sessionId, sequence, data },
  };
}

function createSummary(): TerminalSessionSummary {
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "human",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "background",
      windowVisible: true,
      windowFocused: false,
    },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}
