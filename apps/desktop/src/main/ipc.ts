import { BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";

import {
  createRequestId,
  createTerminalError,
  type RendererSessionEvent,
  type RequestId,
  type SessionId,
  type TerminalConfig,
  type TerminalScreenSnapshot,
} from "@terminal/protocol";
import type { TerminalPolicy } from "@terminal/policy-engine";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import { handleRendererCommandPayload } from "./terminal-command-handler";

export const IPC_CHANNELS = {
  command: "terminal.command",
  event: "session.event",
} as const;

export type ScreenSnapshotService = {
  requestScreenSnapshot(sessionId: SessionId, timeoutMs: number): Promise<TerminalScreenSnapshot>;
  resolveSnapshotResponse(requestId: RequestId, snapshot: TerminalScreenSnapshot): void;
  rejectSnapshotResponse(requestId: RequestId, sessionId: SessionId, reason: string): void;
  registerRendererSession(sessionId: SessionId, rendererId: number): void;
  unregisterRendererSession(sessionId: SessionId, rendererId: number): void;
  unregisterRenderer(rendererId: number): SessionId[];
  unregisterSession(sessionId: SessionId): void;
  dispose(): void;
};

type ScreenSnapshotRequestEvent = Extract<
  RendererSessionEvent,
  { type: "session.snapshot.request" }
>;

export type ScreenSnapshotServiceOptions = {
  getRendererCount?: () => number;
  sendSnapshotRequest?: (
    event: ScreenSnapshotRequestEvent,
    rendererIds: ReadonlySet<number>,
  ) => void;
};

export function registerTerminalIpc(
  sessionManager: TerminalSessionManager,
  policy: TerminalPolicy,
  logger: AppLogger,
  getConfig: () => TerminalConfig,
  saveConfig: (config: TerminalConfig) => Promise<TerminalConfig>,
  screenSnapshotService: ScreenSnapshotService = createScreenSnapshotService(),
): () => void {
  const trackedRendererIds = new Set<number>();

  ipcMain.handle(IPC_CHANNELS.command, async (event, payload: unknown) => {
    const rendererId = event.sender.id;
    trackRendererCleanup({
      sender: event.sender,
      trackedRendererIds,
      screenSnapshotService,
      sessionManager,
      logger,
    });
    return handleRendererCommandPayload(payload, {
      sessionManager,
      requestScreenSnapshot: (sessionId, timeoutMs) =>
        screenSnapshotService.requestScreenSnapshot(sessionId, timeoutMs),
      resolveSnapshotResponse: (requestId, snapshot) =>
        screenSnapshotService.resolveSnapshotResponse(requestId, snapshot),
      rejectSnapshotResponse: (requestId, sessionId, reason) =>
        screenSnapshotService.rejectSnapshotResponse(requestId, sessionId, reason),
      registerRendererSession: (sessionId) =>
        screenSnapshotService.registerRendererSession(sessionId, rendererId),
      unregisterRendererSession: (sessionId) =>
        screenSnapshotService.unregisterRendererSession(sessionId, rendererId),
      getConfig,
      saveConfig,
      policy,
      logger,
    });
  });

  const unsubscribe = sessionManager.onSessionEvent((event) => {
    broadcastRendererEvent(event);
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
        screenSnapshotService.unregisterSession(event.payload.sessionId);
        logger.info("session", "detached", {
          sessionId: event.payload.sessionId,
        });
        break;
      case "session.exited":
        screenSnapshotService.unregisterSession(event.payload.sessionId);
        logger.info("session", "exited", {
          sessionId: event.payload.sessionId,
          exitCode: event.payload.exitCode,
          signal: event.payload.signal,
        });
        break;
      case "session.error":
        if (event.payload.type === "session_not_found" && event.payload.sessionId) {
          screenSnapshotService.unregisterSession(event.payload.sessionId);
        }
        logger.error("session", "error", {
          sessionId: event.payload.sessionId,
          errorType: event.payload.type,
          cause: event.payload.cause,
        });
        break;
      case "session.title":
        logger.info("session", "title_changed", {
          sessionId: event.payload.sessionId,
        });
        break;
      case "session.bell":
        logger.info("session", "bell", {
          sessionId: event.payload.sessionId,
        });
        break;
      case "session.output":
      case "session.snapshot.request":
        break;
    }
  });

  return () => {
    unsubscribe();
    screenSnapshotService.dispose();
    ipcMain.removeHandler(IPC_CHANNELS.command);
  };
}

