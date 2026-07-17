import { spawnSync, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, type ElectronApplication, type Page } from "playwright";
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

import {
  alternateScreenCommand,
  inputGateFixtureCommand,
  interruptFixtureCommand,
  nodeEvalCommand,
} from "./e2e-commands";
import { terminalUiTimeoutMs } from "./e2e-timeouts";
import {
  TEST_AGENT_ACCESS_KEY,
  preseedAgentAccessKey,
  readPersistedAgentAccessKey,
} from "../shared/agent-access-key-fixture";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const e2eUiTimeoutMs = terminalUiTimeoutMs(process.platform);
const e2eAppLaunchTimeoutMs = process.platform === "linux" && process.env.CI ? 60_000 : 30_000;

let electronProcess: ChildProcess | null = null;
let browser: ElectronApplication | null = null;
let electronOutput = "";
let rendererOutput = "";
const tempUserDataDirs: string[] = [];

describe("desktop terminal smoke", () => {
  afterEach(async () => {
    const connectedBrowser = browser;
    browser = null;
    if (connectedBrowser) await settleWithin(connectedBrowser.close(), 5_000);
    await stopElectronProcess();
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
    await setNativeWindowSize(page, 960, 640);

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

  it("keeps the integrated titlebar safe, interactive, and transparent to terminal keys", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    await setNativeWindowSize(page, 640, 560);

    const chrome = await page.evaluate(() => {
      const titlebar = document.querySelector<HTMLElement>('[data-testid="window-titlebar"]');
      const content = titlebar?.querySelector<HTMLElement>(".titlebar-content");
      const tabStrip = titlebar?.querySelector<HTMLElement>('[data-testid="terminal-tab-strip"]');
      const activeTab = tabStrip?.querySelector<HTMLElement>(".tab-item.is-active");
      const controlSelectors = [
        ["sidebar", '[data-testid="session-sidebar-toggle"]'],
        ["new-tab", '[data-testid="new-tab-button"]'],
        ["theme", '[data-testid="theme-select"]'],
        ["settings", '[data-testid="focused-settings-toggle"]'],
        ["policy", '[data-testid="agent-policy-toggle"]'],
        ["agent-status", '[data-testid="agent-activity"]'],
      ] as const;
      const controls = controlSelectors.map(([name, selector]) => ({
        name,
        element: titlebar?.querySelector<HTMLElement>(selector) ?? null,
      }));
      if (
        !titlebar ||
        !content ||
        !tabStrip ||
        !activeTab ||
        controls.some((item) => !item.element)
      ) {
        return null;
      }

      const overlay = (
        navigator as Navigator & {
          windowControlsOverlay?: {
            visible: boolean;
            getTitlebarAreaRect: () => DOMRect;
          };
        }
      ).windowControlsOverlay;
      const overlayRect = overlay?.getTitlebarAreaRect();
      const bounds = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      const persistentControls = [
        { name: "active-tab", element: activeTab },
        ...controls.map(({ name, element }) => ({ name, element: element! })),
      ];
      const inspectedControls = persistentControls.map(({ name, element }) => {
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hitTarget = document.elementFromPoint(centerX, centerY);
        const style = getComputedStyle(element);
        return {
          name,
          ...bounds(element),
          width: rect.width,
          height: rect.height,
          visible:
            style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
          hit: Boolean(hitTarget && (hitTarget === element || element.contains(hitTarget))),
        };
      });
      const overlaps: string[] = [];
      for (let left = 0; left < inspectedControls.length; left += 1) {
        for (let right = left + 1; right < inspectedControls.length; right += 1) {
          const first = inspectedControls[left]!;
          const second = inspectedControls[right]!;
          if (
            Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 &&
            Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1
          ) {
            overlaps.push(`${first.name}:${second.name}`);
          }
        }
      }

      return {
        viewportWidth: window.innerWidth,
        titlebar: bounds(titlebar),
        content: bounds(content),
        tabStrip: bounds(tabStrip),
        activeTab: bounds(activeTab),
        controls: inspectedControls,
        overlaps,
        dragRegion: getComputedStyle(titlebar).getPropertyValue("app-region").trim(),
        tabStripRegion: getComputedStyle(tabStrip).getPropertyValue("app-region").trim(),
        controlRegions: controls.map(({ element }) =>
          getComputedStyle(element!).getPropertyValue("app-region").trim(),
        ),
        overlay: overlayRect
          ? {
              visible: overlay?.visible ?? false,
              left: overlayRect.x,
              right: overlayRect.x + overlayRect.width,
              height: overlayRect.height,
            }
          : null,
      };
    });

    if (!chrome) throw new Error("Expected the complete integrated titlebar.");
    if (Math.round(chrome.titlebar.bottom - chrome.titlebar.top) !== 44) {
      throw new Error(`Expected a 44px titlebar: ${JSON.stringify(chrome.titlebar)}`);
    }
    if (
      chrome.dragRegion !== "drag" ||
      chrome.tabStripRegion !== "drag" ||
      chrome.controlRegions.some((value) => value !== "no-drag")
    ) {
      throw new Error(`Expected drag-safe titlebar controls: ${JSON.stringify(chrome)}`);
    }
    if (
      chrome.activeTab.left < chrome.tabStrip.left - 1 ||
      chrome.activeTab.right > chrome.tabStrip.right + 1 ||
      chrome.content.right > chrome.titlebar.right + 1 ||
      chrome.content.right > chrome.viewportWidth + 1 ||
      chrome.controls.some(
        (control) =>
          control.width <= 0 ||
          control.height <= 0 ||
          !control.visible ||
          !control.hit ||
          control.left < chrome.content.left - 1 ||
          control.right > chrome.content.right + 1 ||
          control.left < -1 ||
          control.right > chrome.viewportWidth + 1,
      ) ||
      chrome.overlaps.length > 0
    ) {
      throw new Error(
        `Expected all titlebar actions inside the safe area: ${JSON.stringify(chrome)}`,
      );
    }
    if (!chrome.overlay?.visible) {
      throw new Error(`Expected native window-controls overlay: ${JSON.stringify(chrome)}`);
    }
    if (
      Math.round(chrome.overlay.height) !== 44 ||
      chrome.content.left < chrome.overlay.left - 1 ||
      chrome.content.right > chrome.overlay.right + 1
    ) {
      throw new Error(
        `Expected titlebar content inside the overlay safe area: ${JSON.stringify(chrome)}`,
      );
    }

    if (process.platform !== "darwin") {
      const readyMarker = "TERMINAL_CTRL_W_INPUT_READY";
      const handledMarker = "TERMINAL_CTRL_W_INPUT_HANDLED";
      const sessionId = await activeSessionId(page);
      const command = nodeEvalCommand(
        [
          "process.stdin.setRawMode(true);",
          "process.stdin.resume();",
          `process.stdout.write(${JSON.stringify(`${readyMarker}\n`)});`,
          "process.stdin.once('data', (data) => {",
          "  const handled = data.includes(0x17);",
          "  process.stdin.setRawMode(false);",
          `  if (handled) process.stdout.write(${JSON.stringify(`${handledMarker}\n`)});`,
          "  process.exit(handled ? 0 : 1);",
          "});",
        ].join("\n"),
      );
      await writeRendererInput(page, sessionId, `${command}\r`);
      await waitForTerminalText(page, readyMarker);
      const terminalInput = page.locator(".xterm-helper-textarea");
      await terminalInput.focus();
      await page.keyboard.press("Control+W");
      await waitForTerminalText(page, handledMarker);
    }
  });

  it("persists focused settings and applies accessibility preferences to the live terminal", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    await setNativeWindowSize(page, 640, 560);
    await page.getByTestId("theme-select").selectOption("gamer");
    await page.waitForFunction(
      () => document.querySelector<HTMLElement>(".app-shell")?.dataset.theme === "gamer",
      undefined,
      { timeout: e2eUiTimeoutMs },
    );

    await page.getByTestId("focused-settings-toggle").click();
    await page.getByRole("region", { name: "Terminal settings" }).waitFor({
      timeout: e2eUiTimeoutMs,
    });
    await page.getByRole("button", { name: "Add profile" }).click();
    const settingsLayout = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>(".focused-settings-panel");
      const profile = panel?.querySelector<HTMLElement>(".focused-settings-shell-profile");
      const checkbox = panel?.querySelector<HTMLInputElement>(
        '[data-testid="accessibility-screen-reader"]',
      );
      const checkboxText = checkbox
        ?.closest("label")
        ?.querySelector<HTMLElement>(".focused-settings-checkbox-label");
      const controls = profile
        ? [
            ...Array.from(profile.querySelectorAll<HTMLElement>("input, button")),
            ...Array.from(panel!.querySelectorAll<HTMLElement>(".focused-settings-add-profile")),
          ]
        : [];
      if (!panel || !profile || !checkbox || !checkboxText || controls.length !== 5) return null;

      const panelRect = panel.getBoundingClientRect();
      const controlBounds = controls.map((control) => {
        const rect = control.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return {
          left: rect.left,
          right: rect.right,
          hit: Boolean(hit && (hit === control || control.contains(hit))),
        };
      });
      const checkboxRect = checkbox.getBoundingClientRect();
      const checkboxTextRect = checkboxText.getBoundingClientRect();
      return {
        panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
        profileOverflow: profile.scrollWidth > profile.clientWidth + 1,
        controlsInsidePanel: controlBounds.every(
          (bounds) =>
            bounds.left >= panelRect.left - 1 && bounds.right <= panelRect.right + 1 && bounds.hit,
        ),
        checkboxCenterDelta: Math.abs(
          checkboxRect.top +
            checkboxRect.height / 2 -
            (checkboxTextRect.top + checkboxTextRect.height / 2),
        ),
      };
    });
    if (
      !settingsLayout ||
      settingsLayout.panelOverflow ||
      settingsLayout.profileOverflow ||
      !settingsLayout.controlsInsidePanel ||
      settingsLayout.checkboxCenterDelta > 1
    ) {
      throw new Error(
        `Expected responsive focused settings controls: ${JSON.stringify(settingsLayout)}`,
      );
    }
    await page.getByRole("button", { name: "Remove profile" }).click();
    await page.getByTestId("setting-font-size").fill("16");
    await page.getByTestId("setting-font-family").selectOption("custom");
    await page.getByTestId("setting-font-family-custom").fill('Consolas, "Courier New", monospace');
    await page.getByTestId("setting-scrollback").fill("12000");
    await page.getByTestId("setting-color-background").fill("#112233");
    await page.getByTestId("accessibility-minimum-contrast").fill("7");
    await page.getByTestId("accessibility-screen-reader").check();
    await page.getByTestId("accessibility-reduced-motion").check();
    await page.getByTestId("focused-settings-save").click();

    await page.waitForFunction(
      () => {
        const shell = document.querySelector<HTMLElement>(".app-shell");
        return (
          shell?.dataset.screenReader === "true" &&
          shell.dataset.reducedMotion === "true" &&
          shell.style.getPropertyValue("--terminal-font").includes("Consolas") &&
          shell.style.getPropertyValue("--terminal-bg") === "#112233"
        );
      },
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    await page.locator(".xterm-accessibility-tree").waitFor({ timeout: e2eUiTimeoutMs });
    await waitForFileText(join(userDataDir, "settings.json"), '"schemaVersion": 4');
    const saved = JSON.parse(await readFile(join(userDataDir, "settings.json"), "utf8")) as {
      accessibility?: { screenReaderMode?: boolean; reducedMotion?: boolean };
      terminal?: { fontSize?: number; scrollback?: number };
    };
    if (
      saved.terminal?.fontSize !== 16 ||
      saved.terminal.scrollback !== 12_000 ||
      saved.accessibility?.screenReaderMode !== true ||
      saved.accessibility.reducedMotion !== true
    ) {
      throw new Error(`Expected focused settings to persist: ${JSON.stringify(saved)}`);
    }
  });

  it("applies saved presentation defaults to later human terminals only", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        { ...defaultTerminalConfig(), defaultPresentation: "background" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);

    await page.getByTestId("new-tab-button").click();
    await page.waitForFunction(
      async () => {
        const sessions = await window.terminalApi.listSessions();
        return (
          document.querySelectorAll("[data-terminal-tab='true']").length === 2 &&
          sessions.length === 2 &&
          sessions.some((session) => session.presentation.state === "background")
        );
      },
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    const selectedTabs = await page
      .locator("[data-terminal-tab='true'][aria-selected='true']")
      .count();
    if (
      selectedTabs !== 1 ||
      (await page.getByTestId("terminal-tab-0").getAttribute("aria-selected")) !== "true"
    ) {
      throw new Error("A background terminal must not replace the active foreground tab.");
    }

    await page.getByTestId("focused-settings-toggle").click();
    await page.getByTestId("setting-default-presentation").selectOption("headless");
    await page.getByTestId("focused-settings-save").click();
    await page.waitForFunction(
      async () => (await window.terminalApi.getConfig()).defaultPresentation === "headless",
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
    await page.getByTestId("new-tab-button").click();
    await page.waitForFunction(
      async () => {
        const sessions = await window.terminalApi.listSessions();
        return (
          document.querySelectorAll("[data-terminal-tab='true']").length === 2 &&
          sessions.length === 3 &&
          sessions.filter((session) => session.presentation.state === "headless").length === 1
        );
      },
      undefined,
      { timeout: e2eUiTimeoutMs },
    );
  });

  it("keeps a live-bottom renderer viewport on the settled end of bursty output", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const sessionId = await activeSessionId(page);
    const marker = "BURST_OUTPUT_SETTLED_AT_BOTTOM";
    const command = nodeEvalCommand(
      [
        "let line = 0;",
        "const emit = () => {",
        "  if (line < 160) {",
        '    process.stdout.write(`burst-${String(line).padStart(3, "0")}\\n`, () => {',
        "      line += 1;",
        "      setImmediate(emit);",
        "    });",
        "    return;",
        "  }",
        `  process.stdout.write(${JSON.stringify(`${marker}\n`)});`,
        "};",
        "emit();",
      ].join("\n"),
    );

    await writeRendererInput(page, sessionId, `${command}\r`);
    await waitForTerminalText(page, marker);
  });

  it("terminates a live session when the human confirms tab close", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);

    page.once("dialog", (dialog) => dialog.accept());
    await Promise.all([page.waitForEvent("close"), page.getByTestId("close-tab-0").click()]);
  });

  it("restores terminal focus after closing an inactive tab", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);

    await page.getByTestId("new-tab-button").click();
    await expectTabCount(page, 2);
    await waitForTerminalReady(page);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("close-tab-0").click();
    await expectTabCount(page, 1);
    await page.waitForFunction(
      () => {
        const terminal = document.querySelector<HTMLElement>(
          "[data-testid='terminal-ready'] .xterm",
        );
        const input = terminal?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        return terminal?.classList.contains("focus") && document.activeElement === input;
      },
      undefined,
      { timeout: e2eUiTimeoutMs },
    );

    const marker = "FOCUS_AFTER_INACTIVE_TAB_CLOSE";
    await page.keyboard.insertText(platformPrintCommand(marker));
    await page.keyboard.press("Enter");
    await waitForTerminalText(page, marker);
  });

  it("allows the only visible session to be hidden or terminated without replacement", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const sessionId = await activeSessionId(page);
    const card = page.getByTestId(`session-card-${sessionId}`);

    await card.getByRole("button", { name: "Hide" }).click();
    await expectTabCount(page, 0);
    await page.getByTestId("terminal-empty-state").waitFor({ timeout: e2eUiTimeoutMs });
    await card.getByText("headless", { exact: true }).waitFor({ timeout: e2eUiTimeoutMs });

    await card.getByRole("button", { name: "Reveal" }).click();
    await expectTabCount(page, 1);
    await waitForActiveSession(page, sessionId);

    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: "Terminate" }).click();
    await card.waitFor({ state: "detached", timeout: e2eUiTimeoutMs });
    await expectTabCount(page, 0);
    await page.getByTestId("terminal-empty-state").waitFor({ timeout: e2eUiTimeoutMs });
    if (page.isClosed())
      throw new Error("Expected sidebar termination to keep the app window open.");
  });

  it("keeps tab and session navigation reachable in a narrow window", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    await setNativeWindowSize(page, 720, 560);

    for (let index = 0; index < 7; index += 1) {
      await page.getByTestId("new-tab-button").click();
    }
    await expectTabCount(page, 8);
    await page.waitForFunction(
      () => {
        const strip = document.querySelector<HTMLElement>('[data-testid="terminal-tab-strip"]');
        const activeTab = strip?.querySelector<HTMLElement>(".tab-item.is-active");
        if (!strip || !activeTab) return false;
        const stripBounds = strip.getBoundingClientRect();
        const activeTabBounds = activeTab.getBoundingClientRect();
        return (
          activeTabBounds.left >= stripBounds.left - 1 &&
          activeTabBounds.right <= stripBounds.right + 1
        );
      },
      undefined,
      { timeout: terminalUiTimeoutMs(process.platform) },
    );
    await page.getByTestId("terminal-status").waitFor({ state: "visible" });
    if ((await page.locator(".titlebar-status .terminal-state").count()) !== 0) {
      throw new Error("Expected terminal lifecycle to appear only in the active tab.");
    }

    const sidebarToggle = page.getByTestId("session-sidebar-toggle");
    const toggleText = (await sidebarToggle.textContent())?.trim() ?? "";
    if (toggleText !== "") {
      throw new Error(`Expected an icon-only session toggle, got ${JSON.stringify(toggleText)}.`);
    }
    await sidebarToggle.click();
    await page.getByTestId("session-sidebar").waitFor({ state: "hidden" });
    await sidebarToggle.click();
    await page.getByTestId("session-sidebar").waitFor({ state: "visible" });

    const terminalScrollbar = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>(".app-shell");
      const host = document.querySelector<HTMLElement>("[data-testid='terminal-ready']");
      const track = host?.querySelector<HTMLElement>(
        ".xterm-scrollable-element > .scrollbar.vertical",
      );
      const slider = track?.querySelector<HTMLElement>(":scope > .slider");
      const viewport = host?.querySelector<HTMLElement>(".xterm-viewport");
      const overviewRuler = host?.querySelector<HTMLCanvasElement>(
        ".xterm-decoration-overview-ruler",
      );
      if (!shell || !host || !track || !slider || !viewport || !overviewRuler) return null;
      const probe = document.createElement("div");
      probe.style.background = "var(--scrollbar-thumb)";
      probe.style.border = "2px solid transparent";
      shell.append(probe);
      const probeStyle = getComputedStyle(probe);
      const tokenColor = probeStyle.backgroundColor;
      const tokenBorderWidth = probeStyle.borderTopWidth;
      probe.remove();
      const sliderStyle = getComputedStyle(slider);
      const hostBounds = host.getBoundingClientRect();
      const trackBounds = track.getBoundingClientRect();
      const terminal = host.querySelector<HTMLElement>(":scope > .xterm");
      if (!terminal) return null;
      const terminalStyle = getComputedStyle(terminal);
      const rulerContext = overviewRuler.getContext("2d", { willReadFrequently: true });
      const colorProbe = document.createElement("canvas");
      colorProbe.width = 1;
      colorProbe.height = 1;
      const colorProbeContext = colorProbe.getContext("2d", { willReadFrequently: true });
      if (!rulerContext || !colorProbeContext) return null;
      colorProbeContext.fillStyle = getComputedStyle(host).backgroundColor;
      colorProbeContext.fillRect(0, 0, 1, 1);
      return {
        trackWidth: track.getBoundingClientRect().width,
        trackRightGap: hostBounds.right - trackBounds.right,
        terminalPaddingLeft: terminalStyle.paddingLeft,
        terminalPaddingRight: terminalStyle.paddingRight,
        nativeViewportGutter: viewport.offsetWidth - viewport.clientWidth,
        nativeScrollbarWidth: getComputedStyle(viewport).scrollbarWidth,
        overviewRulerBorderPixel: Array.from(
          rulerContext.getImageData(0, Math.floor(overviewRuler.height / 2), 1, 1).data,
        ),
        terminalBackgroundPixel: Array.from(colorProbeContext.getImageData(0, 0, 1, 1).data),
        color: sliderStyle.backgroundColor,
        tokenColor,
        tokenBorderWidth,
        borderRadius: sliderStyle.borderRadius,
        borderWidth: sliderStyle.borderTopWidth,
        backgroundClip: sliderStyle.backgroundClip,
      };
    });
    if (!terminalScrollbar) throw new Error("Expected xterm's custom terminal scrollbar.");
    if (Math.round(terminalScrollbar.trackWidth) !== 8) {
      throw new Error(`Expected an 8px terminal scrollbar, got ${terminalScrollbar.trackWidth}px.`);
    }
    if (
      Math.abs(terminalScrollbar.trackRightGap) > 1 ||
      terminalScrollbar.terminalPaddingLeft !== "12px" ||
      terminalScrollbar.terminalPaddingRight !== "0px"
    ) {
      throw new Error(
        `Expected terminal content padding without a right-edge scrollbar gap: ${JSON.stringify(terminalScrollbar)}.`,
      );
    }
    if (
      terminalScrollbar.nativeViewportGutter !== 0 ||
      terminalScrollbar.nativeScrollbarWidth !== "none"
    ) {
      throw new Error(
        `Expected no duplicate native terminal scrollbar: ${JSON.stringify(terminalScrollbar)}.`,
      );
    }
    if (
      terminalScrollbar.overviewRulerBorderPixel.join(",") !==
      terminalScrollbar.terminalBackgroundPixel.join(",")
    ) {
      throw new Error(
        `Expected no contrasting overview-ruler edge: ${JSON.stringify(terminalScrollbar)}.`,
      );
    }
    if (terminalScrollbar.color !== terminalScrollbar.tokenColor) {
      throw new Error(
        `Expected shared scrollbar color ${terminalScrollbar.tokenColor}, got ${terminalScrollbar.color}.`,
      );
    }
    if (
      terminalScrollbar.borderRadius !== "999px" ||
      terminalScrollbar.borderWidth !== terminalScrollbar.tokenBorderWidth ||
      terminalScrollbar.backgroundClip !== "padding-box"
    ) {
      throw new Error(
        `Expected compact pill scrollbar styling: ${JSON.stringify(terminalScrollbar)}`,
      );
    }

    const tabStrip = page.getByTestId("terminal-tab-strip");
    const before = await tabStrip.evaluate((element) => element.scrollLeft);
    await page.getByTestId("tab-scroll-previous").click();
    const after = await tabStrip.evaluate((element) => element.scrollLeft);
    if (after >= before) {
      throw new Error(
        `Expected previous tab overflow control to scroll left: ${before} -> ${after}`,
      );
    }
    await page.getByTestId("new-tab-button").waitFor({ state: "visible" });
  });

  it("keeps agent policy controls within the popover in wide-font themes", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    await setNativeWindowSize(page, 720, 640);

    for (const theme of ["classic", "gamer"]) {
      await page.getByTestId("theme-select").selectOption(theme);
      await page.waitForFunction(
        (expectedTheme) =>
          document.querySelector(".app-shell")?.getAttribute("data-theme") === expectedTheme,
        theme,
      );
      await page.getByTestId("agent-policy-toggle").click();
      const popover = page.getByRole("region", { name: "Agent policy settings" });
      await popover.waitFor({ state: "visible" });
      const overflows = await popover.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      if (overflows) {
        throw new Error(`Agent policy controls overflow in the ${theme} theme.`);
      }
      await page.getByTestId("agent-policy-toggle").click();
    }
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
    await assertAgentAccessKeyNotExposed(page, TEST_AGENT_ACCESS_KEY);
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

    assertAgentAccessKeyNotInText(
      `${electronOutput}\n${rendererOutput}`,
      TEST_AGENT_ACCESS_KEY,
      "Electron and renderer diagnostics",
    );
  });

  it("rotates the agent access key without terminating existing terminal sessions", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const sessionId = await activeSessionId(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);
    let replacementAgent: E2EAgentClient | null = null;

    try {
      await page.getByTestId("focused-settings-toggle").click();
      await page.getByRole("region", { name: "Terminal settings" }).waitFor({
        state: "visible",
        timeout: e2eUiTimeoutMs,
      });

      const disconnected = agent.waitForDisconnect();
      page.once("dialog", (dialog) => {
        void dialog.accept();
      });
      await page.getByTestId("agent-access-regenerate").click();
      await page
        .getByTestId("agent-access-feedback")
        .filter({ hasText: "New agent access key generated." })
        .waitFor({ state: "visible", timeout: e2eUiTimeoutMs });
      await disconnected;

      const replacementAccessKey = await readPersistedAgentAccessKey(userDataDir);
      if (replacementAccessKey === TEST_AGENT_ACCESS_KEY) {
        throw new Error("Expected regeneration to persist a replacement agent access key.");
      }
      await assertAgentAccessKeyNotExposed(page, TEST_AGENT_ACCESS_KEY);
      await assertAgentAccessKeyNotExposed(page, replacementAccessKey);
      assertAgentAccessKeyNotInText(
        `${electronOutput}\n${rendererOutput}`,
        replacementAccessKey,
        "Electron and renderer diagnostics",
      );

      replacementAgent = await authenticatedAgent(descriptor, replacementAccessKey);
      const existingSession = (await expectAgentOk(
        replacementAgent.request(createAgentCommand("terminal.get", { sessionId })),
      )) as TerminalSessionSummary;
      if (existingSession.sessionId !== sessionId) {
        throw new Error("Expected the terminal session to survive agent access key regeneration.");
      }
      if (existingSession.lifecycle !== "running") {
        throw new Error(
          `Expected the terminal session to remain running after regeneration, got ${existingSession.lifecycle}.`,
        );
      }
      await expectAgentOk(
        replacementAgent.request(createAgentCommand("terminal.attach", { sessionId })),
      );
      await expectAgentOk(
        replacementAgent.request(
          createAgentCommand("terminal.input", {
            sessionId,
            input: `${platformPrintCommand("ROTATED_AGENT_OK")}\r`,
          }),
        ),
      );
      await waitForObservation(replacementAgent, sessionId, (observation) =>
        observation.viewport.rows.some((row) => row.text.includes("ROTATED_AGENT_OK")),
      );
    } finally {
      agent.close();
      replacementAgent?.close();
    }
  });

  it("lets a human reveal, record, hide, revoke, and terminate an agent session", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.create", {})),
      )) as TerminalSessionSummary;
      const card = page.getByTestId(`session-card-${created.sessionId}`);
      await card.waitFor({ timeout: e2eUiTimeoutMs });
      await card.getByText("Agent attached").waitFor({ timeout: e2eUiTimeoutMs });
      await card.getByText("headless").waitFor({ timeout: e2eUiTimeoutMs });

      await card.getByRole("button", { name: "Reveal" }).click();
      await waitForActiveSession(page, created.sessionId);
      await expectTabCount(page, 2);
      await card.getByText("foreground", { exact: true }).waitFor({ timeout: e2eUiTimeoutMs });

      await card.getByRole("button", { name: "Record", exact: true }).click();
      await card.getByText("active", { exact: true }).waitFor({ timeout: e2eUiTimeoutMs });
      await card.getByRole("button", { name: "Stop recording" }).click();
      await card.getByText("inactive", { exact: true }).waitFor({ timeout: e2eUiTimeoutMs });

      await card.getByRole("button", { name: "Hide" }).click();
      await expectTabCount(page, 1);
      await card.getByText("headless").waitFor({ timeout: e2eUiTimeoutMs });

      await card.getByRole("button", { name: "Reveal" }).click();
      await waitForActiveSession(page, created.sessionId);
      await card.getByText("foreground", { exact: true }).waitFor({ timeout: e2eUiTimeoutMs });
      await card.getByRole("button", { name: "Revoke agent" }).click();
      await card.getByText("Agent blocked").waitFor({ timeout: e2eUiTimeoutMs });

      const denied = await agent.request(
        createAgentCommand("terminal.input", {
          sessionId: created.sessionId,
          input: `${platformPrintCommand("AGENT_SHOULD_NOT_RUN")}\r`,
        }),
      );
      if (denied.ok || denied.error.cause !== "session_not_owned") {
        throw new Error(`Expected revoked agent input denial: ${JSON.stringify(denied)}`);
      }
      await page
        .getByText("Agent connection is not attached to this terminal session.")
        .waitFor({ timeout: e2eUiTimeoutMs });

      const blockedAttach = await agent.request(
        createAgentCommand("terminal.attach", { sessionId: created.sessionId }),
      );
      if (blockedAttach.ok || blockedAttach.error.cause !== "agent_control_revoked") {
        throw new Error(`Expected revoked attachment denial: ${JSON.stringify(blockedAttach)}`);
      }

      await card.getByRole("button", { name: "Allow agent control" }).click();
      await card.getByText("No agent").waitFor({ timeout: e2eUiTimeoutMs });
      await expectAgentOk(
        agent.request(createAgentCommand("terminal.attach", { sessionId: created.sessionId })),
      );
      await card.getByText("Agent attached").waitFor({ timeout: e2eUiTimeoutMs });
      await card.getByRole("button", { name: "Revoke agent" }).click();
      await card.getByText("Agent blocked").waitFor({ timeout: e2eUiTimeoutMs });

      await writeRendererInput(
        page,
        created.sessionId,
        `${platformPrintCommand("HUMAN_AFTER_REVOKE")}\r`,
      );
      await waitForTerminalText(page, "HUMAN_AFTER_REVOKE");

      page.once("dialog", (dialog) => dialog.accept());
      await card.getByRole("button", { name: "Terminate" }).click();
      await card.waitFor({ state: "detached", timeout: e2eUiTimeoutMs });
    } finally {
      agent.close();
    }
  });

  it("exposes trusted shell lifecycle and cwd for a headless agent session", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.create", {
            shell: supportedE2eShell(),
            cwd: homedir(),
            env: { HOME: userDataDir },
          }),
        ),
      )) as TerminalSessionSummary;
      await waitForObservation(
        agent,
        created.sessionId,
        (observation) =>
          observation.shellIntegration.status === "available" &&
          observation.command.state === "idle",
      );

      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: `${inputGateFixtureCommand(
              "SHELL_INTEGRATION_INPUT_READY",
              "SHELL_INTEGRATION_OK",
            )}\r`,
          }),
        ),
      );
      await waitForObservation(
        agent,
        created.sessionId,
        (observation) =>
          observation.command.state === "running" &&
          observation.viewport.rows.some((row) =>
            row.text.includes("SHELL_INTEGRATION_INPUT_READY"),
          ),
      );
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: "continue\r",
          }),
        ),
      );
      await waitForObservation(
        agent,
        created.sessionId,
        (observation) =>
          observation.command.state === "idle" &&
          observation.command.lastCommand?.exitCode === 0 &&
          observation.viewport.rows.some((row) => row.text.includes("SHELL_INTEGRATION_OK")),
      );

      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId: created.sessionId,
            input: `${changeDirectoryCommand(userDataDir)}\r`,
          }),
        ),
      );
      const changedDirectory = await waitForObservation(
        agent,
        created.sessionId,
        (observation) =>
          observation.command.state === "idle" && sameCanonicalPath(observation.cwd, userDataDir),
      );
      if (!sameCanonicalPath(changedDirectory.cwd, userDataDir)) {
        throw new Error(`Expected integrated cwd ${userDataDir}, got ${changedDirectory.cwd}.`);
      }
      await expectAgentOk(
        agent.request(createAgentCommand("terminal.close", { sessionId: created.sessionId })),
      );
    } finally {
      agent.close();
    }
  });

  it("automates background, foreground, and headless presentation for agent sessions", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const humanSessionId = await activeSessionId(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.create", {
            presentation: "background",
          }),
        ),
      )) as TerminalSessionSummary;

      await expectTabCount(page, 2);
      if ((await activeSessionId(page)) !== humanSessionId) {
        throw new Error("Background presentation unexpectedly selected the agent terminal.");
      }
      if (created.presentation.state !== "background") {
        throw new Error(
          `Expected background presentation: ${JSON.stringify(created.presentation)}`,
        );
      }

      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.setPresentation", {
            sessionId: created.sessionId,
            presentation: "foreground",
          }),
        ),
      );
      await waitForActiveSession(page, created.sessionId);

      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.setPresentation", {
            sessionId: created.sessionId,
            presentation: "headless",
          }),
        ),
      );
      await expectTabCount(page, 1);
      await expectAgentOk(
        agent.request(createAgentCommand("terminal.close", { sessionId: created.sessionId })),
      );
    } finally {
      agent.close();
    }
  });

  it("presents temporary PTY runs before completion and retains their exited view", async () => {
    const userDataDir = await createTempUserDataDir();
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const humanSessionId = await activeSessionId(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const temporary = await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.run", {
            input: nodeEvalCommand(
              [
                'process.stdout.write("PRESENTED_READY\\n");',
                'process.stdin.setEncoding("utf8");',
                'process.stdin.on("data", () => process.exit(0));',
              ].join("\n"),
            ),
            tty: true,
            timeoutMs: 50,
            presentation: "background",
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
        throw new Error(`Unexpected presented run result: ${JSON.stringify(temporary)}`);
      }
      const sessionId = createSessionId(temporary.sessionId);
      const operationId = createOperationId(temporary.operationId);

      await expectTabCount(page, 2);
      if ((await activeSessionId(page)) !== humanSessionId) {
        throw new Error("Background temporary PTY unexpectedly took focus.");
      }
      await expectAgentOk(
        agent.request(
          createAgentCommand("terminal.input", {
            sessionId,
            input: "finish\r",
          }),
        ),
      );
      await waitForSessionLifecycle(agent, sessionId, "exited");
      await expectTabCount(page, 2);
      await expectAgentOk(agent.request(createAgentCommand("terminal.close", { operationId })));
      await expectTabCount(page, 1);
    } finally {
      agent.close();
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

  it("observes alternate-screen TUI contents from the canonical headless model", async () => {
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
      if (!observation.alternateScreen) {
        throw new Error("Expected the alternate-screen buffer to remain observable.");
      }
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
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    await page.getByText("Redaction 1 pattern").waitFor({ timeout: e2eUiTimeoutMs });
    const sidebarText = await page.getByTestId("session-sidebar").textContent();
    if (sidebarText?.includes("SECRET_TOKEN")) {
      throw new Error("Recording redaction patterns must not be exposed in collaboration UI.");
    }
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

  it("lets a human deny or allow-once an agent operation without exposing command content", async () => {
    const userDataDir = await createTempUserDataDir();
    await writeFile(
      join(userDataDir, "settings.json"),
      `${JSON.stringify(
        {
          ...defaultTerminalConfig(),
          agentPolicy: {
            ...defaultTerminalConfig().agentPolicy,
            termination: "ask",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    browser = await launchApp(userDataDir);
    const page = await firstPage(browser);
    await waitForTerminalReady(page);
    const descriptor = await waitForAgentDescriptor(userDataDir);
    const agent = await authenticatedAgent(descriptor);

    try {
      const created = (await expectAgentOk(
        agent.request(createAgentCommand("terminal.create", {})),
      )) as TerminalSessionSummary;

      const deniedResult = agent.request(
        createAgentCommand("terminal.close", { sessionId: created.sessionId }),
      );
      const permission = page.getByTestId(`permission-${created.sessionId}`);
      await permission.waitFor({ timeout: e2eUiTimeoutMs });
      const permissionText = await permission.textContent();
      if (permissionText?.includes("SECRET_COMMAND")) {
        throw new Error("Permission UI exposed terminal command content.");
      }
      await permission.getByRole("button", { name: "Deny" }).click();
      const denied = await deniedResult;
      if (denied.ok || denied.error.cause !== "permission_denied") {
        throw new Error(`Expected human permission denial: ${JSON.stringify(denied)}`);
      }
      await waitForSessionLifecycle(agent, created.sessionId, "running");

      const allowedResult = agent.request(
        createAgentCommand("terminal.close", { sessionId: created.sessionId }),
      );
      await permission.waitFor({ timeout: e2eUiTimeoutMs });
      await permission.getByRole("button", { name: "Allow once" }).click();
      await expectAgentOk(allowedResult);
    } finally {
      agent.close();
    }
  });
});

async function authenticatedAgent(
  descriptor: AgentGatewayDescriptor,
  accessKey = TEST_AGENT_ACCESS_KEY,
): Promise<E2EAgentClient> {
  const agent = await E2EAgentClient.connect(descriptor.url);
  await expectAgentOk(
    agent.request(
      createAgentCommand("agent.authenticate", {
        token: accessKey,
        protocolVersion: TERMINAL_PROTOCOL_VERSION,
      }),
    ),
  );
  return agent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameCanonicalPath(left: string, right: string): boolean {
  const canonicalLeft = realpathSync.native(left);
  const canonicalRight = realpathSync.native(right);
  return process.platform === "win32"
    ? canonicalLeft.toLowerCase() === canonicalRight.toLowerCase()
    : canonicalLeft === canonicalRight;
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

async function waitForSessionLifecycle(
  agent: E2EAgentClient,
  sessionId: SessionId,
  lifecycle: TerminalSessionSummary["lifecycle"],
): Promise<void> {
  await waitForObservation(agent, sessionId, (observation) => observation.lifecycle === lifecycle);
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
  await preseedAgentAccessKey(userDataDir);
  return userDataDir;
}

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const appCwd = fileURLToPath(new URL("../../", import.meta.url));
  electronOutput = "";
  rendererOutput = "";
  const application = await electron.launch({
    executablePath: electronPath,
    args: [`--user-data-dir=${userDataDir}`, ...platformElectronFlags(), "out/main/index.cjs"],
    cwd: appCwd,
    env: e2eEnvironment(),
    timeout: e2eAppLaunchTimeoutMs,
  });
  electronProcess = application.process();
  electronProcess.stdout?.on("data", (chunk: Buffer) => appendElectronOutput("stdout", chunk));
  electronProcess.stderr?.on("data", (chunk: Buffer) => appendElectronOutput("stderr", chunk));
  return application;
}

async function firstPage(connectedBrowser: ElectronApplication): Promise<Page> {
  const page = await connectedBrowser.firstWindow({ timeout: e2eUiTimeoutMs });
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

async function setNativeWindowSize(page: Page, width: number, height: number): Promise<void> {
  const connectedBrowser = browser;
  if (!connectedBrowser) throw new Error("Cannot resize a disconnected Electron app.");

  const nativeContentBounds = await connectedBrowser.evaluate(
    ({ BrowserWindow }, nextBounds) => {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
      if (windows.length !== 1) {
        throw new Error(`Expected one Electron window, found ${windows.length}.`);
      }

      const window = windows[0]!;
      window.setSize(nextBounds.width, nextBounds.height, false);
      return window.getContentBounds();
    },
    { width, height },
  );

  try {
    await page.waitForFunction(
      ({ expectedWidth, expectedHeight }) => {
        const overlay = (
          navigator as Navigator & {
            windowControlsOverlay?: {
              visible: boolean;
              getTitlebarAreaRect: () => DOMRect;
            };
          }
        ).windowControlsOverlay;
        const overlayRect = overlay?.getTitlebarAreaRect();
        const contentRect = document
          .querySelector<HTMLElement>(".titlebar-content")
          ?.getBoundingClientRect();

        return (
          Math.abs(window.innerWidth - expectedWidth) <= 32 &&
          window.innerHeight <= expectedHeight + 32 &&
          window.innerHeight >= expectedHeight - 80 &&
          overlay?.visible === true &&
          overlayRect !== undefined &&
          overlayRect.width > 0 &&
          overlayRect.x >= -1 &&
          overlayRect.right <= window.innerWidth + 1 &&
          Math.abs(overlayRect.height - 44) <= 1 &&
          contentRect !== undefined &&
          contentRect.left >= overlayRect.left - 1 &&
          contentRect.right <= overlayRect.right + 1 &&
          contentRect.right <= window.innerWidth + 1
        );
      },
      { expectedWidth: width, expectedHeight: height },
      { timeout: e2eUiTimeoutMs },
    );
  } catch (error: unknown) {
    const actual = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      overlay: (() => {
        const value = (
          navigator as Navigator & {
            windowControlsOverlay?: {
              visible: boolean;
              getTitlebarAreaRect: () => DOMRect;
            };
          }
        ).windowControlsOverlay;
        const rect = value?.getTitlebarAreaRect();
        return rect
          ? {
              visible: value?.visible ?? false,
              left: rect.left,
              right: rect.right,
              height: rect.height,
            }
          : null;
      })(),
      content: (() => {
        const rect = document
          .querySelector<HTMLElement>(".titlebar-content")
          ?.getBoundingClientRect();
        return rect ? { left: rect.left, right: rect.right, height: rect.height } : null;
      })(),
    }));
    throw new Error(
      `Native window and titlebar overlay did not settle near ${width}x${height}; native=${JSON.stringify(nativeContentBounds)} actual=${JSON.stringify(actual)}.`,
      { cause: error },
    );
  }
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

async function waitForActiveSession(page: Page, sessionId: SessionId): Promise<void> {
  await page.waitForFunction(
    (expectedSessionId) =>
      document.querySelector("[data-testid='terminal-ready']")?.getAttribute("data-session-id") ===
      expectedSessionId,
    sessionId,
    { timeout: e2eUiTimeoutMs },
  );
}

async function waitForAgentDescriptor(userDataDir: string): Promise<AgentGatewayDescriptor> {
  const descriptorPath = join(userDataDir, "agent-gateway.json");
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    let contents: string;
    try {
      contents = await readFile(descriptorPath, "utf8");
    } catch {
      await delay(50);
      continue;
    }
    assertAgentAccessKeyNotInText(contents, TEST_AGENT_ACCESS_KEY, "Agent gateway descriptor");
    try {
      return parseAgentGatewayDescriptor(JSON.parse(contents) as unknown);
    } catch {
      await delay(50);
    }
  }
  throw new Error("Timed out waiting for agent gateway descriptor.");
}

async function assertAgentAccessKeyNotExposed(page: Page, accessKey: string): Promise<void> {
  assertAgentAccessKeyNotInText(
    (await page.locator("body").textContent()) ?? "",
    accessKey,
    "Desktop UI",
  );
}

function assertAgentAccessKeyNotInText(contents: string, accessKey: string, source: string): void {
  if (contents.includes(accessKey)) {
    throw new Error(`${source} exposed the agent access key.`);
  }
}

async function waitForFileText(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + e2eUiTimeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")).includes(expected)) return;
    } catch {
      // The settings write may not have reached disk yet.
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${expected} in ${path}.`);
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

function supportedE2eShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function changeDirectoryCommand(cwd: string): string {
  if (process.platform === "win32") {
    return `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'`;
  }
  return `cd '${cwd.replaceAll("'", `'\\''`)}'`;
}

function e2eEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (process.platform === "win32") env.ComSpec ??= "C:\\Windows\\System32\\cmd.exe";
  else env.SHELL = "/bin/sh";
  return env;
}

function platformElectronFlags(): string[] {
  return process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : [];
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
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

  waitForDisconnect(timeoutMs = e2eUiTimeoutMs): Promise<void> {
    if (this.socket.readyState === NodeWebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.off("close", onClose);
        reject(new Error("Timed out waiting for the agent WebSocket to disconnect."));
      }, timeoutMs);
      const onClose = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      this.socket.once("close", onClose);
    });
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
