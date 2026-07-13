import { createTerminalError, type SessionId } from "@terminal/protocol";

export type TerminalPresentationRegistry = {
  open(sessionId: SessionId, rendererId: number): void;
  close(sessionId: SessionId, rendererId: number): boolean;
  removeRenderer(rendererId: number): SessionId[];
  removeSession(sessionId: SessionId): void;
  owns(sessionId: SessionId, rendererId: number): boolean;
  rendererIdFor(sessionId: SessionId): number | undefined;
};

export function createTerminalPresentationRegistry(): TerminalPresentationRegistry {
  const rendererBySession = new Map<SessionId, number>();
  return {
    open(sessionId, rendererId) {
      const current = rendererBySession.get(sessionId);
      if (current !== undefined && current !== rendererId) {
        throw createTerminalError(
          "view_unavailable",
          "This terminal session already has a renderer view.",
          { sessionId, operation: "session.openView" },
        );
      }
      rendererBySession.set(sessionId, rendererId);
    },
    close(sessionId, rendererId) {
      if (rendererBySession.get(sessionId) !== rendererId) return false;
      rendererBySession.delete(sessionId);
      return true;
    },
    removeRenderer(rendererId) {
      const removed: SessionId[] = [];
      for (const [sessionId, current] of rendererBySession) {
        if (current === rendererId) {
          rendererBySession.delete(sessionId);
          removed.push(sessionId);
        }
      }
      return removed;
    },
    removeSession(sessionId) {
      rendererBySession.delete(sessionId);
    },
    owns(sessionId, rendererId) {
      return rendererBySession.get(sessionId) === rendererId;
    },
    rendererIdFor(sessionId) {
      return rendererBySession.get(sessionId);
    },
  };
}
