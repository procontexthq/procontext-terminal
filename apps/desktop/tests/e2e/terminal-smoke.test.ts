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
  createAgentCommand,
  parseAgentGatewayDescriptor,
  type AgentCommandResult,
  type AgentGatewayDescriptor,
  type SessionId,
  type TerminalScreenSnapshot,
  type TerminalSessionSnapshot,
  type UiThemePreference,
} from "@terminal/protocol";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const e2eUiTimeoutMs = process.platform === "win32" ? 30000 : 10000;
const e2eAppLaunchTimeoutMs = process.platform === "linux" && process.env.CI ? 60000 : 30000;

let electronProcess: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;
let electronOutput = "";
const tempUserDataDirs: string[] = [];

describe("desktop terminal smoke", () => {
  afterEach(async () => {
    const connectedBrowser = browser;
    browser = null;

    await stopElectronProcess();
    if (connectedBrowser) {
      await settleWithin(connectedBrowser.close(), 5000);
    }

    for (const dir of tempUserDataDirs.splice(0)) {
      await removeTempDir(dir);
    }
  }, 30000);

  it("launches the app, runs a command, observes output, handles paste, resize, ctrl+c, and exit", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);
    const sessionId = await activeSessionId(page);
    await expectSessionCwd(page, sessionId, homedir());

    await typeCommand(page, platformPrintCommand("PHASE1_E2E_OK"));
    await waitForTerminalText(page, "PHASE1_E2E_OK");

    if (process.platform === "linux") {
      await typeCommand(page, platformPrintCommand("PHASE1_PASTE_OK"));
    } else {
      await page.evaluate(
        (command) => navigator.clipboard.writeText(command),
        platformPrintCommand("PHASE1_PASTE_OK"),
      );
      await page.keyboard.press(pasteShortcut());
      await page.keyboard.press("Enter");
    }
    await waitForTerminalText(page, "PHASE1_PASTE_OK");

    await page.setViewportSize({ width: 960, height: 640 });
    await page.waitForFunction(() => document.querySelector(".xterm") !== null);
    await typeCommand(page, platformLongRunningCommand());
    await interruptCommand(page, sessionId);
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForPrompt({
          sessionId: activeSessionId,
          timeoutMs: 10000,
        }),
      sessionId,
    );
    await typeCommand(page, "exit");
    await waitForStatus(page, "exited");
    await page.getByTestId("terminal-exit-message").waitFor();
  });

  it("closes the app window when the final tab close button is accepted", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);

    page.once("dialog", (dialog) => dialog.accept());
    await Promise.all([page.waitForEvent("close"), page.getByTestId("close-tab-0").click()]);
  });

  it("applies persisted UI themes without changing terminal sessions", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    let page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const sessionId = await activeSessionId(page);
    await expectTerminalBackgroundConsistent(page);

    await page.getByTestId("theme-select").selectOption("gamer");
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-theme") === "gamer",
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    await expectThemeFonts(page, "Orbitron", "Share Tech Mono");
    await expectTerminalBackgroundConsistent(page);
    await waitForPersistedUiTheme(userDataDir, "gamer");

    if ((await activeSessionId(page)) !== sessionId) {
      throw new Error("Changing UI theme should not replace the active terminal session.");
    }

    await closeRunningApp();
    browser = await launchApp(userDataDir);
    page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-theme") === "gamer",
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    await expectThemeFonts(page, "Orbitron", "Share Tech Mono");
    await expectTerminalBackgroundConsistent(page);
  });

  it("starts persisted gamer theme with loaded terminal fonts before first command", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          ui: { theme: "gamer" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-theme") === "gamer",
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    await expectThemeFonts(page, "Orbitron", "Share Tech Mono");
    await expectThemeFontsReady(page);

    await typeCommand(page, platformPrintCommand("PHASE_GAMER_STARTUP"));
    await waitForActiveTerminalText(page, "PHASE_GAMER_STARTUP");
    await expectTerminalBackgroundConsistent(page);
  });

  it("creates, switches, closes, and does not restore terminal tabs after restart", async () => {
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
    await closeRunningApp();

    browser = await launchApp(userDataDir);
    page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);
    await waitForActiveTab(page, 0);
  });

  it("routes platform tab shortcuts through terminal tabs instead of the app window", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);

    await page.keyboard.press(newTabShortcut());
    await expectTabCount(page, 2);
    await waitForActiveTab(page, 1);
    await typeCommand(page, platformPrintCommand("SHORTCUT_TAB_TWO"));
    await waitForActiveTerminalText(page, "SHORTCUT_TAB_TWO");

    await page.keyboard.press(previousTabShortcut());
    await waitForActiveTab(page, 0);
    await typeCommand(page, platformPrintCommand("SHORTCUT_TAB_ONE"));
    await waitForActiveTerminalText(page, "SHORTCUT_TAB_ONE");

    await page.keyboard.press(nextTabShortcut());
    await waitForActiveTab(page, 1);
    await waitForActiveTerminalText(page, "SHORTCUT_TAB_TWO");

    let windowClosed = false;
    page.once("close", () => {
      windowClosed = true;
    });
    page.once("dialog", (dialog) => dialog.accept());
    await page.keyboard.press(closeTabShortcut());
    await expectTabCount(page, 1);
    if (windowClosed) {
      throw new Error("Tab close shortcut closed the app window instead of the active tab.");
    }
    await waitForActiveTab(page, 0);
    await waitForActiveTerminalText(page, "SHORTCUT_TAB_ONE");
  });

  it("ignores legacy workspace settings when launching fresh sessions", async () => {
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
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");

    await expectTabCount(page, 1);
    await waitForActiveTab(page, 0);
    const sessionId = await activeSessionId(page);

    const snapshot = await page.evaluate(
      (activeSessionId) => window.terminalApi.getSession({ sessionId: activeSessionId }),
      sessionId,
    );
    if (snapshot.cwd === restoredCwd) {
      throw new Error("Legacy workspace cwd should not be restored into the fresh startup tab.");
    }
    if (snapshot.cwd !== homedir()) {
      throw new Error(`Fresh startup tab should launch in ${homedir()}, got ${snapshot.cwd}.`);
    }
  });

  it("keeps the bottom terminal row visible after scrolling to latest output", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const sessionId = await activeSessionId(page);

    await page.evaluate(
      ({ activeSessionId, command }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { activeSessionId: sessionId, command: platformManyLinesCommand("BOTTOM_ROW", 120) },
    );
    await waitForActiveTerminalText(page, "BOTTOM_ROW_120");
    await page.evaluate(() => {
      const viewport = document.querySelector(".xterm-viewport");
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    });

    await expectTerminalBottomRowVisible(page);
  });

  it("reconciles detached human-created sessions into visible renderer tabs", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    await expectTabCount(page, 1);

    const detachedSessionId = await page.evaluate(async () => {
      const created = await window.terminalApi.createSession({ cols: 80, rows: 24 });
      await window.terminalApi.detachSession({ sessionId: created.sessionId });
      return created.sessionId;
    });

    await expectTabCount(page, 2);
    await page.waitForFunction(
      (expectedSessionId) =>
        document
          .querySelector("[data-testid='terminal-ready']")
          ?.getAttribute("data-session-id") === expectedSessionId,
      detachedSessionId,
      { timeout: 10000 },
    );
    await page.evaluate(
      ({ sessionId, command }) =>
        window.terminalApi.write({
          sessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { sessionId: detachedSessionId, command: platformPrintCommand("HUMAN_DETACHED_VISIBLE") },
    );
    await waitForActiveTerminalText(page, "HUMAN_DETACHED_VISIBLE");
  });

  it("supports agent runtime observation, waits, detach/attach, and recording export", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          recording: {
            state: "disabled",
            redactedPatterns: ["SECRET_TOKEN"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const sessionId = await activeSessionId(page);

    const initialSnapshot = await captureScreen(page, sessionId);
    if (initialSnapshot.sessionId !== sessionId || initialSnapshot.viewport.length === 0) {
      throw new Error("Expected captureScreen to return the active terminal viewport.");
    }

    await page.evaluate(
      ({ sessionId: activeSessionId, command }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { sessionId, command: platformPrintCommand("PHASE2_WAIT_TEXT") },
    );
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForText({
          sessionId: activeSessionId,
          text: "PHASE2_WAIT_TEXT",
          timeoutMs: 5000,
        }),
      sessionId,
    );
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForQuiet({
          sessionId: activeSessionId,
          quietMs: 100,
          timeoutMs: 5000,
        }),
      sessionId,
    );

    await page.evaluate(
      (activeSessionId) => window.terminalApi.detachSession({ sessionId: activeSessionId }),
      sessionId,
    );
    await waitForStatus(page, "detached");
    await page.evaluate(
      ({ sessionId: activeSessionId, command }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { sessionId, command: platformPrintCommand("PHASE2_DETACHED_OUTPUT") },
    );
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForText({
          sessionId: activeSessionId,
          text: "PHASE2_DETACHED_OUTPUT",
          timeoutMs: 5000,
        }),
      sessionId,
    );
    const recentOutput = await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.readRecentOutput({
          sessionId: activeSessionId,
          maxBytes: 2000,
        }),
      sessionId,
    );
    if (!recentOutput.data.includes("PHASE2_DETACHED_OUTPUT")) {
      throw new Error("Expected detached session output to stay available in recent output.");
    }
    await page.evaluate(
      (activeSessionId) => window.terminalApi.attachSession({ sessionId: activeSessionId }),
      sessionId,
    );
    await waitForStatus(page, "running");

    if (process.platform !== "win32") {
      await page.evaluate(
        (activeSessionId) =>
          window.terminalApi.write({
            sessionId: activeSessionId,
            data: "printf '\\033[?1049hALTSCREEN\\n'; sleep 1; printf '\\033[?1049l'\r",
            origin: "agent",
          }),
        sessionId,
      );
      const alternateSnapshot = await waitForAlternateScreenSnapshot(page, sessionId);
      if (!alternateSnapshot.viewport.some((row) => row.text.includes("ALTSCREEN"))) {
        throw new Error("Expected alternate-screen snapshot to include fixture output.");
      }
    }

    await page.evaluate(
      (activeSessionId) => window.terminalApi.startRecording({ sessionId: activeSessionId }),
      sessionId,
    );
    await page.evaluate(
      ({ sessionId: activeSessionId, command }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { sessionId, command: platformPrintCommand("FIRST_SECRET_TOKEN") },
    );
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForText({
          sessionId: activeSessionId,
          text: "FIRST_SECRET_TOKEN",
          timeoutMs: 5000,
        }),
      sessionId,
    );
    await page.evaluate(
      ({ sessionId: activeSessionId, command }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${command}\r`,
          origin: "agent",
        }),
      { sessionId, command: platformPrintCommand("SECOND_SECRET_TOKEN") },
    );
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.waitForText({
          sessionId: activeSessionId,
          text: "SECOND_SECRET_TOKEN",
          timeoutMs: 5000,
        }),
      sessionId,
    );
    await page.evaluate(
      (activeSessionId) => window.terminalApi.stopRecording({ sessionId: activeSessionId }),
      sessionId,
    );
    const recording = await page.evaluate(
      (activeSessionId) => window.terminalApi.exportRecording({ sessionId: activeSessionId }),
      sessionId,
    );
    const recordingText = JSON.stringify(recording.events);
    if (
      !recordingText.includes("FIRST_[redacted]") ||
      !recordingText.includes("SECOND_[redacted]") ||
      recordingText.includes("SECRET_TOKEN")
    ) {
      throw new Error("Expected recording export to redact configured transcript patterns.");
    }
  });

  it("publishes the agent gateway only after the startup terminal is listable", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const descriptor = await waitForAgentDescriptor(userDataDir, { pollMs: 5 });
    const agent = await E2EAgentClient.connect(descriptor.url);

    try {
      await expectAgentOk(
        agent.request(createAgentCommand("agent.authenticate", { token: descriptor.token })),
      );
      const sessions = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.list", {})),
      )) as TerminalSessionSnapshot[];
      if (!sessions.some((session) => session.createdBy === "human")) {
        throw new Error(
          `Expected startup human session to be visible after descriptor publication: ${JSON.stringify(
            sessions,
          )}`,
        );
      }
    } finally {
      agent.close();
    }
  });

  it("exposes an authenticated local agent gateway that shares the visible PTY session", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          recording: {
            state: "disabled",
            redactedPatterns: ["AGENT_SECRET"],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const sessionId = await activeSessionId(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await E2EAgentClient.connect(descriptor.url);
    const unauthenticatedAgent = await E2EAgentClient.connect(descriptor.url);

    try {
      await expectAgentOk(
        agent.request(createAgentCommand("agent.authenticate", { token: descriptor.token })),
      );
      await expectAgentOk(agent.request(createAgentCommand("terminal.attach", { sessionId })));

      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.sendText", {
            sessionId,
            text: `${platformPrintCommand("PHASE3_AGENT_TO_UI")}\r`,
          }),
        ),
      );
      await waitForTerminalText(page, "PHASE3_AGENT_TO_UI");
      await page.waitForFunction(
        () =>
          document.querySelector("[data-testid='agent-activity']")?.textContent === "Agent active",
        undefined,
        { timeout: 10000 },
      );

      await expectAgentOk(
        agent.request(createAgentCommand("terminal.startRecording", { sessionId })),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.sendMouse", {
            sessionId,
            data: "\u001b[M   ",
          }),
        ),
      );
      await expectAgentOk(agent.request(createAgentCommand("terminal.interrupt", { sessionId })));
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.sendText", {
            sessionId,
            text: `${platformLongRunningCommand()}\r`,
          }),
        ),
      );
      await delay(250);
      await expectAgentOk(agent.request(createAgentCommand("terminal.interrupt", { sessionId })));
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.waitForQuiet", {
            sessionId,
            quietMs: 100,
            timeoutMs: 5000,
          }),
        ),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.paste", {
            sessionId,
            text: `${platformPrintCommand("PHASE3_AGENT_PASTE_AGENCY_AGENTS")}\r${platformPrintCommand(
              "PHASE3_AGENT_RECORDING_AGENT_SECRET",
            )}\r`,
          }),
        ),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.waitForText", {
            sessionId,
            text: "PHASE3_AGENT_RECORDING_AGENT_SECRET",
            timeoutMs: 10000,
          }),
        ),
      );
      await expectAgentOk(
        agent.request(createAgentCommand("terminal.stopRecording", { sessionId })),
      );
      const exportedRecording = await expectAgentOk(
        agent.request(createAgentCommand("terminal.exportRecording", { sessionId })),
      );
      const recordingText = JSON.stringify(exportedRecording);
      if (
        !recordingText.includes("PHASE3_AGENT_RECORDING_[redacted]") ||
        recordingText.includes("AGENT_SECRET")
      ) {
        throw new Error(
          "Expected agent recording export to redact configured transcript patterns.",
        );
      }

      await typeCommand(page, platformPrintCommand("PHASE3_UI_TO_AGENT"));
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.waitForText", {
            sessionId,
            text: "PHASE3_UI_TO_AGENT",
            timeoutMs: 10000,
          }),
        ),
      );
      const recentOutput = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.readRecentOutput", { sessionId, maxBytes: 4000 }),
        ),
      );
      if (!JSON.stringify(recentOutput).includes("PHASE3_UI_TO_AGENT")) {
        throw new Error("Expected gateway recent output to include text written through the UI.");
      }

      const denied = await unauthenticatedAgent.request(
        createAgentCommand("terminal.sendText", {
          sessionId,
          text: `${platformPrintCommand("PHASE3_UNAUTH_SHOULD_NOT_APPEAR")}\r`,
        }),
      );
      if (denied.ok || denied.error.type !== "auth_required") {
        throw new Error(
          `Expected unauthenticated gateway request to be denied: ${JSON.stringify(denied)}`,
        );
      }
      await delay(200);
      const afterDenied = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.readRecentOutput", { sessionId, maxBytes: 4000 }),
        ),
      );
      if (JSON.stringify(afterDenied).includes("PHASE3_UNAUTH_SHOULD_NOT_APPEAR")) {
        throw new Error("Unauthorized gateway input mutated the terminal session.");
      }
    } finally {
      agent.close();
      unauthenticatedAgent.close();
    }
  });

  it("surfaces agent-created terminal sessions as visible renderer tabs", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await page.waitForSelector("[data-testid='terminal-ready']");
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await E2EAgentClient.connect(descriptor.url);

    try {
      await expectAgentOk(
        agent.request(createAgentCommand("agent.authenticate", { token: descriptor.token })),
      );
      const created = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.create", { cols: 80, rows: 24 })),
      )) as TerminalSessionSnapshot;
      if (created.state !== "detached") {
        throw new Error(`Expected agent-created session to start detached: ${created.state}`);
      }

      await page.waitForFunction(
        (createdSessionId) =>
          document
            .querySelector("[data-testid='terminal-ready']")
            ?.getAttribute("data-session-id") === createdSessionId,
        created.sessionId,
        { timeout: 10000 },
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.sendText", {
            sessionId: created.sessionId,
            text: `${platformPrintCommand("AGENT_CREATED_VISIBLE")}\r`,
          }),
        ),
      );
      await waitForActiveTerminalText(page, "AGENT_CREATED_VISIBLE");
    } finally {
      agent.close();
    }
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
  electronOutput = "";
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

async function closeRunningApp(): Promise<void> {
  const connectedBrowser = browser;
  browser = null;
  await stopElectronProcess();
  if (connectedBrowser) {
    await settleWithin(connectedBrowser.close(), 5000);
  }
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
  terminateProcessTree(child, "SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);

  if (child.exitCode !== null) {
    return;
  }

  terminateProcessTree(child, "SIGKILL");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
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
      if (electronProcess && electronProcess.exitCode !== null) {
        throw new Error(
          `Electron exited before opening CDP on ${endpoint} with code ${electronProcess.exitCode}.\n${electronOutput}`,
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out connecting to Electron at ${endpoint}.\n${electronOutput}`, {
    cause: lastError,
  });
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
    { timeout: e2eUiTimeoutMs },
  );
}

async function waitForActiveTerminalText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector("[data-testid='terminal-ready'] .xterm-rows")
        ?.textContent?.includes(expected),
    text,
    { timeout: e2eUiTimeoutMs },
  );
}

