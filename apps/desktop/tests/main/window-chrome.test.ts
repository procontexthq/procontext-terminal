import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { AppShortcutAction } from "@terminal/protocol";

import { PRODUCT_NAME } from "../../src/main/app-branding";
import {
  WINDOW_TITLEBAR_HEIGHT,
  createApplicationMenuTemplate,
  dispatchApplicationMenuShortcut,
  resolveWindowChromeOptions,
} from "../../src/main/window-chrome";

describe("window chrome", () => {
  it("integrates the renderer titlebar while retaining platform-native controls", () => {
    expect(resolveWindowChromeOptions("darwin")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: { height: WINDOW_TITLEBAR_HEIGHT },
    });

    for (const platform of ["win32", "linux"] as const) {
      expect(resolveWindowChromeOptions(platform)).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: "#00000000",
          symbolColor: "#e8eaed",
          height: WINDOW_TITLEBAR_HEIGHT,
        },
        autoHideMenuBar: true,
      });
    }
  });

  it("removes the Windows and Linux application menus and their accelerators", () => {
    const dispatch = (): void => undefined;

    expect(createApplicationMenuTemplate("win32", PRODUCT_NAME, dispatch)).toBeNull();
    expect(createApplicationMenuTemplate("linux", PRODUCT_NAME, dispatch)).toBeNull();
  });

  it("keeps only useful native macOS menu groups", () => {
    const template = createApplicationMenuTemplate("darwin", PRODUCT_NAME, (): void => undefined);

    expect(template?.map((item) => item.label)).toEqual([
      PRODUCT_NAME,
      "Terminal",
      "Edit",
      "Window",
    ]);
    expect(template?.some((item) => ["File", "View", "Help"].includes(item.label ?? ""))).toBe(
      false,
    );

    const editItems = menuItems(template, "Edit");
    expect(editItems.map((item) => item.role)).toEqual(["copy", "paste", "selectAll"]);

    const windowItems = menuItems(template, "Window");
    expect(template?.find((item) => item.label === "Window")?.role).toBe("windowMenu");
    expect(windowItems.map((item) => item.role ?? item.type)).toEqual([
      "minimize",
      "zoom",
      "togglefullscreen",
      "separator",
      "front",
    ]);
  });

  it("routes macOS terminal menu actions through the existing typed shortcut path", () => {
    const actions: AppShortcutAction[] = [];
    const template = createApplicationMenuTemplate("darwin", PRODUCT_NAME, (action) => {
      actions.push(action);
    });
    const terminalItems = menuItems(template, "Terminal");

    clickMenuItem(terminalItems, "New Terminal");
    clickMenuItem(terminalItems, "Close Terminal");
    clickMenuItem(terminalItems, "Previous Terminal");
    clickMenuItem(terminalItems, "Next Terminal");

    expect(actions).toEqual(["newTab", "closeTab", "previousTab", "nextTab"]);
    expect(terminalItems.map((item) => item.accelerator ?? item.type)).toEqual([
      "Command+T",
      "Command+W",
      "separator",
      "Command+Shift+[",
      "Command+Shift+]",
    ]);
  });

  it("opens a new macOS window when New Terminal is used without an existing window", async () => {
    const createWindow = vi.fn(() => Promise.resolve(undefined));

    await dispatchApplicationMenuShortcut("newTab", {
      channel: "terminal:app-shortcut",
      getFocusedWindow: () => null,
      getAllWindows: () => [],
      createWindow,
    });
    await dispatchApplicationMenuShortcut("closeTab", {
      channel: "terminal:app-shortcut",
      getFocusedWindow: () => null,
      getAllWindows: () => [],
      createWindow,
    });

    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});

function menuItems(
  template: MenuItemConstructorOptions[] | null,
  label: string,
): MenuItemConstructorOptions[] {
  const submenu = template?.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(submenu)) {
    throw new Error(`Expected ${label} menu items.`);
  }
  return submenu;
}

function clickMenuItem(items: MenuItemConstructorOptions[], label: string): void {
  const item = items.find((candidate) => candidate.label === label);
  if (!item?.click) {
    throw new Error(`Expected clickable ${label} menu item.`);
  }
  item.click(null as never, null as never, null as never);
}
