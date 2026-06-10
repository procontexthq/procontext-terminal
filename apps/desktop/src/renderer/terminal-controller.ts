import type { FitAddon } from "@xterm/addon-fit";

import type {
  RendererSessionEvent,
  RendererTerminalApi,
  SessionId,
  TerminalError,
  Unsubscribe,
} from "@terminal/protocol";

import { captureTerminalScreen, isObservableTerminal } from "./screen-observer";

export type TerminalLike = {
  open(element: HTMLElement): void;
  write(data: string): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  onTitleChange?(handler: (title: string) => void): { dispose: () => void };
  onBell?(handler: () => void): { dispose: () => void };
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

type DataSubscription = {
  dispose: () => void;
};

export type TerminalController = {
  sessionId: SessionId;
  focus(): void;
  resize(): Promise<void>;
  dispose(options?: TerminalControllerDisposeOptions): Promise<boolean>;
};

export type CreateTerminalSessionOptions = {
  api: RendererTerminalApi;
  element: HTMLElement;
  session?: TerminalLaunchMetadata;
  attachSessionId?: SessionId;
  createTerminal: () => TerminalLike;
  createFitAddon: () => FitAddonLike;
  onTitleChange?: (title: string) => void;
  onBell?: () => void;
  onSessionEvent?: (event: RendererSessionEvent) => void;
  onError?: (error: unknown) => void;
};

export async function createTerminalSession({
  api,
  element,
  session,
  attachSessionId,
  createTerminal,
  createFitAddon,
  onTitleChange,
  onBell,
  onSessionEvent,
  onError,
}: CreateTerminalSessionOptions): Promise<TerminalController> {
  const terminal = createTerminal();
  const fitAddon = createFitAddon();
  let dataSubscription: DataSubscription | null = null;
  let titleSubscription: DataSubscription | null = null;
  let bellSubscription: DataSubscription | null = null;
  let eventSubscription: Unsubscribe | null = null;
  let currentTitle: string | null = null;

  try {
    terminal.loadAddon?.(fitAddon);
    terminal.open(element);
    fitAddon.fit();

    const dimensions = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    let sessionId: SessionId | null = null;
    let bufferedEvents: RendererSessionEvent[] = [];
    let rendererInputEnabled = false;
    let sessionCanAcceptPtyOperations = false;
    const processSessionEvent = (event: RendererSessionEvent): void => {
      onSessionEvent?.(event);
      switch (event.type) {
        case "session.output":
          terminal.write(event.payload.data);
          break;
        case "session.title":
          currentTitle = event.payload.title;
          onTitleChange?.(event.payload.title);
          break;
        case "session.bell":
          onBell?.();
          break;
        case "session.attached":
          rendererInputEnabled = true;
          sessionCanAcceptPtyOperations = true;
          break;
        case "session.detached":
          rendererInputEnabled = false;
          sessionCanAcceptPtyOperations = true;
          break;
        case "session.exited":
          rendererInputEnabled = false;
          sessionCanAcceptPtyOperations = false;
          break;
        case "session.error":
          onError?.(event.payload);
          break;
        case "session.snapshot.request":
          if (!sessionId) {
            break;
          }
          if (!isObservableTerminal(terminal)) {
            void api
              .reportSnapshotUnavailable({
                requestId: event.requestId,
                sessionId,
                reason: "Terminal screen snapshot is not supported by this terminal.",
              })
              .catch((error: unknown) => {
                onError?.(error);
              });
            break;
          }
          void api
            .respondToSnapshot({
              requestId: event.requestId,
              snapshot: captureTerminalScreen({
                terminal,
                sessionId,
                title: currentTitle,
              }),
            })
            .catch((error: unknown) => {
              onError?.(error);
            });
          break;
        case "agent.activity":
        case "session.created":
          break;
      }
    };
    eventSubscription = api.onTerminalEvent((event) => {
      if (!sessionId) {
        bufferedEvents.push(event);
        return;
      }
      if (eventMatchesSession(event, sessionId)) {
        processSessionEvent(event);
      }
    });
    const snapshot = attachSessionId
      ? await api.attachSession({ sessionId: attachSessionId })
      : await api.createSession({
          ...dimensions,
          ...(session?.cwd ? { cwd: session.cwd } : {}),
          ...(session?.shell ? { shell: session.shell } : {}),
        });
    sessionId = snapshot.sessionId;
    rendererInputEnabled = snapshot.state !== "detached";
    sessionCanAcceptPtyOperations = snapshot.state === "running" || snapshot.state === "detached";
    const eventsToFlush = bufferedEvents;
    bufferedEvents = [];
    for (const event of eventsToFlush) {
      if (eventMatchesSession(event, sessionId)) {
        processSessionEvent(event);
      }
    }
    dataSubscription = terminal.onData((data) => {
      if (!rendererInputEnabled) {
        return;
      }
      void api.write({ sessionId: snapshot.sessionId, data }).catch((error: unknown) => {
        onError?.(error);
      });
    });
    if (attachSessionId) {
      const recentOutput = await api.readRecentOutput({
        sessionId: snapshot.sessionId,
        maxBytes: 100_000,
      });
      if (recentOutput.data) {
        terminal.write(recentOutput.data);
      }
    }
    titleSubscription =
      terminal.onTitleChange?.((title) => {
        if (!sessionId) {
          return;
        }
        void api.setTitle({ sessionId, title }).catch((error: unknown) => {
          onError?.(error);
        });
      }) ?? null;
    bellSubscription =
      terminal.onBell?.(() => {
        if (!sessionId) {
          return;
        }
        void api.reportBell({ sessionId }).catch((error: unknown) => {
          onError?.(error);
        });
      }) ?? null;
    let disposed = false;

    return {
      sessionId: snapshot.sessionId,
      focus() {
        terminal.focus?.();
      },
      async resize() {
        if (disposed) {
          return;
        }
        fitAddon.fit();
        const nextDimensions = fitAddon.proposeDimensions() ?? dimensions;
        if (!rendererInputEnabled) {
          return;
        }
        try {
          await api.resize({ sessionId: snapshot.sessionId, ...nextDimensions });
        } catch (error: unknown) {
          onError?.(error);
        }
      },
      async dispose(options = {}) {
        if (disposed) {
          return true;
        }
        if (options.sessionLifecycle === "terminate" && sessionCanAcceptPtyOperations) {
          try {
            await api.kill({ sessionId: snapshot.sessionId });
            rendererInputEnabled = false;
            sessionCanAcceptPtyOperations = false;
          } catch (error: unknown) {
            onError?.(error);
            return false;
          }
        }
        if (
          options.sessionLifecycle !== "terminate" &&
          rendererInputEnabled &&
          sessionCanAcceptPtyOperations
        ) {
          try {
            await api.detachSession({ sessionId: snapshot.sessionId });
            rendererInputEnabled = false;
          } catch (error: unknown) {
            onError?.(error);
            return false;
          }
        }
        disposed = true;
        disposeRendererResources({
          dataSubscription,
          titleSubscription,
          bellSubscription,
          eventSubscription,
          terminal,
          onError,
        });
        return true;
      },
    };
  } catch (error: unknown) {
    await releaseFailedSession(api, error);
    disposeRendererResources({
      dataSubscription,
      titleSubscription,
      bellSubscription,
      eventSubscription,
      terminal,
      onError,
    });
    throw error;
  }
}

async function releaseFailedSession(api: RendererTerminalApi, error: unknown): Promise<void> {
  const terminalError = extractTerminalError(error);
  if (!terminalError?.sessionId || terminalError.type !== "pty_spawn_failed") {
    return;
  }

  try {
    await api.releaseSession({ sessionId: terminalError.sessionId });
  } catch {
    // Session creation can fail before a session record exists; cleanup is best-effort.
  }
}

function extractTerminalError(error: unknown): TerminalError | null {
  if (!isObject(error)) {
    return null;
  }

  if (isTerminalError(error)) {
    return error;
  }

  const maybeTerminalError = error.terminalError;
  return isTerminalError(maybeTerminalError) ? maybeTerminalError : null;
}

function isTerminalError(value: unknown): value is TerminalError {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    typeof value.message === "string" &&
    (!("sessionId" in value) || typeof value.sessionId === "string")
  );
}

function disposeRendererResources({
  dataSubscription,
  titleSubscription,
  bellSubscription,
  eventSubscription,
  terminal,
  onError,
}: {
  dataSubscription: DataSubscription | null;
  titleSubscription: DataSubscription | null;
  bellSubscription: DataSubscription | null;
  eventSubscription: Unsubscribe | null;
  terminal: TerminalLike;
  onError?: (error: unknown) => void;
}): void {
  try {
    dataSubscription?.dispose();
  } catch (error: unknown) {
    onError?.(error);
  }
  try {
    titleSubscription?.dispose();
  } catch (error: unknown) {
    onError?.(error);
  }
  try {
    bellSubscription?.dispose();
  } catch (error: unknown) {
    onError?.(error);
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
    case "session.created":
    case "session.attached":
    case "session.detached":
    case "session.title":
    case "session.bell":
      return event.payload.sessionId === sessionId;
    case "session.output":
      return event.payload.sessionId === sessionId;
    case "session.exited":
      return event.payload.sessionId === sessionId;
    case "session.error":
      return event.payload.sessionId === sessionId;
    case "session.snapshot.request":
      return event.payload.sessionId === sessionId;
    case "agent.activity":
      return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
