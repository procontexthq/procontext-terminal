import type { FitAddon } from "@xterm/addon-fit";

import type {
  RendererSessionEvent,
  RendererTerminalApi,
  SessionId,
  TerminalLifecycleState,
  TerminalResponseResult,
  TerminalTheme,
  TerminalAccessibilityConfig,
  Unsubscribe,
} from "@terminal/protocol";

import {
  createTerminalResponseCoordinator,
  type TerminalParserLike,
} from "./terminal-response-coordinator";
import type { TerminalSearchTarget } from "./terminal-search";
import { terminalAccessibilityOptions } from "./terminal-accessibility";

export type TerminalLike = {
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  options?: {
    cursorBlink?: boolean;
    fontFamily?: string;
    fontSize?: number;
    minimumContrastRatio?: number;
    screenReaderMode?: boolean;
    scrollback?: number;
    theme?: Partial<TerminalTheme>;
  };
  parser?: TerminalParserLike;
  rows?: number;
  open(element: HTMLElement): void;
  write(data: string, callback?: () => void): void;
  scrollToLine?(line: number): void;
  refresh?(start: number, end: number): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  onScroll?(handler: (viewportY: number) => void): { dispose: () => void };
  focus?(): void;
  dispose(): void;
  loadAddon?(addon: unknown): void;
};

export type FitAddonLike = Pick<FitAddon, "fit" | "proposeDimensions">;
export type TerminalSessionDisposeLifecycle = "detach" | "terminate";
export type TerminalControllerDisposeOptions = {
  sessionLifecycle?: TerminalSessionDisposeLifecycle;
};

export type TerminalLaunchMetadata = {
  cwd: string | null;
  shell: string | null;
};

export type TerminalController = TerminalSearchTarget & {
  sessionId: SessionId;
  readonly lifecycle: TerminalLifecycleState;
  focus(): void;
  resize(): Promise<void>;
  setFocused(focused: boolean): Promise<void>;
  setFontFamily(fontFamily: string): void;
  setFontSize(fontSize: number): void;
  setScrollback(scrollback: number): void;
  setAccessibility(accessibility: TerminalAccessibilityConfig): void;
  setTheme(theme: TerminalTheme): void;
  dispose(options?: TerminalControllerDisposeOptions): Promise<boolean>;
};

export type CreateTerminalSessionOptions = {
  api: RendererTerminalApi;
  element: HTMLElement;
  session?: TerminalLaunchMetadata;
  attachSessionId?: SessionId;
  createTerminal: () => TerminalLike;
  createFitAddon: () => FitAddonLike;
  createSearchAddon?: () => TerminalSearchTarget;
  onTitleChange?: (title: string) => void;
  onBell?: () => void;
  onSessionEvent?: (event: RendererSessionEvent) => void;
  onError?: (error: unknown) => void;
};

