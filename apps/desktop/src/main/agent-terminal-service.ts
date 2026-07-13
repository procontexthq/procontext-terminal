import type { AgentTerminalService } from "@terminal/agent-gateway";
import type { TerminalOperationManager, TerminalSessionManager } from "@terminal/session-core";

export function createAgentTerminalService(
  sessions: TerminalSessionManager,
  operations: TerminalOperationManager,
): AgentTerminalService {
  return {
    list: () => sessions.listSessions(),
    get: (request) => sessions.getSession(request),
    create: (request) => sessions.createSession({ ...request, createdBy: "agent" }),
    run: (request) => operations.run(request),
    input: (request) => sessions.input({ ...request, origin: "agent" }),
    resize: (request) => sessions.resize(request),
    scroll: (request) => sessions.scroll(request),
    observe: (request, signal) =>
      "sessionId" in request
        ? sessions.observe(request, signal)
        : operations.observe(request, signal),
    close: (request) => operations.close(request),
    startRecording: (request) => sessions.startRecording(request),
    stopRecording: (request) => sessions.stopRecording(request),
    exportRecording: (request) => sessions.exportRecording(request),
  };
}
