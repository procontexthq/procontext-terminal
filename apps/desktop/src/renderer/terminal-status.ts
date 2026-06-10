import type { RendererSessionEvent, SessionState } from "@terminal/protocol";

export type TerminalUiStatus = "starting" | SessionState;

export function nextTerminalStatus(
  current: TerminalUiStatus,
  event: RendererSessionEvent,
): TerminalUiStatus {
  switch (event.type) {
    case "session.created":
      return event.payload.state;
    case "session.attached":
      return "running";
    case "session.detached":
      return "detached";
    case "session.exited":
      return "exited";
    case "session.error":
      return current;
    case "session.title":
    case "session.bell":
      return current;
    case "session.output":
      return outputStatus(current);
    case "session.snapshot.request":
    case "agent.activity":
      return current;
  }
}

function outputStatus(status: TerminalUiStatus): TerminalUiStatus {
  return status === "starting" || status === "creating" ? "running" : status;
}
