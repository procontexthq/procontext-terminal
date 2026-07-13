import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

import { defaultTerminalConfig } from "@terminal/config";
import {
  TERMINAL_PROTOCOL_VERSION,
  createAgentCommand,
  createOperationId,
  createSessionId,
  parseAgentGatewayDescriptor,
  type AgentCommandResult,
  type AgentGatewayDescriptor,
  type ObserveTerminalResult,
  type SessionId,
  type TerminalObservation,
  type TerminalSessionSummary,
} from "@terminal/protocol";

import { alternateScreenCommand, interruptFixtureCommand, nodeEvalCommand } from "./e2e-commands";
import { terminalUiTimeoutMs } from "./e2e-timeouts";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const e2eUiTimeoutMs = terminalUiTimeoutMs(process.platform);
const e2eAppLaunchTimeoutMs = process.platform === "linux" && process.env.CI ? 60_000 : 30_000;

let electronProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;
let electronOutput = "";
let rendererOutput = "";
const tempUserDataDirs: string[] = [];

describe("desktop terminal smoke", () => {
  afterEach(async () => {
    const connectedBrowser = browser;
    browser = null;
    await stopElectronProcess();
    if (connectedBrowser) await settleWithin(connectedBrowser.close(), 5_000);
    for (const dir of tempUserDataDirs.splice(0)) await removeTempDir(dir);
  }, 30_000);

  it("runs a human terminal with raw input, resize, interrupt, and clean exit", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const sessionId = await activeSessionId(page);
    await expectSessionCwd(page, sessionId, homedir());

    await writeRendererInput(page, sessionId, `${platformPrintCommand("HUMAN_READY")}\r`);
    await waitForTerminalText(page, "HUMAN_READY");
    await page.setViewportSize({ width: 960, height: 640 });

    const interruptReady = "HUMAN_INTERRUPT_READY";
    const interruptHandled = "HUMAN_INTERRUPT_HANDLED";
    await writeRendererInput(
      page,
      sessionId,
      `${interruptFixtureCommand(interruptReady, interruptHandled)}\r`,
    );
    await waitForTerminalText(page, interruptReady);
    await writeRendererInput(page, sessionId, "\u0003");
    await waitForTerminalText(page, interruptHandled);
    await writeRendererCommandUntilText(
      page,
      sessionId,
      platformPrintCommand("AFTER_INTERRUPT"),
      "AFTER_INTERRUPT",
    );

    await writeRendererInput(page, sessionId, "exit\r");
    await waitForStatus(page, "exited");
    await page.getByTestId("terminal-exit-message").waitFor({ timeout: e2eUiTimeoutMs });
  });

  it("terminates a live session when the human confirms tab close", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);

    page.once("dialog", (dialog) => dialog.accept());
    await Promise.all([page.waitForEvent("close"), page.getByTestId("close-tab-0").click()]);
  });

  it("reattaches a renderer view from canonical serialized state", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const sessionId = await activeSessionId(page);
    await writeRendererInput(page, sessionId, `${platformPrintCommand("REATTACH_STATE")}\r`);
    await waitForTerminalText(page, "REATTACH_STATE");

    await page.evaluate(
      (activeSessionId) => window.terminalApi.closeView({ sessionId: activeSessionId }),
      sessionId,
    );
    const headless = await page.evaluate(
      (activeSessionId) => window.terminalApi.getSession({ sessionId: activeSessionId }),
      sessionId,
    );
    const bootstrap = await page.evaluate(
      (activeSessionId) => window.terminalApi.openView({ sessionId: activeSessionId }),
      sessionId,
    );

    if (headless.presentation.state !== "headless") {
      throw new Error(
        `Expected closed renderer view to become headless: ${headless.presentation.state}`,
      );
    }
    if (
      bootstrap.session.presentation.state !== "background" ||
      !bootstrap.serialized.includes("REATTACH_STATE")
    ) {
      throw new Error("Expected renderer reattachment to use canonical serialized state.");
    }
  });

  it("keeps agent-created sessions headless and transfers exclusive control on disconnect", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const first = await authenticatedAgent(descriptor);
    const second = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        first.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
      )) as TerminalSessionSummary;
      if (created.presentation.state !== "headless") {
        throw new Error(`Expected headless agent session, got ${created.presentation.state}.`);
      }
      await expectTabCount(page, 1);

      const denied = await second.request(
        createAgentCommand("terminal.attach", { sessionId: created.sessionId }),
      );
      if (denied.ok || denied.error.type !== "session_in_use") {
        throw new Error(`Expected exclusive attachment denial: ${JSON.stringify(denied)}`);
      }

      first.close();
      await attachEventually(second, created.sessionId);
      await expectAgentOk(
        second.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: `${platformPrintCommand("HEADLESS_AGENT_OK")}\r`,
          }),
        ),
      );
      await waitForObservation(second, created.sessionId, (observation) =>
        observation.viewport.rows.some((row) => row.text.includes("HEADLESS_AGENT_OK")),
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("runs captured and interactive temporary one-shot operations headlessly", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const captured = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.run", {
            input: nodeEvalCommand(
              'process.stdout.write("CAPTURED_OUT"); process.stderr.write("CAPTURED_ERR");',
            ),
            tty: false,
            timeoutMs: e2eUiTimeoutMs,
          }),
        ),
      );
      if (
        !isRecord(captured) ||
        captured.status !== "completed" ||
        captured.tty !== false ||
        captured.stdout !== "CAPTURED_OUT" ||
        captured.stderr !== "CAPTURED_ERR"
      ) {
        throw new Error(`Unexpected captured run result: ${JSON.stringify(captured)}`);
      }

      const temporary = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.run", {
            input: nodeEvalCommand(
              [
                'process.stdin.setEncoding("utf8");',
                'process.stdin.on("data", (data) => {',
                '  if (data.includes("continue")) {',
                '    process.stdout.write("TEMPORARY_DONE\\n");',
                "    process.exit(0);",
                "  }",
                "});",
                'process.stdout.write("TEMPORARY_READY\\n");',
              ].join("\n"),
            ),
            tty: true,
            timeoutMs: 50,
          }),
        ),
      );
      if (
        !isRecord(temporary) ||
        temporary.status !== "running" ||
        temporary.tty !== true ||
        typeof temporary.sessionId !== "string" ||
        typeof temporary.operationId !== "string"
      ) {
        throw new Error(`Unexpected temporary run result: ${JSON.stringify(temporary)}`);
      }

      const sessionId = createSessionId(temporary.sessionId);
      await waitForObservation(agent, sessionId, (observation) =>
        observation.viewport.rows.some((row) => row.text.includes("TEMPORARY_READY")),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId,
            input: "continue\r",
          }),
        ),
      );
      await waitForObservation(agent, sessionId, (observation) =>
        observation.viewport.rows.some((row) => row.text.includes("TEMPORARY_DONE")),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.close", {
            operationId: createOperationId(temporary.operationId),
          }),
        ),
      );
      await expectTabCount(page, 1);
    } finally {
      agent.close();
    }
  });

  it("observes alternate-screen TUI state from the canonical headless model", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
      )) as TerminalSessionSummary;
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: `${alternateScreenCommand("CANONICAL_ALT_SCREEN")}\r`,
          }),
        ),
      );

      const observation = await waitForObservation(
        agent,
        created.sessionId,
        (current) =>
          current.alternateScreen &&
          current.viewport.rows.some((row) => row.text.includes("CANONICAL_ALT_SCREEN")),
      );
      if (!observation.cursor.visible) {
        throw new Error("Expected alternate-screen cursor visibility to remain observable.");
      }
      await expectAgentOk(
        agent.request(createAgentCommand("terminal.close", { sessionId: created.sessionId })),
      );
    } finally {
      agent.close();
    }
  });

  it("records and redacts raw agent interaction through the new recording namespace", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          recording: { state: "disabled", redactedPatterns: ["SECRET_TOKEN"] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    browser = await launchApp(userDataDir);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.create", {})),
      )) as TerminalSessionSummary;
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.recording.start", { sessionId: created.sessionId }),
        ),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: `${platformPrintCommand("VALUE_SECRET_TOKEN")}\r`,
          }),
        ),
      );
      await waitForObservation(agent, created.sessionId, (observation) =>
        observation.viewport.rows.some((row) => row.text.includes("VALUE_SECRET_TOKEN")),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.recording.stop", { sessionId: created.sessionId }),
        ),
      );
      const exported = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.recording.export", { sessionId: created.sessionId }),
        ),
      );
      const text = JSON.stringify(exported);
      if (!text.includes("VALUE_[redacted]") || text.includes("SECRET_TOKEN")) {
        throw new Error("Expected recording export to redact configured transcript patterns.");
      }
    } finally {
      agent.close();
    }
  });
});

