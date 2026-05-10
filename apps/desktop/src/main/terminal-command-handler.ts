import {
  createRendererCommandFailure,
  createRendererCommandSuccess,
  createRequestId,
  createTerminalError,
  parseRendererCommand,
  terminalErrorSchema,
  type CreateSessionRequest,
  type RendererCommand,
  type RendererCommandResult,
  type TerminalConfig,
  type TerminalError,
} from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";
import type { AppLogger } from "./logger";

export type TerminalCommandServices = {
  sessionManager: Pick<
    TerminalSessionManager,
    "createSession" | "write" | "resize" | "kill" | "getSession"
  >;
  getConfig(): TerminalConfig;
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
    const requestId = extractRequestId(payload);
    const terminalError = createTerminalError(
      "invalid_request",
      "Invalid renderer command payload.",
      {
        operation: "ipc",
        cause: errorMessage(error),
      },
    );
    services.logger?.warn("ipc", "command.invalid", {
      requestId,
      errorType: terminalError.type,
      cause: terminalError.cause,
    });
    return createRendererCommandFailure(requestId, terminalError);
  }

  try {
    services.logger?.debug("ipc", "command.received", {
      requestId: command.requestId,
      commandType: command.type,
    });
    return await handleRendererCommand(command, services);
  } catch (error: unknown) {
    const terminalError = normalizeTerminalError(error);
    services.logger?.warn("ipc", "command.failed", {
      requestId: command.requestId,
      commandType: command.type,
      errorType: terminalError.type,
      sessionId: terminalError.sessionId,
      cause: terminalError.cause,
    });
    return createRendererCommandFailure(command.requestId, terminalError);
  }
}

async function handleRendererCommand(
  command: RendererCommand,
  services: TerminalCommandServices,
): Promise<RendererCommandResult<unknown>> {
  switch (command.type) {
    case "session.create":
      services.logger?.info("session", "create_requested", {
        requestId: command.requestId,
        cwd: command.payload.cwd,
        hasExplicitShell: Boolean(command.payload.shell),
      });
      return createRendererCommandSuccess(
        command.requestId,
        await services.sessionManager.createSession(
          applyConfiguredShell(command.payload, services.getConfig()),
        ),
      );
    case "session.write":
      await services.sessionManager.write(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.resize":
      await services.sessionManager.resize(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.kill":
      services.logger?.info("session", "kill_requested", {
        requestId: command.requestId,
        sessionId: command.payload.sessionId,
      });
      await services.sessionManager.kill(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.get":
      return createRendererCommandSuccess(
        command.requestId,
        services.sessionManager.getSession(command.payload),
      );
    case "settings.get":
      return createRendererCommandSuccess(command.requestId, services.getConfig());
  }
}

function applyConfiguredShell(
  request: CreateSessionRequest,
  config: TerminalConfig,
): CreateSessionRequest {
  if (request.shell || !config.shell.defaultProfile) {
    return request;
  }

  return { ...request, shell: config.shell.defaultProfile };
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
  if (parsed.success) {
    return parsed.data;
  }

  return createTerminalError("invalid_request", errorMessage(error), {
    operation: "ipc",
    cause: errorMessage(error),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
