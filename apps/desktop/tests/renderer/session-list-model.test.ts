import { describe, expect, it } from "vitest";

import {
  createSessionId,
  type AgentSessionControlState,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  applySessionListEvent,
  createSessionListState,
  sessionListItems,
} from "../../src/renderer/session-list-model";

describe("session list model", () => {
  it("composes canonical summaries with separate agent-control state", () => {
    const human = summary("human", "foreground");
    const agent = summary("agent", "headless");
    const control: AgentSessionControlState = {
      sessionId: agent.sessionId,
      state: "attached",
      attachedAt: "2026-07-14T00:00:00.000Z",
    };
    const state = createSessionListState([human, agent], [control]);

    expect(sessionListItems(state)).toEqual([
      expect.objectContaining({ session: agent, control }),
      expect.objectContaining({
        session: human,
        control: {
          sessionId: human.sessionId,
          state: "detached",
          attachedAt: null,
        },
      }),
    ]);
  });

  it("updates canonical metadata, attachment state, and removes stale sessions", () => {
    const session = summary("agent", "headless");
    let state = createSessionListState([session], []);
    state = applySessionListEvent(state, {
      type: "session.updated",
      payload: { ...session, cwd: "/workspace/packages/protocol" },
    });
    state = applySessionListEvent(state, {
      type: "agent.control.changed",
      payload: {
        sessionId: session.sessionId,
        state: "revoked",
        attachedAt: null,
      },
    });

    expect(sessionListItems(state)[0]).toMatchObject({
      session: { cwd: "/workspace/packages/protocol" },
      control: { state: "revoked" },
    });

    state = applySessionListEvent(state, {
      type: "session.removed",
      payload: { sessionId: session.sessionId },
    });
    expect(sessionListItems(state)).toEqual([]);
  });

  it("never exposes shell command lines through collaboration labels", async () => {
    const { sessionCommandLabel } = await import("../../src/renderer/session-list-model");
    const session = {
      ...summary("agent", "headless"),
      command: {
        state: "running" as const,
        commandId: "command-secret",
        commandLine: "SECRET_COMMAND --token SECRET",
      },
    };

    expect(sessionCommandLabel(session)).toBe("Command running");
    expect(sessionCommandLabel(session)).not.toContain("SECRET");
  });
});

function summary(
  createdBy: "human" | "agent",
  presentation: "headless" | "foreground",
): TerminalSessionSummary {
  const sessionId = createSessionId(`session-${createdBy}`);
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/zsh",
    cwd: "/workspace",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy,
    createdAt: createdBy === "agent" ? "2026-07-14T01:00:00.000Z" : "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
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
    command: { state: "idle" },
    recording: { state: "inactive" },
  };
}