async function authenticatedAgent(descriptor: AgentGatewayDescriptor): Promise<E2EAgentClient> {
  const agent = await E2EAgentClient.connect(descriptor.url);
  await expectAgentOk(
    agent.request(
      createAgentCommand("agent.authenticate", {
        token: descriptor.token,
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
      }),
    ),
  );
  return agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitForObservation(
  agent: E2EAgentClient,
  sessionId: SessionId,
  predicate: (observation: TerminalObservation) => boolean,
): Promise<TerminalObservation> {
  const deadline = Date.now() + e2eUiTimeoutMs;
  let afterVersion = 0;
  let lastObservation: TerminalObservation | null = null;
  while (Date.now() < deadline) {
    const result = (await expectAgentOk(
      agent.request(
        createAgentCommand("terminal.observe", {
          sessionId,
          afterVersion,
          timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
        }),
      ),
    )) as ObserveTerminalResult;
    if (result.status === "changed") {
      lastObservation = result.observation;
      afterVersion = result.observation.version;
      if (predicate(result.observation)) return result.observation;
    } else {
      afterVersion = result.version;
    }
  }
  throw new Error(
    `Timed out waiting for canonical terminal observation. last=${JSON.stringify(lastObservation)}`,
  );
}

async function attachEventually(agent: E2EAgentClient, sessionId: SessionId): Promise<void> {
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    const result = await agent.request(createAgentCommand("terminal.attach", { sessionId }));
    if (result.ok) return;
    if (result.error.type !== "session_in_use") {
      throw new Error(`Unexpected attach failure: ${JSON.stringify(result.error)}`);
    }
    await delay(25);
  }
  throw new Error("Timed out waiting for agent attachment release.");
}

