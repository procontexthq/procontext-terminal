import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";

import type { RawData, WebSocket, WebSocketServer } from "ws";

import type { AgentPolicy, AgentPolicyOperation } from "@terminal/policy-engine";
import {
  createAgentCommandFailure,
  createAgentCommandSuccess,
  createRequestId,
  createTerminalError,
  parseAgentCommand,
  type AgentActivityState,
  type AgentAuditEvent,
  type AgentCommand,
  type AgentCommandResult,
  type AgentCommandType,
  type AgentEvent,
  type AgentGatewayDescriptor,
  type AttachSessionRequest,
  type CaptureScreenRequest,
  type CreateSessionRequest,
  type KillSessionRequest,
  type PolicyDenial,
  type ReadRecentOutputRequest,
  type RecentOutputSnapshot,
  type RendererSessionEvent,
  type RequestId,
  type ResizeSessionRequest,
  type SendKeyRequest,
  type SessionId,
  type TerminalError,
  type TerminalScreenSnapshot,
  type TerminalSessionSnapshot,
  type TerminalWaitResult,
  type Unsubscribe,
  type WaitForPromptRequest,
  type WaitForQuietRequest,
  type WaitForScreenChangeRequest,
  type WaitForTextRequest,
  type WriteInputRequest,
} from "@terminal/protocol";

export type AgentGatewayTerminalServices = {
  listSessions(): TerminalSessionSnapshot[];
  createSession(request: CreateSessionRequest): Promise<TerminalSessionSnapshot>;
  getSession(request: AttachSessionRequest): TerminalSessionSnapshot;
  write(request: WriteInputRequest): Promise<void>;
  sendKey(request: SendKeyRequest): Promise<void>;
  resize(request: ResizeSessionRequest): Promise<void>;
  readRecentOutput(request: ReadRecentOutputRequest): RecentOutputSnapshot;
  captureScreen(request: CaptureScreenRequest): Promise<TerminalScreenSnapshot>;
  waitForText(request: WaitForTextRequest): Promise<TerminalWaitResult>;
  waitForQuiet(request: WaitForQuietRequest): Promise<TerminalWaitResult>;
  waitForScreenChange(request: WaitForScreenChangeRequest): Promise<TerminalWaitResult>;
  waitForPrompt(request: WaitForPromptRequest): Promise<TerminalWaitResult>;
  kill(request: KillSessionRequest): Promise<void>;
  onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe;
};

export type AgentGatewayOptions = {
  descriptorPath: string;
  services: AgentGatewayTerminalServices;
  policy: AgentPolicy;
  host?: string;
  port?: number;
  token?: string;
  tokenTtlMs?: number;
  tokenExpiresAt?: string;
  now?: () => Date;
  audit?: (event: AgentAuditEvent) => void;
  onActivity?: (state: AgentActivityState) => void;
};

export type AgentGateway = {
  descriptor: AgentGatewayDescriptor;
  descriptorPath: string;
  stop(): Promise<void>;
};

type ConnectionContext = {
  id: string;
  socket: WebSocket;
  local: boolean;
  authenticated: boolean;
  ownedSessionIds: Set<SessionId>;
};

const defaultHost = "127.0.0.1";
const defaultTokenTtlMs = 15 * 60 * 1000;

