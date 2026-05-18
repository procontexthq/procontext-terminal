import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import {
  defaultTerminalConfig,
  loadTerminalConfig,
  resolveTerminalConfigPath,
  saveTerminalConfig,
} from "@terminal/config";
import { NodePtyHost } from "@terminal/pty-host";
import { FileTerminalRecorder, createPatternRedactor } from "@terminal/recorder";
import { TerminalSessionManager } from "@terminal/session-core";
import type { TerminalConfig } from "@terminal/protocol";

import { registerTerminalIpc } from "./ipc";
import { createAppLogger, parseLogLevel, resolveMainLogPath } from "./logger";

let logger = createAppLogger({
  isDevelopment: !app.isPackaged,
  level: resolveLogLevel(),
});
let recorder: FileTerminalRecorder | null = null;
const sessionManager = new TerminalSessionManager(new NodePtyHost(), {
  recorder: {
    record: (event) => recorder?.record(event),
    start: (session) => recorder?.start(session),
    stop: (sessionId) => recorder?.stop(sessionId),
    export: (sessionId) =>
      recorder?.export(sessionId) ??
      Promise.resolve({
        schemaVersion: 1,
        sessionId,
        exportedAt: new Date().toISOString(),
        events: [],
      }),
  },
  onEventHandlerError: (error, event) => {
    logger.warn("session", "event_handler_failed", {
      eventType: event.type,
      cause: error instanceof Error ? error.message : String(error),
    });
  },
});
let unregisterIpc: (() => void) | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
let terminalConfigPath: string | null = null;
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

    terminalConfigPath = resolveTerminalConfigPath(app.getPath("userData"));
    logger.info("settings", "load_started", { settingsPath: terminalConfigPath });
    const loadedConfig = await loadTerminalConfig(terminalConfigPath);
    terminalConfig = loadedConfig.config;
    for (const warning of loadedConfig.warnings) {
      logger.warn("settings", "warning", { settingsPath: terminalConfigPath, warning });
    }
    logger.info("settings", "loaded", {
      settingsPath: terminalConfigPath,
      defaultProfileConfigured: Boolean(terminalConfig.shell.defaultProfile),
    });
    recorder = new FileTerminalRecorder({
      directory: join(app.getPath("userData"), "recordings"),
      redactors: [createPatternRedactor(terminalConfig.recording.redactedPatterns)],
    });

    unregisterIpc = registerTerminalIpc(sessionManager, logger, () => terminalConfig, saveConfig);
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

async function saveConfig(config: TerminalConfig): Promise<TerminalConfig> {
  if (!terminalConfigPath) {
    throw new Error("Terminal settings path is not initialized.");
  }

  await saveTerminalConfig(terminalConfigPath, config);
  terminalConfig = config;
  const redactors = [createPatternRedactor(terminalConfig.recording.redactedPatterns)];
  if (recorder) {
    recorder.updateRedactors(redactors);
  } else {
    recorder = new FileTerminalRecorder({
      directory: join(app.getPath("userData"), "recordings"),
      redactors,
    });
  }
  logger.info("settings", "saved", {
    settingsPath: terminalConfigPath,
    workspaceTabs: config.workspace.tabs.length,
    activeTabIndex: config.workspace.activeTabIndex,
  });
  return terminalConfig;
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
