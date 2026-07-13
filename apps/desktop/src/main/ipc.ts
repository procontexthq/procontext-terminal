import { BrowserWindow, ipcMain, type WebContents } from "electron";

import type { TerminalPolicy } from "@terminal/policy-engine";
import type { RendererSessionEvent, SessionId, TerminalConfig } from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import type { TerminalPresentationRegistry } from "./presentation-registry";
import { handleRendererCommandPayload } from "./terminal-command-handler";

export const IPC_CHANNELS = {
  command: "terminal.command",
  event: "session.event",
  appShortcut: "app.shortcut",
} as const;

export function registerTerminalIpc({
  sessionManager,
  presentationRegistry,
  policy,
  logger,
  getConfig,
  saveConfig,
}: {
  sessionManager: TerminalSessionManager;
  presentationRegistry: TerminalPresentationRegistry;
  policy: TerminalPolicy;
  logger: AppLogger;
  getConfig: () => TerminalConfig;
  saveConfig: (config: TerminalConfig) => Promise<TerminalConfig>;
}): () => void {
  const trackedRendererIds = new Set<number>();
  ipcMain.handle(IPC_CHANNELS.command, async (event, payload: unknown) => {
    trackRendererCleanup({
      sender: event.sender,
      trackedRendererIds,
      presentationRegistry,
      sessionManager,
      logger,
    });
    return handleRendererCommandPayload(payload, {
      sessionManager,
      presentationRegistry,
      rendererId: event.sender.id,
      getConfig,
      saveConfig,
      policy,
      logger,
    });
  });

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    broadcastRendererEvent(event);
    logSessionEvent(event, logger);
  });

  return () => {
    unsubscribe();
    ipcMain.removeHandler(IPC_CHANNELS.command);
  };
}

export function broadcastRendererEvent(event: RendererSessionEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isUsableRendererWindow(window)) {
      window.webContents.send(IPC_CHANNELS.event, event);
    }
  }
}

function trackRendererCleanup({
  sender,
  trackedRendererIds,
  presentationRegistry,
  sessionManager,
  logger,
}: {
  sender: WebContents;
  trackedRendererIds: Set<number>;
  presentationRegistry: TerminalPresentationRegistry;
  sessionManager: TerminalSessionManager;
  logger: Pick<AppLogger, "warn">;
}): void {
  if (trackedRendererIds.has(sender.id)) return;
  const rendererId = sender.id;
  trackedRendererIds.add(rendererId);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    trackedRendererIds.delete(rendererId);
    for (const sessionId of presentationRegistry.removeRenderer(rendererId)) {
      setHeadlessIfPresent(sessionManager, sessionId, logger);
    }
  };
  sender.once("destroyed", cleanup);
  sender.once("render-process-gone", cleanup);
}

function setHeadlessIfPresent(
  manager: TerminalSessionManager,
  sessionId: SessionId,
  logger: Pick<AppLogger, "warn">,
): void {
  try {
    manager.setPresentation(sessionId, {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });
  } catch (error: unknown) {
    logger.warn("session", "renderer_cleanup_failed", {
      sessionId,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function logSessionEvent(event: RendererSessionEvent, logger: AppLogger): void {
  switch (event.type) {
    case "session.updated":
      logger.info("session", "updated", {
        sessionId: event.payload.sessionId,
        lifecycle: event.payload.lifecycle,
      });
      break;
    case "session.error":
      logger.error("session", "error", {
        sessionId: event.payload.sessionId,
        errorType: event.payload.type,
        cause: event.payload.cause,
      });
      break;
    case "session.bell":
      logger.info("session", "bell", { sessionId: event.payload.sessionId });
      break;
    case "session.output":
    case "session.viewport":
    case "agent.activity":
      break;
  }
}

function isUsableRendererWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}
