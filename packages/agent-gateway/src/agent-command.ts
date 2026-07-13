import type { AgentPolicyOperation } from "@terminal/policy-engine";
import {
  createTerminalError,
  type AgentCommand,
  type PolicyDenial,
  type SessionId,
  type TerminalError,
} from "@terminal/protocol";

export function policyOperation(command: AgentCommand): AgentPolicyOperation {
  const sessionId = commandSessionId(command);
  switch (command.type) {
    case "agent.authenticate":
      return { type: command.type };
    case "terminal.list":
      return { type: command.type, observationKind: "list" };
    case "terminal.get":
    case "terminal.attach":
      return { type: command.type, sessionId, observationKind: "get" };
    case "terminal.create":
      return {
        type: command.type,
        ...(command.payload.cwd ? { cwd: command.payload.cwd } : {}),
        ...(command.payload.shell ? { shell: command.payload.shell } : {}),
      };
    case "terminal.input":
      return { type: command.type, sessionId, inputKind: "input" };
    case "terminal.resize":
      return { type: command.type, sessionId, inputKind: "resize" };
    case "terminal.scroll":
      return { type: command.type, sessionId, inputKind: "scroll" };
    case "terminal.observe":
      return { type: command.type, sessionId, observationKind: "observe" };
    case "terminal.close":
      return { type: command.type, sessionId, inputKind: "close" };
    case "terminal.recording.start":
      return { type: command.type, sessionId, recordingKind: "start" };
    case "terminal.recording.stop":
      return { type: command.type, sessionId, recordingKind: "stop" };
    case "terminal.recording.export":
      return { type: command.type, sessionId, recordingKind: "export" };
  }
}

export function commandSessionId(command: AgentCommand): SessionId | undefined {
  switch (command.type) {
    case "agent.authenticate":
    case "terminal.list":
    case "terminal.create":
      return undefined;
    default:
      return command.payload.sessionId;
  }
}

export function denialError(command: AgentCommand, denial: PolicyDenial): TerminalError {
  return createTerminalError(
    denial.code === "auth_required" ? "auth_required" : "policy_denied",
    denial.message,
    {
      operation: command.type,
      ...(commandSessionId(command) ? { sessionId: commandSessionId(command) } : {}),
      cause: denial.code,
    },
  );
}

export function normalizeCommandError(error: unknown, command: AgentCommand): TerminalError {
  if (isTerminalError(error)) return error;
  return createTerminalError(
    "gateway_failed",
    error instanceof Error ? error.message : String(error),
    {
      operation: command.type,
      ...(commandSessionId(command) ? { sessionId: commandSessionId(command) } : {}),
      cause: error instanceof Error ? error.message : String(error),
    },
  );
}

function isTerminalError(value: unknown): value is TerminalError {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "message" in value &&
    typeof value.type === "string" &&
    typeof value.message === "string"
  );
}
