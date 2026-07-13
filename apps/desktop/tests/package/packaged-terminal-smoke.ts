import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, it } from "vitest";
import { WebSocket as NodeWebSocket } from "ws";

import {
  TERMINAL_PROTOCOL_VERSION,
  createAgentCommand,
  parseAgentGatewayDescriptor,
  type AgentCommandResult,
  type AgentGatewayDescriptor,
  type ObserveTerminalResult,
  type SessionId,
  type TerminalSessionSummary,
} from "@terminal/protocol";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

let appProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;
let appOutput = "";
const tempUserDataDirs: string[] = [];

describe("packaged desktop terminal smoke", () => {
  afterEach(async () => {
    const connectedBrowser = browser;
    browser = null;

    await stopPackagedApp();
    if (connectedBrowser) {
      await settleWithin(connectedBrowser.close(), 5000);
    }

    for (const dir of tempUserDataDirs.splice(0)) {
      await removeTempDir(dir);
    }
  }, 30000);

  it("launches the packaged app, runs a PTY command, and serves agent operations", async () => {
    const executable = await resolvePackagedExecutable();
    const userDataDir = await createTempUserDataDir();
    browser = await launchPackagedApp(executable, userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const sessionId = await activeSessionId(page);
    const initialSession = await getSession(page, sessionId);
    if (initialSession.cwd !== homedir()) {
      throw new Error(
        `Expected packaged default terminal cwd to be the user home ${homedir()}, got ${initialSession.cwd}.`,
      );
    }

    await writeTerminalInput(page, sessionId, `${platformPrintCommand("PHASE5_PACKAGE_PTY")}\r`);
    await waitForVisibleOutput(page, "PHASE5_PACKAGE_PTY");

    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await E2EAgentClient.connect(descriptor.url);
    try {
      await expectAgentOk(
        agent.request(
          createAgentCommand("agent.authenticate", {
            token: descriptor.token,
            protocolVersion: TERMINAL_PROTOCOL_VERSION,
          }),
        ),
      );
      await expectAgentOk(agent.request(createAgentCommand("terminal.attach", { sessionId })));
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId,
            input: `${platformPrintCommand("PHASE5_PACKAGE_AGENT")}\r`,
          }),
        ),
      );
      const observation = await waitForAgentObservation(agent, sessionId, "PHASE5_PACKAGE_AGENT");
      if (!JSON.stringify(observation.viewport.rows).includes("PHASE5_PACKAGE_AGENT")) {
        throw new Error("Expected packaged canonical observation to include agent output.");
      }
      await waitForVisibleOutput(page, "PHASE5_PACKAGE_AGENT");
    } finally {
      agent.close();
    }

    if (appOutput.includes(descriptor.token)) {
      throw new Error("Packaged app diagnostics must not write the agent token to stdio.");
    }
  });
});

async function resolvePackagedExecutable(): Promise<string> {
  const distDir = join(desktopRoot, "dist");
  const entries = await directoryEntries(distDir);

  if (process.platform === "darwin") {
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("mac")) {
        continue;
      }
      const appBundle = await firstMatchingDirectory(join(distDir, entry.name), (name) =>
        name.endsWith(".app"),
      );
      if (appBundle) {
        return join(appBundle, "Contents", "MacOS", basename(appBundle, ".app"));
      }
    }
  }

  if (process.platform === "linux") {
    const unpacked = await firstMatchingDirectory(distDir, (name) => name.endsWith("-unpacked"));
    if (unpacked) {
      return firstAccessiblePath([
        join(unpacked, "procontext-terminal"),
        join(unpacked, "ProContext Terminal"),
      ]);
    }
  }

  if (process.platform === "win32") {
    const unpacked = await firstMatchingDirectory(distDir, (name) => name.endsWith("-unpacked"));
    if (unpacked) {
      const executable = await firstMatchingFile(unpacked, (name) => {
        const lowerName = name.toLowerCase();
        return lowerName.endsWith(".exe") && !lowerName.includes("uninstall");
      });
      if (executable) {
        return executable;
      }
    }
  }

  throw new Error(`Could not find packaged executable for ${process.platform} in ${distDir}.`);
}

async function launchPackagedApp(executable: string, userDataDir: string): Promise<Browser> {
  const port = await getFreePort();
  appOutput = "";
  appProcess = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      ...platformElectronFlags(),
    ],
    {
      cwd: desktopRoot,
      env: e2eEnvironment(),
      detached: process.platform !== "win32",
    },
  );
  appProcess.stdout.on("data", (chunk: Buffer) => appendAppOutput("stdout", chunk));
  appProcess.stderr.on("data", (chunk: Buffer) => appendAppOutput("stderr", chunk));

  return connectToPackagedApp(port);
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

async function connectToPackagedApp(port: number): Promise<Browser> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error: unknown) {
      lastError = error;
      if (appProcess && appProcess.exitCode !== null) {
        throw new Error(
          `Packaged app exited before opening CDP on ${endpoint} with code ${appProcess.exitCode}.\n${appOutput}`,
          { cause: error },
        );
      }
      await delay(100);
    }
  }

  throw new Error(`Timed out connecting to packaged app at ${endpoint}.\n${appOutput}`, {
    cause: lastError,
  });
}

async function firstPage(connectedBrowser: Browser): Promise<Page> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const context of connectedBrowser.contexts()) {
      const page = context.pages()[0];
      if (page) {
        return page;
      }
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for packaged app page.");
}

