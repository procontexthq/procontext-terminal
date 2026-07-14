// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalTabStrip } from "../../src/renderer/terminal-tab-strip";
import type { TerminalTab } from "../../src/renderer/terminal-tabs";

describe("TerminalTabStrip", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
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