async function createTempUserDataDir(): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), "terminal-e2e-user-data-"));
  tempUserDataDirs.push(userDataDir);
  return userDataDir;
}

async function launchApp(userDataDir: string): Promise<Browser> {
  const appCwd = fileURLToPath(new URL("../../", import.meta.url));
  const port = await getFreePort();
  electronOutput = "";
  rendererOutput = "";
  electronProcess = spawn(
    electronPath,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...platformElectronFlags(),
      "out/main/index.cjs",
    ],
    {
      cwd: appCwd,
      env: e2eEnvironment(),
      detached: process.platform !== "win32",
    },
  );
  electronProcess.stdout.on("data", (chunk: Buffer) => appendElectronOutput("stdout", chunk));
  electronProcess.stderr.on("data", (chunk: Buffer) => appendElectronOutput("stderr", chunk));
  return connectToElectron(port);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate local debug port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function connectToElectron(port: number): Promise<Browser> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + e2eAppLaunchTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error: unknown) {
      lastError = error;
      if (electronProcess?.exitCode !== null) {
        throw new Error(
          `Electron exited before opening CDP with code ${electronProcess?.exitCode}.\n${electronOutput}`,
          { cause: error },
        );
      }
      await delay(100);
    }
  }
  throw new Error(`Timed out connecting to Electron.\n${electronOutput}`, { cause: lastError });
}

