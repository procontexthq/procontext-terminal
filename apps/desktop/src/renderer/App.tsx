import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import "@xterm/xterm/css/xterm.css";

import type {
  AppShortcutAction,
  AgentPolicyConfig,
  RendererPresentationAcknowledgement,
  RendererPresentationCommand,
  RendererSessionEvent,
  SessionId,
  TerminalConfig,
  UiThemePreference,
} from "@terminal/protocol";

import type { TerminalController } from "./terminal-controller";
import { TerminalTabView } from "./terminal-tab-view";
import {
  completePendingPresentationOpen,
  failPendingPresentationOpen,
  handlePresentationCommand,
} from "./presentation-commands";
import {
  addTerminalTab,
  closeTerminalTab,
  createInitialTerminalTabs,
  markTabBell,
  renameTabFromTitle,
  selectAdjacentTerminalTab,
  selectTerminalTab,
  setTabSessionId,
  terminalTabLabel,
  updateTabFromSession,
  updateTabStatus,
  type TerminalTab,
  type TerminalTabsState,
} from "./terminal-tabs";
import { nextTerminalStatus, type TerminalUiStatus } from "./terminal-status";
import { NotificationCenter } from "./notification-center";
import { AgentPolicySettings } from "./agent-policy-settings";
import { PermissionCenter } from "./permission-center";
import { SessionSidebar } from "./session-sidebar";
import { themeFontLoadDescriptors, themeFontSet } from "./theme-fonts";
import { useSessionCollaboration } from "./use-session-collaboration";
import { useAgentPermissions } from "./use-agent-permissions";
import { resolveAppShortcut } from "../shared/app-shortcuts";
import { keyboardEventShortcutInput, rendererShortcutPlatform } from "./renderer-shortcuts";

