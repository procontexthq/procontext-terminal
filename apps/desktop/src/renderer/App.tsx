import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { RendererSessionEvent } from "@terminal/protocol";

import { createTerminalSession, type TerminalController } from "./terminal-controller";

export function App(): ReactElement {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const controller = useRef<TerminalController | null>(null);
  const [status, setStatus] = useState("starting");

  useEffect(() => {
    let disposed = false;
    let unsubscribeStatus: (() => void) | null = null;

    async function start(): Promise<void> {
      if (!terminalElement.current) return;
      const config = await window.terminalApi.getConfig();

      const nextController = await createTerminalSession({
        api: window.terminalApi,
        element: terminalElement.current,
        createTerminal: () =>
          new Terminal({
            fontFamily: config.terminal.fontFamily,
            fontSize: config.terminal.fontSize,
            scrollback: config.terminal.scrollback,
            theme: config.terminal.theme,
            cursorBlink: true,
          }),
        createFitAddon: () => new FitAddon(),
        onError: (error) => {
          setStatus("failed");
          console.error(error);
        },
      });

      if (disposed) {
        nextController.dispose();
        return;
      }

      controller.current = nextController;
      setStatus("running");
      unsubscribeStatus = window.terminalApi.onSessionEvent(nextController.sessionId, (event) => {
        setStatus(statusFromEvent(event));
      });
      await nextController.resize();
    }

    void start().catch((error: unknown) => {
      setStatus("failed");
      console.error(error);
    });

    const resizeObserver = new ResizeObserver(() => {
      void controller.current?.resize();
    });
    if (terminalElement.current) resizeObserver.observe(terminalElement.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      unsubscribeStatus?.();
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);

  return (
    <main className="app-shell">
      <header className="titlebar">
        <span>Terminal</span>
        <span data-testid="terminal-status">{status}</span>
      </header>
      <section
        ref={terminalElement}
        className="terminal-host"
        data-testid={status === "running" ? "terminal-ready" : "terminal-host"}
      />
    </main>
  );
}

function statusFromEvent(event: RendererSessionEvent): string {
  switch (event.type) {
    case "session.created":
      return event.payload.state;
    case "session.exited":
      return "exited";
    case "session.error":
      return "failed";
    case "session.output":
      return "running";
  }
}
