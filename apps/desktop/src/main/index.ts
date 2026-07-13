import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, nativeImage } from "electron";

import {
  resolveAgentGatewayDescriptorPath,
  startAgentGateway,
  type AgentGateway,
  type AgentTerminalService,
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
import type { TerminalConfig, TerminalSessionSummary } from "@terminal/protocol";

import { broadcastRendererEvent, IPC_CHANNELS, registerTerminalIpc } from "./ipc";
import { resolveAppShortcut, type AppShortcutPlatform } from "../shared/app-shortcuts";
import { PRODUCT_NAME, shouldSetDevelopmentDockIcon } from "./app-branding";
import { resolveDefaultTerminalCwd } from "./default-terminal-cwd";
import { createAppLogger, parseLogLevel, resolveMainLogPath } from "./logger";
import { createTerminalPresentationRegistry } from "./presentation-registry";
import { attachWindowCloseSessionCleanup } from "./window-lifecycle";

app.setName(PRODUCT_NAME);

let logger = createAppLogger({
  isDevelopment: !app.isPackaged,
  level: resolveLogLevel(),
});
let recorder: FileTerminalRecorder | null = null;
const sessionManager = new TerminalSessionManager(new NodePtyHost(), {
  defaultCwd: defaultTerminalCwd,
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
const presentationRegistry = createTerminalPresentationRegistry();
const terminalPolicy = createDefaultTerminalPolicy();
let unregisterIpc: (() => void) | null = null;
let agentGateway: AgentGateway | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
let quitAfterShutdown = false;
let suppressNextWindowAllClosedQuit = false;

function defaultTerminalCwd(): string {
  const resolved = resolveDefaultTerminalCwd({ appHome: safeAppHome() });
  if (resolved.source !== "app-home") {
    logger.warn("session", "default_cwd_fallback", {
      cwd: resolved.cwd,
      source: resolved.source,
    });
  }
  return resolved.cwd;
}

function safeAppHome(): string {
  try {
    return app.getPath("home");
  } catch {
    return "";
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  logger.info("window", "create_requested");
  const appIconPath = resolveAppIconPath();
  const window = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: terminalConfig.terminal.theme.background,
    ...(appIconPath ? { icon: appIconPath } : {}),
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
  window.webContents.on("before-input-event", (event, input) => {
    const platform = appShortcutPlatform();
    if (!platform) {
      return;
    }
    const action = resolveAppShortcut(
      {
        key: input.key,
        code: input.code,
        alt: input.alt,
        control: input.control,
        meta: input.meta,
        shift: input.shift,
        type: input.type,
        isAutoRepeat: input.isAutoRepeat,
      },
      platform,
    );
    if (!action) {
      return;
    }

    event.preventDefault();
    window.webContents.send(IPC_CHANNELS.appShortcut, action);
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
    applyDevelopmentDockIcon();
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

    unregisterIpc = registerTerminalIpc({
      sessionManager,
      presentationRegistry,
      policy: terminalPolicy,
      logger,
      getConfig: () => terminalConfig,
      saveConfig,
    });
    let startupWindowCreated = false;
    await createMainWindow()
      .then(() => {
        startupWindowCreated = true;
      })
      .catch((error: unknown) => {
        logger.warn("window", "startup_create_failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      });
    if (startupWindowCreated) {
      const startupSession = await waitForInitialHumanSessionSettled(sessionManager, 5000);
      if (startupSession.status === "settled") {
        logger.info("agent", "gateway_startup_session_ready", {
          sessionId: startupSession.session.sessionId,
          sessionState: startupSession.session.lifecycle,
        });
      } else {
        logger.warn("agent", "gateway_startup_session_timeout", {
          timeoutMs: startupSession.timeoutMs,
        });
      }
    }
    agentGateway = await startAgentGateway({
      descriptorPath: resolveAgentGatewayDescriptorPath(app.getPath("userData")),
      services: createAgentGatewayServices(sessionManager),
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

function resolveAppIconPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, "icon.png")]
    : [join(__dirname, "../../resources/icon.png")];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function applyDevelopmentDockIcon(): void {
  if (!shouldSetDevelopmentDockIcon(process.platform, app.isPackaged) || !app.dock) {
    return;
  }
  const appIconPath = resolveAppIconPath();
  if (appIconPath) {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath));
  }
}

function appShortcutPlatform(): AppShortcutPlatform | null {
  return isAppShortcutPlatform(process.platform) ? process.platform : null;
}

function isAppShortcutPlatform(value: NodeJS.Platform): value is AppShortcutPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
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

function createAgentGatewayServices(manager: TerminalSessionManager): AgentTerminalService {
  return {
    list: () => manager.listSessions(),
    get: (request) => manager.getSession(request),
    create: (request) => manager.createSession({ ...request, createdBy: "agent" }),
    input: (request) => manager.input({ ...request, origin: "agent" }),
    resize: (request) => manager.resize(request),
    scroll: (request) => manager.scroll(request),
    observe: (request, signal) => manager.observe(request, signal),
    close: (request) => manager.close(request),
    startRecording: (request) => manager.startRecording(request),
    stopRecording: (request) => manager.stopRecording(request),
    exportRecording: (request) => manager.exportRecording(request),
  };
}

type InitialHumanSessionWaitResult =
  | { status: "settled"; session: TerminalSessionSummary }
  | { status: "timed_out"; timeoutMs: number };

function waitForInitialHumanSessionSettled(
  manager: TerminalSessionManager,
  timeoutMs: number,
): Promise<InitialHumanSessionWaitResult> {
  const settled = findSettledHumanSession(manager);
  if (settled) {
    return Promise.resolve({ status: "settled", session: settled });
  }

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const finish = (result: InitialHumanSessionWaitResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      unsubscribe?.();
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      finish({ status: "timed_out", timeoutMs });
    }, timeoutMs);

    unsubscribe = manager.onSessionEvent(() => {
      const nextSettled = findSettledHumanSession(manager);
      if (nextSettled) {
        finish({ status: "settled", session: nextSettled });
      }
    });
  });
}

function findSettledHumanSession(
  manager: TerminalSessionManager,
): TerminalSessionSummary | undefined {
  return manager
    .listSessions()
    .find((session) => session.createdBy === "human" && session.lifecycle !== "creating");
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
