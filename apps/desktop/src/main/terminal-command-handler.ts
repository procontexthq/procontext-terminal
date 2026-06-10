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
  type RequestId,
  type TerminalConfig,
  type TerminalError,
  type TerminalScreenSnapshot,
} from "@terminal/protocol";
import type { TerminalPolicy, TerminalPolicyOperation } from "@terminal/policy-engine";
import type { TerminalSessionManager } from "@terminal/session-core";
import type { AppLogger } from "./logger";

export type TerminalCommandServices = {
  sessionManager: Pick<
    TerminalSessionManager,
    | "createSession"
    | "listSessions"
    | "write"
    | "sendKey"
    | "paste"
    | "sendMouse"
    | "setTitle"
    | "reportBell"
    | "interrupt"
    | "resize"
    | "kill"
    | "detachSession"
    | "attachSession"
    | "getSession"
    | "releaseSession"
    | "readRecentOutput"
    | "getLastActivityAt"
    | "startRecording"
    | "stopRecording"
    | "exportRecording"
  >;
  requestScreenSnapshot(
    sessionId: TerminalScreenSnapshot["sessionId"],
    timeoutMs: number,
  ): Promise<TerminalScreenSnapshot>;
  resolveSnapshotResponse(requestId: RequestId, snapshot: TerminalScreenSnapshot): void;
  rejectSnapshotResponse(
    requestId: RequestId,
    sessionId: TerminalScreenSnapshot["sessionId"],
    reason: string,
  ): void;
  registerRendererSession?(sessionId: TerminalScreenSnapshot["sessionId"]): void;
  unregisterRendererSession?(sessionId: TerminalScreenSnapshot["sessionId"]): void;
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
    case "session.create": {
      services.logger?.info("session", "create_requested", {
        requestId: command.requestId,
        cwd: command.payload.cwd,
        hasExplicitShell: Boolean(command.payload.shell),
      });
      const created = await services.sessionManager.createSession(
        applyConfiguredShell(command.payload, services.getConfig()),
      );
      services.registerRendererSession?.(created.sessionId);
      return createRendererCommandSuccess(command.requestId, created);
    }
    case "session.list":
      return createRendererCommandSuccess(
        command.requestId,
        services.sessionManager.listSessions(),
      );
    case "session.write":
      await services.sessionManager.write(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.sendKey":
      await services.sessionManager.sendKey(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.paste":
      await services.sessionManager.paste(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.mouse":
      await services.sessionManager.sendMouse(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.setTitle":
      return createRendererCommandSuccess(
        command.requestId,
        services.sessionManager.setTitle(command.payload),
      );
    case "session.bell":
      services.sessionManager.reportBell(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.interrupt":
      await services.sessionManager.interrupt(command.payload);
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
      services.unregisterRendererSession?.(command.payload.sessionId);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.detach": {
      const snapshot = services.sessionManager.detachSession(command.payload);
      services.unregisterRendererSession?.(snapshot.sessionId);
      return createRendererCommandSuccess(command.requestId, snapshot);
    }
    case "session.attach": {
      const snapshot = services.sessionManager.attachSession(command.payload);
      services.registerRendererSession?.(snapshot.sessionId);
      return createRendererCommandSuccess(command.requestId, snapshot);
    }
    case "session.release":
      services.logger?.info("session", "release_requested", {
        requestId: command.requestId,
        sessionId: command.payload.sessionId,
      });
      await services.sessionManager.releaseSession(command.payload);
      services.unregisterRendererSession?.(command.payload.sessionId);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.get":
      return createRendererCommandSuccess(
        command.requestId,
        services.sessionManager.getSession(command.payload),
      );
    case "session.readRecentOutput":
      return createRendererCommandSuccess(
        command.requestId,
        services.sessionManager.readRecentOutput(command.payload),
      );
    case "session.captureScreen":
      return createRendererCommandSuccess(
        command.requestId,
        await services.requestScreenSnapshot(command.payload.sessionId, command.payload.timeoutMs),
      );
    case "session.snapshot.response":
      services.resolveSnapshotResponse(command.payload.requestId, command.payload.snapshot);
      return createRendererCommandSuccess(command.requestId, null);
    case "session.snapshot.unavailable":
      services.rejectSnapshotResponse(
        command.payload.requestId,
        command.payload.sessionId,
        command.payload.reason,
      );
      return createRendererCommandSuccess(command.requestId, null);
    case "session.waitForText":
      return createRendererCommandSuccess(
        command.requestId,
        await waitForText(command.payload, services),
      );
    case "session.waitForScreenChange":
      return createRendererCommandSuccess(
        command.requestId,
        await waitForScreenChange(command.payload, services),
      );
    case "session.waitForQuiet":
      return createRendererCommandSuccess(
        command.requestId,
        await waitForQuiet(command.payload, services),
      );
    case "session.waitForPrompt":
      return createRendererCommandSuccess(
        command.requestId,
        await waitForPrompt(command.payload, services),
      );
    case "recording.start":
      authorizeRendererRecordingCommand(command, "start", services);
      await services.sessionManager.startRecording(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "recording.stop":
      authorizeRendererRecordingCommand(command, "stop", services);
      await services.sessionManager.stopRecording(command.payload);
      return createRendererCommandSuccess(command.requestId, null);
    case "recording.export":
      authorizeRendererRecordingCommand(command, "export", services);
      return createRendererCommandSuccess(
        command.requestId,
        await services.sessionManager.exportRecording(command.payload),
      );
    case "settings.get":
      return createRendererCommandSuccess(command.requestId, services.getConfig());
    case "settings.saveUiTheme": {
      const current = services.getConfig();
      try {
        const saved = await services.saveConfig({
          ...current,
          ui: {
            ...current.ui,
            theme: command.payload.theme,
          },
        });
        return createRendererCommandSuccess(command.requestId, saved);
      } catch (error: unknown) {
        throw createTerminalError("settings_save_failed", "Could not save UI theme settings.", {
          operation: "settings.saveUiTheme",
          cause: errorMessage(error),
        });
      }
    }
  }
}

function authorizeRendererRecordingCommand(
  command: Extract<
    RendererCommand,
    { type: "recording.start" | "recording.stop" | "recording.export" }
  >,
  recordingKind: NonNullable<TerminalPolicyOperation["recordingKind"]>,
  services: TerminalCommandServices,
): void {
  const operation = {
    type: command.type,
    sessionId: command.payload.sessionId,
    recordingKind,
  } satisfies TerminalPolicyOperation;
  const decision = services.policy.authorize({
    actor: { kind: "human", local: true },
    operation,
  });

  services.logger?.info("policy", "decision", {
    requestId: command.requestId,
    commandType: command.type,
    sessionId: command.payload.sessionId,
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
        sessionId: command.payload.sessionId,
        cause: decision.reason.code,
      },
    );
  }
}

function applyConfiguredShell(
  request: CreateSessionRequest,
  config: TerminalConfig,
): CreateSessionRequest {
  if (request.shell || !config.shell.defaultProfile) {
    return request;
  }

  const profile = config.shell.profiles.find(
    (candidate) => candidate.id === config.shell.defaultProfile,
  );
  if (profile) {
    return {
      ...request,
      shell: profile.shell,
      ...(profile.cwd ? { cwd: profile.cwd } : {}),
      env: {
        ...request.env,
        ...profile.env,
      },
    };
  }

  return { ...request, shell: config.shell.defaultProfile };
}

export async function waitForText(
  request: Extract<RendererCommand, { type: "session.waitForText" }>["payload"],
  services: TerminalCommandServices,
) {
  const deadline = Date.now() + request.timeoutMs;
  while (Date.now() <= deadline) {
    const recentOutput =
      request.includeRecentOutput === false
        ? ""
        : services.sessionManager.readRecentOutput({
            sessionId: request.sessionId,
            maxBytes: 100_000,
          }).data;

    if (recentOutput.includes(request.text)) {
      return { sessionId: request.sessionId, matchedAt: new Date().toISOString() };
    }

    let snapshot: TerminalScreenSnapshot;
    try {
      snapshot = await services.requestScreenSnapshot(
        request.sessionId,
        Math.min(remainingTimeout(deadline), 500),
      );
    } catch (error: unknown) {
      if (request.includeRecentOutput === false) {
        throw error;
      }
      await delay(50);
      continue;
    }
    const viewportText = snapshot.viewport.map((row) => row.text).join("\n");
    if (viewportText.includes(request.text)) {
      return { sessionId: request.sessionId, matchedAt: new Date().toISOString(), snapshot };
    }
    await delay(50);
  }

  throw createTerminalError("wait_timeout", `Timed out waiting for text: ${request.text}`, {
    sessionId: request.sessionId,
    operation: "session.waitForText",
  });
}

export async function waitForScreenChange(
  request: Extract<RendererCommand, { type: "session.waitForScreenChange" }>["payload"],
  services: TerminalCommandServices,
) {
  const deadline = Date.now() + request.timeoutMs;
  const initial =
    request.baselineHash ??
    snapshotHash(
      await services.requestScreenSnapshot(request.sessionId, remainingTimeout(deadline)),
    );
  while (Date.now() <= deadline) {
    const snapshot = await services.requestScreenSnapshot(
      request.sessionId,
      Math.min(remainingTimeout(deadline), 500),
    );
    if (snapshotHash(snapshot) !== initial) {
      return { sessionId: request.sessionId, matchedAt: new Date().toISOString(), snapshot };
    }
    await delay(50);
  }

  throw createTerminalError("wait_timeout", "Timed out waiting for screen change.", {
    sessionId: request.sessionId,
    operation: "session.waitForScreenChange",
  });
}

export async function waitForQuiet(
  request: Extract<RendererCommand, { type: "session.waitForQuiet" }>["payload"],
  services: TerminalCommandServices,
) {
  const deadline = Date.now() + request.timeoutMs;
  while (Date.now() <= deadline) {
    const elapsed = Date.now() - services.sessionManager.getLastActivityAt(request.sessionId);
    if (elapsed >= request.quietMs) {
      return { sessionId: request.sessionId, matchedAt: new Date().toISOString() };
    }
    await delay(Math.min(50, request.quietMs));
  }

  throw createTerminalError("wait_timeout", "Timed out waiting for terminal quiet.", {
    sessionId: request.sessionId,
    operation: "session.waitForQuiet",
  });
}

export async function waitForPrompt(
  request: Extract<RendererCommand, { type: "session.waitForPrompt" }>["payload"],
  services: TerminalCommandServices,
) {
  const deadline = Date.now() + request.timeoutMs;
  while (Date.now() <= deadline) {
    const snapshot = await services.requestScreenSnapshot(
      request.sessionId,
      Math.min(remainingTimeout(deadline), 500),
    );
    const lastLine = [...snapshot.viewport].reverse().find((row) => row.text.trim().length > 0);
    if (lastLine && /[$#>]\s*$/.test(lastLine.text)) {
      return { sessionId: request.sessionId, matchedAt: new Date().toISOString(), snapshot };
    }
    await delay(50);
  }

  throw createTerminalError("wait_timeout", "Timed out waiting for prompt.", {
    sessionId: request.sessionId,
    operation: "session.waitForPrompt",
  });
}

function snapshotHash(snapshot: TerminalScreenSnapshot): string {
  return JSON.stringify({
    cursor: snapshot.cursor,
    alternateScreen: snapshot.alternateScreen,
    viewport: snapshot.viewport,
  });
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
