import { describe, expect, it, vi } from "vitest";

import {
  createSessionId,
  type RendererSessionEvent,
  type RendererTerminalApi,
  type SessionId,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  createTerminalSession,
  type FitAddonLike,
  type TerminalLike,
} from "../../src/renderer/terminal-controller";
import type { TerminalSearchTarget } from "../../src/renderer/terminal-search";

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

  it("suppresses a correlated cursor report without swallowing later identical input", async () => {
    const terminal = new FakeTerminal();
    terminal.responsesByWrite.set("abc\u001b[6n", ["\u001b[2;11R"]);
    const { api, emit } = createApi();
    await createController(api, terminal);
    terminal.deferWrites = true;

    emit(outputEvent(1, "abc\u001b[6n", [{ data: "\u001b[1;4R", status: "returned" }]));
    terminal.emitData("\u001b[1;4R");
    terminal.flushWrites();

    expect(api.input).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      input: "\u001b[1;4R",
    });
  });

  it("forwards unmatched input after an output response scope settles", async () => {
    const terminal = new FakeTerminal();
    const { api, emit } = createApi();
    await createController(api, terminal);

    emit(
      outputEvent(1, "query without a projection response", [
        { data: "\u001b[1;1R", status: "returned" },
      ]),
    );
    terminal.emitData("\u001b[1;1R");

    expect(api.input).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      input: "\u001b[1;1R",
    });
  });

  it("forwards a projection response when canonical output was not answered", async () => {
    const terminal = new FakeTerminal();
    terminal.responsesByWrite.set("\u001b[6n", ["\u001b[2;11R"]);
    const { api, emit } = createApi();
    await createController(api, terminal);

    emit(outputEvent(1, "\u001b[6n"));

    expect(api.input).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      input: "\u001b[2;11R",
    });
  });

  it("associates mixed PTY write outcomes with their original query occurrences", async () => {
    const terminal = new FakeTerminal();
    terminal.responsesByWrite.set("\u001b[6n\r\n\u001b[6n", ["\u001b[3;1R", "\u001b[4;1R"]);
    const { api, emit } = createApi();
    await createController(api, terminal);

    emit(
      outputEvent(1, "\u001b[6n\r\n\u001b[6n", [
        { data: "\u001b[1;1R", status: "failed" },
        { data: "\u001b[2;1R", status: "returned" },
      ]),
    );

    expect(api.input).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      input: "\u001b[3;1R",
    });
  });

  it("reports human scrolling and applies canonical agent scrolling without feedback", async () => {
    const terminal = new FakeTerminal();
    const { api, emit } = createApi();
    await createController(api, terminal);

    terminal.buffer.active.baseY = 8;
    terminal.emitScroll(5);
    emit({
      type: "session.viewport",
      payload: { sessionId, viewportY: 2, observationVersion: 4 },
    });
    terminal.emitScroll(2);
    await Promise.resolve();

    expect(api.reportViewport).toHaveBeenCalledTimes(1);
    expect(api.reportViewport).toHaveBeenCalledWith({
      sessionId,
      viewportY: 5,
      atBottom: false,
    });
    expect(terminal.scrollToLine).toHaveBeenCalledWith(2);
  });

  it("reports the live bottom semantically instead of as a stale absolute row", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    await createController(api, terminal);

    terminal.buffer.active.baseY = 12;
    terminal.emitScroll(12);
    terminal.emitScroll(7);

    expect(api.reportViewport).toHaveBeenNthCalledWith(1, {
      sessionId,
      viewportY: 12,
      atBottom: true,
    });
    expect(api.reportViewport).toHaveBeenNthCalledWith(2, {
      sessionId,
      viewportY: 7,
      atBottom: false,
    });
  });

  it("reports one settled search viewport without disabling later human scroll reports", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    const searchTarget: TerminalSearchTarget = {
      findNext: vi.fn(() => {
        terminal.emitScroll(2);
        return true;
      }),
      findPrevious: vi.fn(() => false),
      clearDecorations: vi.fn(),
    };
    const controller = await createController(api, terminal, searchTarget);

    expect(controller.findNext("needle", { incremental: true })).toBe(true);
    expect(terminal.loadAddon).toHaveBeenCalledWith(searchTarget);
    expect(api.reportViewport).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(api.reportViewport).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      viewportY: 2,
      atBottom: false,
    });
    terminal.emitScroll(3);
    expect(api.reportViewport).toHaveBeenLastCalledWith({
      sessionId,
      viewportY: 3,
      atBottom: false,
    });
  });

  it("reports whether its renderer view is foreground or background", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    const controller = await createController(api, terminal);

    await controller.setFocused(true);
    await controller.setFocused(false);

    expect(api.reportViewFocus).toHaveBeenNthCalledWith(1, { sessionId, focused: true });
    expect(api.reportViewFocus).toHaveBeenNthCalledWith(2, { sessionId, focused: false });
  });

  it("applies focused terminal and accessibility settings to a live view", async () => {
    const terminal = new FakeTerminal();
    const { api } = createApi();
    const controller = await createController(api, terminal);

    controller.setFontSize(16);
    controller.setScrollback(12_000);
    controller.setAccessibility({
      screenReaderMode: true,
      reducedMotion: true,
      minimumContrastRatio: 7,
    });

    expect(terminal.options).toMatchObject({
      cursorBlink: false,
      fontSize: 16,
      minimumContrastRatio: 7,
      screenReaderMode: true,
      scrollback: 12_000,
    });
    expect(terminal.refresh).toHaveBeenCalled();
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
  readonly responsesByWrite = new Map<string, string[]>();
  readonly scrollToLine = vi.fn<(line: number) => void>();
  readonly dispose = vi.fn();
  readonly focus = vi.fn();
  readonly refresh = vi.fn();
  deferWrites = false;
  options = {};
  buffer = { active: { baseY: 0, viewportY: 0 } };
  rows = 24;
  private dataHandler: (data: string) => void = () => undefined;
  private scrollHandler: (viewportY: number) => void = () => undefined;
  private readonly pendingWrites: Array<() => void> = [];
  private readonly csiHandlers: Array<{
    id: { prefix?: string; final: string };
    handler: (params: Array<number | number[]>) => boolean | Promise<boolean>;
  }> = [];
  readonly parser = {
    registerCsiHandler: (
      id: { prefix?: string; final: string },
      handler: (params: Array<number | number[]>) => boolean | Promise<boolean>,
    ) => {
      const entry = { id, handler };
      this.csiHandlers.push(entry);
      return {
        dispose: () => {
          const index = this.csiHandlers.indexOf(entry);
          if (index >= 0) this.csiHandlers.splice(index, 1);
        },
      };
    },
  };

  open(): void {}

  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    const processWrite = () => {
      const responses = this.responsesByWrite.get(data) ?? [];
      const queryCount = data.split("\u001b[6n").length - 1;
      if (queryCount === 0) {
        for (const response of responses) this.emitData(response);
      } else {
        for (let index = 0; index < queryCount; index += 1) {
          const response = responses[index];
          if (!this.handleCsi("n", [6]) && response !== undefined) {
            this.emitData(response);
          }
        }
      }
      callback?.();
    };
    if (this.deferWrites) {
      this.pendingWrites.push(processWrite);
      return;
    }
    processWrite();
  }

  flushWrites(): void {
    for (const write of this.pendingWrites.splice(0)) write();
  }

  onData(handler: (data: string) => void): { dispose: () => void } {
    this.dataHandler = handler;
    return { dispose: vi.fn() };
  }

  onScroll(handler: (viewportY: number) => void): { dispose: () => void } {
    this.scrollHandler = handler;
    return { dispose: vi.fn() };
  }

  readonly loadAddon = vi.fn();

  emitData(data: string): void {
    this.dataHandler(data);
  }

  emitScroll(viewportY: number): void {
    this.buffer.active.viewportY = viewportY;
    this.scrollHandler(viewportY);
  }

  private handleCsi(final: string, params: Array<number | number[]>): boolean {
    for (const { id, handler } of [...this.csiHandlers].reverse()) {
      if (id.final !== final || id.prefix !== undefined) continue;
      const result = handler(params);
      if (result instanceof Promise)
        throw new Error("Fake CSI handlers must settle synchronously.");
      if (result) return true;
    }
    return false;
  }
}