export function resolveAgentGatewayDescriptorPath(userDataPath: string): string {
  return join(userDataPath, "agent-gateway.json");
}

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
  let lastActiveAt: string | null = null;
  let stopped = false;

  const unsubscribe = options.services.onSessionEvent((event) => {
    for (const connection of connections.values()) {
      const agentEvent = mapRendererEventForConnection(event, connection);
      if (agentEvent) {
        sendJson(connection.socket, agentEvent);
      }
    }
  });

  wss.on("connection", (socket, request) => {
    const connection: ConnectionContext = {
      id: randomId("agent-connection"),
      socket,
      local: isLoopbackAddress(request.socket.remoteAddress),
      authenticated: false,
      ownedSessionIds: new Set(),
    };
    connections.set(connection.id, connection);
    emitActivity();

    socket.on("message", (data) => {
      void handleMessage(data, connection);
    });
    socket.on("close", () => {
      connections.delete(connection.id);
      emitActivity();
    });
    socket.on("error", () => {
      connections.delete(connection.id);
      emitActivity();
    });
  });

  await listen(server, options.port ?? 0, host);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve agent gateway server address.");
  }
  const descriptor: AgentGatewayDescriptor = {
    url: `ws://${host}:${address.port}`,
    token,
    tokenExpiresAt,
    pid: process.pid,
  };
  await writeDescriptor(options.descriptorPath, descriptor);

  return {
    descriptor,
    descriptorPath: options.descriptorPath,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      unsubscribe();
      for (const connection of connections.values()) {
        connection.socket.close();
      }
      connections.clear();
      await closeWebSocketServer(wss);
      await closeHttpServer(server);
      await rm(options.descriptorPath, { force: true });
      emitActivity();
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
      const terminalError = createTerminalError(
        "invalid_request",
        "Invalid agent command payload.",
        {
          operation: "agent.command",
          cause: error instanceof Error ? error.message : String(error),
        },
      );
      audit(connection, "terminal.list", "failure", requestId, terminalError);
      sendResult(connection, createAgentCommandFailure(requestId, terminalError));
      return;
    }

    const decision = options.policy.authorize({
      actor: {
        kind: "agent",
        authenticated: connection.authenticated,
        local: connection.local,
        ownedSessionIds: connection.ownedSessionIds,
      },
      operation: policyOperationForCommand(command),
    });
    if (decision.type === "deny") {
      const terminalError = terminalErrorFromPolicyDenial(command, decision.reason);
      audit(
        connection,
        command.type,
        "deny",
        command.requestId,
        terminalError,
        decision.reason.code,
      );
      sendJson(connection.socket, {
        type: "terminal.denied",
        payload: decision.reason,
      } satisfies AgentEvent);
      sendResult(connection, createAgentCommandFailure(command.requestId, terminalError));
      return;
    }

    if (command.type === "agent.authenticate") {
      handleAuthenticate(command, connection);
      return;
    }

    if (!connection.authenticated) {
      const terminalError = createTerminalError(
        "auth_required",
        "Agent authentication is required.",
        {
          operation: command.type,
          sessionId: commandSessionId(command),
        },
      );
      audit(connection, command.type, "deny", command.requestId, terminalError);
      sendResult(connection, createAgentCommandFailure(command.requestId, terminalError));
      return;
    }

    try {
      const value = await executeCommand(command, connection);
      audit(connection, command.type, "allow", command.requestId, undefined);
      sendResult(connection, createAgentCommandSuccess(command.requestId, value));
    } catch (error: unknown) {
      const terminalError = normalizeTerminalError(error, command);
      audit(connection, command.type, "failure", command.requestId, terminalError);
      sendJson(connection.socket, {
        type: "terminal.error",
        payload: terminalError,
      } satisfies AgentEvent);
      sendResult(connection, createAgentCommandFailure(command.requestId, terminalError));
    }
  }

  function handleAuthenticate(
    command: Extract<AgentCommand, { type: "agent.authenticate" }>,
    connection: ConnectionContext,
  ): void {
    if (now().getTime() > Date.parse(tokenExpiresAt)) {
      const error = createTerminalError("auth_failed", "Agent authentication token expired.", {
        operation: command.type,
      });
      audit(connection, command.type, "failure", command.requestId, error);
      sendResult(connection, createAgentCommandFailure(command.requestId, error));
      return;
    }

    if (command.payload.token !== token) {
      const error = createTerminalError("auth_failed", "Agent authentication failed.", {
        operation: command.type,
      });
      audit(connection, command.type, "failure", command.requestId, error);
      sendResult(connection, createAgentCommandFailure(command.requestId, error));
      return;
    }

    connection.authenticated = true;
    const value = { authenticatedAt: now().toISOString(), tokenExpiresAt };
    audit(connection, command.type, "allow", command.requestId, undefined);
    sendResult(connection, createAgentCommandSuccess(command.requestId, value));
    sendJson(connection.socket, {
      type: "agent.authenticated",
      payload: value,
    } satisfies AgentEvent);
    emitActivity();
  }

  async function executeCommand(
    command: AgentCommand,
    connection: ConnectionContext,
  ): Promise<unknown> {
    switch (command.type) {
      case "agent.authenticate":
        throw new Error("Authentication command is handled before dispatch.");
      case "terminal.list":
        return options.services.listSessions();
      case "terminal.create": {
        const snapshot = await options.services.createSession({
          ...command.payload,
          createdBy: "agent",
        });
        connection.ownedSessionIds.add(snapshot.sessionId);
        sendJson(connection.socket, {
          type: "terminal.created",
          payload: snapshot,
        } satisfies AgentEvent);
        return snapshot;
      }
      case "terminal.attach": {
        const snapshot = options.services.getSession(command.payload);
        connection.ownedSessionIds.add(snapshot.sessionId);
        sendJson(connection.socket, {
          type: "terminal.attached",
          payload: snapshot,
        } satisfies AgentEvent);
        return snapshot;
      }
      case "terminal.sendText":
        await options.services.write({
          sessionId: command.payload.sessionId,
          data: command.payload.text,
          origin: "agent",
        });
        return null;
      case "terminal.sendKey":
        await options.services.sendKey({
          sessionId: command.payload.sessionId,
          key: command.payload.key,
          origin: "agent",
        });
        return null;
      case "terminal.resize":
        await options.services.resize(command.payload);
        return null;
      case "terminal.readRecentOutput":
        return options.services.readRecentOutput(command.payload);
      case "terminal.captureScreen":
        return options.services.captureScreen(command.payload);
      case "terminal.waitForText":
        return options.services.waitForText(command.payload);
      case "terminal.waitForScreenChange":
        return options.services.waitForScreenChange(command.payload);
      case "terminal.waitForQuiet":
        return options.services.waitForQuiet(command.payload);
      case "terminal.waitForPrompt":
        return options.services.waitForPrompt(command.payload);
      case "terminal.kill":
        await options.services.kill(command.payload);
        return null;
    }
  }

  function audit(
    connection: ConnectionContext,
    action: AgentCommandType,
    outcome: AgentAuditEvent["outcome"],
    requestId: RequestId,
    error?: TerminalError,
    denialCode?: AgentAuditEvent["denialCode"],
  ): void {
    options.audit?.({
      type: "agent.audit",
      at: now().toISOString(),
      connectionId: connection.id,
      authenticated: connection.authenticated,
      action,
      outcome,
      requestId,
      ...(error?.sessionId ? { sessionId: error.sessionId } : {}),
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
}

function mapRendererEventForConnection(
  event: RendererSessionEvent,
  connection: ConnectionContext,
): AgentEvent | null {
  switch (event.type) {
    case "session.created":
      return connection.ownedSessionIds.has(event.payload.sessionId)
        ? { type: "terminal.created", payload: event.payload }
        : null;
    case "session.attached":
      return connection.ownedSessionIds.has(event.payload.sessionId)
        ? { type: "terminal.attached", payload: event.payload }
        : null;
    case "session.output":
      return connection.ownedSessionIds.has(event.payload.sessionId)
        ? { type: "terminal.output", payload: event.payload }
        : null;
    case "session.exited":
      return connection.ownedSessionIds.has(event.payload.sessionId)
        ? { type: "terminal.exited", payload: event.payload }
        : null;
    case "session.error":
      return event.payload.sessionId && connection.ownedSessionIds.has(event.payload.sessionId)
        ? { type: "terminal.error", payload: event.payload }
        : null;
    case "session.detached":
    case "session.snapshot.request":
    case "agent.activity":
      return null;
  }
}

function commandSessionId(command: AgentCommand): SessionId | undefined {
  switch (command.type) {
    case "agent.authenticate":
    case "terminal.list":
    case "terminal.create":
      return undefined;
    case "terminal.attach":
    case "terminal.sendKey":
    case "terminal.resize":
    case "terminal.readRecentOutput":
    case "terminal.captureScreen":
    case "terminal.waitForText":
    case "terminal.waitForScreenChange":
    case "terminal.waitForQuiet":
    case "terminal.waitForPrompt":
    case "terminal.kill":
      return command.payload.sessionId;
    case "terminal.sendText":
      return command.payload.sessionId;
  }
}

function policyOperationForCommand(command: AgentCommand): AgentPolicyOperation {
  switch (command.type) {
    case "agent.authenticate":
      return { type: command.type };
    case "terminal.list":
      return { type: command.type, observationKind: "list" };
    case "terminal.create":
      return {
        type: command.type,
        ...(command.payload.cwd ? { cwd: command.payload.cwd } : {}),
        ...(command.payload.shell ? { shell: command.payload.shell } : {}),
      };
    case "terminal.attach":
      return { type: command.type, sessionId: command.payload.sessionId, observationKind: "get" };
    case "terminal.sendText":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "text" };
    case "terminal.sendKey":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "key" };
    case "terminal.resize":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "resize" };
    case "terminal.readRecentOutput":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "recentOutput",
      };
    case "terminal.captureScreen":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "screen",
      };
    case "terminal.waitForText":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "waitText",
      };
    case "terminal.waitForScreenChange":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "waitScreenChange",
      };
    case "terminal.waitForQuiet":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "waitQuiet",
      };
    case "terminal.waitForPrompt":
      return {
        type: command.type,
        sessionId: command.payload.sessionId,
        observationKind: "waitPrompt",
      };
    case "terminal.kill":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "kill" };
  }
}

