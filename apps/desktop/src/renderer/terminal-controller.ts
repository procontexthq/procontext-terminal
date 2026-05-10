import type { FitAddon } from "@xterm/addon-fit";

import type {
  RendererSessionEvent,
  RendererTerminalApi,
  SessionId,
  TerminalWorkspaceTab,
  Unsubscribe,
} from "@terminal/protocol";

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
  session?: TerminalWorkspaceTab;
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

  try {
    terminal.loadAddon?.(fitAddon);
    terminal.open(element);
    fitAddon.fit();

    const dimensions = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    const snapshot = await api.createSession({
      ...dimensions,
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(session?.shell ? { shell: session.shell } : {}),
    });
    let sessionAcceptsPtyOperations = true;
    dataSubscription = terminal.onData((data) => {
      if (!sessionAcceptsPtyOperations) {
        return;
      }
      void api.write({ sessionId: snapshot.sessionId, data }).catch((error: unknown) => {
        onError?.(error);
      });
    });
    eventSubscription = api.onSessionEvent(snapshot.sessionId, (event) => {
      onSessionEvent?.(event);
      switch (event.type) {
        case "session.output":
          terminal.write(event.payload.data);
          break;
        case "session.exited":
        case "session.error":
          sessionAcceptsPtyOperations = false;
          break;
        case "session.created":
          break;
      }
    });
    titleSubscription =
      terminal.onTitleChange?.((title) => {
        onTitleChange?.(title);
      }) ?? null;
    bellSubscription =
      terminal.onBell?.(() => {
        onBell?.();
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
        if (!sessionAcceptsPtyOperations) {
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
        if (options.sessionLifecycle === "terminate" && sessionAcceptsPtyOperations) {
          try {
            await api.kill({ sessionId: snapshot.sessionId });
            sessionAcceptsPtyOperations = false;
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
