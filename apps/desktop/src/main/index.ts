import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, screen, shell } from "electron";

import {
  resolveAgentGatewayDescriptorPath,
  startAgentGateway,
  type AgentGateway,
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
import {
  NodeCapturedProcessHost,
  TerminalOperationManager,
  TerminalSessionManager,
} from "@terminal/session-core";
import type { AppShortcutAction, TerminalConfig, WindowGeometry } from "@terminal/protocol";

import {
  broadcastRendererEvent,
  hasAvailableRenderer,
  IPC_CHANNELS,
  registerTerminalIpc,
} from "./ipc";
import { resolveAppShortcut, type AppShortcutPlatform } from "../shared/app-shortcuts";
import { createAgentTerminalService } from "./agent-terminal-service";
import {
  createAgentAccessKeyStore,
  resolveAgentAccessKeyPath,
  type AgentAccessKeyStore,
} from "./agent-access-key-store";
import { PRODUCT_NAME, shouldSetDevelopmentDockIcon } from "./app-branding";
import { createDesktopCollaborationServices } from "./collaboration-services";
import { resolveDefaultTerminalCwd } from "./default-terminal-cwd";
import { createAppLogger, parseLogLevel, resolveMainLogPath } from "./logger";
import { createTerminalPresentationRegistry } from "./presentation-registry";
import { createTerminalPresentationController } from "./presentation-controller";
import {
  createQueuedTerminalConfigPersistence,
  type TerminalConfigMutation,
} from "./terminal-config-persistence";
import { createTerminalLinkOpener } from "./terminal-link-opener";
import { waitForInitialHumanSessionSettled } from "./startup-session";
import { configureSingleInstance } from "./single-instance";
import {
  createApplicationMenuTemplate,
  dispatchApplicationMenuShortcut,
  resolveWindowChromeOptions,
} from "./window-chrome";
import { attachWindowCloseSessionCleanup } from "./window-lifecycle";
import {
  attachWindowGeometryPersistence,
  resolveWindowBounds,
  type WindowBounds,
  type WindowGeometryPersistence,
} from "./window-state";

app.setName(PRODUCT_NAME);

let logger = createAppLogger({
  isDevelopment: !app.isPackaged,
  level: resolveLogLevel(),
});
let recorder: FileTerminalRecorder | null = null;
let terminalConfig: TerminalConfig = defaultTerminalConfig();
const sessionManager = new TerminalSessionManager(new NodePtyHost(), {
  defaultCwd: defaultTerminalCwd,
  getScrollback: () => terminalConfig.terminal.scrollback,
  startRecordingByDefault: () => terminalConfig.recording.state === "enabled",
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
const operationManager = new TerminalOperationManager(
  new NodeCapturedProcessHost(),
  sessionManager,
  {
    defaultCwd: defaultTerminalCwd,
    onBackgroundError: (error) => {
      logger.error("operation", "background_failure", {
        cause: error instanceof Error ? error.message : String(error),
      });
    },
    onOperationRemoved: (operationId) => agentGateway?.removeOperationControl(operationId),
  },
);
const presentationRegistry = createTerminalPresentationRegistry();
const openTerminalLink = createTerminalLinkOpener({
  platform:
    process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
  openExternal: (target) => shell.openExternal(target),
  showItemInFolder: (target) => shell.showItemInFolder(target),
  statPath: (target) => stat(target),
});
const presentationController = createTerminalPresentationController({
  sessions: sessionManager,
  registry: presentationRegistry,
  getWindows: () => BrowserWindow.getAllWindows(),
  createWindow: ({ show }) => createMainWindow({ show }),
  logger: {
    info: (component, event, context) => logger.info(component, event, context),
    warn: (component, event, context) => logger.warn(component, event, context),
  },
});
const terminalPolicy = createDefaultTerminalPolicy();
let unregisterIpc: (() => void) | null = null;
let agentGateway: AgentGateway | null = null;
let agentAccessKeyStore: AgentAccessKeyStore | null = null;
const terminalConfigPersistence = createQueuedTerminalConfigPersistence({
  getConfig: () => terminalConfig,
  setConfig: (config) => {
    terminalConfig = config;
  },
  persist: (config) =>
    saveTerminalConfig(resolveTerminalConfigPath(app.getPath("userData")), config),
  onPersisted: (config, mutation) => {
    if (mutation.type === "focused-settings") updateRecorderRedactors(config);
    if (mutation.type !== "window-geometry") {
      logger.info("settings", "saved", {
        settingsPath: resolveTerminalConfigPath(app.getPath("userData")),
        uiTheme: config.ui.theme,
      });
    }
  },
});
let disposeCollaborationServices: (() => void) | null = null;
let primaryWindowGeometryPersistence: WindowGeometryPersistence | null = null;
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

async function createMainWindow(options: { show?: boolean } = {}): Promise<BrowserWindow> {
  logger.info("window", "create_requested");
  const appIconPath = resolveAppIconPath();
  const isPrimaryWindow = BrowserWindow.getAllWindows().length === 0;
  const initialBounds = isPrimaryWindow
    ? resolvePrimaryWindowBounds()
    : { width: 1000, height: 700 };
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: 640,
    minHeight: 420,
    ...resolveWindowChromeOptions(process.platform),
    backgroundColor: terminalConfig.terminal.theme.background,
    show: options.show ?? true,
    ...(appIconPath ? { icon: appIconPath } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.accessibleTitle = PRODUCT_NAME;
  attachWindowCloseSessionCleanup({
    window,
    sessionManager,
    logger,
    getIsAppQuitting: () => quitAfterShutdown,
    shutdownTimeoutMs: 1500,
    sessionLifecycle: "preserve",
  });
  if (isPrimaryWindow) {
    const geometryPersistence = attachWindowGeometryPersistence({
      window,
      getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
      saveGeometry: saveWindowGeometry,
      onError: (error) => {
        logger.warn("window", "geometry_save_failed", {
          windowId: window.id,
          cause: error instanceof Error ? error.message : String(error),
        });
      },
    });
    primaryWindowGeometryPersistence = geometryPersistence;
    window.once("closed", () => {
      geometryPersistence.dispose();
      if (primaryWindowGeometryPersistence === geometryPersistence) {
        primaryWindowGeometryPersistence = null;
      }
    });
  }

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

const isPrimaryAppInstance = configureSingleInstance({
  requestLock: () => app.requestSingleInstanceLock(),
  onSecondInstance: (handler) => app.on("second-instance", handler),
  quit: () => app.quit(),
  getWindows: () => BrowserWindow.getAllWindows(),
});

if (isPrimaryAppInstance) {
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

      const agentAccessKeyPath = resolveAgentAccessKeyPath(app.getPath("userData"));
      try {
        agentAccessKeyStore = await createAgentAccessKeyStore({
          credentialPath: agentAccessKeyPath,
          activateAccessKey: (accessKey) => agentGateway?.rotateAccessKey(accessKey),
          writeClipboard: (accessKey) => clipboard.writeText(accessKey),
          onWarning: (warning) => {
            logger.warn("agent", warning.type, { credentialPath: warning.credentialPath });
          },
        });
      } catch (error: unknown) {
        logger.error("agent", "access_key_unavailable", {
          credentialPath: agentAccessKeyPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

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
      const collaborationServices = createDesktopCollaborationServices({
        getGateway: () => agentGateway,
        sessions: sessionManager,
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        broadcast: broadcastRendererEvent,
        hasAvailableRenderer,
      });
      disposeCollaborationServices = () => collaborationServices.dispose();

      unregisterIpc = registerTerminalIpc({
        sessionManager,
        presentationRegistry,
        presentationController,
        policy: terminalPolicy,
        logger,
        closeSession: (request) => operationManager.close(request),
        getConfig: () => terminalConfig,
        saveConfig,
        getAgentAccessKeyMetadata: () => requireAgentAccessKeyStore().getMetadata(),
        copyAgentAccessKey: () => requireAgentAccessKeyStore().copy(),
        regenerateAgentAccessKey: () => requireAgentAccessKeyStore().regenerate(),
        openLink: openTerminalLink,
        ...collaborationServices.renderer,
      });
      installApplicationMenu();
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
      if (agentAccessKeyStore) {
        try {
          agentGateway = await startAgentGateway({
            descriptorPath: resolveAgentGatewayDescriptorPath(app.getPath("userData")),
            accessKey: agentAccessKeyStore.getAccessKey(),
            services: createAgentTerminalService(
              sessionManager,
              operationManager,
              presentationController,
            ),
            policy: createDefaultAgentPolicy({
              getPermissionMode: (category) => terminalConfig.agentPolicy[category],
            }),
            audit: (event) => {
              logger.info("agent", "audit", {
                connectionId: event.connectionId,
                action: event.action,
                outcome: event.outcome,
                requestId: event.requestId,
                sessionId: event.sessionId,
                operationId: event.operationId,
                errorType: event.errorType,
                denialCode: event.denialCode,
              });
            },
            onCallbackError: (callback, error) => {
              logger.warn("agent", "gateway_callback_failed", {
                callback,
                errorName: error instanceof Error ? error.name : typeof error,
              });
            },
            ...collaborationServices.gateway,
          });
          logger.info("agent", "gateway_started", {
            descriptorPath: agentGateway.descriptorPath,
            url: sanitizeUrlForLog(agentGateway.descriptor.url),
            protocolVersion: agentGateway.descriptor.protocolVersion,
          });
        } catch (error: unknown) {
          logger.error("agent", "gateway_start_failed", {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
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
}

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

function installApplicationMenu(): void {
  const template = createApplicationMenuTemplate(
    process.platform,
    PRODUCT_NAME,
    dispatchAppShortcut,
  );
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null);
}

function dispatchAppShortcut(action: AppShortcutAction): void {
  void dispatchApplicationMenuShortcut(action, {
    channel: IPC_CHANNELS.appShortcut,
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    getAllWindows: () => BrowserWindow.getAllWindows(),
    createWindow: () => createMainWindow(),
  }).catch((error: unknown) => {
    logger.warn("window", "menu_shortcut_failed", {
      action,
      cause: error instanceof Error ? error.message : String(error),
    });
  });
}

function appShortcutPlatform(): AppShortcutPlatform | null {
  return isAppShortcutPlatform(process.platform) ? process.platform : null;
}

function isAppShortcutPlatform(value: NodeJS.Platform): value is AppShortcutPlatform {
  return value === "darwin" || value === "win32" || value === "linux";
}

async function saveConfig(mutation: TerminalConfigMutation): Promise<TerminalConfig> {
  return terminalConfigPersistence.save(mutation);
}

function requireAgentAccessKeyStore(): AgentAccessKeyStore {
  if (!agentAccessKeyStore) throw new Error("Agent access is unavailable.");
  return agentAccessKeyStore;
}

async function saveWindowGeometry(geometry: WindowGeometry): Promise<void> {
  await terminalConfigPersistence.save({ type: "window-geometry", geometry });
}

function updateRecorderRedactors(config: TerminalConfig): void {
  const redactors = [createPatternRedactor(config.recording.redactedPatterns)];
  if (recorder) {
    recorder.updateRedactors(redactors);
    return;
  }
  recorder = new FileTerminalRecorder({
    directory: join(app.getPath("userData"), "recordings"),
    redactors,
  });
}

function resolvePrimaryWindowBounds(): WindowBounds {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const width = Math.min(1000, workArea.width);
  const height = Math.min(700, workArea.height);
  const fallback = {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
  const displays = [
    primaryDisplay,
    ...screen.getAllDisplays().filter((display) => display.id !== primaryDisplay.id),
  ].map((display) => ({
    id: display.id,
    workArea: display.workArea,
  }));
  return resolveWindowBounds(terminalConfig.windowGeometry, displays, fallback);
}

async function shutdownApp() {
  await flushPrimaryWindowGeometry();
  await terminalConfigPersistence.pending();
  disposeCollaborationServices?.();
  disposeCollaborationServices = null;
  if (agentGateway) {
    logger.info("agent", "gateway_shutdown_started");
    await agentGateway.stop();
    agentGateway = null;
    logger.info("agent", "gateway_shutdown_completed");
  }
  unregisterIpc?.();
  unregisterIpc = null;
  let operationShutdownError: unknown;
  try {
    const operationResult = await operationManager.shutdown();
    logger.info("operation", "shutdown_completed", operationResult);
  } catch (error: unknown) {
    operationShutdownError = error;
    logger.error("operation", "shutdown_failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  logger.info("session", "shutdown_started", { timeoutMs: 1500 });
  const sessionResult = await sessionManager.shutdown({ timeoutMs: 1500 });
  if (operationShutdownError) throw operationShutdownError;
  return sessionResult;
}

async function flushPrimaryWindowGeometry(): Promise<void> {
  const persistence = primaryWindowGeometryPersistence;
  if (!persistence) return;

  primaryWindowGeometryPersistence = null;
  try {
    await persistence.flush();
  } finally {
    persistence.dispose();
  }
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
