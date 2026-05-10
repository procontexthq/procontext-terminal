import type { TerminalWorkspaceState, TerminalWorkspaceTab } from "@terminal/protocol";

import type { TerminalUiStatus } from "./terminal-status";

export type TerminalTab = TerminalWorkspaceTab & {
  id: string;
  title: string | null;
  status: TerminalUiStatus;
  hasUnreadBell: boolean;
};

export type TerminalTabsState = {
  tabs: TerminalTab[];
  activeTabId: string;
};

let nextTabIndex = 1;

export function createInitialTerminalTabs(workspace: TerminalWorkspaceState): TerminalTabsState {
  const tabs = workspace.tabs.map((tab) => createTerminalTab(tab));
  const activeTab = tabs[workspace.activeTabIndex] ?? tabs[0] ?? createTerminalTab(defaultTab());
  return {
    tabs: tabs.length > 0 ? tabs : [activeTab],
    activeTabId: activeTab.id,
  };
}

export function terminalTabsToWorkspace(state: TerminalTabsState): TerminalWorkspaceState {
  const activeTabIndex = Math.max(
    0,
    state.tabs.findIndex((tab) => tab.id === state.activeTabId),
  );
  return {
    tabs: state.tabs.map(({ cwd, shell }) => ({ cwd, shell })),
    activeTabIndex,
  };
}

export function addTerminalTab(
  state: TerminalTabsState,
  tab: TerminalWorkspaceTab = defaultTab(),
): TerminalTabsState {
  const nextTab = createTerminalTab(tab);
  return {
    tabs: [...state.tabs, nextTab],
    activeTabId: nextTab.id,
  };
}

export function selectTerminalTab(state: TerminalTabsState, tabId: string): TerminalTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) {
    return state;
  }

  return {
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, hasUnreadBell: false } : tab)),
    activeTabId: tabId,
  };
}

export function closeTerminalTab(state: TerminalTabsState, tabId: string): TerminalTabsState {
  const closedIndex = state.tabs.findIndex((tab) => tab.id === tabId);
  if (closedIndex === -1) {
    return state;
  }

  const remainingTabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (remainingTabs.length === 0) {
    const replacement = createTerminalTab(defaultTab());
    return {
      tabs: [replacement],
      activeTabId: replacement.id,
    };
  }

  if (state.activeTabId !== tabId) {
    return {
      tabs: remainingTabs,
      activeTabId: state.activeTabId,
    };
  }

  const nextActiveTab = remainingTabs[Math.max(0, closedIndex - 1)] ?? remainingTabs[0];
  if (!nextActiveTab) {
    return state;
  }
  return {
    tabs: remainingTabs,
    activeTabId: nextActiveTab.id,
  };
}

export function renameTabFromTitle(
  state: TerminalTabsState,
  tabId: string,
  title: string,
): TerminalTabsState {
  const nextTitle = title.trim();
  if (!nextTitle) {
    return state;
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, title: nextTitle } : tab)),
  };
}

export function markTabBell(state: TerminalTabsState, tabId: string): TerminalTabsState {
  if (state.activeTabId === tabId) {
    return state;
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, hasUnreadBell: true } : tab)),
  };
}

export function updateTabStatus(
  state: TerminalTabsState,
  tabId: string,
  status: TerminalUiStatus,
): TerminalTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, status } : tab)),
  };
}

export function terminalTabLabel(tab: TerminalTab, index: number): string {
  if (tab.title) {
    return tab.title;
  }

  if (tab.cwd) {
    return basename(tab.cwd);
  }

  if (tab.shell) {
    return basename(tab.shell);
  }

  return `Terminal ${index + 1}`;
}

export function defaultTab(): TerminalWorkspaceTab {
  return { cwd: null, shell: null };
}

function createTerminalTab(tab: TerminalWorkspaceTab): TerminalTab {
  return {
    id: `tab-${nextTabIndex++}`,
    cwd: tab.cwd,
    shell: tab.shell,
    title: null,
    status: "starting",
    hasUnreadBell: false,
  };
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}
