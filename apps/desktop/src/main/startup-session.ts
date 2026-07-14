import type { TerminalSessionSummary } from "@terminal/protocol";
import type { TerminalSessionManager } from "@terminal/session-core";

export type InitialHumanSessionWaitResult =
  | { status: "settled"; session: TerminalSessionSummary }
  | { status: "timed_out"; timeoutMs: number };

export function waitForInitialHumanSessionSettled(
  manager: TerminalSessionManager,
  timeoutMs: number,
): Promise<InitialHumanSessionWaitResult> {
  const settled = findSettledHumanSession(manager);
  if (settled) return Promise.resolve({ status: "settled", session: settled });

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let finished = false;
    const finish = (result: InitialHumanSessionWaitResult): void => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ status: "timed_out", timeoutMs }), timeoutMs);

    unsubscribe = manager.onSessionEvent(() => {
      const nextSettled = findSettledHumanSession(manager);
      if (nextSettled) finish({ status: "settled", session: nextSettled });
    });
  });
}

function findSettledHumanSession(
  manager: TerminalSessionManager,
): TerminalSessionSummary | undefined {
  return manager
    .listSessions()
    .find((session) => session.createdBy === "human" && session.lifecycle !== "creating");
}
