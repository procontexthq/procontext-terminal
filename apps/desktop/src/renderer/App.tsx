import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { createTerminalSession, type TerminalController } from "./terminal-controller";
import { nextTerminalStatus, type TerminalUiStatus } from "./terminal-status";

export function App(): ReactElement {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const controller = useRef<TerminalController | null>(null);
  const [status, setStatus] = useState<TerminalUiStatus>("starting");

  useEffect(() => {
    let disposed = false;
    let unsubscribeStatus: (() => void) | null = null;

    async function start(): Promise<void> {
      if (!terminalElement.current) return;
      const config = await window.terminalApi.getConfig();
      if (!terminalElement.current || disposed) return;

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
        void nextController.dispose({ sessionLifecycle: "terminate" });
        return;
      }

      controller.current = nextController;
      setStatus("running");
      unsubscribeStatus = window.terminalApi.onSessionEvent(nextController.sessionId, (event) => {
        setStatus((current) => nextTerminalStatus(current, event));
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
      void controller.current?.dispose({ sessionLifecycle: "terminate" });
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
