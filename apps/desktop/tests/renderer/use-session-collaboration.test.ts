// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSessionId,
  type AgentSessionControlState,
  type RendererSessionEvent,
  type RendererTerminalApi,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import type { SessionCollaboration } from "../../src/renderer/use-session-collaboration";
import { useSessionCollaboration } from "../../src/renderer/use-session-collaboration";

describe("useSessionCollaboration", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("does not resurrect a session removed after the initial snapshot was taken", async () => {
    const session = summary();
    const sessions = deferred<TerminalSessionSummary[]>();
    const controls = deferred<AgentSessionControlState[]>();
    let emit: (event: RendererSessionEvent) => void = () => undefined;
    installApi({
      listSessions: () => sessions.promise,
      listAgentControls: () => controls.promise,
      onTerminalEvent: (handler) => {
        emit = handler;
        return () => undefined;
      },
    });
    const harness = renderHarness();
    await act(() => Promise.resolve());

    act(() => {
      emit({ type: "session.removed", payload: { sessionId: session.sessionId } });
    });
    await act(async () => {
      sessions.resolve([session]);
      controls.resolve([]);
      await Promise.all([sessions.promise, controls.promise]);
    });

    expect(harness.current().items).toEqual([]);
    harness.unmount();
  });

  it("preserves a revoked-control event that is newer than the initial snapshot", async () => {
    const session = summary();
    const attached: AgentSessionControlState = {
      sessionId: session.sessionId,
      state: "attached",
      attachedAt: "2026-07-14T00:00:00.000Z",
    };
    const sessions = deferred<TerminalSessionSummary[]>();
    const controls = deferred<AgentSessionControlState[]>();
    let emit: (event: RendererSessionEvent) => void = () => undefined;
    installApi({
      listSessions: () => sessions.promise,
      listAgentControls: () => controls.promise,
      onTerminalEvent: (handler) => {
        emit = handler;
        return () => undefined;
      },
    });
    const harness = renderHarness();
    await act(() => Promise.resolve());

    act(() => {
      emit({
        type: "agent.control.changed",
        payload: {
          sessionId: session.sessionId,
          state: "revoked",
          attachedAt: null,
        },
      });
    });
    await act(async () => {
      sessions.resolve([session]);
      controls.resolve([attached]);
      await Promise.all([sessions.promise, controls.promise]);
    });

    expect(harness.current().items[0]?.control.state).toBe("revoked");
    harness.unmount();
  });
});

function renderHarness(): {
  current(): SessionCollaboration;
  unmount(): void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let collaboration: SessionCollaboration | null = null;

  function Harness() {
    const tabsStateRef = { current: null };
    const controllers = { current: new Map() };
    collaboration = useSessionCollaboration({
      tabsStateRef,
      controllers,
      setTabsState: vi.fn(),
    });
    return null;
  }

  act(() => {
    root.render(createElement(Harness));
  });

  return {
    current() {
      if (!collaboration) throw new Error("Collaboration hook did not render.");
      return collaboration;
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

function installApi(
  api: Pick<RendererTerminalApi, "listSessions" | "listAgentControls" | "onTerminalEvent">,
): void {
  Object.defineProperty(window, "terminalApi", {
    configurable: true,
    value: api,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function summary(): TerminalSessionSummary {
  return {
    sessionId: createSessionId("session-bootstrap"),
    lifecycle: "running",
    shell: "/bin/zsh",
    cwd: "/workspace",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "agent",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    observationVersion: 1,
    presentation: {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
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
