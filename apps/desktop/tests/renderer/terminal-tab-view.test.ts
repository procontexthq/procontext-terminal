// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import { createSessionId } from "@terminal/protocol";

import type { TerminalController } from "../../src/renderer/terminal-controller";
import { TerminalTabView } from "../../src/renderer/terminal-tab-view";
import type { TerminalTab } from "../../src/renderer/terminal-tabs";

const { createTerminalSessionMock, terminalConstructorMock } = vi.hoisted(() => ({
  createTerminalSessionMock: vi.fn(),
  terminalConstructorMock: vi.fn(),
}));

const controller: TerminalController = {
  sessionId: createSessionId("session-view"),
  lifecycle: "running",
  focus: vi.fn(),
  resize: vi.fn(() => Promise.resolve()),
  setFontFamily: vi.fn(),
  setTheme: vi.fn(),
  setFocused: vi.fn(() => Promise.resolve()),
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
  Terminal: class {
    constructor(options: unknown) {
      terminalConstructorMock(options);
    }
  },
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
    terminalConstructorMock.mockReset();
    vi.mocked(controller.dispose).mockClear();
    vi.mocked(controller.focus).mockClear();
    vi.mocked(controller.resize).mockClear();
    vi.mocked(controller.setFocused).mockClear();
    vi.mocked(controller.setTheme).mockClear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("configures a compact scrollbar without a contrasting overview-ruler edge", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const props = createProps(createTab("/workspace"));

    act(() => {
      root.render(createElement(TerminalTabView, props));
    });
    await act(() => Promise.resolve());

    const sessionOptions = createTerminalSessionMock.mock.calls[0]?.[0] as
      | { createTerminal(): unknown }
      | undefined;
    sessionOptions?.createTerminal();

    const terminalOptions = terminalConstructorMock.mock.calls[0]?.[0] as
      | {
          overviewRuler?: { width?: number };
          scrollback?: number;
          theme?: { overviewRulerBorder?: string };
        }
      | undefined;
    expect(terminalOptions?.overviewRuler).toEqual({ width: 8 });
    expect(terminalOptions?.scrollback).toBe(props.config.terminal.scrollback);
    expect(terminalOptions?.theme?.overviewRulerBorder).toBe(props.terminalTheme.background);

    const nextTheme = { ...props.terminalTheme, background: "#050607" };
    act(() => {
      root.render(createElement(TerminalTabView, { ...props, terminalTheme: nextTheme }));
    });
    await act(() => Promise.resolve());
    expect(controller.setTheme).toHaveBeenCalledWith(
      expect.objectContaining({
        overviewRulerBorder: nextTheme.background,
      }),
    );

    act(() => root.unmount());
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

  it("reports active-tab focus changes through its terminal controller", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const tab = createTab("/workspace");
    const props = createProps(tab);

    act(() => {
      root.render(createElement(TerminalTabView, props));
    });
    await act(() => Promise.resolve());

    expect(controller.setFocused).toHaveBeenCalledWith(true);

    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(() => {
      window.dispatchEvent(new Event("blur"));
      return Promise.resolve();
    });
    expect(controller.setFocused).toHaveBeenLastCalledWith(false);

    vi.mocked(document.hasFocus).mockReturnValue(true);
    await act(() => {
      window.dispatchEvent(new Event("focus"));
      return Promise.resolve();
    });
    expect(controller.setFocused).toHaveBeenLastCalledWith(true);

    act(() => {
      root.render(createElement(TerminalTabView, { ...props, active: false }));
    });
    await act(() => Promise.resolve());

    expect(controller.setFocused).toHaveBeenLastCalledWith(false);
    await act(() => {
      window.dispatchEvent(new Event("focus"));
      return Promise.resolve();
    });
    expect(controller.setFocused).toHaveBeenLastCalledWith(false);
    act(() => root.unmount());
  });

  it("refocuses the active terminal after a human tab-close request", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const tab = createTab("/workspace");
    const props = createProps(tab);

    act(() => {
      root.render(createElement(TerminalTabView, props));
    });
    await act(() => Promise.resolve());
    vi.mocked(controller.focus).mockClear();

    act(() => {
      root.render(
        createElement(TerminalTabView, {
          ...props,
          focusRequestVersion: props.focusRequestVersion + 1,
        }),
      );
    });
    await act(() => Promise.resolve());

    expect(controller.focus).toHaveBeenCalledOnce();
    act(() => root.unmount());
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
    focusRequestVersion: 0,
    registerController: vi.fn(),
    setStatus: vi.fn(),
    onSessionEvent: vi.fn(),
    onTitleChange: vi.fn(),
    onBell: vi.fn(),
    onError: vi.fn(),
  };
}
