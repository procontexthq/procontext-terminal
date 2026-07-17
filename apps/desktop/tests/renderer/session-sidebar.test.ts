// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionId,
  type AgentSessionControlState,
  type SessionId,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import { SessionSidebar, type SessionSidebarActions } from "../../src/renderer/session-sidebar";

describe("SessionSidebar", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders privacy-safe status with direct contextual and disclosed secondary actions", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const session = createSummary();
    const actions = createActions();

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [{ session, control: control(session.sessionId, "attached") }],
          activeSessionId: session.sessionId,
          redactionPatternCount: 2,
          actions,
        }),
      );
    });

    const card = sessionCard(container, session.sessionId);
    expect(card.textContent).toContain("Agent attached");
    expect(card.textContent).toContain("Command running");
    expect(container.textContent).toContain("Human and agent terminals · Redaction");
    expect(container.textContent).toContain("Redaction 2 patterns");
    expect(container.textContent).not.toMatch(/[Ââ]/u);
    expect(container.textContent).not.toContain("SECRET_COMMAND");
    expect(directActionLabels(card)).toEqual(["Hide", "Stop recording"]);
    expect(card.textContent).not.toContain("Revoke agent");
    expect(card.textContent).not.toContain("Export recording");
    expect(card.textContent).not.toContain("Terminate");

    const more = moreActionsButton(card);
    expect(more.textContent?.trim()).toBe("...");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    act(() => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const disclosureId = more.getAttribute("aria-controls");
    expect(disclosureId).not.toBeNull();
    expect(document.getElementById(disclosureId!)).not.toBeNull();
    expect(card.textContent).toContain("Revoke agent");
    expect(card.textContent).toContain("Export recording");
    expect(card.textContent).toContain("Terminate");

    act(() => buttonWithText(card, "Revoke agent").click());
    expect(actions.revoke).toHaveBeenCalledWith(session.sessionId);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);
    act(() => more.click());
    act(() => buttonWithText(card, "Export recording").click());
    expect(actions.exportRecording).toHaveBeenCalledWith(session.sessionId);
    expect(document.activeElement).toBe(more);
    act(() => buttonWithText(card, "Stop recording").click());
    expect(actions.stopRecording).toHaveBeenCalledWith(session.sessionId);

    act(() => root.unmount());
  });

  it("offers exactly one presentation action for active, visible, and headless sessions", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const active = createSummary({ id: "active", presentation: "foreground" });
    const background = createSummary({ id: "background", presentation: "background" });
    const headless = createSummary({ id: "headless", presentation: "headless" });
    const actions = createActions();

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [active, background, headless].map((session) => ({
            session,
            control: control(session.sessionId, "detached"),
          })),
          activeSessionId: active.sessionId,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });

    expect(presentationActionLabels(sessionCard(container, active.sessionId))).toEqual(["Hide"]);
    expect(presentationActionLabels(sessionCard(container, background.sessionId))).toEqual([
      "Focus",
    ]);
    expect(presentationActionLabels(sessionCard(container, headless.sessionId))).toEqual([
      "Reveal",
    ]);

    act(() => buttonWithText(sessionCard(container, active.sessionId), "Hide").click());
    act(() => buttonWithText(sessionCard(container, background.sessionId), "Focus").click());
    act(() => buttonWithText(sessionCard(container, headless.sessionId), "Reveal").click());
    expect(actions.hide).toHaveBeenCalledWith(active);
    expect(actions.reveal).toHaveBeenCalledWith(background);
    expect(actions.reveal).toHaveBeenCalledWith(headless);
    expect(container.textContent).not.toContain("No agent");

    act(() => root.unmount());
  });

  it("moves focus to a neighboring session after a confirmed removal", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const first = createSummary({ id: "first" });
    const second = createSummary({ id: "second", presentation: "background" });
    const actions = createActions();
    actions.terminate.mockReturnValue(true);
    const item = (session: TerminalSessionSummary) => ({
      session,
      control: control(session.sessionId, "detached"),
    });

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [item(first), item(second)],
          activeSessionId: first.sessionId,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });
    const firstCard = sessionCard(container, first.sessionId);
    const firstMore = moreActionsButton(firstCard);
    act(() => firstMore.click());
    act(() => buttonWithText(firstCard, "Terminate").click());
    expect(document.activeElement).toBe(firstMore);

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [item(second)],
          activeSessionId: second.sessionId,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });
    expect(document.activeElement).toBe(
      moreActionsButton(sessionCard(container, second.sessionId)),
    );

    act(() => root.unmount());
  });

  it("keeps agent approval, export, and finished-session removal in an accessible disclosure", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const session = createSummary({
      id: "finished",
      lifecycle: "exited",
      presentation: "headless",
      recording: "inactive",
    });
    const actions = createActions();

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [{ session, control: control(session.sessionId, "revoked") }],
          activeSessionId: null,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });

    const card = sessionCard(container, session.sessionId);
    expect(card.textContent).toContain("Agent blocked");
    expect(directActionLabels(card)).toEqual(["Reveal"]);
    const more = moreActionsButton(card);
    more.focus();
    act(() => more.click());
    expect(card.textContent).toContain("Allow agent control");
    expect(card.textContent).toContain("Export recording");
    expect(card.textContent).toContain("Remove");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);

    act(() => more.click());
    act(() => buttonWithText(card, "Allow agent control").click());
    expect(actions.allow).toHaveBeenCalledWith(session.sessionId);
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);

    act(() => more.click());
    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: false,
          items: [{ session, control: control(session.sessionId, "revoked") }],
          activeSessionId: null,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });
    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [{ session, control: control(session.sessionId, "revoked") }],
          activeSessionId: null,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });
    const reopenedCard = sessionCard(container, session.sessionId);
    const reopenedMore = moreActionsButton(reopenedCard);
    expect(reopenedMore.getAttribute("aria-expanded")).toBe("false");

    act(() => reopenedMore.click());
    act(() => buttonWithText(reopenedCard, "Remove").click());
    expect(actions.terminate).toHaveBeenCalledWith(session);
    expect(document.activeElement).toBe(reopenedMore);

    act(() => root.unmount());
  });
});

