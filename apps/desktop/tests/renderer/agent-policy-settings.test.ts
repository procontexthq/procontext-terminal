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
});