async function firstPage(connectedBrowser: Browser): Promise<Page> {
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    for (const context of connectedBrowser.contexts()) {
      const page = context.pages()[0];
      if (page) {
        page.on("console", (message) => {
          if (message.type() === "error" || message.type() === "warning") {
            rendererOutput += `[console:${message.type()}] ${message.text()}\n`;
          }
        });
        page.on("pageerror", (error) => {
          rendererOutput += `[pageerror] ${error.stack ?? error.message}\n`;
        });
        return page;
      }
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Electron page.");
}

async function waitForTerminalReady(page: Page): Promise<void> {
  try {
    await page.waitForSelector("[data-testid='terminal-ready']", {
      timeout: e2eUiTimeoutMs,
    });
  } catch (error: unknown) {
    const state = await page
      .evaluate(() => ({
        url: window.location.href,
        status: document.querySelector("[data-testid='terminal-status']")?.textContent ?? null,
        body: document.body.innerText.slice(0, 2_000),
      }))
      .catch((diagnosticError: unknown) => ({
        diagnosticError:
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      }));
    throw new Error(
      `Terminal renderer did not become ready. state=${JSON.stringify(
        state,
      )}\nrenderer=${rendererOutput}\nelectron=${electronOutput}`,
      { cause: error },
    );
  }
}

async function activeSessionId(page: Page): Promise<SessionId> {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector("[data-testid='terminal-ready']")?.getAttribute("data-session-id"),
      ),
    undefined,
    { timeout: e2eUiTimeoutMs },
  );
  const value = await page
    .locator("[data-testid='terminal-ready']")
    .getAttribute("data-session-id");
  if (!value) throw new Error("Active terminal did not expose a session id.");
  return value as SessionId;
}

async function writeRendererInput(page: Page, sessionId: SessionId, input: string): Promise<void> {
  await page.evaluate(
    ({ activeSessionId, data }) =>
      window.terminalApi.input({ sessionId: activeSessionId, input: data }),
    { activeSessionId: sessionId, data: input },
  );
}

async function expectSessionCwd(page: Page, sessionId: SessionId, cwd: string): Promise<void> {
  const summary = await page.evaluate(
    (activeSessionId) => window.terminalApi.getSession({ sessionId: activeSessionId }),
    sessionId,
  );
  if (summary.cwd !== cwd) throw new Error(`Expected cwd ${cwd}, got ${summary.cwd}.`);
}

async function writeRendererCommandUntilText(
  page: Page,
  sessionId: SessionId,
  command: string,
  expectedText: string,
): Promise<void> {
  const deadline = Date.now() + e2eUiTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await writeRendererInput(page, sessionId, `${command}\r`);
    try {
      await waitForTerminalText(
        page,
        expectedText,
        Math.min(1_000, Math.max(1, deadline - Date.now())),
      );
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new Error(`Terminal did not accept command producing ${expectedText}.`, {
    cause: lastError,
  });
}

async function waitForTerminalText(
  page: Page,
  text: string,
  timeoutMs = e2eUiTimeoutMs,
): Promise<void> {
  try {
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector("[data-testid='terminal-ready'] .xterm-rows")
          ?.textContent?.includes(expected),
      text,
      { timeout: timeoutMs },
    );
  } catch (error: unknown) {
    const screen = await page
      .locator("[data-testid='terminal-ready'] .xterm-rows")
      .textContent()
      .catch(() => null);
    throw new Error(`Timed out waiting for terminal text ${text}. screen=${screen}`, {
      cause: error,
    });
  }
}

async function waitForStatus(page: Page, status: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("[data-testid='terminal-status']")?.textContent?.includes(expected),
    status,
    { timeout: e2eUiTimeoutMs },
  );
}

async function expectTabCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("[data-terminal-tab='true']").length === expected,
    count,
    { timeout: e2eUiTimeoutMs },
  );
}