export async function createTerminalSession(
  options: CreateTerminalSessionOptions,
): Promise<TerminalController> {
  const terminal = options.createTerminal();
  const fitAddon = options.createFitAddon();
  let searchTarget: TerminalSearchTarget | null = null;
  const subscriptions: Array<{ dispose(): void }> = [];
  const responseCoordinator = createTerminalResponseCoordinator(terminal.parser);
  subscriptions.push(responseCoordinator);
  let eventSubscription: Unsubscribe | null = null;
  let sessionId: SessionId | null = null;
  let lifecycle: TerminalLifecycleState = "creating";
  let disposed = false;
  let createdSession = false;
  let lastOutputSequence = 0;
  let bootstrapComplete = false;
  let bufferedEvents: RendererSessionEvent[] = [];
  let suppressViewportReport = false;
  let localViewportReportSuppressions = 0;

  const reportCurrentViewport = (): void => {
    if (!sessionId || disposed) return;
    const viewportY = terminal.buffer.active.viewportY;
    void options.api
      .reportViewport({
        sessionId,
        viewportY,
        atBottom: terminal.buffer.active.baseY === viewportY,
      })
      .catch(options.onError);
  };

  const runLocalSearch = <T>(operation: () => T, reportSettledViewport = false): T => {
    localViewportReportSuppressions += 1;
    let result: T;
    try {
      result = operation();
      return result;
    } finally {
      queueMicrotask(() => {
        localViewportReportSuppressions = Math.max(0, localViewportReportSuppressions - 1);
        if (reportSettledViewport && result === true) reportCurrentViewport();
      });
    }
  };

  const writeProjectionOutput = (
    data: string,
    terminalResponses: TerminalResponseResult[] = [],
  ): void => {
    terminal.write(data, responseCoordinator.beginOutput(terminalResponses));
  };

  const processEvent = (event: RendererSessionEvent): void => {
    if (!sessionId || !eventMatchesSession(event, sessionId)) return;
    options.onSessionEvent?.(event);
    switch (event.type) {
      case "session.output":
        if (event.payload.sequence <= lastOutputSequence) return;
        lastOutputSequence = event.payload.sequence;
        writeProjectionOutput(event.payload.data, event.payload.terminalResponses);
        break;
      case "session.viewport":
        suppressViewportReport = true;
        terminal.scrollToLine?.(event.payload.viewportY);
        queueMicrotask(() => {
          suppressViewportReport = false;
        });
        break;
      case "session.updated":
        lifecycle = event.payload.lifecycle;
        if (event.payload.title) options.onTitleChange?.(event.payload.title);
        break;
      case "session.removed":
        break;
      case "session.bell":
        options.onBell?.();
        break;
      case "session.error":
        options.onError?.(event.payload);
        break;
      case "agent.activity":
      case "agent.control.changed":
      case "policy.denied":
      case "presentation.command":
        break;
    }
  };

  try {
    terminal.loadAddon?.(fitAddon);
    const nextSearchTarget = options.createSearchAddon?.();
    if (nextSearchTarget && terminal.loadAddon) {
      terminal.loadAddon(nextSearchTarget);
      searchTarget = nextSearchTarget;
    }
    terminal.open(options.element);
    fitAddon.fit();
    const dimensions = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };

    eventSubscription = options.api.onTerminalEvent((event) => {
      if (!bootstrapComplete) {
        bufferedEvents.push(event);
        return;
      }
      processEvent(event);
    });

    const summary = options.attachSessionId
      ? await options.api.getSession({ sessionId: options.attachSessionId })
      : await options.api.createSession({
          ...dimensions,
          ...(options.session?.cwd ? { cwd: options.session.cwd } : {}),
          ...(options.session?.shell ? { shell: options.session.shell } : {}),
        });
    sessionId = summary.sessionId;
    createdSession = !options.attachSessionId;
    lifecycle = summary.lifecycle;

    const bootstrap = await options.api.openView({ sessionId });
    await writeTerminal(terminal, bootstrap.serialized);
    lastOutputSequence = bootstrap.sequence;
    lifecycle = bootstrap.session.lifecycle;
    if (bootstrap.session.title) options.onTitleChange?.(bootstrap.session.title);
    terminal.scrollToLine?.(bootstrap.viewportY);
    bootstrapComplete = true;
    for (const event of bufferedEvents) processEvent(event);
    bufferedEvents = [];

    subscriptions.push(
      terminal.onData((input) => {
        if (responseCoordinator.consumeInput(input)) return;
        if (lifecycle !== "running" || !sessionId) return;
        void options.api.input({ sessionId, input }).catch(options.onError);
      }),
    );
    const scrollSubscription = terminal.onScroll?.((viewportY) => {
      if (suppressViewportReport || localViewportReportSuppressions > 0 || !sessionId) return;
      void options.api
        .reportViewport({
          sessionId,
          viewportY,
          atBottom: terminal.buffer.active.baseY === viewportY,
        })
        .catch(options.onError);
    });
    if (scrollSubscription) subscriptions.push(scrollSubscription);

    const activeSessionId = sessionId;
    return {
      sessionId: activeSessionId,
      get lifecycle() {
        return lifecycle;
      },
      focus() {
        terminal.focus?.();
      },
      setFontFamily(fontFamily) {
        if (terminal.options) terminal.options.fontFamily = fontFamily;
        refreshTerminal(terminal, options.onError);
      },
      setFontSize(fontSize) {
        if (terminal.options) terminal.options.fontSize = fontSize;
        refreshTerminal(terminal, options.onError);
      },
      setScrollback(scrollback) {
        if (terminal.options) terminal.options.scrollback = scrollback;
        refreshTerminal(terminal, options.onError);
      },
      setAccessibility(accessibility) {
        if (terminal.options) {
          Object.assign(terminal.options, terminalAccessibilityOptions(accessibility));
        }
        refreshTerminal(terminal, options.onError);
      },
      setTheme(theme) {
        if (terminal.options) terminal.options.theme = theme;
        refreshTerminal(terminal, options.onError);
      },
      findNext(query, searchOptions) {
        return runLocalSearch(() => searchTarget?.findNext(query, searchOptions) ?? false, true);
      },
      findPrevious(query, searchOptions) {
        return runLocalSearch(
          () => searchTarget?.findPrevious(query, searchOptions) ?? false,
          true,
        );
      },
      clearDecorations() {
        runLocalSearch(() => searchTarget?.clearDecorations());
      },
      async resize() {
        if (disposed || lifecycle !== "running") return;
        fitAddon.fit();
        const nextDimensions = fitAddon.proposeDimensions() ?? dimensions;
        try {
          await options.api.resize({ sessionId: activeSessionId, ...nextDimensions });
        } catch (error: unknown) {
          options.onError?.(error);
        }
      },
      async setFocused(focused) {
        if (disposed) return;
        try {
          await options.api.reportViewFocus({ sessionId: activeSessionId, focused });
        } catch (error: unknown) {
          options.onError?.(error);
        }
      },
      async dispose(disposeOptions = {}) {
        if (disposed) return true;
        if (disposeOptions.sessionLifecycle === "terminate") {
          try {
            const result = await options.api.close({ sessionId: activeSessionId });
            if (result.status !== "closed") return false;
            lifecycle = "exited";
          } catch (error: unknown) {
            options.onError?.(error);
            return false;
          }
        }
        try {
          await options.api.closeView({ sessionId: activeSessionId });
        } catch (error: unknown) {
          options.onError?.(error);
          if (disposeOptions.sessionLifecycle !== "terminate") return false;
        }
        disposed = true;
        disposeResources(terminal, subscriptions, eventSubscription, options.onError);
        return true;
      },
    };
  } catch (error: unknown) {
    if (createdSession && sessionId) {
      await options.api.close({ sessionId }).catch(() => undefined);
    }
    disposeResources(terminal, subscriptions, eventSubscription, options.onError);
    throw error;
  }
}

