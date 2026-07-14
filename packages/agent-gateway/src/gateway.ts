import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";

import type { RawData, WebSocket } from "ws";

import {
  TERMINAL_PROTOCOL_VERSION,
  createAgentCommandFailure,
  createAgentCommandSuccess,
  createDecisionId,
  createTerminalError,
  parseAgentCommand,
  type AgentAuditEvent,
  type AgentCommand,
  type AgentGatewayDescriptor,
  type AgentSessionControlState,
  type OperationId,
  type PolicyDenialCode,
  type SessionId,
  type TerminalError,
} from "@terminal/protocol";

import {
  commandOperationId,
  commandSessionId,
  denialError,
  normalizeCommandError,
  policyOperation,
} from "./agent-command.js";
import { createAttachmentRegistry } from "./attachment-registry.js";
import { dispatchAgentCommand } from "./command-dispatch.js";
import {
  detachedControlState,
  readUnsupportedProtocolVersion,
  revokedControlState,
  sendResult,
} from "./gateway-state.js";
import {
  permissionDenialCode,
  permissionDenialMessage,
  requestAgentPermission,
} from "./permission-resolution.js";
import {
  createSessionRequestTracker,
  type SessionRequestTracker,
} from "./session-request-tracker.js";
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
  requests: SessionRequestTracker;
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
  const revokedSessionIds = new Set<SessionId>();
  const operationSessions = new Map<OperationId, SessionId>();
  let stopped = false;
  let lastActiveAt: string | null = null;

  wss.on("connection", (socket, request) => {
    const abortController = new AbortController();
    const connection: ConnectionContext = {
      id: randomId("agent-connection"),
      socket,
      local: isLoopbackAddress(request.socket.remoteAddress),
      authenticated: false,
      attachedSessionIds: new Set(),
      abortController,
      requests: createSessionRequestTracker(abortController.signal),
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
    listSessionControls() {
      return listSessionControls();
    },
    revokeSessionControl(sessionId) {
      const changed = !revokedSessionIds.has(sessionId);
      revokedSessionIds.add(sessionId);
      markSessionRequestsRevoked(sessionId);
      const state = revokedControlState(sessionId);
      releaseSession(sessionId, state, changed);
      return state;
    },
    allowSessionControl(sessionId) {
      const changed = revokedSessionIds.delete(sessionId);
      const attached = attachments.list().find((control) => control.sessionId === sessionId);
      if (!changed && attached) return attached;
      const state = detachedControlState(sessionId);
      if (changed) options.onControlChanged?.(state);
      return state;
    },
    removeSessionControl(sessionId) {
      revokedSessionIds.delete(sessionId);
      releaseSession(sessionId);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await closeRuntime(false);
    },
  };

  async function handleMessage(data: RawData, connection: ConnectionContext): Promise<void> {
    lastActiveAt = now().toISOString();
    emitActivity();
    let rawCommand: unknown;
    try {
      rawCommand = JSON.parse(rawDataToString(data)) as unknown;
    } catch (error: unknown) {
      sendInvalidCommand(data, connection, error);
      return;
    }
    const unsupportedVersion = readUnsupportedProtocolVersion(rawCommand);
    if (unsupportedVersion !== undefined) {
      const requestId = extractRequestIdFromRaw(data);
      sendResult(
        connection,
        createAgentCommandFailure(
          requestId,
          createTerminalError(
            "protocol_version_unsupported",
            `Terminal protocol version ${String(unsupportedVersion)} is unsupported.`,
            {
              operation: "agent.authenticate",
            },
          ),
        ),
      );
      return;
    }

    let command: AgentCommand;
    try {
      command = parseAgentCommand(rawCommand);
    } catch (error: unknown) {
      sendInvalidCommand(data, connection, error);
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
      denyCommand(command, connection, decision.decisionId, decision.reason.code, {
        message: decision.reason.message,
      });
      return;
    }

    if (command.type === "agent.authenticate") {
      authenticate(command, connection);
      return;
    }

    if (command.type === "terminal.attach" && revokedSessionIds.has(command.payload.sessionId)) {
      denyRevokedAttachment(command, connection);
      return;
    }

    const activeRequest = connection.requests.begin(commandSessionId(command));
    try {
      if (decision.type === "prompt") {
        const outcome = await requestAgentPermission(
          options.requestPermission,
          decision.prompt,
          activeRequest.signal,
        );
        if (outcome !== "allow") {
          if (
            command.type === "terminal.attach" &&
            (activeRequest.controlRevoked || revokedSessionIds.has(command.payload.sessionId))
          ) {
            denyRevokedAttachment(command, connection);
            return;
          }
          denyCommand(command, connection, decision.decisionId, permissionDenialCode(outcome));
          return;
        }
      }
      const value = await dispatchAgentCommand(command, options.services, activeRequest.signal, {
        attach: (sessionId) => attachOrThrow(sessionId, connection),
        detach: (sessionId) => detach(sessionId, connection),
        rememberOperation: (operationId, sessionId) => {
          operationSessions.set(operationId, sessionId);
        },
        releaseOperation,
        releaseSessionOperations,
      });
      if (command.type === "terminal.attach" && activeRequest.controlRevoked) {
        denyRevokedAttachment(command, connection);
        return;
      }
      audit(connection, command, "allow");
      sendResult(connection, createAgentCommandSuccess(command.requestId, value));
    } catch (error: unknown) {
      const normalized = normalizeCommandError(error, command);
      audit(connection, command, "failure", normalized);
      sendResult(connection, createAgentCommandFailure(command.requestId, normalized));
    } finally {
      connection.requests.end(activeRequest);
    }
  }

  function sendInvalidCommand(data: RawData, connection: ConnectionContext, error: unknown): void {
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

  function attachOrThrow(sessionId: SessionId, connection: ConnectionContext): void {
    const attachedAt = now().toISOString();
    if (!attachments.attach(sessionId, connection.id, attachedAt)) {
      throw createTerminalError(
        "session_in_use",
        "Another agent connection controls this terminal session.",
        { sessionId, operation: "terminal.attach" },
      );
    }
    connection.attachedSessionIds.add(sessionId);
    options.onControlChanged?.({
      sessionId,
      state: "attached",
      attachedAt:
        attachments.list().find((control) => control.sessionId === sessionId)?.attachedAt ??
        attachedAt,
    });
  }

  function detach(sessionId: SessionId, connection: ConnectionContext): void {
    const wasAttached = connection.attachedSessionIds.delete(sessionId);
    attachments.detach(sessionId, connection.id);
    connection.requests.abortSession(sessionId);
    if (wasAttached) options.onControlChanged?.(detachedControlState(sessionId));
  }

  function releaseSession(
    sessionId: SessionId,
    nextState: AgentSessionControlState = detachedControlState(sessionId),
    emitWhenUnattached = false,
  ): void {
    const connectionId = attachments.release(sessionId);
    for (const connection of connections.values()) {
      connection.attachedSessionIds.delete(sessionId);
      connection.requests.abortSession(sessionId);
    }
    if (connectionId || emitWhenUnattached) options.onControlChanged?.(nextState);
  }

  function releaseOperation(operationId: OperationId): void {
    const sessionId = operationSessions.get(operationId);
    if (!sessionId) return;
    releaseSession(sessionId);
    operationSessions.delete(operationId);
  }

  function releaseSessionOperations(sessionId: SessionId): void {
    for (const [operationId, candidateSessionId] of operationSessions) {
      if (candidateSessionId === sessionId) operationSessions.delete(operationId);
    }
  }

  function removeConnection(connection: ConnectionContext): void {
    if (!connections.delete(connection.id)) return;
    connection.abortController.abort();
    const detachedSessionIds = attachments.detachConnection(connection.id);
    connection.attachedSessionIds.clear();
    for (const sessionId of detachedSessionIds) {
      options.onControlChanged?.(detachedControlState(sessionId));
    }
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
      ...(commandOperationId(command) ? { operationId: commandOperationId(command) } : {}),
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

  function listSessionControls(): AgentSessionControlState[] {
    const controls = attachments.list();
    for (const sessionId of revokedSessionIds) {
      controls.push(revokedControlState(sessionId));
    }
    return controls;
  }

  function denyRevokedAttachment(
    command: Extract<AgentCommand, { type: "terminal.attach" }>,
    connection: ConnectionContext,
  ): void {
    const decisionId = createDecisionId();
    const message = "Agent control has been revoked for this terminal session.";
    const error = createTerminalError("policy_denied", message, {
      operation: command.type,
      sessionId: command.payload.sessionId,
      cause: "agent_control_revoked",
    });
    options.onPolicyDenied?.({
      decisionId,
      at: now().toISOString(),
      actor: "agent",
      operation: command.type,
      sessionId: command.payload.sessionId,
      code: "agent_control_revoked",
      message,
    });
    audit(connection, command, "deny", error, "agent_control_revoked");
    sendResult(connection, createAgentCommandFailure(command.requestId, error));
  }

  function denyCommand(
    command: AgentCommand,
    connection: ConnectionContext,
    decisionId: string,
    code: PolicyDenialCode,
    optionsOverride: { message?: string } = {},
  ): void {
    const message = optionsOverride.message ?? permissionDenialMessage(code);
    const error = denialError(command, {
      decisionId,
      code,
      message,
      operation: command.type,
      ...(commandSessionId(command) ? { sessionId: commandSessionId(command) } : {}),
      ...(commandOperationId(command) ? { operationId: commandOperationId(command) } : {}),
    });
    options.onPolicyDenied?.({
      decisionId,
      at: now().toISOString(),
      actor: "agent",
      operation: command.type,
      ...(commandSessionId(command) ? { sessionId: commandSessionId(command) } : {}),
      code,
      message,
    });
    audit(connection, command, "deny", error, code);
    sendResult(connection, createAgentCommandFailure(command.requestId, error));
  }

  function markSessionRequestsRevoked(sessionId: SessionId): void {
    for (const connection of connections.values()) {
      connection.requests.markControlRevoked(sessionId);
    }
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