async function expectTerminalBottomRowVisible(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const viewport = document.querySelector(".xterm-viewport");
      const lastRow = Array.from(document.querySelectorAll(".xterm-rows > div")).at(-1);
      if (!viewport || !lastRow) {
        return false;
      }
      const viewportRect = viewport.getBoundingClientRect();
      const rowRect = lastRow.getBoundingClientRect();
      return rowRect.top >= viewportRect.top && rowRect.bottom <= viewportRect.bottom + 0.5;
    },
    undefined,
    { timeout: e2eUiTimeoutMs },
  );
}

async function expectTerminalBackgroundConsistent(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const shell = document.querySelector(".terminal-session-view.is-active");
      const host = document.querySelector(".terminal-host.is-active");
      const terminal = document.querySelector(".terminal-host > .xterm");
      const screen = document.querySelector(".xterm-screen");
      const viewport = document.querySelector(".xterm-viewport");
      const scrollArea = document.querySelector(".xterm-scroll-area");
      const rows = document.querySelector(".xterm-rows");
      if (!shell || !host || !terminal || !screen || !viewport || !rows) {
        return false;
      }
      const expected = getComputedStyle(shell).backgroundColor;
      const renderedSurfaces = [host, terminal, screen, viewport, rows];
      if (scrollArea) {
        renderedSurfaces.push(scrollArea);
      }
      return renderedSurfaces.every(
        (element) => getComputedStyle(element).backgroundColor === expected,
      );
    },
    undefined,
    { timeout: e2eUiTimeoutMs },
  );
}

