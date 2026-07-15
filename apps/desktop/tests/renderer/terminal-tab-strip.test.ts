// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTabStrip } from "../../src/renderer/terminal-tab-strip";
import type { TerminalTab } from "../../src/renderer/terminal-tabs";

describe("TerminalTabStrip", () => {
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it("keeps overflow navigation and the new-tab action outside the scroll viewport", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onAdd = vi.fn();

    act(() => {
      root.render(
        createElement(TerminalTabStrip, {
          tabs: tabs(),
          activeTabId: "tab-3",
          onSelect: vi.fn(),
          onClose: vi.fn(),
          onAdd,
        }),
      );
    });

    const strip = container.querySelector<HTMLElement>('[data-testid="terminal-tab-strip"]');
    if (!strip) throw new Error("Expected terminal tab strip.");
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 720 },
      scrollLeft: { configurable: true, writable: true, value: 240 },
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    const previous = container.querySelector<HTMLButtonElement>(
      '[data-testid="tab-scroll-previous"]',
    );
    const next = container.querySelector<HTMLButtonElement>('[data-testid="tab-scroll-next"]');
    expect(previous?.disabled).toBe(false);
    expect(next?.disabled).toBe(false);

    act(() => previous?.click());
    expect(strip.scrollLeft).toBeLessThan(240);
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="new-tab-button"]')?.click();
    });
    expect(onAdd).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("realigns the complete active tab after resizes and tab layout changes", () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const observe = vi.fn();
    const scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallbacks.push(callback);
        }

        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (nextTabs: TerminalTab[]) =>
      createElement(TerminalTabStrip, {
        tabs: nextTabs,
        activeTabId: "tab-3",
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onAdd: vi.fn(),
      });

    act(() => {
      root.render(render(tabs()));
    });

    const strip = container.querySelector<HTMLElement>('[data-testid="terminal-tab-strip"]');
    const activeButton = container.querySelector<HTMLElement>('[data-testid="terminal-tab-3"]');
    const activeItem = activeButton?.closest<HTMLElement>(".tab-item");
    if (!strip || !activeItem) throw new Error("Expected the active terminal tab item.");

    expect(observe).toHaveBeenCalledWith(strip);
    expect(observe).toHaveBeenCalledWith(activeItem);
    expect(scrollIntoView.mock.contexts).toContain(activeItem);

    scrollIntoView.mockClear();
    const observedResize = resizeCallbacks[0];
    if (!observedResize) throw new Error("Expected a tab-strip resize observer.");
    act(() => {
      observedResize([], {} as ResizeObserver);
    });
    expect(scrollIntoView.mock.contexts).toContain(activeItem);

    scrollIntoView.mockClear();
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(scrollIntoView.mock.contexts).toContain(activeItem);

    scrollIntoView.mockClear();
    const relaidOutTabs = [
      ...tabs(),
      {
        ...tabs()[0]!,
        id: "tab-4",
      },
    ];
    act(() => {
      root.render(render(relaidOutTabs));
    });
    expect(scrollIntoView.mock.contexts).toContain(activeItem);
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
    });

    act(() => root.unmount());
  });

  it("does not undo manual overflow navigation for status-only tab updates", () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (nextTabs: TerminalTab[]) =>
      createElement(TerminalTabStrip, {
        tabs: nextTabs,
        activeTabId: "tab-3",
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onAdd: vi.fn(),
      });

    act(() => {
      root.render(render(tabs()));
    });
    scrollIntoView.mockClear();
    const updatedTabs = tabs();
    updatedTabs[0] = { ...updatedTabs[0]!, status: "exited" };
    act(() => {
      root.render(render(updatedTabs));
    });

    expect(scrollIntoView).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});

function tabs(): TerminalTab[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `tab-${index}`,
    sessionId: null,
    cwd: `/workspace/${index}`,
    shell: "/bin/zsh",
    title: null,
    status: "running",
    hasUnreadBell: false,
  }));
}
