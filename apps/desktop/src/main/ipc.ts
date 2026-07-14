import { BrowserWindow, ipcMain, type WebContents } from "electron";

import type { TerminalPolicy } from "@terminal/policy-engine";
import type {
  AgentSessionControlState,
  AgentPermissionRequest,
  CloseTerminalRequest,
  CloseTerminalResult,
  PolicyDenialNotice,
  RecordingControlRequest,
  RecordingExportFileResult,
  ResolvePermissionRequest,
  RendererSessionEvent,
  SessionId,
  TerminalConfig,
} from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import type { TerminalPresentationRegistry } from "./presentation-registry";
import type { TerminalPresentationController } from "./presentation-controller";
import { handleRendererCommandPayload } from "./terminal-command-handler";

export const IPC_CHANNELS = {
  command: "terminal.command",
  event: "session.event",
  appShortcut: "app.shortcut",
} as const;

export function registerTerminalIpc({
  sessionManager,
  presentationRegistry,
  presentationController,
  policy,
  logger,
  closeSession,
  getConfig,
  saveConfig,
  listAgentControls,
  revokeAgentControl,
  allowAgentControl,
  exportRecordingFile,
  listPermissions,
  resolvePermission,
  onPolicyDenied,
  onRendererUnavailable,
  onSessionRemoved,
}: {
  sessionManager: TerminalSessionManager;
  presentationRegistry: TerminalPresentationRegistry;
  presentationController: TerminalPresentationController;
  policy: TerminalPolicy;
  logger: AppLogger;
  closeSession: (request: CloseTerminalRequest) => Promise<CloseTerminalResult>;
  getConfig: () => TerminalConfig;
  saveConfig: (config: TerminalConfig) => Promise<TerminalConfig>;
  listAgentControls: () => AgentSessionControlState[];
  revokeAgentControl: (sessionId: SessionId) => AgentSessionControlState;
  allowAgentControl: (sessionId: SessionId) => AgentSessionControlState;
  exportRecordingFile: (request: RecordingControlRequest) => Promise<RecordingExportFileResult>;
  listPermissions: () => AgentPermissionRequest[];
  resolvePermission: (request: ResolvePermissionRequest) => boolean;
  onPolicyDenied?: (notice: PolicyDenialNotice) => void;
  onRendererUnavailable?: () => void;
  onSessionRemoved?: (sessionId: SessionId) => void;
}): () => void {
  const trackedRendererIds = new Set<number>();
  ipcMain.handle(IPC_CHANNELS.command, async (event, payload: unknown) => {
    trackRendererCleanup({
      sender: event.sender,
      trackedRendererIds,
      presentationRegistry,
      presentationController,
      sessionManager,
      logger,
      onRendererUnavailable,
    });
    return handleRendererCommandPayload(payload, {
      sessionManager,
      presentationRegistry,
      presentationController,
      rendererId: event.sender.id,
      closeSession,
      getConfig,
      saveConfig,
      listAgentControls,
      revokeAgentControl,
      allowAgentControl,
      exportRecordingFile,
      listPermissions,
      resolvePermission,
      onPolicyDenied,
      policy,
      logger,
    });
  });

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    if (event.type === "session.removed") onSessionRemoved?.(event.payload.sessionId);
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

export function hasAvailableRenderer(): boolean {
  return BrowserWindow.getAllWindows().some(isUsableRendererWindow);
}

function trackRendererCleanup({
  sender,
  trackedRendererIds,
  presentationRegistry,
  presentationController,
  sessionManager,
  logger,
  onRendererUnavailable,
}: {
  sender: WebContents;
  trackedRendererIds: Set<number>;
  presentationRegistry: TerminalPresentationRegistry;
  presentationController: TerminalPresentationController;
  sessionManager: TerminalSessionManager;
  logger: Pick<AppLogger, "warn">;
  onRendererUnavailable?: () => void;
}): void {
  if (trackedRendererIds.has(sender.id)) return;
  const rendererId = sender.id;
  trackedRendererIds.add(rendererId);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    trackedRendererIds.delete(rendererId);
    presentationController.rendererUnavailable(rendererId);
    for (const sessionId of presentationRegistry.removeRenderer(rendererId)) {
      void setHeadlessIfPresent(sessionManager, sessionId, logger);
    }
    onRendererUnavailable?.();
  };
  sender.once("destroyed", cleanup);
  sender.once("render-process-gone", cleanup);
}

async function setHeadlessIfPresent(
  manager: TerminalSessionManager,
  sessionId: SessionId,
  logger: Pick<AppLogger, "warn">,
): Promise<void> {
  try {
    await manager.setPresentation(sessionId, {
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
    case "session.removed":
      logger.info("session", "removed", { sessionId: event.payload.sessionId });
      break;
    case "session.bell":
      logger.info("session", "bell", { sessionId: event.payload.sessionId });
      break;
    case "session.output":
    case "session.viewport":
    case "agent.activity":
    case "agent.control.changed":
    case "policy.denied":
    case "permission.requested":
    case "permission.resolved":
    case "presentation.command":
      break;
  }
}

function isUsableRendererWindow(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}
