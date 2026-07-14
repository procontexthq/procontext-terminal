// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionSidebarToggle } from "../../src/renderer/session-sidebar-toggle";

describe("SessionSidebarToggle", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("uses an accessible icon-only control", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onToggle = vi.fn();

    act(() => {
      root.render(createElement(SessionSidebarToggle, { open: true, onToggle }));
    });

    const button = container.querySelector("button");
    expect(button?.textContent?.trim()).toBe("");
    expect(button?.getAttribute("aria-label")).toBe("Hide terminal sessions");
    expect(button?.querySelector("svg")).not.toBeNull();
    act(() => button?.click());
    expect(onToggle).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });
});