export function broadcastRendererEvent(event: RendererSessionEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isUsableRendererWindow(window)) {
      continue;
    }
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

export function createScreenSnapshotService(
  options: ScreenSnapshotServiceOptions = {},
): ScreenSnapshotService {
  const snapshotRequests = new Map<
    RequestId,
    {
      sessionId: SessionId;
      resolve: (snapshot: TerminalScreenSnapshot) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const rendererSessions = new Map<SessionId, Set<number>>();
  const getRendererCount =
    options.getRendererCount ??
    (() => BrowserWindow.getAllWindows().filter(isUsableRendererWindow).length);
  const sendSnapshotRequest = options.sendSnapshotRequest ?? sendSnapshotRequestToRenderers;

  return {
    requestScreenSnapshot(sessionId, timeoutMs) {
      return requestScreenSnapshot({
        snapshotRequests,
        rendererSessions,
        getRendererCount,
        sendSnapshotRequest,
        sessionId,
        timeoutMs,
      });
    },
    resolveSnapshotResponse(requestId, snapshot) {
      const pending = snapshotRequests.get(requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      snapshotRequests.delete(requestId);
      if (pending.sessionId !== snapshot.sessionId) {
        pending.reject(
          createTerminalError(
            "session_snapshot_failed",
            "Renderer returned a snapshot for the wrong session.",
            {
              sessionId: pending.sessionId,
              operation: "session.captureScreen",
              cause: "Snapshot response session mismatch.",
            },
          ),
        );
        return;
      }
      pending.resolve(snapshot);
    },
    rejectSnapshotResponse(requestId, sessionId, reason) {
      const pending = snapshotRequests.get(requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      snapshotRequests.delete(requestId);
      if (pending.sessionId !== sessionId) {
        pending.reject(
          createTerminalError(
            "session_snapshot_failed",
            "Renderer reported snapshot unavailability for the wrong session.",
            {
              sessionId: pending.sessionId,
              operation: "session.captureScreen",
              cause: "Snapshot unavailable session mismatch.",
            },
          ),
        );
        return;
      }
      pending.reject(
        createTerminalError("observation_unavailable", "Renderer snapshot is unavailable.", {
          sessionId: pending.sessionId,
          operation: "session.captureScreen",
          cause: reason,
        }),
      );
    },
    registerRendererSession(sessionId, rendererId) {
      const rendererIds = rendererSessions.get(sessionId) ?? new Set<number>();
      rendererIds.add(rendererId);
      rendererSessions.set(sessionId, rendererIds);
    },
    unregisterRendererSession(sessionId, rendererId) {
      const rendererIds = rendererSessions.get(sessionId);
      if (!rendererIds) {
        return;
      }
      rendererIds.delete(rendererId);
      if (rendererIds.size === 0) {
        rendererSessions.delete(sessionId);
      }
    },
    unregisterRenderer(rendererId) {
      const orphanedSessionIds: SessionId[] = [];
      for (const [sessionId, rendererIds] of rendererSessions) {
        rendererIds.delete(rendererId);
        if (rendererIds.size === 0) {
          rendererSessions.delete(sessionId);
          orphanedSessionIds.push(sessionId);
          rejectSnapshotRequestsForSession(
            snapshotRequests,
            sessionId,
            "No renderer owns the requested session.",
          );
        }
      }
      return orphanedSessionIds;
    },
    unregisterSession(sessionId) {
      rendererSessions.delete(sessionId);
      rejectSnapshotRequestsForSession(
        snapshotRequests,
        sessionId,
        "No renderer owns the requested session.",
      );
    },
    dispose() {
      for (const [requestId, pending] of snapshotRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Snapshot request ${requestId} was cancelled.`));
      }
      snapshotRequests.clear();
      rendererSessions.clear();
    },
  };
}

function requestScreenSnapshot({
  snapshotRequests,
  rendererSessions,
  getRendererCount,
  sendSnapshotRequest,
  sessionId,
  timeoutMs,
}: {
  snapshotRequests: Map<
    RequestId,
    {
      sessionId: SessionId;
      resolve: (snapshot: TerminalScreenSnapshot) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
  rendererSessions: Map<SessionId, Set<number>>;
  getRendererCount: () => number;
  sendSnapshotRequest: (
    event: ScreenSnapshotRequestEvent,
    rendererIds: ReadonlySet<number>,
  ) => void;
  sessionId: SessionId;
  timeoutMs: number;
}): Promise<TerminalScreenSnapshot> {
  if (getRendererCount() === 0) {
    return Promise.reject(
      createTerminalError("observation_unavailable", "No renderer window is available.", {
        sessionId,
        operation: "session.captureScreen",
      }),
    );
  }

  const rendererIds = rendererSessions.get(sessionId);
  if (!rendererIds || rendererIds.size === 0) {
    return Promise.reject(
      createTerminalError("observation_unavailable", "No renderer owns the requested session.", {
        sessionId,
        operation: "session.captureScreen",
        cause: "No renderer owns the requested session.",
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
    snapshotRequests.set(requestId, { sessionId, resolve, reject, timeout });
    sendSnapshotRequest(
      {
        type: "session.snapshot.request",
        requestId,
        payload: { sessionId },
      },
      rendererIds,
    );
  });
}

function sendSnapshotRequestToRenderers(
  event: ScreenSnapshotRequestEvent,
  rendererIds: ReadonlySet<number>,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!isUsableRendererWindow(window)) {
      continue;
    }
    if (rendererIds.has(window.webContents.id)) {
      window.webContents.send(IPC_CHANNELS.event, event);
    }
  }
}

function rejectSnapshotRequestsForSession(
  snapshotRequests: Map<
    RequestId,
    {
      sessionId: SessionId;
      resolve: (snapshot: TerminalScreenSnapshot) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >,
  sessionId: SessionId,
  reason: string,
): void {
  for (const [requestId, pending] of snapshotRequests) {
    if (pending.sessionId !== sessionId) {
      continue;
    }
    clearTimeout(pending.timeout);
    snapshotRequests.delete(requestId);
    pending.reject(
      createTerminalError("observation_unavailable", "Renderer snapshot is unavailable.", {
        sessionId,
        operation: "session.captureScreen",
        cause: reason,
      }),
    );
  }
}

export function detachOrphanedRendererSessions({
  sessionIds,
  sessionManager,
  rendererId,
  logger,
}: {
  sessionIds: readonly SessionId[];
  sessionManager: Pick<TerminalSessionManager, "getSession" | "detachSession">;
  rendererId: number;
  logger: Pick<AppLogger, "warn">;
}): void {
  for (const sessionId of sessionIds) {
    try {
      const snapshot = sessionManager.getSession({ sessionId });
      if (snapshot.state !== "running") {
        continue;
      }
      sessionManager.detachSession({ sessionId });
    } catch (error: unknown) {
      logger.warn("session", "renderer_orphan_detach_failed", {
        rendererId,
        sessionId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function cleanupRendererOwnership({
  screenSnapshotService,
  sessionManager,
  rendererId,
  logger,
}: {
  screenSnapshotService: Pick<ScreenSnapshotService, "unregisterRenderer">;
  sessionManager: Pick<TerminalSessionManager, "getSession" | "detachSession">;
  rendererId: number;
  logger: Pick<AppLogger, "warn">;
}): void {
  const orphanedSessionIds = screenSnapshotService.unregisterRenderer(rendererId);
  detachOrphanedRendererSessions({
    sessionIds: orphanedSessionIds,
    sessionManager,
    rendererId,
    logger,
  });
}

function trackRendererCleanup({
  sender,
  trackedRendererIds,
  screenSnapshotService,
  sessionManager,
  logger,
}: {
  sender: WebContents;
  trackedRendererIds: Set<number>;
  screenSnapshotService: ScreenSnapshotService;
  sessionManager: Pick<TerminalSessionManager, "getSession" | "detachSession">;
  logger: Pick<AppLogger, "warn">;
}): void {
  if (trackedRendererIds.has(sender.id)) {
    return;
  }

  const rendererId = sender.id;
  trackedRendererIds.add(rendererId);
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    trackedRendererIds.delete(rendererId);
    cleanupRendererOwnership({
      screenSnapshotService,
      sessionManager,
      rendererId,
      logger,
    });
  };
  sender.once("destroyed", cleanup);
  sender.once("render-process-gone", cleanup);
}

function isUsableRendererWindow(window: BrowserWindow): boolean {
  if (window.isDestroyed()) {
    return false;
  }
  const { webContents } = window;
  if (webContents.isDestroyed()) {
    return false;
  }
  if (webContents.isCrashed()) {
    return false;
  }
  return true;
}
