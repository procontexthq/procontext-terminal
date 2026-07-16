import type { TerminalSessionManager, TerminalSessionShutdownResult } from "@terminal/session-core";

import type { AppLogger } from "./logger";

type WindowCloseEvent = {
  preventDefault(): void;
};

type ManagedWindow = {
  readonly id: number;
  on(event: "close", handler: (event: WindowCloseEvent) => void): void;
  isDestroyed(): boolean;
  destroy(): void;
};

export type WindowCloseSessionManager = Pick<TerminalSessionManager, "listSessions" | "shutdown">;

export type AttachWindowCloseSessionCleanupOptions = {
  window: ManagedWindow;
  sessionManager: WindowCloseSessionManager;
  logger: Pick<AppLogger, "info" | "warn" | "error">;
  getIsAppQuitting: () => boolean;
  shutdownTimeoutMs: number;
  sessionLifecycle: "preserve" | "terminate";
};

export function attachWindowCloseSessionCleanup({
  window,
  sessionManager,
  logger,
  getIsAppQuitting,
  shutdownTimeoutMs,
  sessionLifecycle,
}: AttachWindowCloseSessionCleanupOptions): void {
  if (sessionLifecycle === "preserve") return;

  let cleanupInProgress = false;
  let cleanupComplete = false;

  window.on("close", (event) => {
    if (cleanupComplete || getIsAppQuitting()) {
      return;
    }

    const sessionCount = sessionManager.listSessions().length;
    if (sessionCount === 0) {
      return;
    }

    event.preventDefault();
    if (cleanupInProgress) {
      return;
    }

    cleanupInProgress = true;
    logger.info("window", "close_session_cleanup_started", {
      windowId: window.id,
      sessionCount,
      timeoutMs: shutdownTimeoutMs,
    });
    void sessionManager
      .shutdown({ timeoutMs: shutdownTimeoutMs })
      .then((result) => {
        cleanupInProgress = false;
        handleCleanupResult({
          window,
          logger,
          result,
        });
        if (result.timedOut > 0) {
          return;
        }

        cleanupComplete = true;
        if (!window.isDestroyed()) {
          window.destroy();
        }
      })
      .catch((error: unknown) => {
        cleanupInProgress = false;
        logger.error("window", "close_session_cleanup_failed", {
          windowId: window.id,
          cause: error instanceof Error ? error.message : String(error),
        });
      });
  });
}

function handleCleanupResult({
  window,
  logger,
  result,
}: {
  window: Pick<ManagedWindow, "id">;
  logger: Pick<AppLogger, "info" | "warn">;
  result: TerminalSessionShutdownResult;
}): void {
  logger.info("window", "close_session_cleanup_completed", {
    windowId: window.id,
    terminated: result.terminated,
    timedOut: result.timedOut,
  });

  if (result.timedOut > 0) {
    logger.warn("window", "close_session_cleanup_timed_out", {
      windowId: window.id,
      timedOut: result.timedOut,
    });
  }
}
