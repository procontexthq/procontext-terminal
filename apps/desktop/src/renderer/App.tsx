import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import "@xterm/xterm/css/xterm.css";

import type {
  AppShortcutAction,
  RendererSessionEvent,
  SessionId,
  TerminalConfig,
  TerminalSessionSnapshot,
  UiThemePreference,
} from "@terminal/protocol";

import type { TerminalController } from "./terminal-controller";
import { TerminalTabView } from "./terminal-tab-view";
import {
  addAttachedTerminalTab,
  addTerminalTab,
  closeTerminalTab,
  createInitialTerminalTabs,
  markTabBell,
  renameTabFromTitle,
  selectAdjacentTerminalTab,
  selectTerminalTab,
  setTabSessionId,
  terminalTabLabel,
  updateTabStatus,
  type TerminalTab,
  type TerminalTabsState,
} from "./terminal-tabs";
import { nextTerminalStatus, type TerminalUiStatus } from "./terminal-status";
import { themeFontSet } from "./theme-fonts";
import {
  resolveAppShortcut,
  type AppShortcutInput,
  type AppShortcutPlatform,
} from "../shared/app-shortcuts";

export function App(): ReactElement {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [tabsState, setTabsState] = useState<TerminalTabsState | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [uiTheme, setUiTheme] = useState<UiThemePreference>("default");
  const controllers = useRef(new Map<string, TerminalController>());
  const pendingDetachedSessions = useRef<TerminalSessionSnapshot[]>([]);

  const reportError = useCallback((error: unknown) => {
    console.error(error);
  }, []);

  useEffect(() => {
    let disposed = false;
    const sessions = window.terminalApi.listSessions().catch((error: unknown) => {
      reportError(error);
      return [] as TerminalSessionSnapshot[];
    });
    void Promise.all([window.terminalApi.getConfig(), sessions])
      .then(([loadedConfig, existingSessions]) => {
        if (disposed) {
          return;
        }
        let nextTabsState = createInitialTerminalTabs();
        for (const snapshot of latestSessionSnapshots([
          ...pendingDetachedSessions.current,
          ...existingSessions,
        ])) {
          if (shouldDisplayDetachedSession(snapshot)) {
            nextTabsState = addAttachedTerminalTab(nextTabsState, snapshot, {
              reusePlaceholder: true,
            });
          }
        }
        pendingDetachedSessions.current = [];
        setConfig(loadedConfig);
        setUiTheme(loadedConfig.ui.theme);
        setTabsState(nextTabsState);
      })
      .catch((error: unknown) => {
        reportError(error);
      });

    return () => {
      disposed = true;
    };
  }, [reportError]);

  useEffect(() => {
    return window.terminalApi.onTerminalEvent((event) => {
      if (event.type === "agent.activity") {
        setAgentActive(event.payload.authenticatedConnections > 0);
        return;
      }

      if (
        (event.type === "session.created" || event.type === "session.detached") &&
        shouldDisplayDetachedSession(event.payload)
      ) {
        setTabsState((current) => {
          if (!current) {
            pendingDetachedSessions.current = upsertPendingDetachedSession(
              pendingDetachedSessions.current,
              event.payload,
            );
            return current;
          }
          return addAttachedTerminalTab(current, event.payload);
        });
      }
    });
  }, []);

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

  const tabs = tabsState?.tabs ?? [];
  const activeTabId = tabsState?.activeTabId ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const fonts = themeFontSet(uiTheme);
  const terminalTheme = useMemo(
    () =>
      config
        ? {
            ...config.terminal.theme,
            background: fonts.terminalBackground,
          }
        : null,
    [config, fonts.terminalBackground],
  );
  const appStyle: CSSProperties & Record<"--ui-font" | "--terminal-font", string> = {
    "--ui-font": fonts.uiFontFamily,
    "--terminal-font": fonts.terminalFontFamily,
  };

  const closeTab = useCallback(
    (tab: TerminalTab, index: number) => {
      void closeTabByPolicy({
        tab,
        label: terminalTabLabel(tab, index),
        controllers: controllers.current,
        onClose: () => {
          if (tabs.length === 1) {
            window.close();
            return;
          }
          setTabsState((current) => (current ? closeTerminalTab(current, tab.id) : current));
        },
        onRelease: (sessionId) => releaseSessionWhenInactive(sessionId, reportError),
        onError: reportError,
      });
    },
    [reportError, tabs.length],
  );

  const selectAdjacentTab = useCallback((direction: "previous" | "next") => {
    setTabsState((current) => (current ? selectAdjacentTerminalTab(current, direction) : current));
  }, []);

  const closeActiveTab = useCallback(() => {
    if (!activeTab) {
      return;
    }
    const activeIndex = tabs.findIndex((tab) => tab.id === activeTab.id);
    closeTab(activeTab, activeIndex);
  }, [activeTab, closeTab, tabs]);

  const handleAppShortcut = useCallback(
    (action: AppShortcutAction) => {
      switch (action) {
        case "newTab":
          addTab();
          break;
        case "closeTab":
          closeActiveTab();
          break;
        case "previousTab":
          selectAdjacentTab("previous");
          break;
        case "nextTab":
          selectAdjacentTab("next");
          break;
      }
    },
    [addTab, closeActiveTab, selectAdjacentTab],
  );

  useEffect(() => window.terminalApi.onAppShortcut(handleAppShortcut), [handleAppShortcut]);

  useEffect(() => {
    const platform = rendererShortcutPlatform();
    if (!platform) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      const action = resolveAppShortcut(keyboardEventShortcutInput(event), platform);
      if (!action) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      handleAppShortcut(action);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleAppShortcut]);

  return (
    <main className="app-shell" data-theme={uiTheme} style={appStyle}>
      <header className="titlebar">
        <div className="tab-strip" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab, index) => (
            <div className={`tab-item${tab.id === activeTabId ? " is-active" : ""}`} key={tab.id}>
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
                <span className={`tab-status is-${tab.status}`}>{tab.status}</span>
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
        <div className="titlebar-status">
          <label className="theme-picker">
            <span>Theme</span>
            <select
              data-testid="theme-select"
              value={uiTheme}
              onChange={(event) => {
                const nextTheme = parseUiTheme(event.target.value);
                setUiTheme(nextTheme);
                void window.terminalApi
                  .saveUiTheme(nextTheme)
                  .then((savedConfig) => {
                    setConfig(savedConfig);
                    setUiTheme(savedConfig.ui.theme);
                  })
                  .catch(reportError);
              }}
            >
              <option value="default">Default</option>
              <option value="coder">Coder</option>
              <option value="gamer">Gamer</option>
              <option value="classic">Classic</option>
            </select>
          </label>
          <span
            className={`agent-activity${agentActive ? " is-active" : ""}`}
            data-testid="agent-activity"
          >
            {agentActive ? "Agent active" : "Agent idle"}
          </span>
          <span
            className={`terminal-state is-${activeTab?.status ?? "starting"}`}
            data-testid="terminal-status"
          >
            {activeTab?.status ?? "starting"}
          </span>
        </div>
      </header>
      <section className="terminal-workspace">
        {config && terminalTheme && tabsState
          ? tabs.map((tab) => (
              <TerminalTabView
                key={tab.id}
                tab={tab}
                config={config}
                active={tab.id === activeTabId}
                terminalFontFamily={fonts.terminalFontFamily}
                terminalTheme={terminalTheme}
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

function keyboardEventShortcutInput(event: KeyboardEvent): AppShortcutInput {
  return {
    key: event.key,
    code: event.code,
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    type: "keyDown",
    isAutoRepeat: event.repeat,
  };
}

function rendererShortcutPlatform(): AppShortcutPlatform | null {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return "darwin";
  }
  if (platform.includes("win")) {
    return "win32";
  }
  if (platform.includes("linux") || platform.includes("x11")) {
    return "linux";
  }
  return null;
}

function parseUiTheme(value: string | null): UiThemePreference {
  return value === "coder" || value === "gamer" || value === "classic" ? value : "default";
}

function shouldDisplayDetachedSession(snapshot: TerminalSessionSnapshot): boolean {
  return snapshot.state === "detached";
}

function upsertPendingDetachedSession(
  snapshots: TerminalSessionSnapshot[],
  nextSnapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot[] {
  const existingIndex = snapshots.findIndex(
    (snapshot) => snapshot.sessionId === nextSnapshot.sessionId,
  );
  if (existingIndex === -1) {
    return [...snapshots, nextSnapshot];
  }
  return snapshots.map((snapshot, index) => (index === existingIndex ? nextSnapshot : snapshot));
}

function latestSessionSnapshots(snapshots: TerminalSessionSnapshot[]): TerminalSessionSnapshot[] {
  const bySessionId = new Map<SessionId, TerminalSessionSnapshot>();
  for (const snapshot of snapshots) {
    bySessionId.set(snapshot.sessionId, snapshot);
  }
  return [...bySessionId.values()];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
