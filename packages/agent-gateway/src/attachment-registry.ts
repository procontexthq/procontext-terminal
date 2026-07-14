import type { SessionId } from "@terminal/protocol";

import type { AttachmentRegistry } from "./types.js";

export function createAttachmentRegistry(): AttachmentRegistry {
  const attachedConnections = new Map<SessionId, { connectionId: string; attachedAt: string }>();
  return {
    attach(sessionId, connectionId, attachedAt) {
      const current = attachedConnections.get(sessionId);
      if (current && current.connectionId !== connectionId) return false;
      if (!current) attachedConnections.set(sessionId, { connectionId, attachedAt });
      return true;
    },
    detach(sessionId, connectionId) {
      if (attachedConnections.get(sessionId)?.connectionId === connectionId) {
        attachedConnections.delete(sessionId);
      }
    },
    release(sessionId) {
      const connectionId = attachedConnections.get(sessionId)?.connectionId;
      attachedConnections.delete(sessionId);
      return connectionId;
    },
    detachConnection(connectionId) {
      const detached: SessionId[] = [];
      for (const [sessionId, current] of attachedConnections) {
        if (current.connectionId === connectionId) {
          attachedConnections.delete(sessionId);
          detached.push(sessionId);
        }
      }
      return detached;
    },
    list() {
      return [...attachedConnections.entries()].map(([sessionId, attachment]) => ({
        sessionId,
        state: "attached" as const,
        attachedAt: attachment.attachedAt,
      }));
    },
  };
}
