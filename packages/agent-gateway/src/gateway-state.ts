import type { WebSocket } from "ws";

import {
  TERMINAL_PROTOCOL_VERSION,
  type AgentCommandResult,
  type AgentSessionControlState,
  type SessionId,
} from "@terminal/protocol";

export function detachedControlState(sessionId: SessionId): AgentSessionControlState {
  return { sessionId, state: "detached", attachedAt: null };
}

export function revokedControlState(sessionId: SessionId): AgentSessionControlState {
  return { sessionId, state: "revoked", attachedAt: null };
}

export function sendResult(
  connection: { socket: Pick<WebSocket, "readyState" | "send"> },
  result: AgentCommandResult,
): void {
  if (connection.socket.readyState === 1) {
    connection.socket.send(JSON.stringify(result));
  }
}

export function readUnsupportedProtocolVersion(value: unknown): number | undefined {
  if (!isRecord(value) || value.type !== "agent.authenticate" || !isRecord(value.payload)) {
    return undefined;
  }
  if (!("protocolVersion" in value.payload)) return undefined;
  const protocolVersion = value.payload.protocolVersion;
  if (typeof protocolVersion !== "number") return undefined;
  return protocolVersion === TERMINAL_PROTOCOL_VERSION ? undefined : protocolVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
