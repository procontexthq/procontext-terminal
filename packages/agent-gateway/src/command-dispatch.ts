import type { AgentCommand, OperationId, SessionId } from "@terminal/protocol";

import type { AgentTerminalService } from "./types.js";

export type AgentCommandOwnership = {
  attach(sessionId: SessionId): void;
  detach(sessionId: SessionId): void;
  rememberOperation(operationId: OperationId, sessionId: SessionId): void;
  releaseOperation(operationId: OperationId): void;
  releaseSessionOperations(sessionId: SessionId): void;
};

export async function dispatchAgentCommand(
  command: AgentCommand,
  services: AgentTerminalService,
  signal: AbortSignal,
  ownership: AgentCommandOwnership,
): Promise<unknown> {
  switch (command.type) {
    case "agent.authenticate":
      throw new Error("Authentication is handled before dispatch.");
    case "terminal.list":
      return services.list();
    case "terminal.get":
      return services.get(command.payload);
    case "terminal.run": {
      const result = await services.run(command.payload);
      if (result.tty) ownership.rememberOperation(result.operationId, result.sessionId);
      if (result.tty && result.status === "running") ownership.attach(result.sessionId);
      return result;
    }
    case "terminal.create": {
      const session = await services.create(command.payload);
      ownership.attach(session.sessionId);
      return session;
    }
    case "terminal.attach": {
      const session = services.get(command.payload);
      ownership.attach(session.sessionId);
      return session;
    }
    case "terminal.input":
      return services.input(command.payload);
    case "terminal.resize":
      return services.resize(command.payload);
    case "terminal.scroll":
      return services.scroll(command.payload);
    case "terminal.observe":
      return services.observe(command.payload, signal);
    case "terminal.close": {
      const result = await services.close(command.payload);
      if (result.status === "closed" && "sessionId" in command.payload) {
        ownership.detach(command.payload.sessionId);
        ownership.releaseSessionOperations(command.payload.sessionId);
      }
      if (result.status === "closed" && "operationId" in command.payload) {
        ownership.releaseOperation(command.payload.operationId);
      }
      return result;
    }
    case "terminal.recording.start":
      await services.startRecording(command.payload);
      return null;
    case "terminal.recording.stop":
      await services.stopRecording(command.payload);
      return null;
    case "terminal.recording.export":
      return services.exportRecording(command.payload);
  }
}
