import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import "@xterm/xterm/css/xterm.css";

import type {
  RendererSessionEvent,
  SessionId,
  TerminalConfig,
  TerminalWorkspaceState,
} from "@terminal/protocol";

import type { TerminalController } from "./terminal-controller";
import { TerminalTabView } from "./terminal-tab-view";
import {
  addTerminalTab,
  closeTerminalTab,
  createInitialTerminalTabs,
  markTabBell,
  renameTabFromTitle,
  selectTerminalTab,
  setTabSessionId,
  terminalTabLabel,
  terminalTabsToWorkspace,
  updateTabStatus,
  type TerminalTab,
  type TerminalTabsState,
} from "./terminal-tabs";
import { nextTerminalStatus, type TerminalUiStatus } from "./terminal-status";

export function App(): ReactElement {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [tabsState, setTabsState] = useState<TerminalTabsState | null>(null);
  const controllers = useRef(new Map<string, TerminalController>());
  const saveQueue = useRef(Promise.resolve());
  const lastSavedWorkspace = useRef<string | null>(null);

  const reportError = useCallback((error: unknown) => {
    console.error(error);
  }, []);

  useEffect(() => {
    let disposed = false;
    void window.terminalApi
      .getConfig()
      .then((loadedConfig) => {
        if (disposed) {
          return;
        }
        lastSavedWorkspace.current = stableWorkspaceKey(loadedConfig.workspace);
        setConfig(loadedConfig);
        setTabsState(createInitialTerminalTabs(loadedConfig.workspace));
      })
      .catch((error: unknown) => {
        reportError(error);
      });

    return () => {
      disposed = true;
    };
  }, [reportError]);

  useEffect(() => {
    if (!tabsState) {
      return;
    }

    const workspace = terminalTabsToWorkspace(tabsState);
    const workspaceKey = stableWorkspaceKey(workspace);
    if (workspaceKey === lastSavedWorkspace.current) {
      return;
    }
    lastSavedWorkspace.current = workspaceKey;
    saveQueue.current = saveQueue.current
      .then(() => window.terminalApi.saveWorkspace(workspace))
      .then((savedConfig) => {
        setConfig(savedConfig);
      })
      .catch((error: unknown) => {
        lastSavedWorkspace.current = null;
        reportError(error);
      });
  }, [reportError, tabsState]);

  const registerController = useCallback((tabId: string, controller: TerminalController | null) => {
    if (controller) {
      controllers.current.set(tabId, controller);
      setTabsState((current) =>
        current ? setTabSessionId(current, tabId, controller.sessionId) : current,
      );
      return;
    }
    controllers.current.delete(tabId);
    setTabsState((current) => (current ? setTabSessionId(current, tabId, null) : current));
  }, []);

  const updateStatusFromEvent = useCallback((tabId: string, event: RendererSessionEvent) => {
    setTabsState((current) => {
      if (!current) {
        return current;
      }
      const tab = current.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return current;
      }
      return updateTabStatus(current, tabId, nextTerminalStatus(tab.status, event));
    });
  }, []);

  const setTabStatus = useCallback((tabId: string, status: TerminalUiStatus) => {
    setTabsState((current) => (current ? updateTabStatus(current, tabId, status) : current));
  }, []);

  const setTabTitle = useCallback((tabId: string, title: string) => {
    setTabsState((current) => (current ? renameTabFromTitle(current, tabId, title) : current));
  }, []);

  const setTabBell = useCallback((tabId: string) => {
    setTabsState((current) => (current ? markTabBell(current, tabId) : current));
  }, []);

  const selectTab = useCallback((tabId: string) => {
    setTabsState((current) => (current ? selectTerminalTab(current, tabId) : current));
  }, []);

  const addTab = useCallback(() => {
    setTabsState((current) => (current ? addTerminalTab(current) : current));
  }, []);

  const closeTab = useCallback(
    (tab: TerminalTab, index: number) => {
      void closeTabByPolicy({
        tab,
        label: terminalTabLabel(tab, index),
        controllers: controllers.current,
        onClose: () => {
          setTabsState((current) => (current ? closeTerminalTab(current, tab.id) : current));
        },
        onRelease: (sessionId) => releaseSessionWhenInactive(sessionId, reportError),
        onError: reportError,
      });
    },
    [reportError],
  );

  const tabs = tabsState?.tabs ?? [];
  const activeTabId = tabsState?.activeTabId ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="tab-strip" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab, index) => (
            <div className="tab-item" key={tab.id}>
              <button
                type="button"
                role="tab"
                className={`tab-button${tab.id === activeTabId ? " is-active" : ""}`}
                data-terminal-tab="true"
                data-testid={`terminal-tab-${index}`}
                aria-selected={tab.id === activeTabId}
                onClick={() => selectTab(tab.id)}
              >
                {tab.hasUnreadBell ? <span className="tab-bell" aria-hidden="true" /> : null}
                <span className="tab-label">{terminalTabLabel(tab, index)}</span>
                <span className="tab-status">{tab.status}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                data-testid={`close-tab-${index}`}
                aria-label={`Close ${terminalTabLabel(tab, index)}`}
                onClick={() => closeTab(tab, index)}
              >
                x
              </button>
            </div>
          ))}
          <button
            type="button"
            className="new-tab-button"
            data-testid="new-tab-button"
            aria-label="New terminal tab"
            onClick={addTab}
          >
            +
          </button>
        </div>
        <span data-testid="terminal-status">{activeTab?.status ?? "starting"}</span>
      </header>
      <section className="terminal-workspace">
        {config && tabsState
          ? tabs.map((tab) => (
              <TerminalTabView
                key={tab.id}
                tab={tab}
                config={config}
                active={tab.id === activeTabId}
                registerController={registerController}
                setStatus={setTabStatus}
                onSessionEvent={updateStatusFromEvent}
                onTitleChange={setTabTitle}
                onBell={setTabBell}
                onError={reportError}
              />
            ))
          : null}
      </section>
    </main>
  );
}

