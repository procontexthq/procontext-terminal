import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import type { RendererSessionEvent, TerminalConfig } from "@terminal/protocol";

import { createTerminalSession, type TerminalController } from "./terminal-controller";
import type { TerminalTab } from "./terminal-tabs";
import type { TerminalUiStatus } from "./terminal-status";

export function TerminalTabView({
  tab,
  config,
  active,
  registerController,
  setStatus,
  onSessionEvent,
  onTitleChange,
  onBell,
  onError,
}: {
  tab: TerminalTab;
  config: TerminalConfig;
  active: boolean;
  registerController: (tabId: string, controller: TerminalController | null) => void;
  setStatus: (tabId: string, status: TerminalUiStatus) => void;
  onSessionEvent: (tabId: string, event: RendererSessionEvent) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onBell: (tabId: string) => void;
  onError: (error: unknown) => void;
}): ReactElement {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const controller = useRef<TerminalController | null>(null);
  const terminalFinished = tab.status === "exited" || tab.status === "failed";

  useEffect(() => {
    let disposed = false;

    async function start(): Promise<void> {
      if (!terminalElement.current) {
        return;
      }

      try {
        const nextController = await createTerminalSession({
          api: window.terminalApi,
          element: terminalElement.current,
          session: {
            cwd: tab.cwd,
            shell: tab.shell,
          },
          attachSessionId: tab.sessionId ?? undefined,
          createTerminal: () =>
            new Terminal({
              fontFamily: config.terminal.fontFamily,
              fontSize: config.terminal.fontSize,
              scrollback: config.terminal.scrollback,
              theme: config.terminal.theme,
              cursorBlink: true,
            }),
          createFitAddon: () => new FitAddon(),
          onSessionEvent: (event) => onSessionEvent(tab.id, event),
          onTitleChange: (title) => onTitleChange(tab.id, title),
          onBell: () => onBell(tab.id),
          onError,
        });

        if (disposed) {
          void nextController.dispose({ sessionLifecycle: "terminate" });
          return;
        }

        controller.current = nextController;
        registerController(tab.id, nextController);
        setStatus(tab.id, "running");
        await nextController.resize();
        if (active) {
          nextController.focus();
        }
      } catch (error: unknown) {
        setStatus(tab.id, "failed");
        onError(error);
      }
    }

    void start();

    const resizeObserver = new ResizeObserver(() => {
      void controller.current?.resize();
    });
    if (terminalElement.current) {
      resizeObserver.observe(terminalElement.current);
    }

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      registerController(tab.id, null);
      void controller.current?.dispose({ sessionLifecycle: "terminate" });
      controller.current = null;
    };
  }, [
    onBell,
    onError,
    onSessionEvent,
    onTitleChange,
    registerController,
    setStatus,
    tab.cwd,
    tab.id,
    tab.shell,
  ]);

  useEffect(() => {
    if (!active) {
      return;
    }
    controller.current?.focus();
    void controller.current?.resize();
  }, [active]);

  return (
    <div
      className={`terminal-session-view${active ? " is-active" : ""}${
        terminalFinished ? " is-finished" : ""
      }`}
      aria-hidden={!active}
    >
      <div
        ref={terminalElement}
        className={`terminal-host${active ? " is-active" : ""}`}
        data-testid={active && tab.status === "running" ? "terminal-ready" : "terminal-host"}
        data-session-id={tab.sessionId ?? ""}
      />
      {active && terminalFinished ? (
        <div
          className={`terminal-exit-banner is-${tab.status}`}
          data-testid="terminal-exit-message"
          role="status"
        >
          {tab.status === "failed" ? "Terminal failed." : "Process exited."}
          <span>Close this tab or open a new terminal.</span>
        </div>
      ) : null}
    </div>
  );
}
