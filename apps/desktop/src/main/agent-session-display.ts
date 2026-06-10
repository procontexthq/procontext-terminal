import { createTerminalError, type TerminalSessionSnapshot } from "@terminal/protocol";

import type { AppLogger } from "./logger";

export type AgentSessionDisplayService = {
  displaySession(snapshot: TerminalSessionSnapshot): Promise<void>;
};

type AgentSessionDisplayWindow = {
  isDestroyed?(): boolean;
  webContents?: {
    isDestroyed?(): boolean;
    isCrashed?(): boolean;
  };
};

export function createAgentSessionDisplayService({
  getWindows,
  createWindow,
  logger,
  windowCreationTimeoutMs = 5000,
}: {
  getWindows: () => readonly AgentSessionDisplayWindow[];
  createWindow: () => Promise<unknown>;
  logger: Pick<AppLogger, "info" | "warn">;
  windowCreationTimeoutMs?: number;
}): AgentSessionDisplayService {
  let pendingWindowCreation: Promise<unknown> | null = null;

  async function ensureRendererWindow(sessionId: TerminalSessionSnapshot["sessionId"]) {
    if (hasUsableWindow(getWindows())) {
      return;
    }

    logger.info("agent", "display_window_create_requested", { sessionId });
    pendingWindowCreation ??= createWindow();

    try {
      await withTimeout(pendingWindowCreation, windowCreationTimeoutMs);
    } catch (error: unknown) {
      throw createTerminalError("observation_unavailable", "Renderer window is unavailable.", {
        sessionId,
        operation: "terminal.display",
        cause: errorMessage(error),
      });
    } finally {
      pendingWindowCreation = null;
    }

    if (!hasUsableWindow(getWindows())) {
      throw createTerminalError("observation_unavailable", "Renderer window is unavailable.", {
        sessionId,
        operation: "terminal.display",
        cause: "Window creation completed without a usable renderer window.",
      });
    }
  }

  return {
    async displaySession(snapshot) {
      try {
        await ensureRendererWindow(snapshot.sessionId);
      } catch (error: unknown) {
        const terminalError = createTerminalError(
          "observation_unavailable",
          "Renderer window is unavailable.",
          {
            sessionId: snapshot.sessionId,
            operation: "terminal.display",
            cause: errorMessage(error),
          },
        );
        logger.warn("agent", "display_window_unavailable", {
          sessionId: snapshot.sessionId,
          errorType: terminalError.type,
          cause: terminalError.cause,
        });
        throw terminalError;
      }

      logger.info("agent", "display_requested", { sessionId: snapshot.sessionId });
    },
  };
}

function hasUsableWindow(windows: readonly AgentSessionDisplayWindow[]): boolean {
  return windows.some((window) => {
    if (window.isDestroyed?.()) {
      return false;
    }
    if (window.webContents?.isDestroyed?.()) {
      return false;
    }
    if (window.webContents?.isCrashed?.()) {
      return false;
    }
    return true;
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (typeof cause === "string") {
      return cause;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<TValue>(promise: Promise<TValue>, timeoutMs: number): Promise<TValue> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms while creating a renderer window.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
