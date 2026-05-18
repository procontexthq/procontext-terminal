import { BrowserWindow, ipcMain } from "electron";

import {
  createRequestId,
  createTerminalError,
  type RendererSessionEvent,
  type RequestId,
  type SessionId,
  type TerminalConfig,
  type TerminalScreenSnapshot,
} from "@terminal/protocol";
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
  const snapshotRequests = new Map<
    RequestId,
    {
      resolve: (snapshot: TerminalScreenSnapshot) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  ipcMain.handle(IPC_CHANNELS.command, async (_event, payload: unknown) =>
    handleRendererCommandPayload(payload, {
      sessionManager,
      requestScreenSnapshot: (sessionId, timeoutMs) =>
        requestScreenSnapshot(snapshotRequests, sessionId, timeoutMs),
      resolveSnapshotResponse: (requestId, snapshot) => {
        const pending = snapshotRequests.get(requestId as RequestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        snapshotRequests.delete(requestId as RequestId);
        pending.resolve(snapshot);
      },
      getConfig,
      saveConfig,
      logger,
    }),
  );

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    broadcastSessionEvent(event);
    switch (event.type) {
      case "session.created":
      case "session.attached":
        logger.info("session", "running", {
          sessionId: event.payload.sessionId,
          shell: event.payload.shell,
          cwd: event.payload.cwd,
          cols: event.payload.cols,
          rows: event.payload.rows,
        });
        break;
      case "session.detached":
        logger.info("session", "detached", {
          sessionId: event.payload.sessionId,
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
      case "session.snapshot.request":
        break;
    }
  });

  return () => {
    unsubscribe();
    for (const [requestId, pending] of snapshotRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Snapshot request ${requestId} was cancelled.`));
    }
    snapshotRequests.clear();
    ipcMain.removeHandler(IPC_CHANNELS.command);
  };
}

function broadcastSessionEvent(event: RendererSessionEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

function requestScreenSnapshot(
  snapshotRequests: Map<
    RequestId,
    {
      resolve: (snapshot: TerminalScreenSnapshot) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >,
  sessionId: SessionId,
  timeoutMs: number,
): Promise<TerminalScreenSnapshot> {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    return Promise.reject(
      createTerminalError("session_snapshot_failed", "No renderer window is available.", {
        sessionId,
        operation: "session.captureScreen",
      }),
    );
  }

  const requestId = createRequestId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      snapshotRequests.delete(requestId);
      reject(
        createTerminalError("wait_timeout", "Timed out waiting for screen snapshot.", {
          sessionId,
          operation: "session.captureScreen",
        }),
      );
    }, timeoutMs);
    snapshotRequests.set(requestId, { resolve, reject, timeout });
    broadcastSessionEvent({
      type: "session.snapshot.request",
      requestId,
      payload: { sessionId },
    });
  });
}
