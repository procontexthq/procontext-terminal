import type { FitAddon } from "@xterm/addon-fit";

import type { RendererTerminalApi, SessionId } from "@terminal/protocol";

export type TerminalLike = {
  open(element: HTMLElement): void;
  write(data: string): void;
  onData(handler: (data: string) => void): { dispose: () => void };
  dispose(): void;
  loadAddon?(addon: unknown): void;
};

export type FitAddonLike = Pick<FitAddon, "fit" | "proposeDimensions">;

export type TerminalController = {
  sessionId: SessionId;
  resize(): Promise<void>;
  dispose(): void;
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
  terminal.loadAddon?.(fitAddon);
  terminal.open(element);
  fitAddon.fit();

  const dimensions = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
  const snapshot = await api.createSession(dimensions);
  const dataSubscription = terminal.onData((data) => {
    void api.write({ sessionId: snapshot.sessionId, data }).catch((error: unknown) => {
      onError?.(error);
    });
  });
  const eventSubscription = api.onSessionEvent(snapshot.sessionId, (event) => {
    if (event.type === "session.output") {
      terminal.write(event.payload.data);
    }
  });

  return {
    sessionId: snapshot.sessionId,
    async resize() {
      fitAddon.fit();
      const nextDimensions = fitAddon.proposeDimensions() ?? dimensions;
      try {
        await api.resize({ sessionId: snapshot.sessionId, ...nextDimensions });
      } catch (error: unknown) {
        onError?.(error);
      }
    },
    dispose() {
      dataSubscription.dispose();
      eventSubscription();
      terminal.dispose();
    },
  };
}