async function createController(
  api: RendererTerminalApi,
  terminal: FakeTerminal,
  searchTarget?: TerminalSearchTarget,
) {
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
    ...(searchTarget ? { createSearchAddon: () => searchTarget } : {}),
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
    reportViewFocus: vi.fn(() => Promise.resolve()),
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
    exportRecordingFile: vi.fn(() => Promise.resolve({ status: "cancelled" as const })),
    listAgentControls: vi.fn(() => Promise.resolve([])),
    revokeAgentControl: vi.fn(({ sessionId: revokedSessionId }: { sessionId: SessionId }) =>
      Promise.resolve({
        sessionId: revokedSessionId,
        state: "revoked" as const,
        attachedAt: null,
      }),
    ),
    allowAgentControl: vi.fn(({ sessionId: allowedSessionId }: { sessionId: SessionId }) =>
      Promise.resolve({
        sessionId: allowedSessionId,
        state: "detached" as const,
        attachedAt: null,
      }),
    ),
    listPermissions: vi.fn(() => Promise.resolve([])),
    resolvePermission: vi.fn(() => Promise.resolve(false)),
    getConfig: vi.fn(),
    openLink: vi.fn(() => Promise.resolve({ status: "opened" as const })),
    saveUiTheme: vi.fn(),
    saveFocusedSettings: vi.fn(),
    saveAgentPolicy: vi.fn(),
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

function outputEvent(
  sequence: number,
  data: string,
  terminalResponses?: Array<{
    data: string;
    status: "returned" | "failed";
  }>,
): RendererSessionEvent {
  return {
    type: "session.output",
    payload: { sessionId, sequence, data, ...(terminalResponses ? { terminalResponses } : {}) },
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