async function waitForAgentDescriptor(userDataDir: string): Promise<AgentGatewayDescriptor> {
  const descriptorPath = join(userDataDir, "agent-gateway.json");
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    try {
      return parseAgentGatewayDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
      );
    } catch {
      await delay(50);
    }
  }
  throw new Error("Timed out waiting for agent gateway descriptor.");
}

async function stopElectronProcess(): Promise<void> {
  const child = electronProcess;
  if (!child) return;
  electronProcess = null;
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  terminateProcessTree(child, "SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode !== null) return;
  terminateProcessTree(child, "SIGKILL");
  await Promise.race([exited, delay(5_000)]);
}

function platformPrintCommand(text: string): string {
  return process.platform === "win32" ? `echo ${text}` : `printf '${text}\\n'`;
}

function e2eEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") env.ComSpec ??= "C:\\Windows\\System32\\cmd.exe";
  else env.SHELL = "/bin/sh";
  return env;
}

function platformElectronFlags(): string[] {
  return process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error: unknown) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not remove ${dir}.`);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([operation.catch(() => undefined), delay(timeoutMs)]);
}

function appendElectronOutput(source: string, chunk: Buffer): void {
  electronOutput += `[electron ${source}] ${chunk.toString("utf8")}`;
  if (electronOutput.length > 12_000) electronOutput = electronOutput.slice(-12_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectAgentOk(result: Promise<AgentCommandResult>): Promise<unknown> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`Expected agent command success: ${JSON.stringify(resolved.error)}`);
  }
  return resolved.value;
}

class E2EAgentClient {
  private readonly pendingMessages: unknown[] = [];
  private readonly parseErrors: string[] = [];
  private readonly waiters = new Set<(message: unknown) => boolean>();

  private constructor(private readonly socket: NodeWebSocket) {
    socket.on("message", (data) => {
      void parseWebSocketMessage(data)
        .then((message) => {
          for (const waiter of [...this.waiters]) {
            if (waiter(message)) return;
          }
          this.pendingMessages.push(message);
        })
        .catch((error: unknown) => {
          this.parseErrors.push(error instanceof Error ? error.message : String(error));
        });
    });
  }

  static async connect(url: string): Promise<E2EAgentClient> {
    const socket = new NodeWebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", () => reject(new Error("Agent WebSocket failed.")));
    });
    return new E2EAgentClient(socket);
  }

  async request(command: unknown): Promise<AgentCommandResult> {
    const response = this.waitForResult(agentCommandLabel(command));
    this.socket.send(JSON.stringify(command));
    return response;
  }

  close(): void {
    this.socket.close();
  }

  private waitForResult(label: string, timeoutMs = e2eUiTimeoutMs): Promise<AgentCommandResult> {
    const queuedIndex = this.pendingMessages.findIndex(isAgentCommandResult);
    if (queuedIndex !== -1) {
      const [message] = this.pendingMessages.splice(queuedIndex, 1);
      return Promise.resolve(message as AgentCommandResult);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Timed out waiting for ${label}. pending=${JSON.stringify(
              this.pendingMessages,
            )} parseErrors=${JSON.stringify(this.parseErrors)}`,
          ),
        );
      }, timeoutMs);
      const waiter = (message: unknown): boolean => {
        if (!isAgentCommandResult(message)) return false;
        clearTimeout(timeout);
        this.waiters.delete(waiter);
        resolve(message);
        return true;
      };
      this.waiters.add(waiter);
    });
  }
}

function isAgentCommandResult(value: unknown): value is AgentCommandResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function agentCommandLabel(command: unknown): string {
  return typeof command === "object" &&
    command !== null &&
    "type" in command &&
    typeof command.type === "string"
    ? command.type
    : "unknown";
}

async function parseWebSocketMessage(data: unknown): Promise<unknown> {
  if (typeof data === "string") return JSON.parse(data) as unknown;
  if (data instanceof Blob) return JSON.parse(await data.text()) as unknown;
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
