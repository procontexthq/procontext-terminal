import type { FitAddon } from "@xterm/addon-fit";

import type { RendererTerminalApi, SessionId, Unsubscribe } from "@terminal/protocol";

export type TerminalLike = {
  open(element: HTMLElement): void;
  write(data: string): void;
  onData(handler: (data: string) => void): { dispose: () => void };
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
  resize(): Promise<void>;
  dispose(options?: TerminalControllerDisposeOptions): Promise<void>;
};

export type CreateTerminalSessionOptions = {
  api: RendererTerminalApi;
  element: HTMLElement;
  createTerminal: () => TerminalLike;
  createFitAddon: () => FitAddonLike;
  onError?: (error: unknown) => void;
};

export async function createTerminalSession({
  api,
  element,
  createTerminal,
  createFitAddon,
  onError,
}: CreateTerminalSessionOptions): Promise<TerminalController> {
  const terminal = createTerminal();
  const fitAddon = createFitAddon();
  let dataSubscription: DataSubscription | null = null;
  let eventSubscription: Unsubscribe | null = null;

  try {
    terminal.loadAddon?.(fitAddon);
    terminal.open(element);
    fitAddon.fit();

    const dimensions = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    const snapshot = await api.createSession(dimensions);
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
    let disposed = false;

    return {
      sessionId: snapshot.sessionId,
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
          return;
        }
        disposed = true;
        disposeRendererResources({
          dataSubscription,
          eventSubscription,
          terminal,
          onError,
        });
        if (options.sessionLifecycle !== "terminate" || !sessionAcceptsPtyOperations) {
          return;
        }
        try {
          await api.kill({ sessionId: snapshot.sessionId });
        } catch (error: unknown) {
          onError?.(error);
        }
      },
    };
  } catch (error: unknown) {
    disposeRendererResources({
      dataSubscription,
      eventSubscription,
      terminal,
      onError,
    });
    throw error;
  }
}

function disposeRendererResources({
  dataSubscription,
  eventSubscription,
  terminal,
  onError,
}: {
  dataSubscription: DataSubscription | null;
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
