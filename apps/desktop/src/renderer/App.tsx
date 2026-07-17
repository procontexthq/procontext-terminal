import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement } from "react";
import "@xterm/xterm/css/xterm.css";

import type {
  AppShortcutAction,
  AgentAccessKeyMetadata,
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
import { FocusedSettings } from "./focused-settings";
import { PermissionCenter } from "./permission-center";
import { SessionSidebarToggle } from "./session-sidebar-toggle";
import { SessionSidebar } from "./session-sidebar";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { themeFontLoadDescriptors, themeFontSet } from "./theme-fonts";
import { useSessionCollaboration } from "./use-session-collaboration";
import { useAgentPermissions } from "./use-agent-permissions";
import { resolveAppShortcut } from "../shared/app-shortcuts";
import { keyboardEventShortcutInput, rendererShortcutPlatform } from "./renderer-shortcuts";
import { openNewHumanTerminal } from "./new-human-terminal";

export function App(): ReactElement {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [tabsState, setTabsState] = useState<TerminalTabsState | null>(null);
  const [focusRequestVersion, setFocusRequestVersion] = useState(0);
  const [agentActive, setAgentActive] = useState(false);
  const [agentAccessMetadata, setAgentAccessMetadata] = useState<AgentAccessKeyMetadata | null>(
    null,
  );
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
    let disposed = false;
    void window.terminalApi
      .getAgentAccessKeyMetadata()
      .then((metadata) => {
        if (!disposed) setAgentAccessMetadata(metadata);
      })
      .catch(reportError);
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
    void openNewHumanTerminal(config?.defaultPresentation ?? "foreground", {
      addVisibleTab: (activate) => {
        setTabsState((current) =>
          current ? addTerminalTab(current, undefined, { activate }) : current,
        );
      },
      createHeadless: () => window.terminalApi.createSession({ presentation: "headless" }),
    }).catch(reportError);
  }, [config?.defaultPresentation, reportError]);

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
  const terminalFontFamily = config?.terminal.fontFamily ?? fonts.terminalFontFamily;
  const fontLoadDescriptors = useMemo(
    () => themeFontLoadDescriptors(fonts, terminalFontSize, terminalFontFamily),
    [fonts, terminalFontFamily, terminalFontSize],
  );
  const terminalTheme = config?.terminal.theme ?? null;
  const appStyle: CSSProperties &
    Record<"--ui-font" | "--terminal-bg" | "--terminal-font", string> = {
    "--ui-font": fonts.uiFontFamily,
    "--terminal-bg": terminalTheme?.background ?? fonts.terminalBackground,
    "--terminal-font": terminalFontFamily,
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
          setFocusRequestVersion((current) => current + 1);
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
    <main
      className="app-shell"
      data-theme={uiTheme}
      data-reduced-motion={config?.accessibility.reducedMotion ? "true" : "false"}
      data-screen-reader={config?.accessibility.screenReaderMode ? "true" : "false"}
      style={appStyle}
    >
      <header className="titlebar" data-testid="window-titlebar">
        <div className="titlebar-content">
          <SessionSidebarToggle
            open={collaboration.sidebarOpen}
            onToggle={collaboration.toggleSidebar}
          />
          <TerminalTabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={selectTab}
            onClose={closeTab}
            onAdd={addTab}
          />
          <div className="titlebar-status">
            {config ? (
              <FocusedSettings
                config={config}
                uiTheme={uiTheme}
                agentAccess={
                  agentAccessMetadata
                    ? {
                        metadata: agentAccessMetadata,
                        onCopy: () => window.terminalApi.copyAgentAccessKey(),
                        onRegenerate: async () => {
                          const metadata = await window.terminalApi.regenerateAgentAccessKey();
                          setAgentAccessMetadata(metadata);
                          return metadata;
                        },
                        onError: reportError,
                      }
                    : undefined
                }
                onUiThemeChange={async (nextTheme) => {
                  const previousTheme = uiTheme;
                  setUiTheme(nextTheme);
                  try {
                    const savedConfig = await window.terminalApi.saveUiTheme(nextTheme);
                    setConfig(savedConfig);
                    setUiTheme(savedConfig.ui.theme);
                    return savedConfig;
                  } catch (error: unknown) {
                    setUiTheme(previousTheme);
                    reportError(error);
                    return null;
                  }
                }}
                onSave={(settings) => {
                  void window.terminalApi
                    .saveFocusedSettings(settings)
                    .then(setConfig)
                    .catch(reportError);
                }}
              />
            ) : null}
            {config ? (
              <AgentPolicySettings
                active={agentActive}
                policy={config.agentPolicy}
                onSave={(policy: AgentPolicyConfig) => {
                  void window.terminalApi
                    .saveAgentPolicy(policy)
                    .then(setConfig)
                    .catch(reportError);
                }}
              />
            ) : null}
          </div>
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
                  terminalFontFamily={terminalFontFamily}
                  fontLoadDescriptors={fontLoadDescriptors}
                  terminalTheme={terminalTheme}
                  focusRequestVersion={focusRequestVersion}
                  registerController={registerController}
                  setStatus={setTabStatus}
                  onSessionEvent={updateStatusFromEvent}
                  onTitleChange={setTabTitle}
                  onBell={setTabBell}
                  onError={reportError}
                />
              ))
            : null}
          {config && tabsState && !activeTab ? (
            <div className="terminal-empty-state" data-testid="terminal-empty-state" role="status">
              <strong>{tabs.length === 0 ? "No visible terminals" : "No active terminal"}</strong>
              <span>
                {tabs.length === 0
                  ? "Open a new tab or reveal a session from Sessions."
                  : "Select a tab to show its terminal."}
              </span>
            </div>
          ) : null}
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