function writeTerminal(terminal: TerminalLike, data: string): Promise<void> {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => terminal.write(data, resolve));
}

function refreshTerminal(
  terminal: TerminalLike,
  onError: ((error: unknown) => void) | undefined,
): void {
  try {
    terminal.refresh?.(0, Math.max(0, (terminal.rows ?? 1) - 1));
  } catch (error: unknown) {
    onError?.(error);
  }
}

function disposeResources(
  terminal: TerminalLike,
  subscriptions: Array<{ dispose(): void }>,
  eventSubscription: Unsubscribe | null,
  onError: ((error: unknown) => void) | undefined,
): void {
  for (const subscription of subscriptions) {
    try {
      subscription.dispose();
    } catch (error: unknown) {
      onError?.(error);
    }
  }
  try {
    eventSubscription?.();
  } catch (error: unknown) {
    onError?.(error);
  }
  try {
    terminal.dispose();
  } catch (error: unknown) {
    onError?.(error);
  }
}

function eventMatchesSession(event: RendererSessionEvent, sessionId: SessionId): boolean {
  switch (event.type) {
    case "session.output":
    case "session.viewport":
    case "session.updated":
    case "session.removed":
    case "session.bell":
      return event.payload.sessionId === sessionId;
    case "session.error":
      return event.payload.sessionId === sessionId;
    case "agent.activity":
    case "agent.control.changed":
    case "policy.denied":
    case "permission.requested":
    case "permission.resolved":
    case "presentation.command":
      return false;
  }
}
