import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";

import type { RawData, WebSocket } from "ws";

import {
  TERMINAL_PROTOCOL_VERSION,
  createAgentCommandFailure,
  createAgentCommandSuccess,
  createTerminalError,
  parseAgentCommand,
  type AgentAuditEvent,
  type AgentCommand,
  type AgentCommandResult,
  type AgentGatewayDescriptor,
  type SessionId,
  type TerminalError,
} from "@terminal/protocol";

import {
  commandSessionId,
  denialError,
  normalizeCommandError,
  policyOperation,
} from "./agent-command.js";
import { createAttachmentRegistry } from "./attachment-registry.js";
import {
  closeHttpServer,
  closeWebSocketServer,
  createWebSocketServer,
  extractRequestIdFromRaw,
  isLoopbackAddress,
  listen,
  randomId,
  rawDataToString,
  writeDescriptor,
} from "./transport.js";
import type { AgentGateway, AgentGatewayOptions } from "./types.js";

type ConnectionContext = {
  id: string;
  socket: WebSocket;
  local: boolean;
  authenticated: boolean;
  attachedSessionIds: Set<SessionId>;
  abortController: AbortController;
};

const defaultHost = "127.0.0.1";
const defaultTokenTtlMs = 15 * 60 * 1_000;

export async function startAgentGateway(options: AgentGatewayOptions): Promise<AgentGateway> {
  const now = options.now ?? (() => new Date());
  const host = options.host ?? defaultHost;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const tokenExpiresAt =
    options.tokenExpiresAt ??
    new Date(now().getTime() + (options.tokenTtlMs ?? defaultTokenTtlMs)).toISOString();
  const server = createServer();
  const wss = await createWebSocketServer(server);
  const connections = new Map<string, ConnectionContext>();
  const attachments = createAttachmentRegistry();
  let stopped = false;
  let lastActiveAt: string | null = null;

  wss.on("connection", (socket, request) => {
    const connection: ConnectionContext = {
      id: randomId("agent-connection"),
      socket,
      local: isLoopbackAddress(request.socket.remoteAddress),
      authenticated: false,
      attachedSessionIds: new Set(),
      abortController: new AbortController(),
    };
    connections.set(connection.id, connection);
    emitActivity();
    socket.on("message", (data) => void handleMessage(data, connection));
    socket.on("close", () => removeConnection(connection));
    socket.on("error", () => removeConnection(connection));
  });

  let descriptor: AgentGatewayDescriptor;
  try {
    await listen(server, options.port ?? 0, host);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not resolve agent gateway server address.");
    }
    descriptor = {
      url: `ws://${host}:${address.port}`,
      token,
      tokenExpiresAt,
      pid: process.pid,
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
    };
    await writeDescriptor(options.descriptorPath, descriptor);
  } catch (error: unknown) {
    await closeRuntime(true);
    throw error;
  }

  return {
    descriptor,
    descriptorPath: options.descriptorPath,
    async stop() {
      if (stopped) return;
      stopped = true;
      await closeRuntime(false);
    },
  };

  async function handleMessage(data: RawData, connection: ConnectionContext): Promise<void> {
    lastActiveAt = now().toISOString();
    emitActivity();
    let command: AgentCommand;
    try {
      command = parseAgentCommand(JSON.parse(rawDataToString(data)) as unknown);
    } catch (error: unknown) {
      const requestId = extractRequestIdFromRaw(data);
      sendResult(
        connection,
        createAgentCommandFailure(
          requestId,
          createTerminalError("invalid_request", "Invalid agent command payload.", {
            operation: "agent.command",
            cause: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      return;
    }

    const decision = options.policy.authorize({
      actor: {
        kind: "agent",
        authenticated: connection.authenticated,
        local: connection.local,
        attachedSessionIds: connection.attachedSessionIds,
      },
      operation: policyOperation(command),
    });
    if (decision.type === "deny") {
      const error = denialError(command, decision.reason);
      audit(connection, command, "deny", error, decision.reason.code);
      sendResult(connection, createAgentCommandFailure(command.requestId, error));
      return;
    }

    if (command.type === "agent.authenticate") {
      authenticate(command, connection);
      return;
    }

    try {
      const value = await execute(command, connection);
      audit(connection, command, "allow");
      sendResult(connection, createAgentCommandSuccess(command.requestId, value));
    } catch (error: unknown) {
      const normalized = normalizeCommandError(error, command);
      audit(connection, command, "failure", normalized);
      sendResult(connection, createAgentCommandFailure(command.requestId, normalized));
    }
  }

  function authenticate(
    command: Extract<AgentCommand, { type: "agent.authenticate" }>,
    connection: ConnectionContext,
  ): void {
    if (now().getTime() > Date.parse(tokenExpiresAt)) {
      const error = createTerminalError("auth_failed", "Agent authentication token expired.", {
        operation: command.type,
      });
      audit(connection, command, "failure", error);
      sendResult(connection, createAgentCommandFailure(command.requestId, error));
      return;
    }
    if (command.payload.token !== token) {
      const error = createTerminalError("auth_failed", "Agent authentication failed.", {
        operation: command.type,
      });
      audit(connection, command, "failure", error);
      sendResult(connection, createAgentCommandFailure(command.requestId, error));
      return;
    }
    connection.authenticated = true;
    const value = {
      authenticatedAt: now().toISOString(),
      tokenExpiresAt,
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
    };
    audit(connection, command, "allow");
    sendResult(connection, createAgentCommandSuccess(command.requestId, value));
    emitActivity();
  }

  async function execute(command: AgentCommand, connection: ConnectionContext): Promise<unknown> {
    switch (command.type) {
      case "agent.authenticate":
        throw new Error("Authentication is handled before dispatch.");
      case "terminal.list":
        return options.services.list();
      case "terminal.get":
        return options.services.get(command.payload);
      case "terminal.create": {
        const session = await options.services.create(command.payload);
        attachOrThrow(session.sessionId, connection);
        return session;
      }
      case "terminal.attach": {
        const session = options.services.get(command.payload);
        attachOrThrow(session.sessionId, connection);
        return session;
      }
      case "terminal.input":
        return options.services.input(command.payload);
      case "terminal.resize":
        return options.services.resize(command.payload);
      case "terminal.scroll":
        return options.services.scroll(command.payload);
      case "terminal.observe":
        return options.services.observe(command.payload, connection.abortController.signal);
      case "terminal.close": {
        const result = await options.services.close(command.payload);
        if (result.status === "closed") detach(command.payload.sessionId, connection);
        return result;
      }
      case "terminal.recording.start":
        await options.services.startRecording(command.payload);
        return null;
      case "terminal.recording.stop":
        await options.services.stopRecording(command.payload);
        return null;
      case "terminal.recording.export":
        return options.services.exportRecording(command.payload);
    }
  }

  function attachOrThrow(sessionId: SessionId, connection: ConnectionContext): void {
    if (!attachments.attach(sessionId, connection.id)) {
      throw createTerminalError(
        "session_in_use",
        "Another agent connection controls this terminal session.",
        { sessionId, operation: "terminal.attach" },
      );
    }
    connection.attachedSessionIds.add(sessionId);
  }

  function detach(sessionId: SessionId, connection: ConnectionContext): void {
    attachments.detach(sessionId, connection.id);
    connection.attachedSessionIds.delete(sessionId);
  }

  function removeConnection(connection: ConnectionContext): void {
    if (!connections.delete(connection.id)) return;
    connection.abortController.abort();
    attachments.detachConnection(connection.id);
    connection.attachedSessionIds.clear();
    emitActivity();
  }

  function audit(
    connection: ConnectionContext,
    command: AgentCommand,
    outcome: AgentAuditEvent["outcome"],
    error?: TerminalError,
    denialCode?: AgentAuditEvent["denialCode"],
  ): void {
    options.audit?.({
      type: "agent.audit",
      at: now().toISOString(),
      connectionId: connection.id,
      authenticated: connection.authenticated,
      action: command.type,
      outcome,
      requestId: command.requestId,
      ...(commandSessionId(command) ? { sessionId: commandSessionId(command) } : {}),
      ...(error ? { errorType: error.type } : {}),
      ...(denialCode ? { denialCode } : {}),
    });
  }

  function emitActivity(): void {
    options.onActivity?.({
      activeConnections: connections.size,
      authenticatedConnections: [...connections.values()].filter(
        (connection) => connection.authenticated,
      ).length,
      lastActiveAt,
    });
  }

  async function closeRuntime(ignoreErrors: boolean): Promise<void> {
    for (const connection of connections.values()) {
      connection.socket.close();
      removeConnection(connection);
    }
    const tasks = [
      closeWebSocketServer(wss),
      closeHttpServer(server),
      rm(options.descriptorPath, { force: true }),
    ];
    if (ignoreErrors) await Promise.allSettled(tasks);
    else await Promise.all(tasks);
    emitActivity();
  }
}

function sendResult(connection: ConnectionContext, result: AgentCommandResult): void {
  if (connection.socket.readyState === 1) {
    connection.socket.send(JSON.stringify(result));
  }
}
