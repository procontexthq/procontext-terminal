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
import { createAppLogger, parseLogLevel, resolveMainLogPath } from "./logger";

let logger = createAppLogger({
  isDevelopment: !app.isPackaged,
  level: resolveLogLevel(),
});
const sessionManager = new TerminalSessionManager(new NodePtyHost());
let unregisterIpc: (() => void) | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
let quitAfterShutdown = false;

async function createMainWindow(): Promise<BrowserWindow> {
  logger.info("window", "create_requested");
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

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    logger.error("renderer", "load_failed", {
      windowId: window.id,
      errorCode,
      errorDescription,
      validatedURL: sanitizeUrlForLog(validatedURL),
    });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    logger.error("renderer", "process_gone", {
      windowId: window.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.webContents.on("unresponsive", () => {
    logger.warn("renderer", "unresponsive", { windowId: window.id });
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl && !app.isPackaged) {
    logger.debug("renderer", "load_started", { windowId: window.id, source: "dev_server" });
    await window.loadURL(rendererUrl);
  } else {
    logger.debug("renderer", "load_started", { windowId: window.id, source: "file" });
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
  logger.info("window", "created", { windowId: window.id });

  return window;
}

process.on("uncaughtException", (error) => {
  logger.error("process", "uncaught_exception", {
    cause: error.message,
    stack: error.stack,
  });
  process.exitCode = 1;
  app.quit();
});

process.on("unhandledRejection", (reason) => {
  logger.error("process", "unhandled_rejection", {
    cause: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

void app
  .whenReady()
  .then(async () => {
    const logDirectory = app.getPath("logs");
    logger = createAppLogger({
      isDevelopment: !app.isPackaged,
      logDirectory,
      level: resolveLogLevel(),
    });
    logger.info("app", "startup", {
      isPackaged: app.isPackaged,
      logDirectory,
      logFilePath: resolveMainLogPath(logDirectory),
    });

    const settingsPath = resolveTerminalConfigPath(app.getPath("userData"));
    logger.info("settings", "load_started", { settingsPath });
    const loadedConfig = await loadTerminalConfig(settingsPath);
    terminalConfig = loadedConfig.config;
    for (const warning of loadedConfig.warnings) {
      logger.warn("settings", "warning", { settingsPath, warning });
    }
    logger.info("settings", "loaded", {
      settingsPath,
      defaultProfileConfigured: Boolean(terminalConfig.shell.defaultProfile),
    });

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
  logger.info("app", "quit_requested");
  unregisterIpc?.();
  unregisterIpc = null;
  logger.info("session", "shutdown_started", { timeoutMs: 1500 });
  void sessionManager
    .shutdown({ timeoutMs: 1500 })
    .then((result) => {
      logger.info("session", "shutdown_completed", result);
      if (result.timedOut > 0) {
        logger.warn("session", "shutdown_kill_timeout", { timedOut: result.timedOut });
      }
    })
    .catch((error: unknown) => {
      logger.error("app", "shutdown_failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      app.quit();
    });
});

function resolveLogLevel() {
  return parseLogLevel(process.env.PROCONTEXT_LOG_LEVEL, !app.isPackaged ? "debug" : "info");
}

function sanitizeUrlForLog(value: string): string {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("?")[0]?.split("#")[0] ?? "";
  }
}
