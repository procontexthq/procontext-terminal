// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalSearchControls } from "../../src/renderer/terminal-search-controls";

describe("TerminalSearchControls", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("opens from the keyboard and searches next and previous with accessible feedback", () => {
    const fixture = renderSearch();
    fixture.target.findNext.mockReturnValue(true);
    fixture.target.findPrevious.mockReturnValue(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    const region = fixture.container.querySelector('[role="search"]');
    const input = fixture.container.querySelector<HTMLInputElement>(
      'input[aria-label="Search terminal scrollback"]',
    );
    expect(region?.getAttribute("aria-label")).toBe("Terminal search");
    expect(document.activeElement).toBe(input);

    act(() => {
      if (!input) throw new Error("Expected terminal search input.");
      setInputValue(input, "needle");
    });
    expect(fixture.target.findNext).toHaveBeenLastCalledWith("needle", { incremental: true });
    expect(fixture.container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Match found.",
    );

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(fixture.target.findNext).toHaveBeenCalledTimes(2);

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
      );
    });
    expect(fixture.target.findPrevious).toHaveBeenCalledWith("needle", { incremental: false });
    expect(fixture.container.querySelector('button[aria-label="Previous match"]')).not.toBeNull();
    expect(fixture.container.querySelector('button[aria-label="Next match"]')).not.toBeNull();

    fixture.unmount();
  });

  it("announces no matches and closes without changing terminal or canonical state", () => {
    const fixture = renderSearch();
    fixture.target.findNext.mockReturnValue(false);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    const input = fixture.container.querySelector<HTMLInputElement>("input");
    act(() => {
      if (!input) throw new Error("Expected terminal search input.");
      setInputValue(input, "missing");
    });
    expect(fixture.container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "No matches found.",
    );

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(fixture.container.querySelector('[role="search"]')).toBeNull();
    expect(fixture.target.clearDecorations).toHaveBeenCalledOnce();
    expect(fixture.onRequestTerminalFocus).toHaveBeenCalledOnce();

    fixture.unmount();
  });

  it("does not open search for an inactive terminal view", () => {
    const fixture = renderSearch(false);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(fixture.container.querySelector('[role="search"]')).toBeNull();
    fixture.unmount();
  });
});

function renderSearch(active = true): {
  container: HTMLDivElement;
  target: {
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
    clearDecorations: ReturnType<typeof vi.fn>;
  };
  onRequestTerminalFocus: ReturnType<typeof vi.fn>;
  unmount(): void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const target = {
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
  };
  const onRequestTerminalFocus = vi.fn();

  act(() => {
    root.render(
      createElement(TerminalSearchControls, {
        active,
        target,
        onRequestTerminalFocus,
      }),
    );
  });

  return {
    container,
    target,
    onRequestTerminalFocus,
    unmount() {
      act(() => root.unmount());
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Expected the native input value setter.");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
