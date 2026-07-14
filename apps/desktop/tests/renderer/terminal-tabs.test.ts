import { describe, expect, it } from "vitest";

import { createSessionId, type TerminalSessionSummary } from "@terminal/protocol";

import {
  addAttachedTerminalTab,
  addTerminalTab,
  closeTerminalTab,
  createInitialTerminalTabs,
  markTabBell,
  selectAdjacentTerminalTab,
  selectTerminalTab,
  updateTabFromSession,
} from "../../src/renderer/terminal-tabs";

describe("terminal tabs model", () => {
  it("starts with one fresh placeholder tab", () => {
    const state = createInitialTerminalTabs();

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      sessionId: null,
      title: null,
      status: "starting",
    });
  });

  it("adds, selects, closes, and retains one fallback tab", () => {
    let state = createInitialTerminalTabs();
    state = addTerminalTab(state, { cwd: "/work/new", shell: null });
    const first = state.tabs[0]?.id ?? "";
    state = selectTerminalTab(state, first);
    state = closeTerminalTab(state, first);
    state = closeTerminalTab(state, state.activeTabId);

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ sessionId: null, cwd: null, shell: null });
  });

  it("wraps adjacent tab selection and tracks unread bells", () => {
    let state = addTerminalTab(createInitialTerminalTabs());
    const [first, second] = state.tabs;
    state = markTabBell(state, first?.id ?? "");
    expect(state.tabs[0]?.hasUnreadBell).toBe(true);

    state = selectAdjacentTerminalTab(state, "next");
    expect(state.activeTabId).toBe(first?.id);
    expect(state.tabs[0]?.hasUnreadBell).toBe(false);

    state = selectAdjacentTerminalTab(state, "previous");
    expect(state.activeTabId).toBe(second?.id);
  });

  it("adds a canonical session summary without duplicating its tab", () => {
    let state = createInitialTerminalTabs();
    state = addAttachedTerminalTab(state, createSummary());
    state = addAttachedTerminalTab(state, {
      ...createSummary(),
      title: "vim package.json",
      lifecycle: "exited",
    });

    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]).toMatchObject({
      sessionId: "session-agent",
      cwd: "/repo",
      shell: "/bin/zsh",
      title: "vim package.json",
      status: "exited",
    });
  });

  it("can reuse the initial placeholder during startup reconciliation", () => {
    const initial = createInitialTerminalTabs();
    const initialId = initial.tabs[0]?.id;
    const state = addAttachedTerminalTab(initial, createSummary("human"), {
      reusePlaceholder: true,
    });

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      id: initialId,
      sessionId: "session-agent",
      status: "running",
    });
  });

  it("opens an attached background tab without changing the active tab", () => {
    const initial = addTerminalTab(createInitialTerminalTabs());
    const activeTabId = initial.activeTabId;
    const state = addAttachedTerminalTab(initial, createSummary(), { activate: false });

    expect(state.activeTabId).toBe(activeTabId);
    expect(state.tabs.at(-1)?.sessionId).toBe("session-agent");
  });

  it("updates cwd metadata from canonical session updates", () => {
    let state = addAttachedTerminalTab(createInitialTerminalTabs(), createSummary(), {
      reusePlaceholder: true,
    });

    state = updateTabFromSession(state, {
      ...createSummary(),
      cwd: "/repo/packages/session-core",
      shellIntegration: {
        status: "available",
        capabilities: {
          prompt: true,
          commandStart: true,
          commandFinish: true,
          commandLine: true,
          exitCode: true,
          cwd: true,
        },
      },
      command: { state: "idle" },
    });

    expect(state.tabs[0]).toMatchObject({
      cwd: "/repo/packages/session-core",
      status: "running",
    });
  });

  it("applies buffered session metadata before a placeholder receives its session id", () => {
    const initial = createInitialTerminalTabs();
    const state = updateTabFromSession(initial, createSummary(), initial.activeTabId);

    expect(state.tabs[0]).toMatchObject({
      sessionId: null,
      cwd: "/repo",
      shell: "/bin/zsh",
    });
  });
});

function createSummary(createdBy: "human" | "agent" = "agent"): TerminalSessionSummary {
  return {
    sessionId: createSessionId("session-agent"),
    lifecycle: "running",
    shell: "/bin/zsh",
    cwd: "/repo",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}
