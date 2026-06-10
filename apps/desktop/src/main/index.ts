import { join } from "node:path";

import { app, BrowserWindow } from "electron";

import {
  resolveAgentGatewayDescriptorPath,
  startAgentGateway,
  type AgentGateway,
  type AgentGatewayTerminalServices,
} from "@terminal/agent-gateway";
import {
  defaultTerminalConfig,
  loadTerminalConfig,
  resolveTerminalConfigPath,
  saveTerminalConfig,
} from "@terminal/config";
import { createDefaultAgentPolicy, createDefaultTerminalPolicy } from "@terminal/policy-engine";
import { NodePtyHost } from "@terminal/pty-host";
import { FileTerminalRecorder, createPatternRedactor } from "@terminal/recorder";
import { TerminalSessionManager } from "@terminal/session-core";
import type { TerminalConfig } from "@terminal/protocol";

import {
  broadcastRendererEvent,
  createScreenSnapshotService,
  registerTerminalIpc,
  type ScreenSnapshotService,
} from "./ipc";
import {
  createAgentSessionDisplayService,
  type AgentSessionDisplayService,
} from "./agent-session-display";
import { createAppLogger, parseLogLevel, resolveMainLogPath } from "./logger";
import {
  waitForPrompt,
  waitForQuiet,
  waitForScreenChange,
  waitForText,
  type TerminalCommandServices,
} from "./terminal-command-handler";
import { attachWindowCloseSessionCleanup } from "./window-lifecycle";

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
const screenSnapshotService = createScreenSnapshotService();
const terminalPolicy = createDefaultTerminalPolicy();
let unregisterIpc: (() => void) | null = null;
let agentGateway: AgentGateway | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
let quitAfterShutdown = false;
let suppressNextWindowAllClosedQuit = false;

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
  attachWindowCloseSessionCleanup({
    window,
    sessionManager,
    logger,
    getIsAppQuitting: () => quitAfterShutdown,
    shutdownTimeoutMs: 1500,
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
  try {
    if (rendererUrl && !app.isPackaged) {
      logger.debug("renderer", "load_started", { windowId: window.id, source: "dev_server" });
      await window.loadURL(rendererUrl);
    } else {
      logger.debug("renderer", "load_started", { windowId: window.id, source: "file" });
      await window.loadFile(join(__dirname, "../renderer/index.html"));
    }
  } catch (error: unknown) {
    logger.error("renderer", "load_failed", {
      windowId: window.id,
      cause: error instanceof Error ? error.message : String(error),
    });
    if (!window.isDestroyed()) {
      suppressNextWindowAllClosedQuit = BrowserWindow.getAllWindows().every(
        (candidate) => candidate.id === window.id || candidate.isDestroyed(),
      );
      window.destroy();
    }
    throw error;
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

    const terminalConfigPath = resolveTerminalConfigPath(app.getPath("userData"));
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

    unregisterIpc = registerTerminalIpc(
      sessionManager,
      terminalPolicy,
      logger,
      () => terminalConfig,
      saveConfig,
      screenSnapshotService,
    );
    await createMainWindow().catch((error: unknown) => {
      logger.warn("window", "startup_create_failed", {
        cause: error instanceof Error ? error.message : String(error),
      });
    });
    const agentSessionDisplay = createAgentSessionDisplayService({
      getWindows: () => BrowserWindow.getAllWindows(),
      createWindow: createMainWindow,
      logger,
    });
    agentGateway = await startAgentGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(app.getPath("userData")),
      services: createAgentGatewayServices(
        sessionManager,
        screenSnapshotService,
        agentSessionDisplay,
      ),
      policy: createDefaultAgentPolicy(),
      audit: (event) => {
        logger.info("agent", "audit", {
          connectionId: event.connectionId,
          action: event.action,
          outcome: event.outcome,
          requestId: event.requestId,
          sessionId: event.sessionId,
          errorType: event.errorType,
          denialCode: event.denialCode,
        });
      },
      onActivity: (payload) => {
        broadcastRendererEvent({ type: "agent.activity", payload });
      },
    });
    logger.info("agent", "gateway_started", {
      descriptorPath: agentGateway.descriptorPath,
      url: sanitizeUrlForLog(agentGateway.descriptor.url),
      tokenExpiresAt: agentGateway.descriptor.tokenExpiresAt,
    });
    logger.info("app", "ready");

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().catch((error: unknown) => {
          logger.warn("window", "activate_create_failed", {
            cause: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  })
  .catch((error: unknown) => {
    logger.error("app", "startup_failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  });

app.on("window-all-closed", () => {
  if (suppressNextWindowAllClosedQuit) {
    suppressNextWindowAllClosedQuit = false;
    return;
  }

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
  void shutdownApp()
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
  const terminalConfigPath = resolveTerminalConfigPath(app.getPath("userData"));
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
    uiTheme: config.ui.theme,
  });
  return terminalConfig;
}

async function shutdownApp() {
  if (agentGateway) {
    logger.info("agent", "gateway_shutdown_started");
    await agentGateway.stop();
    agentGateway = null;
    logger.info("agent", "gateway_shutdown_completed");
  }
  unregisterIpc?.();
  unregisterIpc = null;
  logger.info("session", "shutdown_started", { timeoutMs: 1500 });
  return sessionManager.shutdown({ timeoutMs: 1500 });
}

function createAgentGatewayServices(
  manager: TerminalSessionManager,
  snapshotService: ScreenSnapshotService,
  agentSessionDisplay: AgentSessionDisplayService,
): AgentGatewayTerminalServices {
  const waitServices: TerminalCommandServices = {
    sessionManager: manager,
    requestScreenSnapshot: (sessionId, timeoutMs) =>
      snapshotService.requestScreenSnapshot(sessionId, timeoutMs),
    resolveSnapshotResponse: (requestId, snapshot) =>
      snapshotService.resolveSnapshotResponse(requestId, snapshot),
    rejectSnapshotResponse: (requestId, sessionId, reason) =>
      snapshotService.rejectSnapshotResponse(requestId, sessionId, reason),
    getConfig: () => terminalConfig,
    saveConfig,
    policy: terminalPolicy,
    logger,
  };

  return {
    listSessions: () => manager.listSessions(),
    createSession: (request) => manager.createSession(request),
    displaySession: (snapshot) => agentSessionDisplay.displaySession(snapshot),
    getSession: (request) => manager.getSession(request),
    write: (request) => manager.write(request),
    sendKey: (request) => manager.sendKey(request),
    resize: (request) => manager.resize(request),
    readRecentOutput: (request) => manager.readRecentOutput(request),
    captureScreen: (request) =>
      snapshotService.requestScreenSnapshot(request.sessionId, request.timeoutMs),
    waitForText: (request) => waitForText(request, waitServices),
    waitForQuiet: (request) => waitForQuiet(request, waitServices),
    waitForScreenChange: (request) => waitForScreenChange(request, waitServices),
    waitForPrompt: (request) => waitForPrompt(request, waitServices),
    kill: (request) => manager.kill(request),
    onSessionEvent: (handler) => manager.onSessionEvent(handler),
  };
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
