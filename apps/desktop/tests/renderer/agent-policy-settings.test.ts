// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";

import { AgentPolicySettings } from "../../src/renderer/agent-policy-settings";

describe("AgentPolicySettings", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("edits only coarse agent policy categories and saves them together", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn();

    act(() => {
      root.render(
        createElement(AgentPolicySettings, {
          active: false,
          policy: defaultTerminalConfig().agentPolicy,
          onSave,
        }),
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-policy-toggle"]')?.click();
    });
    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-policy-termination"]',
    );
    if (!select) throw new Error("Expected termination policy select.");
    act(() => {
      select.value = "ask";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-policy-save"]')?.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ termination: "ask", observation: "allow" }),
    );
    expect(container.textContent).not.toContain("command line");
    act(() => root.unmount());
  });

  it("combines agent activity and policy access in one titlebar control", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (active: boolean) =>
      createElement(AgentPolicySettings, {
        active,
        policy: defaultTerminalConfig().agentPolicy,
        onSave: vi.fn(),
      });

    act(() => root.render(render(false)));
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="agent-policy-toggle"]',
    );
    expect(toggle?.textContent).toContain("Agent idle");
    expect(toggle?.getAttribute("aria-label")).toContain("Agent idle");
    expect(container.querySelectorAll('[data-testid="agent-policy-toggle"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="agent-activity"]')?.textContent).toBe(
      "Agent idle",
    );

    act(() => root.render(render(true)));
    expect(toggle?.textContent).toContain("Agent active");
    expect(toggle?.getAttribute("aria-label")).toContain("Agent active");
    expect(container.querySelector('[data-testid="agent-activity"]')?.textContent).toBe(
      "Agent active",
    );

    act(() => root.unmount());
  });
});
