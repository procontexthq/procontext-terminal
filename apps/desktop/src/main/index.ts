import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import {
  defaultTerminalConfig,
  loadTerminalConfig,
  resolveTerminalConfigPath,
} from "@terminal/config";
import { NodePtyHost } from "@terminal/pty-host";
import { TerminalSessionManager } from "@terminal/session-core";
import type { TerminalConfig } from "@terminal/protocol";

import { registerTerminalIpc } from "./ipc";
import { createAppLogger } from "./logger";

const logger = createAppLogger();
const sessionManager = new TerminalSessionManager(new NodePtyHost());
let unregisterIpc: (() => void) | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
let quitAfterShutdown = false;

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: terminalConfig.terminal.theme.background,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl && !app.isPackaged) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

void app
  .whenReady()
  .then(async () => {
    const settingsPath = resolveTerminalConfigPath(app.getPath("userData"));
    const loadedConfig = await loadTerminalConfig(settingsPath);
    terminalConfig = loadedConfig.config;
    for (const warning of loadedConfig.warnings) {
      logger.error("settings", "settings.warning", { settingsPath, warning });
    }

    unregisterIpc = registerTerminalIpc(sessionManager, logger, () => terminalConfig);
    await createMainWindow();
    logger.info("app", "ready");

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow();
      }
    });
  })
  .catch((error: unknown) => {
    logger.error("app", "startup_failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitAfterShutdown) {
    return;
  }

  event.preventDefault();
  quitAfterShutdown = true;
  unregisterIpc?.();
  unregisterIpc = null;
  void sessionManager
    .shutdown({ timeoutMs: 1500 })
    .catch((error: unknown) => {
      logger.error("app", "shutdown_failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      app.quit();
    });
});