async function activeSessionId(page: Page): Promise<SessionId> {
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector("[data-testid='terminal-ready']")?.getAttribute("data-session-id"),
      ),
    undefined,
    { timeout: 10000 },
  );
  const sessionId = await page
    .locator("[data-testid='terminal-ready']")
    .getAttribute("data-session-id");
  if (!sessionId) {
    throw new Error("Active packaged terminal did not expose a session id.");
  }
  return sessionId as SessionId;
}

async function writeTerminalInput(page: Page, sessionId: SessionId, data: string): Promise<void> {
  await page.evaluate(
    ({ activeSessionId, input }) =>
      window.terminalApi.input({
        sessionId: activeSessionId,
        input,
      }),
    { activeSessionId: sessionId, input: data },
  );
}

async function getSession(page: Page, sessionId: SessionId): Promise<TerminalSessionSummary> {
  return page.evaluate(
    (activeSessionId) => window.terminalApi.getSession({ sessionId: activeSessionId }),
    sessionId,
  );
}

async function waitForVisibleOutput(page: Page, expectedText: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector("[data-testid='terminal-ready'] .xterm-rows")
        ?.textContent?.includes(expected),
    expectedText,
    { timeout: 10000 },
  );
}

async function waitForAgentObservation(
  agent: E2EAgentClient,
  sessionId: SessionId,
  expectedText: string,
): Promise<Extract<ObserveTerminalResult, { status: "changed" }>["observation"]> {
  const deadline = Date.now() + 10000;
  let afterVersion = 0;
  while (Date.now() < deadline) {
    const result = (await expectAgentOk(
      agent.request(
        createAgentCommand("terminal.observe", {
          sessionId,
          afterVersion,
          timeoutMs: 1000,
        }),
      ),
    )) as ObserveTerminalResult;
    if (result.status === "changed") {
      afterVersion = result.observation.version;
      if (result.observation.viewport.rows.some((row) => row.text.includes(expectedText))) {
        return result.observation;
      }
    } else {
      afterVersion = result.version;
    }
  }
  throw new Error(`Timed out waiting for packaged observation text ${expectedText}.`);
}

async function waitForAgentDescriptor(userDataDir: string): Promise<AgentGatewayDescriptor> {
  const descriptorPath = join(userDataDir, "agent-gateway.json");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      return parseAgentGatewayDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
      );
    } catch {
      await delay(100);
    }
  }
  throw new Error("Timed out waiting for packaged agent gateway descriptor.");
}

async function createTempUserDataDir(): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), "terminal-packaged-e2e-user-data-"));
  tempUserDataDirs.push(userDataDir);
  return userDataDir;
}

async function stopPackagedApp(): Promise<void> {
  const child = appProcess;
  if (!child) {
    return;
  }
  appProcess = null;
  if (child.exitCode !== null || child.killed) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  terminateProcessTree(child, "SIGTERM");
  await Promise.race([exited, delay(5000)]);

  if (child.exitCode !== null) {
    return;
  }

  terminateProcessTree(child, "SIGKILL");
  await Promise.race([exited, delay(5000)]);
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Could not read ${path}. Run the package script before package smoke tests.`, {
      cause: error,
    });
  }
}

async function firstMatchingDirectory(
  root: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isDirectory() && predicate(entry.name)) {
      return join(root, entry.name);
    }
  }
  return null;
}

async function firstMatchingFile(
  root: string,
  predicate: (name: string) => boolean,
): Promise<string | null> {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isFile() && predicate(entry.name)) {
      return join(root, entry.name);
    }
  }
  return null;
}

async function firstAccessiblePath(paths: string[]): Promise<string> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Keep checking platform-specific executable candidates.
    }
  }
  throw new Error(`Could not find an accessible packaged executable. Tried: ${paths.join(", ")}`);
}

function e2eEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.platform === "win32") {
    env.ComSpec ??= "C:\\Windows\\System32\\cmd.exe";
  } else {
    env.SHELL = "/bin/sh";
  }
  return env;
}

function platformElectronFlags(): string[] {
  return process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
}

function platformPrintCommand(text: string): string {
  return process.platform === "win32" ? `echo ${text}` : `printf '${text}\\n'`;
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

  throw lastError instanceof Error ? lastError : new Error(`Could not remove temp dir ${dir}.`);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([operation.catch(() => undefined), delay(timeoutMs)]);
}

function appendAppOutput(source: string, chunk: Buffer): void {
  appOutput += `[packaged ${source}] ${chunk.toString("utf8")}`;
  if (appOutput.length > 12000) {
    appOutput = appOutput.slice(-12000);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectAgentOk(result: Promise<AgentCommandResult>): Promise<unknown> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`Expected packaged agent command success: ${JSON.stringify(resolved.error)}`);
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
            if (waiter(message)) {
              return;
            }
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
      socket.once("error", () => reject(new Error("Packaged agent WebSocket failed.")));
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

  private waitForResult(label: string, timeoutMs = 10000): Promise<AgentCommandResult> {
    const queuedIndex = this.pendingMessages.findIndex((message) => isAgentCommandResult(message));
    if (queuedIndex !== -1) {
      const [message] = this.pendingMessages.splice(queuedIndex, 1);
      return Promise.resolve(message as AgentCommandResult);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new Error(
            `Timed out waiting for packaged agent response for ${label}. pending=${JSON.stringify(
              this.pendingMessages,
            )} parseErrors=${JSON.stringify(this.parseErrors)}`,
          ),
        );
      }, timeoutMs);
      const waiter = (message: unknown): boolean => {
        if (!isAgentCommandResult(message)) {
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

function isAgentCommandResult(value: unknown): value is AgentCommandResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function agentCommandLabel(command: unknown): string {
  if (
    typeof command === "object" &&
    command !== null &&
    "type" in command &&
    typeof command.type === "string"
  ) {
    return command.type;
  }
  return "unknown";
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
