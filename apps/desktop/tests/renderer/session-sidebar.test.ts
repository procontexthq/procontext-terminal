// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSessionId, type TerminalSessionSummary } from "@terminal/protocol";

import { SessionSidebar } from "../../src/renderer/session-sidebar";

describe("SessionSidebar", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders privacy-safe collaboration status and contextual actions", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const session = createSummary();
    const actions = {
      reveal: vi.fn(),
      hide: vi.fn(),
      revoke: vi.fn(),
      allow: vi.fn(),
      terminate: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      exportRecording: vi.fn(),
    };

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [
            {
              session,
              control: {
                sessionId: session.sessionId,
                state: "attached",
                attachedAt: "2026-07-14T00:00:00.000Z",
              },
            },
          ],
          activeSessionId: session.sessionId,
          redactionPatternCount: 2,
          actions,
        }),
      );
    });

    expect(container.textContent).toContain("Agent attached");
    expect(container.textContent).toContain("Command running");
    expect(container.textContent).toContain("Redaction 2 patterns");
    expect(container.textContent).not.toContain("SECRET_COMMAND");

    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => {
      buttons.find((button) => button.textContent === "Revoke agent")?.click();
      buttons.find((button) => button.textContent === "Hide")?.click();
      buttons.find((button) => button.textContent === "Stop recording")?.click();
    });

    expect(actions.revoke).toHaveBeenCalledWith(session.sessionId);
    expect(actions.hide).toHaveBeenCalledWith(session);
    expect(actions.stopRecording).toHaveBeenCalledWith(session.sessionId);

    act(() => root.unmount());
  });

  it("offers explicit human approval after agent control is revoked", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const session = createSummary();
    const actions = {
      reveal: vi.fn(),
      hide: vi.fn(),
      revoke: vi.fn(),
      allow: vi.fn(),
      terminate: vi.fn(),
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      exportRecording: vi.fn(),
    };

    act(() => {
      root.render(
        createElement(SessionSidebar, {
          open: true,
          items: [
            {
              session,
              control: {
                sessionId: session.sessionId,
                state: "revoked",
                attachedAt: null,
              },
            },
          ],
          activeSessionId: session.sessionId,
          redactionPatternCount: 0,
          actions,
        }),
      );
    });

    expect(container.textContent).toContain("Agent blocked");
    const allowButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Allow agent control",
    );
    act(() => allowButton?.click());
    expect(actions.allow).toHaveBeenCalledWith(session.sessionId);
    expect(actions.revoke).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});

function createSummary(): TerminalSessionSummary {
  const sessionId = createSessionId("session-sidebar");
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/zsh",
    cwd: "/workspace",
    dimensions: { cols: 80, rows: 24 },
    title: "Agent terminal",
    createdBy: "agent",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "foreground",
      windowVisible: true,
      windowFocused: true,
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
    recording: { state: "active" },
  };
}