function terminalErrorFromPolicyDenial(command: AgentCommand, denial: PolicyDenial): TerminalError {
  return createTerminalError(
    denial.code === "auth_required" ? "auth_required" : "policy_denied",
    denial.message,
    {
      operation: command.type,
      sessionId: commandSessionId(command),
      cause: denial.code,
    },
  );
}

function normalizeTerminalError(error: unknown, command: AgentCommand): TerminalError {
  if (isTerminalError(error)) {
    return error;
  }
  return createTerminalError(
    "gateway_failed",
    error instanceof Error ? error.message : String(error),
    {
      operation: command.type,
      sessionId: commandSessionId(command),
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}

function isTerminalError(value: unknown): value is TerminalError {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "message" in value &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}

function sendResult(connection: ConnectionContext, result: AgentCommandResult): void {
  sendJson(connection.socket, result);
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(value));
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function extractRequestIdFromRaw(data: RawData): RequestId {
  try {
    const value = JSON.parse(rawDataToString(data)) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "requestId" in value &&
      typeof value.requestId === "string"
    ) {
      return createRequestId(value.requestId);
    }
  } catch {
    // Fall through to a generated request id.
  }
  return createRequestId();
}

async function writeDescriptor(path: string, descriptor: AgentGatewayDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createWebSocketServer(server: Server): Promise<WebSocketServer> {
  process.env.WS_NO_BUFFER_UTIL ??= "1";
  process.env.WS_NO_UTF_8_VALIDATE ??= "1";
  // ws reads these environment flags while loading optional native addons.
  const { WebSocketServer } = await import("ws");
  return new WebSocketServer({ server });
}

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === undefined ||
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}
