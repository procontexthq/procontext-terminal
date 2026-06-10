import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultAgentPolicy, type AgentPolicy } from "@terminal/policy-engine";
import {
  createAgentCommand,
  createRequestId,
  createSessionId,
  createTerminalError,
  parseAgentGatewayDescriptor,
  type AgentAuditEvent,
  type AgentCommandResult,
  type AgentEvent,
  type RendererSessionEvent,
  type SessionId,
  type TerminalSessionSnapshot,
  type Unsubscribe,
} from "@terminal/protocol";

import {
  resolveAgentGatewayDescriptorPath,
  startAgentGateway,
  type AgentGateway,
  type AgentGatewayTerminalServices,
} from "../src/index";

const gateways: AgentGateway[] = [];
const tempDirs: string[] = [];

describe("agent gateway", () => {
  afterEach(async () => {
    for (const gateway of gateways.splice(0)) {
      await gateway.stop();
    }
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes and removes a loopback descriptor and rejects unauthenticated commands", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const descriptor = parseAgentGatewayDescriptor(
      JSON.parse(await readFile(gateway.descriptorPath, "utf8")) as unknown,
    );
    expect(descriptor.url.startsWith("ws://127.0.0.1:")).toBe(true);
    expect(descriptor.token).toBe("test-token");
    expect(descriptor.pid).toBe(process.pid);

    const client = await AgentTestClient.connect(descriptor.url);
    const denied = await client.request(
      createAgentCommand("terminal.sendText", {
        sessionId: createSessionId("session-1"),
        text: "SECRET_INPUT\r",
      }),
    );

    expect(denied).toMatchObject({
      ok: false,
      error: { type: "auth_required", operation: "terminal.sendText" },
    });
    expect(services.write).not.toHaveBeenCalled();
    client.close();

    await gateway.stop();
    await expect(readFile(gateway.descriptorPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("authenticates and maps terminal commands to services with agent origin", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expectAuthenticate(client);
    const created = await client.request(
      createAgentCommand("terminal.create", { cols: 80, rows: 24 }),
    );
    expect(created).toMatchObject({ ok: true, value: { createdBy: "agent" } });
    const sessionId = (created as Extract<AgentCommandResult, { ok: true }>).value
      .sessionId as SessionId;

    await client.request(
      createAgentCommand("terminal.sendText", {
        sessionId,
        text: "echo PHASE3\r",
      }),
    );
    await client.request(createAgentCommand("terminal.sendKey", { sessionId, key: "Ctrl+C" }));
    await client.request(createAgentCommand("terminal.resize", { sessionId, cols: 100, rows: 30 }));
    await client.request(
      createAgentCommand("terminal.readRecentOutput", { sessionId, maxBytes: 50 }),
    );
    await client.request(
      createAgentCommand("terminal.waitForQuiet", { sessionId, quietMs: 1, timeoutMs: 50 }),
    );
    await client.request(createAgentCommand("terminal.kill", { sessionId }));

    expect(services.createSession).toHaveBeenCalledWith({
      cols: 80,
      rows: 24,
      createdBy: "agent",
    });
    expect(services.displaySession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, createdBy: "agent" }),
    );
    expect(services.write).toHaveBeenCalledWith({
      sessionId,
      data: "echo PHASE3\r",
      origin: "agent",
    });
    expect(services.sendKey).toHaveBeenCalledWith({ sessionId, key: "Ctrl+C", origin: "agent" });
    expect(services.resize).toHaveBeenCalledWith({ sessionId, cols: 100, rows: 30 });
    expect(services.kill).toHaveBeenCalledWith({ sessionId });
    client.close();
  });

  it("rejects wrong tokens without authenticating the connection or mutating sessions", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(
      client.request(createAgentCommand("agent.authenticate", { token: "wrong-token" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_failed", operation: "agent.authenticate" },
    });
    await expect(
      client.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_required", operation: "terminal.create" },
    });

    expect(services.createSession).not.toHaveBeenCalled();
    client.close();
  });

  it("still requires authentication when policy allows an unauthenticated command", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const policy: AgentPolicy = {
      authorize: vi.fn(() => ({ type: "allow", decisionId: "decision-allow" })),
    };
    const gateway = await startAgentGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
      policy,
      token: "test-token",
      tokenExpiresAt: "2026-05-11T00:05:00.000Z",
      now: () => new Date("2026-05-11T00:00:00.000Z"),
    });
    gateways.push(gateway);
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(
      client.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_required", operation: "terminal.create" },
    });

    expect(
      vi
        .mocked(policy.authorize)
        .mock.calls.some(([request]) => request.operation.type === "terminal.create"),
    ).toBe(true);
    expect(services.createSession).not.toHaveBeenCalled();
    client.close();
  });

  it("rejects expired tokens without authenticating the connection or mutating sessions", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
      tokenExpiresAt: "2026-05-11T00:00:00.000Z",
      now: () => new Date("2026-05-11T00:00:01.000Z"),
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(
      client.request(createAgentCommand("agent.authenticate", { token: "test-token" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_failed", operation: "agent.authenticate" },
    });
    await expect(
      client.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_required", operation: "terminal.create" },
    });

    expect(services.createSession).not.toHaveBeenCalled();
    client.close();
  });

  it("routes authentication through policy before mutating connection auth state", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const policy: AgentPolicy = {
      authorize: vi.fn(() => ({
        type: "deny",
        decisionId: "decision-auth-deny",
        reason: {
          decisionId: "decision-auth-deny",
          code: "remote_control_disabled",
          message: "Remote agent control is disabled.",
          operation: "agent.authenticate",
        },
      })),
    };
    const gateway = await startAgentGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
      policy,
      token: "test-token",
      tokenExpiresAt: "2026-05-11T00:05:00.000Z",
      now: () => new Date("2026-05-11T00:00:00.000Z"),
    });
    gateways.push(gateway);
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(
      client.request(createAgentCommand("agent.authenticate", { token: "test-token" })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "policy_denied", operation: "agent.authenticate" },
    });
    await expect(
      client.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
    ).resolves.toMatchObject({
      ok: false,
      error: { type: "policy_denied", operation: "terminal.create" },
    });

    expect(
      vi
        .mocked(policy.authorize)
        .mock.calls.some(([request]) => request.operation.type === "agent.authenticate"),
    ).toBe(true);
    expect(services.createSession).not.toHaveBeenCalled();
    client.close();
  });

  it("passes safe operation metadata to policy without raw terminal input", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const policy: AgentPolicy = {
      authorize: vi.fn(() => ({ type: "allow", decisionId: "decision-safe-context" })),
    };
    const gateway = await startAgentGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
      policy,
      token: "test-token",
      tokenExpiresAt: "2026-05-11T00:05:00.000Z",
      now: () => new Date("2026-05-11T00:00:00.000Z"),
    });
    gateways.push(gateway);
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expectAuthenticate(client);
    const created = await client.request(
      createAgentCommand("terminal.create", {
        cols: 80,
        rows: 24,
        cwd: "/workspace",
        shell: "/bin/sh",
      }),
    );
    const sessionId = (created as Extract<AgentCommandResult, { ok: true }>).value
      .sessionId as SessionId;
    await client.request(
      createAgentCommand("terminal.sendText", {
        sessionId,
        text: "SECRET_INPUT\r",
      }),
    );

    const operations = vi
      .mocked(policy.authorize)
      .mock.calls.map(([request]) => request.operation as Record<string, unknown>);
    expect(operations).toContainEqual(expect.objectContaining({ type: "agent.authenticate" }));
    expect(operations).toContainEqual(
      expect.objectContaining({
        type: "terminal.create",
        cwd: "/workspace",
        shell: "/bin/sh",
      }),
    );
    const sendTextOperation = operations.find(
      (operation) => operation.type === "terminal.sendText",
    );
    expect(sendTextOperation).toMatchObject({
      sessionId,
      inputKind: "text",
    });
    expect(JSON.stringify(sendTextOperation)).not.toContain("SECRET_INPUT");
    client.close();
  });

  it("rejects malformed raw messages without terminal side effects", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(client.requestRaw("not-json")).resolves.toMatchObject({
      ok: false,
      error: { type: "invalid_request", operation: "agent.command" },
    });

    expect(services.createSession).not.toHaveBeenCalled();
    expect(services.write).not.toHaveBeenCalled();
    client.close();
  });

  it("preserves request ids from malformed agent command envelopes", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);

    await expect(
      client.requestRaw(
        JSON.stringify({
          type: "terminal.resize",
          requestId: "malformed-request-1",
          payload: { cols: 0, rows: 24 },
        }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      requestId: "malformed-request-1",
      error: { type: "invalid_request", operation: "agent.command" },
    });

    expect(services.resize).not.toHaveBeenCalled();
    client.close();
  });

  it("requires session ownership, streams only owned session events, and audits without payload leaks", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const auditEvents: AgentAuditEvent[] = [];
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
      audit: (event) => auditEvents.push(event),
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);
    const otherClient = await AgentTestClient.connect(gateway.descriptor.url);
    await expectAuthenticate(client);
    await expectAuthenticate(otherClient);

    const firstSession = createSessionId("session-owned-1");
    const secondSession = createSessionId("session-owned-2");
    services.addSession(firstSession);
    services.addSession(secondSession);
    await client.request(createAgentCommand("terminal.attach", { sessionId: firstSession }));
    await otherClient.request(createAgentCommand("terminal.attach", { sessionId: secondSession }));

    const denied = await client.request(
      createAgentCommand("terminal.kill", { sessionId: secondSession }),
    );
    expect(denied).toMatchObject({
      ok: false,
      error: { type: "policy_denied", sessionId: secondSession },
    });
    expect(services.kill).not.toHaveBeenCalled();

    services.emit({
      type: "session.output",
      payload: { sessionId: firstSession, data: "owned output" },
    });
    expect(await client.waitForEvent("terminal.output")).toMatchObject({
      type: "terminal.output",
      payload: { sessionId: firstSession, data: "owned output" },
    });
    await expect(otherClient.waitForEvent("terminal.output", 100)).rejects.toThrow();
    services.emit({
      type: "session.title",
      payload: { sessionId: firstSession, title: "vim package.json" },
    });
    expect(await client.waitForEvent("terminal.title")).toMatchObject({
      type: "terminal.title",
      payload: { sessionId: firstSession, title: "vim package.json" },
    });
    services.emit({
      type: "session.bell",
      payload: { sessionId: firstSession },
    });
    expect(await client.waitForEvent("terminal.bell")).toMatchObject({
      type: "terminal.bell",
      payload: { sessionId: firstSession },
    });

    const auditText = JSON.stringify(auditEvents);
    expect(auditText).toContain("terminal.kill");
    expect(auditText).not.toContain("test-token");
    expect(auditText).not.toContain("owned output");
    expect(auditText).not.toContain("SECRET_INPUT");
    client.close();
    otherClient.close();
  });

  it("propagates renderer-dependent observation errors as structured terminal errors", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);
    await expectAuthenticate(client);
    const sessionId = createSessionId("session-observation");
    services.addSession(sessionId);
    await client.request(createAgentCommand("terminal.attach", { sessionId }));
    services.captureScreen.mockRejectedValueOnce(
      createTerminalError("observation_unavailable", "No renderer window is available.", {
        sessionId,
        operation: "terminal.captureScreen",
      }),
    );

    await expect(
      client.request(createAgentCommand("terminal.captureScreen", { sessionId, timeoutMs: 50 })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        type: "observation_unavailable",
        sessionId,
        operation: "terminal.captureScreen",
      },
    });
    client.close();
  });

  it("keeps agent-created sessions usable when renderer display fails", async () => {
    const tempDir = await createTempDir();
    const services = createFakeServices();
    const gateway = await startTestGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(tempDir),
      services,
    });
    const client = await AgentTestClient.connect(gateway.descriptor.url);
    await expectAuthenticate(client);
    services.displaySession.mockRejectedValueOnce(
      createTerminalError("observation_unavailable", "Renderer window is unavailable.", {
        operation: "terminal.display",
        cause: "DISPLAY is not set",
      }),
    );

    await expect(
      client.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
    ).resolves.toMatchObject({
      ok: true,
      value: { createdBy: "agent" },
    });
    await expect(client.waitForEvent("terminal.error")).resolves.toMatchObject({
      type: "terminal.error",
      payload: {
        type: "observation_unavailable",
        operation: "terminal.display",
        cause: "DISPLAY is not set",
      },
    });

    const sessionId = createSessionId("session-created-1");
    await expect(
      client.request(createAgentCommand("terminal.sendText", { sessionId, text: "echo ok\r" })),
    ).resolves.toMatchObject({ ok: true });
    expect(services.write).toHaveBeenCalledWith({
      sessionId,
      data: "echo ok\r",
      origin: "agent",
    });
    client.close();
  });
});

