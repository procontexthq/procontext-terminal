import type { RendererSessionEvent, SessionState } from "@terminal/protocol";

export type TerminalUiStatus = "starting" | SessionState;

export function nextTerminalStatus(
  current: TerminalUiStatus,
  event: RendererSessionEvent,
): TerminalUiStatus {
  switch (event.type) {
    case "session.created":
      return event.payload.state;
    case "session.exited":
      return "exited";
    case "session.error":
      return "failed";
    case "session.output":
      return outputStatus(current);
  }
}

function outputStatus(status: TerminalUiStatus): TerminalUiStatus {
  return status === "starting" || status === "creating" ? "running" : status;
}
