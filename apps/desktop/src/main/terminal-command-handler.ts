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

export type TerminalCommandServices = {
  sessionManager: Pick<
    TerminalSessionManager,
    "createSession" | "write" | "resize" | "kill" | "getSession"
  >;
  getConfig(): TerminalConfig;
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
    return await handleRendererCommand(command, services);
  } catch (error: unknown) {
    return createRendererCommandFailure(command.requestId, normalizeTerminalError(error));
  }
}

async function handleRendererCommand(
  command: RendererCommand,
  services: TerminalCommandServices,
): Promise<RendererCommandResult<unknown>> {
  switch (command.type) {
    case "session.create":
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
