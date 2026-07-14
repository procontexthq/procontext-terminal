import {
  createRequestId,
  createTerminalError,
  type RendererPresentationAcknowledgement,
  type RendererPresentationAction,
  type RendererPresentationCommand,
  type RequestId,
  type SessionId,
  type SetTerminalPresentationRequest,
  type TerminalPresentation,
} from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import type { TerminalPresentationRegistry } from "./presentation-registry";

export type PresentationWindow = {
  readonly id: number;
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
    isCrashed(): boolean;
    send(channel: string, event: unknown): void;
  };
  isDestroyed(): boolean;
  isVisible(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

type PresentationSessions = Pick<TerminalSessionManager, "getSession" | "setPresentation">;

type PendingCommand = {
  rendererId: number;
  command: RendererPresentationCommand;
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ReadyWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type TerminalPresentationController = {
  setPresentation(request: SetTerminalPresentationRequest): Promise<TerminalPresentation>;
  closeView(sessionId: SessionId): Promise<void>;
  rendererReady(rendererId: number): void;
  acknowledge(rendererId: number, acknowledgement: RendererPresentationAcknowledgement): void;
  rendererUnavailable(rendererId: number): void;
};

export function createTerminalPresentationController({
  sessions,
  registry,
  getWindows,
  createWindow,
  logger,
  commandTimeoutMs = 5_000,
  createCommandId = createRequestId,
}: {
  sessions: PresentationSessions;
  registry: TerminalPresentationRegistry;
  getWindows: () => readonly PresentationWindow[];
  createWindow: (options: { show: boolean }) => Promise<PresentationWindow>;
  logger: Pick<AppLogger, "info" | "warn">;
  commandTimeoutMs?: number;
  createCommandId?: () => RequestId;
}): TerminalPresentationController {
  const readyRenderers = new Set<number>();
  const readyWaiters = new Map<number, Set<ReadyWaiter>>();
  const pendingCommands = new Map<RequestId, PendingCommand>();
  let pendingWindowCreation: Promise<PresentationWindow> | null = null;

  return {
    async setPresentation(request) {
      const session = sessions.getSession({ sessionId: request.sessionId });
      const ownerId = registry.rendererIdFor(request.sessionId);
      if (
        request.presentation === "headless" &&
        session.presentation.state === "headless" &&
        ownerId === undefined
      ) {
        return session.presentation;
      }
      if (
        request.presentation === "background" &&
        session.presentation.state === request.presentation &&
        ownerId !== undefined
      ) {
        return session.presentation;
      }

      await sessions.setPresentation(request.sessionId, {
        state: "opening",
        windowVisible:
          ownerId === undefined ? false : (windowForRenderer(ownerId)?.isVisible() ?? false),
        windowFocused:
          ownerId === undefined ? false : (windowForRenderer(ownerId)?.isFocused() ?? false),
      });

      try {
        if (request.presentation === "headless") {
          if (ownerId !== undefined) {
            const ownerWindow = requireWindowForRenderer(ownerId, request.sessionId);
            await requestRenderer(ownerWindow, request.sessionId, "hide");
          }
          const presentation = headlessPresentation();
          await sessions.setPresentation(request.sessionId, presentation);
          return presentation;
        }

        let window =
          ownerId === undefined
            ? await ensureRendererWindow(request.sessionId, request.presentation)
            : requireWindowForRenderer(ownerId, request.sessionId);
        await waitForRenderer(window.webContents.id, request.sessionId);

        if (ownerId === undefined) {
          await requestRenderer(window, request.sessionId, "open");
          const openedRendererId = registry.rendererIdFor(request.sessionId);
          if (openedRendererId === undefined) {
            throw presentationError(
              request.sessionId,
              "Renderer acknowledged opening without registering a terminal view.",
            );
          }
          window = requireWindowForRenderer(openedRendererId, request.sessionId);
        } else if (request.presentation === "background") {
          await requestRenderer(window, request.sessionId, "open");
        }

        if (request.presentation === "foreground") {
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          await requestRenderer(window, request.sessionId, "focus");
        }

        const presentation: TerminalPresentation = {
          state: request.presentation,
          windowVisible: window.isVisible(),
          windowFocused: window.isFocused(),
        };
        await sessions.setPresentation(request.sessionId, presentation);
        return presentation;
      } catch (error: unknown) {
        const window = registry.rendererIdFor(request.sessionId);
        const owningWindow = window === undefined ? undefined : windowForRenderer(window);
        const unavailable: TerminalPresentation = {
          state: "unavailable",
          windowVisible: owningWindow?.isVisible() ?? false,
          windowFocused: owningWindow?.isFocused() ?? false,
        };
        await sessions.setPresentation(request.sessionId, unavailable);
        logger.warn("presentation", "transition_unavailable", {
          sessionId: request.sessionId,
          requestedPresentation: request.presentation,
          cause: errorMessage(error),
        });
        return unavailable;
      }
    },

    async closeView(sessionId) {
      const rendererId = registry.rendererIdFor(sessionId);
      if (rendererId === undefined) return;
      try {
        await requestRenderer(requireWindowForRenderer(rendererId, sessionId), sessionId, "close");
      } catch (error: unknown) {
        logger.warn("presentation", "close_unavailable", {
          sessionId,
          cause: errorMessage(error),
        });
        registry.removeSession(sessionId);
      }
    },

    rendererReady(rendererId) {
      readyRenderers.add(rendererId);
      const waiters = readyWaiters.get(rendererId);
      if (!waiters) return;
      readyWaiters.delete(rendererId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve();
      }
    },

    acknowledge(rendererId, acknowledgement) {
      const pending = pendingCommands.get(acknowledgement.commandId);
      if (
        !pending ||
        pending.rendererId !== rendererId ||
        pending.command.sessionId !== acknowledgement.sessionId ||
        pending.command.action !== acknowledgement.action
      ) {
        return;
      }
      pendingCommands.delete(acknowledgement.commandId);
      clearTimeout(pending.timeout);
      if (acknowledgement.status === "completed") {
        pending.resolve();
      } else {
        pending.reject(
          presentationError(
            acknowledgement.sessionId,
            acknowledgement.message ?? `Renderer failed to ${acknowledgement.action} the view.`,
          ),
        );
      }
    },

    rendererUnavailable(rendererId) {
      readyRenderers.delete(rendererId);
      const waiters = readyWaiters.get(rendererId);
      if (waiters) {
        readyWaiters.delete(rendererId);
        for (const waiter of waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error("Renderer became unavailable."));
        }
      }
      for (const [commandId, pending] of pendingCommands) {
        if (pending.rendererId !== rendererId) continue;
        pendingCommands.delete(commandId);
        clearTimeout(pending.timeout);
        pending.reject(new Error("Renderer became unavailable."));
      }
    },
  };

  async function ensureRendererWindow(
    sessionId: SessionId,
    presentation: "background" | "foreground",
  ): Promise<PresentationWindow> {
    const existing = getWindows().find(isUsableWindow);
    if (existing) return existing;
    pendingWindowCreation ??= createWindow({ show: presentation === "foreground" });
    try {
      const window = await pendingWindowCreation;
      if (!isUsableWindow(window)) {
        throw presentationError(sessionId, "Window creation did not produce a usable renderer.");
      }
      return window;
    } finally {
      pendingWindowCreation = null;
    }
  }

  function requestRenderer(
    window: PresentationWindow,
    sessionId: SessionId,
    action: RendererPresentationAction,
  ): Promise<void> {
    const command: RendererPresentationCommand = {
      commandId: createCommandId(),
      sessionId,
      action,
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCommands.delete(command.commandId);
        reject(presentationError(sessionId, `Renderer ${action} acknowledgement timed out.`));
      }, commandTimeoutMs);
      pendingCommands.set(command.commandId, {
        rendererId: window.webContents.id,
        command,
        resolve,
        reject,
        timeout,
      });
      window.webContents.send("session.event", {
        type: "presentation.command",
        payload: command,
      });
    });
  }

  function waitForRenderer(rendererId: number, sessionId: SessionId): Promise<void> {
    if (readyRenderers.has(rendererId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = readyWaiters.get(rendererId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) readyWaiters.delete(rendererId);
        reject(presentationError(sessionId, "Renderer readiness timed out."));
      }, commandTimeoutMs);
      const waiter: ReadyWaiter = { resolve, reject, timeout };
      const waiters = readyWaiters.get(rendererId) ?? new Set<ReadyWaiter>();
      waiters.add(waiter);
      readyWaiters.set(rendererId, waiters);
    });
  }

  function requireWindowForRenderer(rendererId: number, sessionId: SessionId): PresentationWindow {
    const window = windowForRenderer(rendererId);
    if (!window) throw presentationError(sessionId, "Renderer window is unavailable.");
    return window;
  }

  function windowForRenderer(rendererId: number): PresentationWindow | undefined {
    return getWindows().find(
      (window) => window.webContents.id === rendererId && isUsableWindow(window),
    );
  }
}

function isUsableWindow(window: PresentationWindow): boolean {
  return (
    !window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isCrashed()
  );
}

function headlessPresentation(): TerminalPresentation {
  return { state: "headless", windowVisible: false, windowFocused: false };
}

function presentationError(sessionId: SessionId, cause: string) {
  return createTerminalError("view_unavailable", "Terminal presentation is unavailable.", {
    sessionId,
    operation: "terminal.setPresentation",
    cause,
  });
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "cause" in error) {
    const cause = error.cause;
    if (typeof cause === "string") return cause;
  }
  return error instanceof Error ? error.message : String(error);
}
