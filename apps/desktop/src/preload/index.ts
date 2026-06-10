import { contextBridge, ipcRenderer } from "electron";

import { createRendererTerminalApi } from "./terminal-api";

const channels = {
  command: "terminal.command",
  event: "session.event",
  appShortcut: "app.shortcut",
} as const;

const terminalApi = createRendererTerminalApi({
  invoke: (command) => ipcRenderer.invoke(channels.command, command),
  subscribe: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload);
    };
    ipcRenderer.on(channels.event, listener);
    return () => ipcRenderer.removeListener(channels.event, listener);
  },
  subscribeAppShortcut: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      handler(payload);
    };
    ipcRenderer.on(channels.appShortcut, listener);
    return () => ipcRenderer.removeListener(channels.appShortcut, listener);
  },
});

contextBridge.exposeInMainWorld("terminalApi", terminalApi);
