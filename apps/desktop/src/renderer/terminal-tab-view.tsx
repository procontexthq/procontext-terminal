import { useEffect, useMemo, useRef } from "react";
import type { ReactElement } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

import type { RendererSessionEvent, TerminalConfig, TerminalTheme } from "@terminal/protocol";

import { browserFontFaceSet, waitForFontFaces } from "./font-loading";
import { createTerminalSession, type TerminalController } from "./terminal-controller";
import { terminalAccessibilityOptions } from "./terminal-accessibility";
import { createTerminalLinkProvider } from "./terminal-link-provider";
import { TerminalSearchControls } from "./terminal-search-controls";
import type { TerminalSearchTarget } from "./terminal-search";
import type { TerminalTab } from "./terminal-tabs";
import type { TerminalUiStatus } from "./terminal-status";
import { rendererShortcutPlatform } from "./renderer-shortcuts";

export function TerminalTabView({
  tab,
  config,
  active,
  terminalFontFamily,
  fontLoadDescriptors,
  terminalTheme,
  focusRequestVersion,
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
  terminalFontFamily: string;
  fontLoadDescriptors: readonly string[];
  terminalTheme: TerminalTheme;
  focusRequestVersion: number;
  registerController: (tabId: string, controller: TerminalController | null) => void;
  setStatus: (tabId: string, status: TerminalUiStatus) => void;
  onSessionEvent: (tabId: string, event: RendererSessionEvent) => void;
  onTitleChange: (tabId: string, title: string) => void;
  onBell: (tabId: string) => void;
  onError: (error: unknown) => void;
}): ReactElement {
  const terminalElement = useRef<HTMLDivElement | null>(null);
  const controller = useRef<TerminalController | null>(null);
  const launch = useRef({
    session: {
      cwd: tab.cwd,
      shell: tab.shell,
    },
    attachSessionId: tab.sessionId,
  });
  const terminalFinished = tab.status === "exited" || tab.status === "failed";
  const searchTarget = useMemo<TerminalSearchTarget>(
    () => ({
      findNext(query, options) {
        return controller.current?.findNext(query, options) ?? false;
      },
      findPrevious(query, options) {
        return controller.current?.findPrevious(query, options) ?? false;
      },
      clearDecorations() {
        controller.current?.clearDecorations();
      },
    }),
    [],
  );

  useEffect(() => {
    let disposed = false;

    async function start(): Promise<void> {
      if (!terminalElement.current) {
        return;
      }

      try {
        const fontFaceSet = browserFontFaceSet();
        await waitForFontFaces({
          descriptors: fontLoadDescriptors,
          fontFaceSet,
        });
        const nextController = await createTerminalSession({
          api: window.terminalApi,
          element: terminalElement.current,
          session: launch.current.session,
          attachSessionId: launch.current.attachSessionId ?? undefined,
          createTerminal: () => {
            const terminal = new Terminal({
              fontFamily: terminalFontFamily,
              fontSize: config.terminal.fontSize,
              scrollback: config.terminal.scrollback,
              theme: themeForXterm(terminalTheme),
              ...terminalAccessibilityOptions(config.accessibility),
              overviewRuler: { width: 8 },
            });
            terminal.registerLinkProvider(
              createTerminalLinkProvider({
                platform: rendererShortcutPlatform() ?? "linux",
                columns: () => terminal.cols,
                getLine: (line) => {
                  const bufferLine = terminal.buffer.active.getLine(line - 1);
                  return bufferLine === undefined
                    ? null
                    : {
                        cells: Array.from({ length: terminal.cols }, (_, column) => {
                          const cell = bufferLine.getCell(column);
                          return {
                            chars: cell?.getChars() ?? "",
                            width: cell?.getWidth() ?? 1,
                          };
                        }),
                        isWrapped: bufferLine.isWrapped,
                      };
                },
                open: (target) => window.terminalApi.openLink(target),
                onError,
              }),
            );
            return terminal;
          },
          createFitAddon: () => new FitAddon(),
          createSearchAddon: () => new SearchAddon(),
          onSessionEvent: (event) => onSessionEvent(tab.id, event),
          onTitleChange: (title) => onTitleChange(tab.id, title),
          onBell: () => onBell(tab.id),
          onError,
        });

        if (disposed) {
          await nextController.dispose(
            launch.current.attachSessionId ? undefined : { sessionLifecycle: "terminate" },
          );
          return;
        }

        controller.current = nextController;
        registerController(tab.id, nextController);
        setStatus(tab.id, nextController.lifecycle);
        await nextController.resize();
        await nextController.setFocused(active && document.hasFocus());
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
      void controller.current?.dispose();
      controller.current = null;
    };
  }, [onBell, onError, onSessionEvent, onTitleChange, registerController, setStatus, tab.id]);

  useEffect(() => {
    controller.current?.setFontFamily(terminalFontFamily);
    controller.current?.setFontSize(config.terminal.fontSize);
    controller.current?.setScrollback(config.terminal.scrollback);
    controller.current?.setAccessibility(config.accessibility);
    controller.current?.setTheme(themeForXterm(terminalTheme));
    if (active) {
      void controller.current?.resize();
    }
  }, [
    active,
    config.accessibility,
    config.terminal.fontSize,
    config.terminal.scrollback,
    terminalFontFamily,
    terminalTheme,
  ]);

  useEffect(() => {
    let disposed = false;
    const fontFaceSet = browserFontFaceSet();

    void waitForFontFaces({
      descriptors: fontLoadDescriptors,
      fontFaceSet,
      timeoutMs: Number.POSITIVE_INFINITY,
    })
      .then((result) => {
        if (disposed || result !== "loaded") {
          return;
        }
        controller.current?.setFontFamily(terminalFontFamily);
        if (active) {
          void controller.current?.resize();
        }
      })
      .catch(onError);

    return () => {
      disposed = true;
    };
  }, [active, fontLoadDescriptors, onError, terminalFontFamily]);

  useEffect(() => {
    const reportFocus = (): void => {
      void controller.current?.setFocused(active && document.hasFocus());
    };
    reportFocus();
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    if (!active) {
      return () => {
        window.removeEventListener("focus", reportFocus);
        window.removeEventListener("blur", reportFocus);
      };
    }
    controller.current?.focus();
    void controller.current?.resize();
    return () => {
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
    };
  }, [active, focusRequestVersion]);

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
      <TerminalSearchControls
        active={active}
        target={searchTarget}
        onRequestTerminalFocus={() => controller.current?.focus()}
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

function themeForXterm(theme: TerminalTheme): TerminalTheme & { overviewRulerBorder: string } {
  return {
    ...theme,
    overviewRulerBorder: theme.background,
  };
}