async function expectThemeFonts(
  page: Page,
  expectedUiFont: string,
  expectedTerminalFont: string,
): Promise<void> {
  await page.waitForFunction(
    ({ uiFont, terminalFont }) => {
      const shell = document.querySelector(".app-shell");
      const terminal = document.querySelector("[data-testid='terminal-ready'] .xterm");
      if (!shell || !terminal) {
        return false;
      }
      return (
        getComputedStyle(shell).fontFamily.includes(uiFont) &&
        getComputedStyle(terminal).fontFamily.includes(terminalFont)
      );
    },
    { uiFont: expectedUiFont, terminalFont: expectedTerminalFont },
    { timeout: e2eUiTimeoutMs },
  );
}

async function expectThemeFontsReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.fonts.check('500 12px "Orbitron"') &&
      document.fonts.check('400 13px "Share Tech Mono"'),
    undefined,
    { timeout: e2eUiTimeoutMs },
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

async function waitForAgentDescriptor(
  userDataDir: string,
  options: { pollMs?: number } = {},
): Promise<AgentGatewayDescriptor> {
  const descriptorPath = join(userDataDir, "agent-gateway.json");
  const deadline = Date.now() + 10000;
  const pollMs = options.pollMs ?? 100;
  while (Date.now() < deadline) {
    try {
      return parseAgentGatewayDescriptor(
        JSON.parse(await readFile(descriptorPath, "utf8")) as unknown,
      );
    } catch {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  throw new Error("Timed out waiting for agent gateway descriptor.");
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

async function waitForPersistedUiTheme(
  userDataDir: string,
  theme: UiThemePreference,
): Promise<void> {
  const settingsPath = join(userDataDir, "settings.json");
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
        ui?: { theme?: unknown };
      };
      if (settings.ui?.theme === theme) {
        return;
      }
    } catch {
      // Settings may not exist yet; keep polling until the explicit timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for persisted UI theme ${theme}.`);
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
    throw new Error("Active terminal did not expose a session id.");
  }
  return sessionId as SessionId;
}

async function expectSessionCwd(page: Page, sessionId: SessionId, cwd: string): Promise<void> {
  const snapshot = await page.evaluate(
    (activeSessionId) => window.terminalApi.getSession({ sessionId: activeSessionId }),
    sessionId,
  );
  if (snapshot.cwd !== cwd) {
    throw new Error(`Expected session cwd ${cwd}, got ${snapshot.cwd}.`);
  }
}

async function captureScreen(page: Page, sessionId: SessionId): Promise<TerminalScreenSnapshot> {
  return page.evaluate(
    (activeSessionId) =>
      window.terminalApi.captureScreen({
        sessionId: activeSessionId,
        timeoutMs: 5000,
      }),
    sessionId,
  );
}

async function waitForAlternateScreenSnapshot(
  page: Page,
  sessionId: SessionId,
): Promise<TerminalScreenSnapshot> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snapshot = await captureScreen(page, sessionId);
    if (snapshot.alternateScreen) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for alternate-screen snapshot.");
}

