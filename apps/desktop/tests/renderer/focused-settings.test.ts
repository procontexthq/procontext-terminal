// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import type { FocusedTerminalSettings } from "@terminal/protocol";

import { FocusedSettings } from "../../src/renderer/focused-settings";

describe("FocusedSettings", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("edits terminal, shell, accessibility, recording, and presentation settings together", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn<(settings: FocusedTerminalSettings) => void>();
    const config = {
      ...defaultTerminalConfig(),
      shell: {
        defaultProfile: "work",
        profiles: [
          {
            id: "work",
            name: "Work",
            shell: "/bin/zsh",
            cwd: "/workspace",
            env: { TERM_PROGRAM: "procontext" },
          },
        ],
      },
      windowGeometry: { x: 20, y: 30, width: 1000, height: 700, displayId: 1 },
    };

    act(() => {
      root.render(createElement(FocusedSettings, { config, onSave }));
    });
    click(container, "focused-settings-toggle");

    expect(container.textContent).toContain("Terminal appearance");
    expect(container.textContent).toContain("Shell profiles");
    expect(container.textContent).toContain("Accessibility");
    expect(container.textContent).toContain("Recording defaults");

    changeValue(container, "setting-font-size", "16");
    changeValue(container, "setting-scrollback", "12000");
    changeValue(container, "shell-profile-shell-0", "/usr/bin/fish");
    changeValue(container, "accessibility-minimum-contrast", "7");
    changeValue(container, "setting-default-presentation", "background");
    changeValue(container, "recording-default-state", "enabled");
    changeValue(container, "recording-redaction-patterns", "token\\w+\npassword=.*");
    toggle(container, "accessibility-screen-reader", true);
    toggle(container, "accessibility-reduced-motion", true);
    click(container, "focused-settings-save");

    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0]![0];
    expect(saved.terminal).toMatchObject({ fontSize: 16, scrollback: 12_000 });
    expect(saved).toMatchObject({
      shell: {
        defaultProfile: "work",
        profiles: [
          {
            id: "work",
            name: "Work",
            shell: "/usr/bin/fish",
            cwd: "/workspace",
            env: { TERM_PROGRAM: "procontext" },
          },
        ],
      },
      accessibility: {
        screenReaderMode: true,
        reducedMotion: true,
        minimumContrastRatio: 7,
      },
      recording: { state: "enabled", redactedPatterns: ["token\\w+", "password=.*"] },
      defaultPresentation: "background",
    });
    expect(saved).not.toHaveProperty("agentPolicy");
    expect(saved).not.toHaveProperty("ui");
    expect(saved).not.toHaveProperty("windowGeometry");
    expect(saved).not.toHaveProperty("tabs");
    expect(saved).not.toHaveProperty("sessions");

    act(() => root.unmount());
  });

  it("rejects invalid focused settings before invoking the save callback", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn();

    act(() => {
      root.render(createElement(FocusedSettings, { config: defaultTerminalConfig(), onSave }));
    });
    click(container, "focused-settings-toggle");
    changeValue(container, "accessibility-minimum-contrast", "30");
    changeValue(container, "setting-color-background", "not-a-portable-color");
    click(container, "focused-settings-save");

    expect(onSave).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    const contrast = container.querySelector('[data-testid="accessibility-minimum-contrast"]');
    const background = container.querySelector('[data-testid="setting-color-background"]');
    expect(alert?.textContent).toContain("Check the highlighted settings");
    expect(alert?.id).toBe("focused-settings-error");
    expect(contrast?.getAttribute("aria-invalid")).toBe("true");
    expect(contrast?.getAttribute("aria-describedby")).toBe("focused-settings-error");
    expect(background?.getAttribute("aria-invalid")).toBe("true");
    expect(background?.getAttribute("aria-describedby")).toBe("focused-settings-error");

    act(() => root.unmount());
  });
});

function click(container: HTMLElement, testId: string): void {
  act(() => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
  });
}

function changeValue(container: HTMLElement, testId: string, value: string): void {
  const input = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[data-testid="${testId}"]`,
  );
  if (!input) throw new Error(`Missing ${testId}.`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function toggle(container: HTMLElement, testId: string, checked: boolean): void {
  const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (!input) throw new Error(`Missing ${testId}.`);
  act(() => {
    if (input.checked !== checked) input.click();
  });
}