async function startTestGateway({
  descriptorPath,
  services,
  audit,
  now,
  tokenExpiresAt,
}: {
  descriptorPath: string;
  services: ReturnType<typeof createFakeServices>;
  audit?: (event: AgentAuditEvent) => void;
  now?: () => Date;
  tokenExpiresAt?: string;
}): Promise<AgentGateway> {
  const gateway = await startAgentGateway({
    descriptorPath,
    services,
    policy: createDefaultAgentPolicy({ createDecisionId: () => "decision-test" }),
    token: "test-token",
    tokenExpiresAt: tokenExpiresAt ?? "2026-05-11T00:05:00.000Z",
    now: now ?? (() => new Date("2026-05-11T00:00:00.000Z")),
    audit,
  });
  gateways.push(gateway);
  return gateway;
}

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-gateway-test-"));
  tempDirs.push(dir);
  return dir;
}

async function expectAuthenticate(client: AgentTestClient): Promise<void> {
  await expect(
    client.request(
      createAgentCommand("agent.authenticate", { token: "test-token" }, createRequestId()),
    ),
  ).resolves.toMatchObject({
    ok: true,
    value: { tokenExpiresAt: "2026-05-11T00:05:00.000Z" },
  });
}

function createFakeServices(): AgentGatewayTerminalServices & {
  addSession(sessionId: SessionId): TerminalSessionSnapshot;
  emit(event: RendererSessionEvent): void;
  createSession: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["createSession"]>>;
  write: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["write"]>>;
  sendKey: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["sendKey"]>>;
  resize: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["resize"]>>;
  kill: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["kill"]>>;
  captureScreen: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["captureScreen"]>>;
  displaySession: ReturnType<typeof vi.fn<AgentGatewayTerminalServices["displaySession"]>>;
} {
  const sessions = new Map<SessionId, TerminalSessionSnapshot>();
  const handlers = new Set<(event: RendererSessionEvent) => void>();
  const addSession = (sessionId: SessionId): TerminalSessionSnapshot => {
    const snapshot = createSnapshot(sessionId);
    sessions.set(sessionId, snapshot);
    return snapshot;
  };
  const emit = (event: RendererSessionEvent): void => {
    for (const handler of handlers) handler(event);
  };

  return {
    addSession,
    emit,
    listSessions: () => [...sessions.values()],
    createSession: vi.fn<AgentGatewayTerminalServices["createSession"]>((request) => {
      const snapshot = {
        ...createSnapshot(createSessionId(`session-created-${sessions.size + 1}`)),
        state: request.createdBy === "agent" ? "detached" : "running",
        cols: request.cols,
        rows: request.rows,
        createdBy: request.createdBy ?? "human",
      };
      sessions.set(snapshot.sessionId, snapshot);
      emit({ type: "session.created", payload: snapshot });
      return Promise.resolve(snapshot);
    }),
    displaySession: vi.fn<AgentGatewayTerminalServices["displaySession"]>(() => Promise.resolve()),
    getSession: vi.fn<AgentGatewayTerminalServices["getSession"]>(({ sessionId }) => {
      const snapshot = sessions.get(sessionId);
      if (!snapshot) {
        throw new Error(`Missing session ${sessionId}`);
      }
      return snapshot;
    }),
    write: vi.fn<AgentGatewayTerminalServices["write"]>(() => Promise.resolve()),
    sendKey: vi.fn<AgentGatewayTerminalServices["sendKey"]>(() => Promise.resolve()),
    resize: vi.fn<AgentGatewayTerminalServices["resize"]>(() => Promise.resolve()),
    readRecentOutput: vi.fn<AgentGatewayTerminalServices["readRecentOutput"]>(
      ({ sessionId, maxBytes }) => ({
        sessionId,
        data: "recent output",
        maxBytes,
        capturedAt: "2026-05-11T00:00:00.000Z",
      }),
    ),
    captureScreen: vi.fn<AgentGatewayTerminalServices["captureScreen"]>(() =>
      Promise.reject(new Error("not used")),
    ),
    waitForText: vi.fn<AgentGatewayTerminalServices["waitForText"]>(({ sessionId }) =>
      Promise.resolve({ sessionId, matchedAt: "2026-05-11T00:00:00.000Z" }),
    ),
    waitForQuiet: vi.fn<AgentGatewayTerminalServices["waitForQuiet"]>(({ sessionId }) =>
      Promise.resolve({ sessionId, matchedAt: "2026-05-11T00:00:00.000Z" }),
    ),
    waitForScreenChange: vi.fn<AgentGatewayTerminalServices["waitForScreenChange"]>(
      ({ sessionId }) => Promise.resolve({ sessionId, matchedAt: "2026-05-11T00:00:00.000Z" }),
    ),
    waitForPrompt: vi.fn<AgentGatewayTerminalServices["waitForPrompt"]>(({ sessionId }) =>
      Promise.resolve({ sessionId, matchedAt: "2026-05-11T00:00:00.000Z" }),
    ),
    kill: vi.fn<AgentGatewayTerminalServices["kill"]>(() => Promise.resolve()),
    onSessionEvent(handler: (event: RendererSessionEvent) => void): Unsubscribe {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

function createSnapshot(sessionId: SessionId): TerminalSessionSnapshot {
  return {
    sessionId,
    state: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    title: null,
    createdBy: "agent",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
  };
}

class AgentTestClient {
  private readonly pendingMessages: unknown[] = [];
  private readonly waiters = new Set<(message: unknown) => boolean>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      void parseWebSocketMessage(event.data).then((message) => {
        for (const waiter of [...this.waiters]) {
          if (waiter(message)) {
            return;
          }
        }
        this.pendingMessages.push(message);
      });
    });
  }

  static async connect(url: string): Promise<AgentTestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket connection failed.")), {
        once: true,
      });
    });
    return new AgentTestClient(socket);
  }

  async request(command: unknown): Promise<AgentCommandResult> {
    return this.requestRaw(JSON.stringify(command));
  }

  async requestRaw(message: string): Promise<AgentCommandResult> {
    const response = this.waitForResult();
    this.socket.send(message);
    return response;
  }

  waitForEvent(type: AgentEvent["type"], timeoutMs = 1000): Promise<AgentEvent> {
    return this.waitForMessage((message): message is AgentEvent => {
      return (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === type
      );
    }, timeoutMs);
  }

  close(): void {
    this.socket.close();
  }

  private waitForResult(timeoutMs = 1000): Promise<AgentCommandResult> {
    return this.waitForMessage((message): message is AgentCommandResult => {
      return typeof message === "object" && message !== null && "ok" in message;
    }, timeoutMs);
  }

  private waitForMessage<T>(
    predicate: (message: unknown) => message is T,
    timeoutMs: number,
  ): Promise<T> {
    const queuedIndex = this.pendingMessages.findIndex((message) => predicate(message));
    if (queuedIndex !== -1) {
      const [message] = this.pendingMessages.splice(queuedIndex, 1);
      return Promise.resolve(message as T);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Timed out waiting for WebSocket message."));
      }, timeoutMs);
      const waiter = (message: unknown): boolean => {
        if (!predicate(message)) {
          return false;
        }
        clearTimeout(timeout);
        this.waiters.delete(waiter);
        resolve(message);
        return true;
      };
      this.waiters.add(waiter);
    });
  }
}

async function parseWebSocketMessage(data: unknown): Promise<unknown> {
  if (typeof data === "string") {
    return JSON.parse(data) as unknown;
  }
  if (data instanceof Blob) {
    return JSON.parse(await data.text()) as unknown;
  }
  if (data instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(data).toString("utf8")) as unknown;
  }
  if (ArrayBuffer.isView(data)) {
    return JSON.parse(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"),
    ) as unknown;
  }
  return JSON.parse(String(data)) as unknown;
}
