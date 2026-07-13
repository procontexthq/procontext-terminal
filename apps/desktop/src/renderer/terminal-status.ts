import type { RendererSessionEvent, TerminalLifecycleState } from "@terminal/protocol";

export type TerminalUiStatus = "starting" | TerminalLifecycleState;

export function nextTerminalStatus(
  current: TerminalUiStatus,
  event: RendererSessionEvent,
): TerminalUiStatus {
  switch (event.type) {
    case "session.updated":
      return event.payload.lifecycle;
    case "session.output":
      return current === "starting" || current === "creating" ? "running" : current;
    case "session.viewport":
    case "session.bell":
    case "session.error":
    case "agent.activity":
      return current;
  }
}