function createActions() {
  return {
    reveal: vi.fn<SessionSidebarActions["reveal"]>(),
    hide: vi.fn<SessionSidebarActions["hide"]>(),
    revoke: vi.fn<SessionSidebarActions["revoke"]>(),
    allow: vi.fn<SessionSidebarActions["allow"]>(),
    terminate: vi.fn<SessionSidebarActions["terminate"]>(),
    startRecording: vi.fn<SessionSidebarActions["startRecording"]>(),
    stopRecording: vi.fn<SessionSidebarActions["stopRecording"]>(),
    exportRecording: vi.fn<SessionSidebarActions["exportRecording"]>(),
  };
}

function control(
  sessionId: SessionId,
  state: AgentSessionControlState["state"],
): AgentSessionControlState {
  return {
    sessionId,
    state,
    attachedAt: state === "attached" ? "2026-07-14T00:00:00.000Z" : null,
  };
}

function createSummary({
  id = "session-sidebar",
  lifecycle = "running",
  presentation = "foreground",
  recording = "active",
}: {
  id?: string;
  lifecycle?: TerminalSessionSummary["lifecycle"];
  presentation?: TerminalSessionSummary["presentation"]["state"];
  recording?: "active" | "inactive";
} = {}): TerminalSessionSummary {
  const sessionId = createSessionId(id);
  return {
    sessionId,
    lifecycle,
    shell: "/bin/zsh",
    cwd: "/workspace",
    dimensions: { cols: 80, rows: 24 },
    title: `Terminal ${id}`,
    createdBy: "agent",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: presentation,
      windowVisible: presentation !== "headless",
      windowFocused: presentation === "foreground",
    },
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
    command: {
      state: "running",
      commandId: "command-sidebar",
      commandLine: "SECRET_COMMAND --token SECRET",
    },
    recording: { state: recording },
  };
}

function sessionCard(container: HTMLElement, sessionId: SessionId): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-testid="session-card-${sessionId}"]`);
  if (!card) throw new Error(`Missing session card ${sessionId}.`);
  return card;
}

function moreActionsButton(card: HTMLElement): HTMLButtonElement {
  const button = Array.from(card.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith("More actions for "),
  );
  if (!button) throw new Error("Missing session More actions button.");
  return button;
}

function directActionLabels(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll<HTMLButtonElement>("button"))
    .filter((button) => !button.getAttribute("aria-label")?.startsWith("More actions for "))
    .map((button) => button.textContent?.trim() ?? "");
}

function presentationActionLabels(card: HTMLElement): string[] {
  return directActionLabels(card).filter((label) => ["Hide", "Focus", "Reveal"].includes(label));
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button ${text}.`);
  return button;
}
