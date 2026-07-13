import type { AgentTerminalService } from "@terminal/agent-gateway";
import type { TerminalOperationManager, TerminalSessionManager } from "@terminal/session-core";

import type { TerminalPresentationController } from "./presentation-controller";

export function createAgentTerminalService(
  sessions: TerminalSessionManager,
  operations: TerminalOperationManager,
  presentation: TerminalPresentationController,
): AgentTerminalService {
  return {
    list: () => sessions.listSessions(),
    get: (request) => sessions.getSession(request),
    async create(request) {
      const session = await sessions.createSession({ ...request, createdBy: "agent" });
      await presentation.setPresentation({
        sessionId: session.sessionId,
        presentation: request.presentation ?? "headless",
      });
      return sessions.getSession({ sessionId: session.sessionId });
    },
    async attach(request) {
      sessions.getSession(request);
      if (request.presentation && request.presentation !== "unchanged") {
        await presentation.setPresentation({
          sessionId: request.sessionId,
          presentation: request.presentation,
        });
      }
      return sessions.getSession(request);
    },
    run: (request) =>
      operations.run(request, {
        onTemporarySessionCreated: (sessionId, requestedPresentation) =>
          presentation
            .setPresentation({
              sessionId,
              presentation: requestedPresentation,
            })
            .then(() => undefined),
      }),
    input: (request) => sessions.input({ ...request, origin: "agent" }),
    resize: (request) => sessions.resize(request),
    scroll: (request) => sessions.scroll(request),
    setPresentation: (request) => presentation.setPresentation(request),
    observe: (request, signal) =>
      "sessionId" in request
        ? sessions.observe(request, signal)
        : operations.observe(request, signal),
    async close(request) {
      const sessionId =
        "sessionId" in request
          ? request.sessionId
          : operations.sessionIdForOperation(request.operationId);
      if (sessionId) await presentation.closeView(sessionId);
      return await operations.close(request);
    },
    startRecording: (request) => sessions.startRecording(request),
    stopRecording: (request) => sessions.stopRecording(request),
    exportRecording: (request) => sessions.exportRecording(request),
  };
}
