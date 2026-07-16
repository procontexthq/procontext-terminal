// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";
import type { FocusedTerminalSettings } from "@terminal/protocol";

import { FocusedSettings } from "../../src/renderer/focused-settings";

const SYSTEM_MONOSPACE_STACK =
  'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SHARE_TECH_MONO_STACK = `"Share Tech Mono", ${SYSTEM_MONOSPACE_STACK}`;

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

  it("maps a friendly bundled-font choice to its canonical fallback stack", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn<(settings: FocusedTerminalSettings) => void>();

    act(() => {
      root.render(createElement(FocusedSettings, { config: defaultTerminalConfig(), onSave }));
    });
    click(container, "focused-settings-toggle");

    const fontChoice = getControl<HTMLSelectElement>(container, "setting-font-family");
    expect(fontChoice.tagName).toBe("SELECT");
    expect(fontChoice.value).toBe("jetbrains-mono");
    expect(fontChoice.selectedOptions[0]?.textContent).toBe("JetBrains Mono");
    expect(Array.from(fontChoice.options, (option) => [option.value, option.textContent])).toEqual([
      ["jetbrains-mono", "JetBrains Mono"],
      ["share-tech-mono", "Share Tech Mono"],
      ["ibm-plex-mono", "IBM Plex Mono"],
      ["system-monospace", "System monospace"],
      ["custom", "Custom"],
    ]);

    changeValue(container, "setting-font-family", "share-tech-mono");
    click(container, "focused-settings-save");

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0].terminal.fontFamily).toBe(SHARE_TECH_MONO_STACK);

    act(() => root.unmount());
  });

  it("preserves and edits a custom persisted font stack without exposing it as a preset", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn<(settings: FocusedTerminalSettings) => void>();
    const customStack = '"Fira Code", Consolas, monospace';
    const updatedStack = '"Cascadia Mono", Consolas, monospace';
    const config = {
      ...defaultTerminalConfig(),
      terminal: { ...defaultTerminalConfig().terminal, fontFamily: customStack },
    };

    act(() => {
      root.render(createElement(FocusedSettings, { config, onSave }));
    });
    click(container, "focused-settings-toggle");

    const fontChoice = getControl<HTMLSelectElement>(container, "setting-font-family");
    const customFont = getControl<HTMLInputElement>(container, "setting-font-family-custom");
    expect(fontChoice.value).toBe("custom");
    expect(fontChoice.selectedOptions[0]?.textContent).toBe("Custom");
    expect(customFont.value).toBe(customStack);
    expect(customFont.labels?.[0]?.textContent).toContain("Custom font stack");

    click(container, "focused-settings-save");
    expect(onSave.mock.calls[0]![0].terminal.fontFamily).toBe(customStack);

    changeValue(container, "setting-font-family-custom", updatedStack);
    click(container, "focused-settings-save");
    expect(onSave.mock.calls[1]![0].terminal.fontFamily).toBe(updatedStack);

    act(() => root.unmount());
  });

  it("uses accessible horizontal label rows for accessibility checkboxes", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(FocusedSettings, {
          config: defaultTerminalConfig(),
          onSave: vi.fn(),
        }),
      );
    });
    click(container, "focused-settings-toggle");

    for (const [testId, accessibleName] of [
      ["accessibility-screen-reader", "Screen reader mode"],
      ["accessibility-reduced-motion", "Reduce motion"],
    ] as const) {
      const checkbox = getControl<HTMLInputElement>(container, testId);
      const label = checkbox.labels?.[0];
      expect(checkbox.type).toBe("checkbox");
      expect(label?.classList.contains("focused-settings-checkbox")).toBe(true);
      expect(label?.querySelector(".focused-settings-checkbox-label")?.textContent).toBe(
        accessibleName,
      );
      expect(label?.textContent?.trim()).toBe(accessibleName);
    }

    act(() => root.unmount());
  });

  it("keeps portable hex text editable while synchronizing accessible color pickers", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn<(settings: FocusedTerminalSettings) => void>();
    const defaults = defaultTerminalConfig();
    const config = {
      ...defaults,
      terminal: {
        ...defaults.terminal,
        theme: { ...defaults.terminal.theme, background: "#abc" },
      },
    };

    act(() => {
      root.render(createElement(FocusedSettings, { config, onSave }));
    });
    click(container, "focused-settings-toggle");

    const backgroundText = getControl<HTMLInputElement>(container, "setting-color-background");
    const backgroundPicker = getControl<HTMLInputElement>(
      container,
      "setting-color-background-picker",
    );
    expect(backgroundText.type).toBe("text");
    expect(backgroundText.value).toBe("#abc");
    expect(backgroundPicker.type).toBe("color");
    expect(backgroundPicker.value).toBe("#aabbcc");
    expect(backgroundPicker.getAttribute("aria-label")).toBe("Choose background color");

    changeValue(container, "setting-color-background", "#123");
    expect(backgroundText.value).toBe("#123");
    expect(backgroundPicker.value).toBe("#112233");
    click(container, "focused-settings-save");
    expect(onSave.mock.calls[0]![0].terminal.theme.background).toBe("#123");

    changeValue(container, "setting-color-background-picker", "#445566");
    expect(backgroundText.value).toBe("#445566");
    click(container, "focused-settings-save");
    expect(onSave.mock.calls[1]![0].terminal.theme.background).toBe("#445566");

    for (const color of ["foreground", "cursor"] as const) {
      const textInput = getControl<HTMLInputElement>(container, `setting-color-${color}`);
      const picker = getControl<HTMLInputElement>(container, `setting-color-${color}-picker`);
      expect(textInput.type).toBe("text");
      expect(picker.type).toBe("color");
      expect(picker.getAttribute("aria-label")).toBe(`Choose ${color} color`);
    }

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

function getControl<T extends HTMLElement>(container: HTMLElement, testId: string): T {
  const control = container.querySelector<T>(`[data-testid="${testId}"]`);
  if (!control) throw new Error(`Missing ${testId}.`);
  return control;
}
