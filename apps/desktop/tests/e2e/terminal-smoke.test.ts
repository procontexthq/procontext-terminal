import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";
import { afterEach, describe, it } from "vitest";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

let electronProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;

describe("desktop terminal smoke", () => {
  afterEach(async () => {
    await browser?.close();
    browser = null;

    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill();
    }
    electronProcess = null;
  });

  it("launches the app, runs a command, observes output, handles paste, resize, ctrl+c, and exit", async () => {
    const appCwd = fileURLToPath(new URL("../../", import.meta.url));
    const port = 49295;
    electronProcess = spawn(
      electronPath,
      [`--remote-debugging-port=${port}`, "out/main/index.cjs"],
      {
        cwd: appCwd,
        env: {
          ...process.env,
          SHELL: "/bin/sh",
        },
      },
    );

    browser = await connectToElectron(port);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");

    const terminal = page.locator(".xterm").first();
    await terminal.click();
    await page.keyboard.type("printf 'PHASE1_E2E_OK\\n'");
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "PHASE1_E2E_OK");

    await page.evaluate(() => navigator.clipboard.writeText("printf 'PHASE1_PASTE_OK\\n'"));
    await page.keyboard.press("Meta+V");
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, "PHASE1_PASTE_OK");

    await page.setViewportSize({ width: 960, height: 640 });
    await page.waitForFunction(() => document.querySelector(".xterm") !== null);
    await page.keyboard.type("sleep 5");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+C");
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await waitForStatus(page, "exited");
  });
});

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

async function waitForStatus(page: Page, status: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector("[data-testid='terminal-status']")?.textContent?.includes(expected),
    status,
    { timeout: 10000 },
  );
}
