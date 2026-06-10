import { describe, expect, it } from "vitest";

import { createSessionId } from "@terminal/protocol";

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
} from "../../src/renderer/terminal-tabs";

describe("terminal tabs model", () => {
  it("starts with one fresh default tab", () => {
    const state = createInitialTerminalTabs();

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      cwd: null,
      shell: null,
      sessionId: null,
      title: null,
      status: "starting",
    });
    expect(state.activeTabId).toBe(state.tabs[0]?.id);
  });

  it("adds, selects, closes, and keeps one fallback tab", () => {
    let state = createInitialTerminalTabs();

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
    let state = addTerminalTab(createInitialTerminalTabs());
    const inactiveTabId = state.tabs[0]?.id ?? "";

    state = markTabBell(state, inactiveTabId);
    expect(state.tabs[0]?.hasUnreadBell).toBe(true);

    state = selectTerminalTab(state, inactiveTabId);
    expect(state.tabs[0]?.hasUnreadBell).toBe(false);
  });

  it("switches to adjacent tabs with wrapping", () => {
    let state = createInitialTerminalTabs();
    state = addTerminalTab(state);
    state = addTerminalTab(state);

    const [first, second, third] = state.tabs;
    expect(state.activeTabId).toBe(third?.id);

    state = selectAdjacentTerminalTab(state, "previous");
    expect(state.activeTabId).toBe(second?.id);

    state = selectAdjacentTerminalTab(state, "previous");
    expect(state.activeTabId).toBe(first?.id);

    state = selectAdjacentTerminalTab(state, "previous");
    expect(state.activeTabId).toBe(third?.id);

    state = selectAdjacentTerminalTab(state, "next");
    expect(state.activeTabId).toBe(first?.id);
  });

  it("tracks runtime session ids without mutating launch metadata", () => {
    const state = addTerminalTab(createInitialTerminalTabs(), { cwd: "/work/a", shell: null });
    const tabId = state.tabs[1]?.id ?? "";
    const next = setTabSessionId(state, tabId, createSessionId("session-1"));

    expect(next.tabs[1]).toMatchObject({
      sessionId: "session-1",
      cwd: "/work/a",
      shell: null,
    });
  });

  it("renames tabs from non-empty shell title events", () => {
    const state = createInitialTerminalTabs();
    const tabId = state.tabs[0]?.id ?? "";

    const renamed = renameTabFromTitle(state, tabId, "vim package.json");

    expect(renamed.tabs[0]?.title).toBe("vim package.json");
  });

  it("adds an attached agent session tab without duplicating the same session", () => {
    let state = createInitialTerminalTabs();

    state = addAttachedTerminalTab(state, {
      sessionId: createSessionId("session-agent"),
      state: "detached",
      shell: "/bin/zsh",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      title: null,
      createdBy: "agent",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({
      sessionId: "session-agent",
      cwd: "/repo",
      shell: "/bin/zsh",
      status: "detached",
    });
    expect(state.activeTabId).toBe(state.tabs[1]?.id);

    const selectedTabId = state.tabs[0]?.id ?? "";
    state = selectTerminalTab(state, selectedTabId);
    state = addAttachedTerminalTab(state, {
      sessionId: createSessionId("session-agent"),
      state: "detached",
      shell: "/bin/zsh",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      title: "agent shell",
      createdBy: "agent",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:01.000Z",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]?.title).toBe("agent shell");
    expect(state.activeTabId).toBe(state.tabs[1]?.id);
  });

  it("keeps existing tab launch metadata stable when detached session state reconciles", () => {
    let state = createInitialTerminalTabs();
    const tabId = state.tabs[0]?.id ?? "";
    const sessionId = createSessionId("session-existing");
    state = setTabSessionId(state, tabId, sessionId);

    state = addAttachedTerminalTab(state, {
      sessionId,
      state: "detached",
      shell: "/bin/zsh",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      title: "detached shell",
      createdBy: "human",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:01.000Z",
    });

    expect(state.tabs[0]).toMatchObject({
      sessionId,
      cwd: null,
      shell: null,
      title: "detached shell",
      status: "detached",
    });
  });

  it("reuses the default placeholder tab for an attached detached session", () => {
    let state = createInitialTerminalTabs();
    const initialTabId = state.tabs[0]?.id;

    state = addAttachedTerminalTab(
      state,
      {
        sessionId: createSessionId("session-human"),
        state: "detached",
        shell: "/bin/sh",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        title: null,
        createdBy: "human",
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
      { reusePlaceholder: true },
    );

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: initialTabId,
      sessionId: "session-human",
      cwd: "/tmp",
      shell: "/bin/sh",
      status: "detached",
    });
  });

  it("does not reuse a live placeholder tab unless startup reconciliation opts in", () => {
    let state = createInitialTerminalTabs();

    state = addAttachedTerminalTab(state, {
      sessionId: createSessionId("session-agent"),
      state: "detached",
      shell: "/bin/sh",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      title: null,
      createdBy: "agent",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toMatchObject({ sessionId: null, cwd: null, shell: null });
    expect(state.tabs[1]).toMatchObject({ sessionId: "session-agent" });
  });
});
