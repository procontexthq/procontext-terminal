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
  saveConfig: (config: TerminalConfig) => Promise<TerminalConfig>,
): () => void {
  ipcMain.handle(IPC_CHANNELS.command, async (_event, payload: unknown) =>
    handleRendererCommandPayload(payload, {
      sessionManager,
      getConfig,
      saveConfig,
      logger,
    }),
  );

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    broadcastSessionEvent(event);
    switch (event.type) {
      case "session.created":
        logger.info("session", "running", {
          sessionId: event.payload.sessionId,
          shell: event.payload.shell,
          cwd: event.payload.cwd,
          cols: event.payload.cols,
          rows: event.payload.rows,
        });
        break;
      case "session.exited":
        logger.info("session", "exited", {
          sessionId: event.payload.sessionId,
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
        });
        break;
      case "session.error":
        logger.error("session", "error", {
          sessionId: event.payload.sessionId,
          errorType: event.payload.type,
          cause: event.payload.cause,
        });
        break;
      case "session.output":
        break;
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
