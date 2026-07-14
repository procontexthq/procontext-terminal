// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import { createSessionId } from "@terminal/protocol";

import type { TerminalController } from "../../src/renderer/terminal-controller";
import { TerminalTabView } from "../../src/renderer/terminal-tab-view";
import type { TerminalTab } from "../../src/renderer/terminal-tabs";

const { createTerminalSessionMock } = vi.hoisted(() => ({
  createTerminalSessionMock: vi.fn(),
}));

const controller: TerminalController = {
  sessionId: createSessionId("session-view"),
  lifecycle: "running",
  focus: vi.fn(),
  resize: vi.fn(() => Promise.resolve()),
  setFontFamily: vi.fn(),
  setTheme: vi.fn(),
  dispose: vi.fn(() => Promise.resolve(true)),
};

vi.mock("../../src/renderer/terminal-controller", () => {
  return { createTerminalSession: createTerminalSessionMock };
});

vi.mock("../../src/renderer/font-loading", () => ({
  browserFontFaceSet: () => null,
  waitForFontFaces: () => Promise.resolve("unavailable"),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {},
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {},
}));

describe("TerminalTabView", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    createTerminalSessionMock.mockReset();
    createTerminalSessionMock.mockResolvedValue(controller);
    vi.mocked(controller.dispose).mockClear();
    vi.mocked(controller.resize).mockClear();
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the existing terminal controller when canonical cwd metadata changes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const tab = createTab("/workspace");
    const props = createProps(tab);

    act(() => {
      root.render(createElement(TerminalTabView, props));
    });
    await act(() => Promise.resolve());

    act(() => {
      root.render(
        createElement(TerminalTabView, {
          ...props,
          tab: { ...tab, cwd: "/workspace/packages/session-core" },
        }),
      );
    });
    await act(() => Promise.resolve());

    expect(createTerminalSessionMock).toHaveBeenCalledOnce();
    expect(controller.dispose).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("keeps an exited bootstrap in the exited UI state", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const setStatus = vi.fn();
    createTerminalSessionMock.mockResolvedValueOnce({
      ...controller,
      lifecycle: "exited",
    });

    act(() => {
      root.render(
        createElement(TerminalTabView, {
          ...createProps(createTab("/workspace")),
          setStatus,
        }),
      );
    });
    await act(() => Promise.resolve());

    expect(setStatus).toHaveBeenCalledWith("tab-view", "exited");
    expect(setStatus).not.toHaveBeenCalledWith("tab-view", "running");

    act(() => {
      root.unmount();
    });
  });

  it("terminates a newly created session when its tab unmounts before startup completes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let resolveController: (value: TerminalController) => void = () => undefined;
    createTerminalSessionMock.mockReturnValueOnce(
      new Promise<TerminalController>((resolve) => {
        resolveController = resolve;
      }),
    );

    act(() => {
      root.render(
        createElement(
          TerminalTabView,
          createProps({
            ...createTab("/workspace"),
            sessionId: null,
            status: "starting",
          }),
        ),
      );
    });
    act(() => {
      root.unmount();
    });
    await act(() => {
      resolveController(controller);
      return Promise.resolve();
    });

    expect(controller.dispose).toHaveBeenCalledWith({
      sessionLifecycle: "terminate",
    });
  });
});

function createTab(cwd: string): TerminalTab {
  return {
    id: "tab-view",
    sessionId: createSessionId("session-view"),
    cwd,
    shell: "/bin/zsh",
    title: null,
    status: "running",
    hasUnreadBell: false,
  };
}

function createProps(tab: TerminalTab): Parameters<typeof TerminalTabView>[0] {
  const config = defaultTerminalConfig();
  return {
    tab,
    config,
    active: true,
    terminalFontFamily: config.terminal.fontFamily,
    fontLoadDescriptors: [],
    terminalTheme: config.terminal.theme,
    registerController: vi.fn(),
    setStatus: vi.fn(),
    onSessionEvent: vi.fn(),
    onTitleChange: vi.fn(),
    onBell: vi.fn(),
    onError: vi.fn(),
  };
}
