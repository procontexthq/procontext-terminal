import {
  createRendererCommandFailure,
  createRendererCommandSuccess,
  createRequestId,
  createTerminalError,
  parseRendererCommand,
  terminalErrorSchema,
  type CreateTerminalRequest,
  type RendererCommand,
  type RendererCommandResult,
  type TerminalConfig,
  type TerminalError,
} from "@terminal/protocol";
import type { TerminalPolicy, TerminalPolicyOperation } from "@terminal/policy-engine";
import type { TerminalSessionManager } from "@terminal/session-core";

import type { AppLogger } from "./logger";
import type { TerminalPresentationRegistry } from "./presentation-registry";
import type { TerminalPresentationController } from "./presentation-controller";

type RendererTerminalSessionService = Pick<
  TerminalSessionManager,
  | "createSession"
  | "listSessions"
  | "getSession"
  | "input"
  | "resize"
  | "scroll"
  | "close"
  | "getViewBootstrap"
  | "setPresentation"
  | "reportViewport"
  | "startRecording"
  | "stopRecording"
  | "exportRecording"
>;

export type TerminalCommandServices = {
  sessionManager: RendererTerminalSessionService;
  presentationRegistry: TerminalPresentationRegistry;
  presentationController: TerminalPresentationController;
  rendererId: number;
  getConfig(): TerminalConfig;
  saveConfig(config: TerminalConfig): Promise<TerminalConfig>;
  policy: TerminalPolicy;
  logger?: AppLogger;
};

export async function handleRendererCommandPayload(
  payload: unknown,
  services: TerminalCommandServices,
): Promise<RendererCommandResult<unknown>> {
  let command: RendererCommand;
  try {
    command = parseRendererCommand(payload);
  } catch (error: unknown) {
    return createRendererCommandFailure(
      extractRequestId(payload),
      createTerminalError("invalid_request", "Invalid renderer command payload.", {
        operation: "ipc",
        cause: errorMessage(error),
      }),
    );
  }

  try {
    authorizeRendererCommand(command, services);
    return await executeRendererCommand(command, services);
  } catch (error: unknown) {
    const terminalError = normalizeTerminalError(error);
    services.logger?.warn("ipc", "command_failed", {
      requestId: command.requestId,
      commandType: command.type,
      sessionId: terminalError.sessionId,
      errorType: terminalError.type,
      cause: terminalError.cause,
    });
    return createRendererCommandFailure(command.requestId, terminalError);
  }
}

