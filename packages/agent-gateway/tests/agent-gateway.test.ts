import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { createDefaultAgentPolicy } from "@terminal/policy-engine";
import {
  TERMINAL_PROTOCOL_VERSION,
  createAgentCommand,
  createOperationId,
  createRequestId,
  createSessionId,
  parseAgentCommandResult,
  type AgentCommandResult,
  type AgentGatewayDescriptor,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import {
  resolveAgentGatewayDescriptorPath,
  startAgentGateway,
  type AgentGateway,
  type AgentTerminalService,
} from "../src/index";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("agent gateway", () => {
  it("publishes a versioned loopback descriptor and authenticates the fixed protocol", async () => {
    const runtime = await createRuntime();
    const descriptor = JSON.parse(
      await readFile(runtime.descriptorPath, "utf8"),
    ) as AgentGatewayDescriptor;

    expect(descriptor.protocolVersion).toBe(TERMINAL_PROTOCOL_VERSION);
    expect(descriptor.url).toMatch(/^ws:\/\/127\.0\.0\.1:/);

    const client = await AgentClient.connect(descriptor.url);
    const result = await client.request(
      createAgentCommand("agent.authenticate", {
        token: "test-token",
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { protocolVersion: TERMINAL_PROTOCOL_VERSION },
    });
    client.close();
  });

  it("rejects unauthenticated requests and removed command names", async () => {
    const runtime = await createRuntime();
    const client = await AgentClient.connect(runtime.gateway.descriptor.url);

    await expect(client.request(createAgentCommand("terminal.list", {}))).resolves.toMatchObject({
      ok: false,
      error: { type: "auth_required" },
    });
    await expect(
      client.requestRaw({
        type: "terminal.sendText",
        requestId: createRequestId(),
        payload: { sessionId: createSessionId("old"), text: "echo old\r" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { type: "invalid_request" } });
    client.close();
  });

  it("dispatches the terminal API through one narrow service", async () => {
    const services = createServices();
    const runtime = await createRuntime(services);
    const client = await authenticatedClient(runtime.gateway.descriptor);
    const created = await client.request(createAgentCommand("terminal.create", { cwd: "/tmp" }));
    const sessionId = successValue<TerminalSessionSummary>(created).sessionId;

    await client.request(
      createAgentCommand("terminal.run", {
        input: "printf captured",
        tty: false,
        timeoutMs: 100,
      }),
    );
    await client.request(createAgentCommand("terminal.input", { sessionId, input: "\u0003" }));
    await client.request(createAgentCommand("terminal.resize", { sessionId, cols: 100, rows: 30 }));
    await client.request(
      createAgentCommand("terminal.scroll", {
        sessionId,
        scroll: { type: "edge", edge: "bottom" },
      }),
    );
    await client.request(
      createAgentCommand("terminal.setPresentation", {
        sessionId,
        presentation: "background",
      }),
    );
    await client.request(createAgentCommand("terminal.observe", { sessionId, timeoutMs: 100 }));
    await client.request(createAgentCommand("terminal.recording.start", { sessionId }));
    await client.request(createAgentCommand("terminal.recording.stop", { sessionId }));
    await client.request(createAgentCommand("terminal.recording.export", { sessionId }));
    await client.request(createAgentCommand("terminal.close", { sessionId }));

    expect(services.input).toHaveBeenCalledWith({ sessionId, input: "\u0003" });
    expect(services.run).toHaveBeenCalledWith({
      input: "printf captured",
      tty: false,
      timeoutMs: 100,
    });
    expect(services.observe).toHaveBeenCalledWith(
      { sessionId, timeoutMs: 100 },
      expect.any(AbortSignal),
    );
    expect(services.close).toHaveBeenCalledWith({ sessionId });
    expect(services.setPresentation).toHaveBeenCalledWith({
      sessionId,
      presentation: "background",
    });
    client.close();
  });

  it("automatically attaches a running temporary PTY to its creating connection", async () => {
    const services = createServices();
    const sessionId = createSessionId("temporary-pty");
    const operationId = createOperationId("temporary-operation");
    services.run.mockResolvedValueOnce({
      status: "running",
      operationId,
      sessionId,
      tty: true,
      observationVersion: 1,
      elapsedMs: 10,
    });
    const runtime = await createRuntime(services);
    const first = await authenticatedClient(runtime.gateway.descriptor);
    const second = await authenticatedClient(runtime.gateway.descriptor);

    await expect(
      first.request(createAgentCommand("terminal.run", { input: "vim", tty: true })),
    ).resolves.toMatchObject({ ok: true, value: { sessionId, tty: true, status: "running" } });
    await expect(
      second.request(createAgentCommand("terminal.attach", { sessionId })),
    ).resolves.toMatchObject({ ok: false, error: { type: "session_in_use" } });

    await expect(
      first.request(createAgentCommand("terminal.close", { operationId })),
    ).resolves.toMatchObject({ ok: true, value: { status: "closed" } });
    await waitForAttach(second, sessionId);
    first.close();
    second.close();
  });

  it("allows operation observation and close after reconnect", async () => {
    const services = createServices();
    const operationId = createOperationId("reconnect-operation");
    services.observe.mockResolvedValueOnce({
      status: "timeout",
      operationId,
      version: 3,
    });
    const runtime = await createRuntime(services);
    const first = await authenticatedClient(runtime.gateway.descriptor);
    first.close();
    const second = await authenticatedClient(runtime.gateway.descriptor);

    await expect(
      second.request(
        createAgentCommand("terminal.observe", {
          operationId,
          afterVersion: 3,
          timeoutMs: 5,
        }),
      ),
    ).resolves.toMatchObject({ ok: true, value: { operationId, status: "timeout" } });
    await expect(
      second.request(createAgentCommand("terminal.close", { operationId })),
    ).resolves.toMatchObject({ ok: true, value: { status: "closed" } });

    expect(services.close).toHaveBeenCalledWith({ operationId });
    second.close();
  });

  it("allows metadata queries without attachment", async () => {
    const services = createServices();
    const runtime = await createRuntime(services);
    const client = await authenticatedClient(runtime.gateway.descriptor);
    const sessionId = createSessionId("existing");

    await expect(client.request(createAgentCommand("terminal.list", {}))).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      client.request(createAgentCommand("terminal.get", { sessionId })),
    ).resolves.toMatchObject({ ok: true });
    expect(services.list).toHaveBeenCalledOnce();
    expect(services.get).toHaveBeenCalledWith({ sessionId });
    client.close();
  });

  it("enforces one controlling agent and releases attachment on disconnect", async () => {
    const services = createServices();
    const runtime = await createRuntime(services);
    const first = await authenticatedClient(runtime.gateway.descriptor);
    const second = await authenticatedClient(runtime.gateway.descriptor);
    const sessionId = createSessionId("shared");

    await expect(
      first.request(createAgentCommand("terminal.attach", { sessionId })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      second.request(createAgentCommand("terminal.attach", { sessionId })),
    ).resolves.toMatchObject({ ok: false, error: { type: "session_in_use" } });

    first.close();
    await waitForAttach(second, sessionId);
    second.close();
  });

  it("aborts pending observations when a connection closes", async () => {
    const services = createServices();
    let observedSignal: AbortSignal | undefined;
    services.observe.mockImplementation((_request, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const runtime = await createRuntime(services);
    const client = await authenticatedClient(runtime.gateway.descriptor);
    const sessionId = createSessionId("observed");
    await client.request(createAgentCommand("terminal.attach", { sessionId }));

    void client.request(
      createAgentCommand("terminal.observe", { sessionId, afterVersion: 1, timeoutMs: 10_000 }),
    );
    await waitFor(() => observedSignal !== undefined);
    client.close();
    await waitFor(() => observedSignal?.aborted === true);

    expect(observedSignal?.aborted).toBe(true);
  });

  it("audits safe metadata without terminal input", async () => {
    const audit = vi.fn();
    const runtime = await createRuntime(createServices(), audit);
    const client = await authenticatedClient(runtime.gateway.descriptor);
    const sessionId = createSessionId("audit");
    await client.request(createAgentCommand("terminal.attach", { sessionId }));
    await client.request(
      createAgentCommand("terminal.input", { sessionId, input: "SECRET_TERMINAL_INPUT" }),
    );
    await client.request(
      createAgentCommand("terminal.run", {
        input: "SECRET_RUN_INPUT",
        env: { SECRET_ENVIRONMENT_VALUE: "SECRET_VALUE" },
      }),
    );

    const serialized = JSON.stringify(audit.mock.calls);
    expect(serialized).toContain("terminal.input");
    expect(serialized).not.toContain("SECRET_TERMINAL_INPUT");
    expect(serialized).not.toContain("SECRET_RUN_INPUT");
    expect(serialized).not.toContain("SECRET_VALUE");
    client.close();
  });
});

async function createRuntime(
  services = createServices(),
  audit = vi.fn(),
): Promise<{ gateway: AgentGateway; descriptorPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-gateway-"));
  const descriptorPath = resolveAgentGatewayDescriptorPath(directory);
  const gateway = await startAgentGateway({
    descriptorPath,
    services,
    policy: createDefaultAgentPolicy(),
    token: "test-token",
    tokenExpiresAt: "2099-01-01T00:00:00.000Z",
    audit,
  });
  cleanups.push(async () => {
    await gateway.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { gateway, descriptorPath };
}

function createServices() {
  const summary = sessionSummary(createSessionId("existing"));
  return {
    list: vi.fn<AgentTerminalService["list"]>(() => [summary]),
    get: vi.fn<AgentTerminalService["get"]>(({ sessionId }) => ({
      ...summary,
      sessionId,
    })),
    create: vi.fn<AgentTerminalService["create"]>(() =>
      Promise.resolve(sessionSummary(createSessionId("created"))),
    ),
    attach: vi.fn<AgentTerminalService["attach"]>(({ sessionId }) =>
      Promise.resolve(sessionSummary(sessionId)),
    ),
    run: vi.fn<AgentTerminalService["run"]>(() =>
      Promise.resolve({
        status: "completed",
        operationId: createOperationId("captured"),
        tty: false,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
      }),
    ),
    input: vi.fn<AgentTerminalService["input"]>(() =>
      Promise.resolve({ accepted: true, observationVersion: 1 }),
    ),
    resize: vi.fn<AgentTerminalService["resize"]>(() => Promise.resolve({ observationVersion: 2 })),
    scroll: vi.fn<AgentTerminalService["scroll"]>(() => ({
      status: "unchanged",
      observationVersion: 2,
    })),
    setPresentation: vi.fn<AgentTerminalService["setPresentation"]>(() =>
      Promise.resolve({
        state: "background",
        windowVisible: true,
        windowFocused: false,
      }),
    ),
    observe: vi.fn<AgentTerminalService["observe"]>((request) =>
      Promise.resolve(
        "sessionId" in request
          ? { status: "timeout" as const, sessionId: request.sessionId, version: 2 }
          : { status: "timeout" as const, operationId: request.operationId, version: 2 },
      ),
    ),
    close: vi.fn<AgentTerminalService["close"]>(() =>
      Promise.resolve({ status: "closed", exitCode: 0, signal: null }),
    ),
    startRecording: vi.fn<AgentTerminalService["startRecording"]>(() => Promise.resolve()),
    stopRecording: vi.fn<AgentTerminalService["stopRecording"]>(() => Promise.resolve()),
    exportRecording: vi.fn<AgentTerminalService["exportRecording"]>(({ sessionId }) =>
      Promise.resolve({
        schemaVersion: 1,
        sessionId,
        exportedAt: "2026-01-01T00:00:00.000Z",
        events: [],
      }),
    ),
  };
}

function sessionSummary(sessionId: ReturnType<typeof createSessionId>): TerminalSessionSummary {
  return {
    sessionId,
    lifecycle: "running",
    shell: "/bin/sh",
    cwd: "/tmp",
    dimensions: { cols: 80, rows: 24 },
    title: null,
    createdBy: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    observationVersion: 1,
    presentation: { state: "headless", windowVisible: false, windowFocused: false },
    shellIntegration: {
      status: "unavailable",
      capabilities: {
        prompt: false,
        commandStart: false,
        commandFinish: false,
        commandLine: false,
        exitCode: false,
        cwd: false,
      },
    },
    command: { state: "unknown" },
    recording: { state: "inactive" },
  };
}

async function authenticatedClient(descriptor: AgentGatewayDescriptor): Promise<AgentClient> {
  const client = await AgentClient.connect(descriptor.url);
  await client.request(
    createAgentCommand("agent.authenticate", {
      token: "test-token",
      protocolVersion: TERMINAL_PROTOCOL_VERSION,
    }),
  );
  return client;
}

function successValue<T>(result: AgentCommandResult): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAttach(
  client: AgentClient,
  sessionId: ReturnType<typeof createSessionId>,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const result = await client.request(createAgentCommand("terminal.attach", { sessionId }));
    if (result.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Agent attachment was not released.");
}

class AgentClient {
  private readonly pending: Array<(result: AgentCommandResult) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const resolve = this.pending.shift();
      resolve?.(parseAgentCommandResult(JSON.parse(rawDataToString(data)) as unknown));
    });
  }

  static async connect(url: string): Promise<AgentClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new AgentClient(socket);
  }

  request(command: unknown): Promise<AgentCommandResult> {
    return this.requestRaw(command);
  }

  requestRaw(command: unknown): Promise<AgentCommandResult> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.socket.send(JSON.stringify(command));
    });
  }

  close(): void {
    this.socket.close();
  }
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
