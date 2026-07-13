import type { SessionId } from "@terminal/protocol";

import type { AttachmentRegistry } from "./types.js";

export function createAttachmentRegistry(): AttachmentRegistry {
  const attachedConnections = new Map<SessionId, string>();
  return {
    attach(sessionId, connectionId) {
      const current = attachedConnections.get(sessionId);
      if (current && current !== connectionId) return false;
      attachedConnections.set(sessionId, connectionId);
      return true;
    },
    detach(sessionId, connectionId) {
      if (attachedConnections.get(sessionId) === connectionId) {
        attachedConnections.delete(sessionId);
      }
    },
    detachConnection(connectionId) {
      for (const [sessionId, current] of attachedConnections) {
        if (current === connectionId) attachedConnections.delete(sessionId);
      }
    },
  };
}
