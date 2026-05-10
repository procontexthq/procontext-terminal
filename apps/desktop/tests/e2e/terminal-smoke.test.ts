import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, it } from "vitest";

import { defaultTerminalConfig } from "@terminal/config";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

let electronProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;
const tempUserDataDirs: string[] = [];

describe("desktop terminal smoke", () => {
  afterEach(async () => {
    await browser?.close();
    browser = null;

    await stopElectronProcess();

    await Promise.all(
      tempUserDataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("launches the app, runs a command, observes output, handles paste, resize, ctrl+c, and exit", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);

    const terminal = page.locator(".xterm").first();
    await terminal.click();
    await page.keyboard.type(platformPrintCommand("PHASE1_E2E_OK"));
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "PHASE1_E2E_OK");

    await page.evaluate(
      (command) => navigator.clipboard.writeText(command),
      platformPrintCommand("PHASE1_PASTE_OK"),
    );
    await page.keyboard.press(pasteShortcut());
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "PHASE1_PASTE_OK");

    await page.setViewportSize({ width: 960, height: 640 });
    await page.waitForFunction(() => document.querySelector(".xterm") !== null);
    await page.keyboard.type(platformLongRunningCommand());
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+C");
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await waitForStatus(page, "exited");
  });

  it("creates, switches, closes, and restores terminal tabs", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    let page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");

    await page.getByTestId("new-tab-button").click();
    await expectTabCount(page, 2);
    await typeCommand(page, platformPrintCommand("PHASE2_TAB_TWO"));
    await waitForActiveTerminalText(page, "PHASE2_TAB_TWO");

    await page.getByTestId("terminal-tab-0").click();
    await typeCommand(page, platformPrintCommand("PHASE2_TAB_ONE"));
    await waitForActiveTerminalText(page, "PHASE2_TAB_ONE");

    await page.getByTestId("terminal-tab-1").click();
    await waitForActiveTerminalText(page, "PHASE2_TAB_TWO");

    page.once("dialog", (dialog) => dialog.dismiss());
    await page.getByTestId("close-tab-1").click();
    await expectTabCount(page, 2);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("close-tab-1").click();
    await expectTabCount(page, 1);

    await page.getByTestId("new-tab-button").click();
    await typeCommand(page, "exit");
    await waitForStatus(page, "exited");
    let dialogSeen = false;
    page.on("dialog", (dialog) => {
      dialogSeen = true;
      void dialog.dismiss();
    });
    await page.getByTestId("close-tab-1").click();
    await expectTabCount(page, 1);
    if (dialogSeen) {
      throw new Error("Closing an exited tab should not ask for confirmation.");
    }

    await page.getByTestId("new-tab-button").click();
    await expectTabCount(page, 2);
    await page.getByTestId("terminal-tab-1").click();
    await waitForPersistedWorkspace(userDataDir, 2, 1);
    await closeRunningApp();

    browser = await launchApp(userDataDir);
    page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 2);
    await page.getByTestId("terminal-tab-1").waitFor();
    await waitForActiveTab(page, 1);

    await waitForPersistedWorkspace(userDataDir, 2, 1);
  });

  it("launches restored workspace tabs as fresh sessions", async () => {
    const userDataDir = await createTempUserDataDir();
    const restoredCwd = await mkdtemp(join(tmpdir(), "terminal-restored-cwd-"));
    tempUserDataDirs.push(restoredCwd);
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          workspace: {
            tabs: [
              { cwd: restoredCwd, shell: null },
              { cwd: null, shell: null },
            ],
            activeTabIndex: 1,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const expectedCwdLabel = restoredCwd.split(/[\\/]/).pop() ?? restoredCwd;

    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");

    await expectTabCount(page, 2);
    await waitForActiveTab(page, 1);
    await page.getByTestId("terminal-tab-0").click();
    await page.getByTestId("terminal-tab-0").waitFor({ state: "visible" });
    await page.waitForFunction(
      (expected) =>
        document.querySelector("[data-testid='terminal-tab-0']")?.textContent?.includes(expected),
      expectedCwdLabel,
    );
  });
});

async function createTempUserDataDir(): Promise<string> {
  const userDataDir = await mkdtemp(join(tmpdir(), "terminal-e2e-user-data-"));
  tempUserDataDirs.push(userDataDir);
  return userDataDir;
}

async function launchApp(userDataDir: string): Promise<Browser> {
  const appCwd = fileURLToPath(new URL("../../", import.meta.url));
  const port = await getFreePort();
  electronProcess = spawn(
    electronPath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "out/main/index.cjs"],
    {
      cwd: appCwd,
      env: e2eEnvironment(),
    },
  );

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

async function closeRunningApp(): Promise<void> {
  await browser?.close();
  browser = null;
  await stopElectronProcess();
}

async function stopElectronProcess(): Promise<void> {
  const child = electronProcess;
  if (!child) {
    return;
  }
  electronProcess = null;
  if (child.exitCode !== null || child.killed) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill();
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
}

async function connectToElectron(port: number): Promise<Browser> {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch (error: unknown) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out connecting to Electron.");
}

async function firstPage(connectedBrowser: Browser): Promise<Page> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    for (const context of connectedBrowser.contexts()) {
      const page = context.pages()[0];
      if (page) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Electron page.");
}

async function waitForTerminalText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector(".xterm-rows")?.textContent?.includes(expected),
    text,
    { timeout: 10000 },
  );
}

async function waitForActiveTerminalText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector("[data-testid='terminal-ready'] .xterm-rows")
        ?.textContent?.includes(expected),
    text,
    { timeout: 10000 },
  );
}

async function waitForStatus(page: Page, status: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("[data-testid='terminal-status']")?.textContent?.includes(expected),
    status,
    { timeout: 10000 },
  );
}

async function expectTabCount(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll("[data-terminal-tab='true']").length === expected,
    count,
    { timeout: 10000 },
  );
}

async function waitForPersistedWorkspace(
  userDataDir: string,
  tabCount: number,
  activeTabIndex: number,
): Promise<void> {
  const settingsPath = join(userDataDir, "settings.json");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        workspace?: { tabs?: unknown[]; activeTabIndex?: number };
      };
      if (
        settings.workspace?.tabs?.length === tabCount &&
        settings.workspace.activeTabIndex === activeTabIndex
      ) {
        return;
      }
    } catch {
      // Settings may not exist yet; keep polling until the explicit timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("Timed out waiting for persisted workspace state.");
}

async function waitForActiveTab(page: Page, index: number): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector(`[data-testid='terminal-tab-${expected}']`)
        ?.getAttribute("aria-selected") === "true",
    index,
    { timeout: 10000 },
  );
}

async function typeCommand(page: Page, command: string): Promise<void> {
  await page.locator("[data-testid='terminal-ready'] .xterm").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
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

function platformPrintCommand(text: string): string {
  return process.platform === "win32" ? `echo ${text}` : `printf '${text}\\n'`;
}

function platformLongRunningCommand(): string {
  return process.platform === "win32" ? "ping -n 6 127.0.0.1" : "sleep 5";
}

function pasteShortcut(): string {
  return process.platform === "darwin" ? "Meta+V" : "Control+V";
}
