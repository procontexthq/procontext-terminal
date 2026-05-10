import { BrowserWindow, ipcMain } from "electron";

import type { RendererSessionEvent, TerminalConfig } from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import { handleRendererCommandPayload } from "./terminal-command-handler";

export const IPC_CHANNELS = {
  command: "terminal.command",
  event: "session.event",
} as const;

export function registerTerminalIpc(
  sessionManager: TerminalSessionManager,
  logger: AppLogger,
  getConfig: () => TerminalConfig,
): () => void {
  ipcMain.handle(IPC_CHANNELS.command, async (_event, payload: unknown) =>
    handleRendererCommandPayload(payload, {
      sessionManager,
      getConfig,
    }),
  );

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    broadcastSessionEvent(event);
    if (event.type === "session.error") {
      logger.error("session", "session.error", {
        sessionId: event.payload.sessionId,
        errorType: event.payload.type,
      });
    }
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC_CHANNELS.command);
  };
}

function broadcastSessionEvent(event: RendererSessionEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}