async function closeTabByPolicy({
  tab,
  label,
  controllers,
  onClose,
  onRelease,
  onError,
}: {
  tab: TerminalTab;
  label: string;
  controllers: Map<string, TerminalController>;
  onClose: () => void;
  onRelease: (sessionId: SessionId) => Promise<void>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const controller = controllers.get(tab.id);
  if (requiresCloseConfirmation(tab.status)) {
    const confirmed = window.confirm(`Terminate ${label}?`);
    if (!confirmed) {
      return;
    }

    if (controller) {
      const disposed = await controller.dispose({ sessionLifecycle: "terminate" });
      if (!disposed) {
        return;
      }
      void onRelease(controller.sessionId);
    }
    onClose();
    return;
  }

  if (controller) {
    const disposed = await controller.dispose();
    if (!disposed) {
      return;
    }
    try {
      await window.terminalApi.releaseSession({ sessionId: controller.sessionId });
    } catch (error: unknown) {
      onError(error);
      return;
    }
  }
  onClose();
}

async function releaseSessionWhenInactive(
  sessionId: SessionId,
  onError: (error: unknown) => void,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      const snapshot = await window.terminalApi.getSession({ sessionId });
      if (snapshot.state === "exited" || snapshot.state === "failed") {
        await window.terminalApi.releaseSession({ sessionId });
        return;
      }
    } catch (error: unknown) {
      onError(error);
      return;
    }
    await delay(50);
  }
}

function requiresCloseConfirmation(status: TerminalUiStatus): boolean {
  return (
    status === "starting" ||
    status === "creating" ||
    status === "running" ||
    status === "exiting" ||
    status === "detached"
  );
}

function stableWorkspaceKey(workspace: TerminalWorkspaceState): string {
  return JSON.stringify(workspace);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
