import { describe, expect, it } from "vitest";

import type { TerminalWorkspaceState } from "@terminal/protocol";

import {
  addTerminalTab,
  closeTerminalTab,
  createInitialTerminalTabs,
  markTabBell,
  renameTabFromTitle,
  selectTerminalTab,
  terminalTabsToWorkspace,
} from "../../src/renderer/terminal-tabs";

describe("terminal tabs model", () => {
  it("creates tabs from restored workspace and persists launch metadata only", () => {
    const workspace: TerminalWorkspaceState = {
      tabs: [
        { cwd: "/work/a", shell: null },
        { cwd: null, shell: "/bin/zsh" },
      ],
      activeTabIndex: 1,
    };

    const state = createInitialTerminalTabs(workspace);
    const secondTabId = state.tabs[1]?.id;
    if (!secondTabId) {
      throw new Error("Expected restored workspace to create a second tab.");
    }
    const renamed = renameTabFromTitle(state, secondTabId, "vim package.json");

    expect(renamed.tabs[1]?.title).toBe("vim package.json");
    expect(terminalTabsToWorkspace(renamed)).toEqual(workspace);
  });

  it("adds, selects, closes, and keeps one fallback tab", () => {
    let state = createInitialTerminalTabs({
      tabs: [{ cwd: null, shell: null }],
      activeTabIndex: 0,
    });

    state = addTerminalTab(state, { cwd: "/work/new", shell: null });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe(state.tabs[1]?.id);

    state = selectTerminalTab(state, state.tabs[0]?.id ?? "");
    expect(state.activeTabId).toBe(state.tabs[0]?.id);

    state = closeTerminalTab(state, state.tabs[0]?.id ?? "");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id);

    state = closeTerminalTab(state, state.tabs[0]?.id ?? "");
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ cwd: null, shell: null });
  });

  it("tracks unread bell state only for inactive tabs and clears it on select", () => {
    let state = createInitialTerminalTabs({
      tabs: [
        { cwd: null, shell: null },
        { cwd: null, shell: null },
      ],
      activeTabIndex: 0,
    });
    const inactiveTabId = state.tabs[1]?.id ?? "";

    state = markTabBell(state, inactiveTabId);
    expect(state.tabs[1]?.hasUnreadBell).toBe(true);

    state = selectTerminalTab(state, inactiveTabId);
    expect(state.tabs[1]?.hasUnreadBell).toBe(false);
  });
});