async function typeCommand(page: Page, command: string): Promise<void> {
  if (process.platform === "linux") {
    const sessionId = await activeSessionId(page);
    await page.evaluate(
      ({ activeSessionId, input }) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: `${input}\r`,
          origin: "agent",
        }),
      { activeSessionId: sessionId, input: command },
    );
    return;
  }

  await page.locator("[data-testid='terminal-ready'] .xterm").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function interruptCommand(page: Page, sessionId: SessionId): Promise<void> {
  if (process.platform === "linux") {
    await page.evaluate(
      (activeSessionId) =>
        window.terminalApi.write({
          sessionId: activeSessionId,
          data: "\x03",
          origin: "agent",
        }),
      sessionId,
    );
    return;
  }

  await page.keyboard.press("Control+C");
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

function platformManyLinesCommand(prefix: string, count: number): string {
  const quotedPrefix = prefix.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const script = `for (let i = 1; i <= ${count}; i += 1) console.log('${quotedPrefix}_' + i)`;
  return `node -e ${JSON.stringify(script)}`;
}

function platformLongRunningCommand(): string {
  return process.platform === "win32" ? "ping -n 6 127.0.0.1" : "sleep 5";
}

function pasteShortcut(): string {
  return process.platform === "darwin" ? "Meta+V" : "Control+V";
}

function newTabShortcut(): string {
  return process.platform === "darwin" ? "Meta+T" : "Control+Shift+T";
}

function closeTabShortcut(): string {
  return process.platform === "darwin" ? "Meta+W" : "Control+Shift+W";
}

function previousTabShortcut(): string {
  return process.platform === "darwin" ? "Meta+Shift+[" : "Control+PageUp";
}

function nextTabShortcut(): string {
  return process.platform === "darwin" ? "Meta+Shift+]" : "Control+PageDown";
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
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Could not remove temp dir ${dir}.`);
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function appendElectronOutput(source: string, chunk: Buffer): void {
  electronOutput += `[electron ${source}] ${chunk.toString("utf8")}`;
  if (electronOutput.length > 12000) {
    electronOutput = electronOutput.slice(-12000);
  }
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
            `Timed out waiting for agent command response for ${label}. pending=${JSON.stringify(
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
