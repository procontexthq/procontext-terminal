import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";

import type { AppShortcutAction } from "@terminal/protocol";

export const WINDOW_TITLEBAR_HEIGHT = 44;

export type ApplicationMenuShortcutWindow = {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  webContents: {
    isDestroyed: () => boolean;
    send: (channel: string, action: AppShortcutAction) => void;
  };
};

export type ApplicationMenuShortcutDependencies = {
  channel: string;
  getFocusedWindow: () => ApplicationMenuShortcutWindow | null;
  getAllWindows: () => ApplicationMenuShortcutWindow[];
  createWindow: () => Promise<unknown>;
};

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarOverlay" | "titleBarStyle"
>;

export function resolveWindowChromeOptions(platform: NodeJS.Platform): WindowChromeOptions {
  const options: WindowChromeOptions = {
    titleBarStyle: "hidden",
  };

  if (platform === "darwin") {
    return {
      ...options,
      titleBarOverlay: { height: WINDOW_TITLEBAR_HEIGHT },
    };
  }

  return {
    ...options,
    titleBarOverlay: {
      color: "#00000000",
      symbolColor: "#e8eaed",
      height: WINDOW_TITLEBAR_HEIGHT,
    },
    autoHideMenuBar: true,
  };
}

export function createApplicationMenuTemplate(
  platform: NodeJS.Platform,
  productName: string,
  dispatchShortcut: (action: AppShortcutAction) => void,
): MenuItemConstructorOptions[] | null {
  if (platform !== "darwin") {
    return null;
  }

  return [
    {
      label: productName,
      submenu: [
        { role: "about", label: `About ${productName}` },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        terminalMenuItem("New Terminal", "Command+T", "newTab", dispatchShortcut),
        terminalMenuItem("Close Terminal", "Command+W", "closeTab", dispatchShortcut),
        { type: "separator" },
        terminalMenuItem("Previous Terminal", "Command+Shift+[", "previousTab", dispatchShortcut),
        terminalMenuItem("Next Terminal", "Command+Shift+]", "nextTab", dispatchShortcut),
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }],
    },
    {
      label: "Window",
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
}

export async function dispatchApplicationMenuShortcut(
  action: AppShortcutAction,
  dependencies: ApplicationMenuShortcutDependencies,
): Promise<void> {
  const focusedWindow = dependencies.getFocusedWindow();
  const target = isUsableShortcutWindow(focusedWindow)
    ? focusedWindow
    : action === "newTab"
      ? dependencies.getAllWindows().find(isUsableShortcutWindow)
      : undefined;

  if (target) {
    if (target.isMinimized()) {
      target.restore();
    }
    target.show();
    target.focus();
    target.webContents.send(dependencies.channel, action);
    return;
  }

  if (action === "newTab") {
    await dependencies.createWindow();
  }
}

function terminalMenuItem(
  label: string,
  accelerator: string,
  action: AppShortcutAction,
  dispatchShortcut: (action: AppShortcutAction) => void,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => dispatchShortcut(action),
  };
}

function isUsableShortcutWindow(
  window: ApplicationMenuShortcutWindow | null | undefined,
): window is ApplicationMenuShortcutWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed());
}