export function App(): ReactElement {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [tabsState, setTabsState] = useState<TerminalTabsState | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [uiTheme, setUiTheme] = useState<UiThemePreference>("default");
  const controllers = useRef(new Map<string, TerminalController>());
  const tabsStateRef = useRef<TerminalTabsState | null>(null);
  const pendingOpenCommands = useRef(new Map<SessionId, RendererPresentationCommand>());

  const collaboration = useSessionCollaboration({
    tabsStateRef,
    controllers,
    setTabsState,
  });
  const reportError = collaboration.reportError;
  const permissions = useAgentPermissions(reportError);

  useEffect(() => {
    let disposed = false;
    void window.terminalApi
      .getConfig()
      .then((loadedConfig) => {
        if (disposed) {
          return;
        }
        setConfig(loadedConfig);
        setUiTheme(loadedConfig.ui.theme);
        setTabsState(createInitialTerminalTabs());
      })
      .catch((error: unknown) => {
        reportError(error);
      });

    return () => {
      disposed = true;
    };
  }, [reportError]);

  useEffect(() => {
    tabsStateRef.current = tabsState;
  }, [tabsState]);

  const acknowledgePresentation = useCallback(
    (acknowledgement: RendererPresentationAcknowledgement) => {
      void window.terminalApi.acknowledgePresentation(acknowledgement).catch(reportError);
    },
    [reportError],
  );

  const registerController = useCallback(
    (tabId: string, controller: TerminalController | null) => {
      if (controller) {
        controllers.current.set(tabId, controller);
        setTabsState((current) =>
          current ? setTabSessionId(current, tabId, controller.sessionId) : current,
        );
        completePendingPresentationOpen(
          controller.sessionId,
          pendingOpenCommands.current,
          acknowledgePresentation,
        );
        return;
      }
      controllers.current.delete(tabId);
      setTabsState((current) => (current ? setTabSessionId(current, tabId, null) : current));
    },
    [acknowledgePresentation],
  );

  const updateStatusFromEvent = useCallback((tabId: string, event: RendererSessionEvent) => {
    setTabsState((current) => {
      if (!current) {
        return current;
      }
      const tab = current.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) {
        return current;
      }
      if (event.type === "session.updated") {
        return updateTabFromSession(current, event.payload, tabId);
      }
      return updateTabStatus(current, tabId, nextTerminalStatus(tab.status, event));
    });
  }, []);

  const setTabStatus = useCallback(
    (tabId: string, status: TerminalUiStatus) => {
      setTabsState((current) => {
        if (!current) return current;
        const tab = current.tabs.find((candidate) => candidate.id === tabId);
        if (status === "failed" && tab?.sessionId) {
          failPendingPresentationOpen(
            tab.sessionId,
            "Renderer terminal view failed to open.",
            pendingOpenCommands.current,
            acknowledgePresentation,
          );
        }
        return updateTabStatus(current, tabId, status);
      });
    },
    [acknowledgePresentation],
  );

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

  const processPresentationCommand = useCallback(
    (command: RendererPresentationCommand) =>
      handlePresentationCommand(command, {
        api: window.terminalApi,
        getTabsState: () => tabsStateRef.current,
        updateTabs: (update) => {
          setTabsState((state) => (state ? update(state) : state));
        },
        controllers: controllers.current,
        pendingOpenCommands: pendingOpenCommands.current,
        acknowledge: acknowledgePresentation,
      }),
    [acknowledgePresentation],
  );

  useEffect(() => {
    return window.terminalApi.onTerminalEvent((event) => {
      if (event.type === "agent.activity") {
        setAgentActive(event.payload.authenticatedConnections > 0);
      } else if (event.type === "presentation.command") {
        void processPresentationCommand(event.payload);
      }
    });
  }, [processPresentationCommand]);

  const rendererReady = tabsState !== null;

  useEffect(() => {
    if (!rendererReady) return;
    void window.terminalApi.presentationReady().catch(reportError);
  }, [rendererReady, reportError]);

  const tabs = tabsState?.tabs ?? [];
  const activeTabId = tabsState?.activeTabId ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const fonts = themeFontSet(uiTheme);
  const terminalFontSize = config?.terminal.fontSize ?? 13;
  const fontLoadDescriptors = useMemo(
    () => themeFontLoadDescriptors(fonts, terminalFontSize),
    [fonts, terminalFontSize],
  );
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
        <button
          type="button"
          className={`session-sidebar-toggle${collaboration.sidebarOpen ? " is-active" : ""}`}
          aria-label={`${collaboration.sidebarOpen ? "Hide" : "Show"} terminal sessions`}
          aria-expanded={collaboration.sidebarOpen}
          data-testid="session-sidebar-toggle"
          onClick={collaboration.toggleSidebar}
        >
          Sessions
        </button>
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
          {config ? (
            <AgentPolicySettings
              policy={config.agentPolicy}
              onSave={(policy: AgentPolicyConfig) => {
                void window.terminalApi.saveAgentPolicy(policy).then(setConfig).catch(reportError);
              }}
            />
          ) : null}
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
      <section className={`workspace-shell${collaboration.sidebarOpen ? " has-sidebar" : ""}`}>
        <SessionSidebar
          open={collaboration.sidebarOpen}
          items={collaboration.items}
          activeSessionId={activeTab?.sessionId ?? null}
          redactionPatternCount={config?.recording.redactedPatterns.length ?? 0}
          actions={collaboration.actions}
        />
        <section className="terminal-workspace">
          {config && terminalTheme && tabsState
            ? tabs.map((tab) => (
                <TerminalTabView
                  key={tab.id}
                  tab={tab}
                  config={config}
                  active={tab.id === activeTabId}
                  terminalFontFamily={fonts.terminalFontFamily}
                  fontLoadDescriptors={fontLoadDescriptors}
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
      </section>
      <NotificationCenter
        notifications={collaboration.notifications}
        onDismiss={collaboration.dismissNotification}
      />
      <PermissionCenter requests={permissions.requests} onResolve={permissions.resolve} />
    </main>
  );
}

async function closeTabByPolicy({
  tab,
  label,
  controllers,
  onClose,
}: {
  tab: TerminalTab;
  label: string;
  controllers: Map<string, TerminalController>;
  onClose: () => void;
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
    }
    onClose();
    return;
  }

  if (controller) {
    const disposed = await controller.dispose({ sessionLifecycle: "terminate" });
    if (!disposed) {
      return;
    }
  }
  onClose();
}

function requiresCloseConfirmation(status: TerminalUiStatus): boolean {
  return (
    status === "starting" || status === "creating" || status === "running" || status === "exiting"
  );
}

function parseUiTheme(value: string | null): UiThemePreference {
  return value === "coder" || value === "gamer" || value === "classic" ? value : "default";
}