async function executeRendererCommand(
  command: RendererCommand,
  services: TerminalCommandServices,
): Promise<RendererCommandResult<unknown>> {
  const manager = services.sessionManager;
  switch (command.type) {
    case "session.create":
      return createRendererCommandSuccess(
        command.requestId,
        await manager.createSession({
          ...applyConfiguredShell(command.payload, services.getConfig()),
          createdBy: "human",
        }),
      );
    case "session.list":
      return createRendererCommandSuccess(command.requestId, manager.listSessions());
    case "session.get":
      return createRendererCommandSuccess(command.requestId, manager.getSession(command.payload));
    case "session.input":
      return createRendererCommandSuccess(
        command.requestId,
        await manager.input({ ...command.payload, origin: "human" }),
      );
    case "session.resize":
      return createRendererCommandSuccess(command.requestId, await manager.resize(command.payload));
    case "session.scroll":
      return createRendererCommandSuccess(command.requestId, manager.scroll(command.payload));
    case "session.close": {
      const result = await manager.close(command.payload);
      if (result.status === "closed") {
        services.presentationRegistry.removeSession(command.payload.sessionId);
      }
      return createRendererCommandSuccess(command.requestId, result);
    }
    case "session.openView": {
      services.presentationRegistry.open(command.payload.sessionId, services.rendererId);
      try {
        manager.setPresentation(command.payload.sessionId, {
          state: "background",
          windowVisible: true,
          windowFocused: false,
        });
        return createRendererCommandSuccess(
          command.requestId,
          manager.getViewBootstrap(command.payload),
        );
      } catch (error: unknown) {
        services.presentationRegistry.close(command.payload.sessionId, services.rendererId);
        throw error;
      }
    }
    case "session.closeView":
      if (services.presentationRegistry.close(command.payload.sessionId, services.rendererId)) {
        setHeadlessIfPresent(manager, command.payload.sessionId);
      }
      return createRendererCommandSuccess(command.requestId, null);
    case "session.reportViewport":
      if (!services.presentationRegistry.owns(command.payload.sessionId, services.rendererId)) {
        throw createTerminalError("view_unavailable", "Renderer does not own this terminal view.", {
          sessionId: command.payload.sessionId,
          operation: command.type,
        });
      }
      manager.reportViewport(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "recording.start":
      await manager.startRecording(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "recording.stop":
      await manager.stopRecording(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "recording.export":
      return createRendererCommandSuccess(
        command.requestId,
        await manager.exportRecording(command.payload),
      );
    case "settings.get":
      return createRendererCommandSuccess(command.requestId, services.getConfig());
    case "settings.saveUiTheme": {
      const current = services.getConfig();
      try {
        const saved = await services.saveConfig({
          ...current,
          ui: { ...current.ui, theme: command.payload.theme },
        });
        return createRendererCommandSuccess(command.requestId, saved);
      } catch (error: unknown) {
        throw createTerminalError("settings_save_failed", "Could not save UI theme settings.", {
          operation: command.type,
          cause: errorMessage(error),
        });
      }
    }
    case "presentation.ready":
      services.presentationController.rendererReady(services.rendererId);
      return createRendererCommandSuccess(command.requestId, null);
    case "presentation.acknowledge":
      services.presentationController.acknowledge(services.rendererId, command.payload);
      return createRendererCommandSuccess(command.requestId, null);
  }
}

function authorizeRendererCommand(
  command: RendererCommand,
  services: TerminalCommandServices,
): void {
  const operation = policyOperation(command);
  const decision = services.policy.authorize({
    actor: { kind: "human", local: true },
    operation,
  });
  services.logger?.info("policy", "decision", {
    requestId: command.requestId,
    commandType: command.type,
    sessionId: operation.sessionId,
    origin: "human",
    decisionId: decision.decisionId,
    outcome: decision.type,
    ...(decision.type === "deny" ? { denialCode: decision.reason.code } : {}),
  });
  if (decision.type === "deny") {
    throw createTerminalError(
      decision.reason.code === "auth_required" ? "auth_required" : "policy_denied",
      decision.reason.message,
      {
        operation: command.type,
        ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
        cause: decision.reason.code,
      },
    );
  }
}

function policyOperation(command: RendererCommand): TerminalPolicyOperation {
  switch (command.type) {
    case "session.create":
      return {
        type: command.type,
        ...(command.payload.cwd ? { cwd: command.payload.cwd } : {}),
        ...(command.payload.shell ? { shell: command.payload.shell } : {}),
      };
    case "session.list":
      return { type: command.type, observationKind: "list" };
    case "session.get":
    case "session.openView":
      return { type: command.type, sessionId: command.payload.sessionId, observationKind: "get" };
    case "session.input":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "input" };
    case "session.resize":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "resize" };
    case "session.scroll":
    case "session.reportViewport":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "scroll" };
    case "session.close":
      return { type: command.type, sessionId: command.payload.sessionId, inputKind: "close" };
    case "session.closeView":
      return { type: command.type, sessionId: command.payload.sessionId };
    case "recording.start":
      return { type: command.type, sessionId: command.payload.sessionId, recordingKind: "start" };
    case "recording.stop":
      return { type: command.type, sessionId: command.payload.sessionId, recordingKind: "stop" };
    case "recording.export":
      return { type: command.type, sessionId: command.payload.sessionId, recordingKind: "export" };
    case "settings.get":
    case "settings.saveUiTheme":
    case "presentation.ready":
    case "presentation.acknowledge":
      return { type: command.type };
  }
}

export function applyConfiguredShell(
  request: CreateTerminalRequest,
  config: TerminalConfig,
): CreateTerminalRequest {
  if (request.shell || !config.shell.defaultProfile) return request;
  const profile = config.shell.profiles.find(
    (candidate) => candidate.id === config.shell.defaultProfile,
  );
  if (!profile) return { ...request, shell: config.shell.defaultProfile };
  return {
    ...request,
    shell: profile.shell,
    ...(profile.cwd ? { cwd: profile.cwd } : {}),
    env: { ...request.env, ...profile.env },
  };
}

function setHeadlessIfPresent(
  manager: RendererTerminalSessionService,
  sessionId: Parameters<RendererTerminalSessionService["setPresentation"]>[0],
): void {
  try {
    manager.setPresentation(sessionId, {
      state: "headless",
      windowVisible: false,
      windowFocused: false,
    });
  } catch (error: unknown) {
    if (!isTerminalError(error) || error.type !== "session_not_found") throw error;
  }
}

function extractRequestId(payload: unknown) {
  if (typeof payload === "object" && payload !== null && "requestId" in payload) {
    const requestId = payload.requestId;
    if (typeof requestId === "string") {
      try {
        return createRequestId(requestId);
      } catch {
        return createRequestId();
      }
    }
  }
  return createRequestId();
}

function normalizeTerminalError(error: unknown): TerminalError {
  const parsed = terminalErrorSchema.safeParse(error);
  if (parsed.success) return parsed.data;
  return createTerminalError("invalid_request", errorMessage(error), {
    operation: "ipc",
    cause: errorMessage(error),
  });
}

function isTerminalError(value: unknown): value is TerminalError {
  return terminalErrorSchema.safeParse(value).success;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
