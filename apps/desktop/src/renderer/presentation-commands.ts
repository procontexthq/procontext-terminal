import type {
  RendererPresentationAcknowledgement,
  RendererPresentationCommand,
  RendererTerminalApi,
  SessionId,
} from "@terminal/protocol";

import type { TerminalController } from "./terminal-controller";
import {
  addAttachedTerminalTab,
  closeTerminalTab,
  selectTerminalTab,
  type TerminalTabsState,
} from "./terminal-tabs";

export type PresentationCommandContext = {
  api: Pick<RendererTerminalApi, "getSession">;
  getTabsState: () => TerminalTabsState | null;
  updateTabs: (update: (state: TerminalTabsState) => TerminalTabsState) => void;
  controllers: Map<string, TerminalController>;
  pendingOpenCommands: Map<SessionId, RendererPresentationCommand>;
  acknowledge: (acknowledgement: RendererPresentationAcknowledgement) => void;
};

export async function handlePresentationCommand(
  command: RendererPresentationCommand,
  context: PresentationCommandContext,
): Promise<void> {
  try {
    switch (command.action) {
      case "open":
        await openPresentation(command, context);
        return;
      case "focus":
        focusPresentation(command, context);
        return;
      case "hide":
      case "close":
        await removePresentation(command, context);
    }
  } catch (error: unknown) {
    context.acknowledge({
      ...command,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function completePendingPresentationOpen(
  sessionId: SessionId,
  pendingOpenCommands: Map<SessionId, RendererPresentationCommand>,
  acknowledge: PresentationCommandContext["acknowledge"],
): void {
  const pending = pendingOpenCommands.get(sessionId);
  if (!pending) return;
  pendingOpenCommands.delete(sessionId);
  acknowledge({ ...pending, status: "completed" });
}

export function failPendingPresentationOpen(
  sessionId: SessionId,
  message: string,
  pendingOpenCommands: Map<SessionId, RendererPresentationCommand>,
  acknowledge: PresentationCommandContext["acknowledge"],
): void {
  const pending = pendingOpenCommands.get(sessionId);
  if (!pending) return;
  pendingOpenCommands.delete(sessionId);
  acknowledge({ ...pending, status: "failed", message });
}

async function openPresentation(
  command: RendererPresentationCommand,
  context: PresentationCommandContext,
): Promise<void> {
  const summary = await context.api.getSession({ sessionId: command.sessionId });
  const current = context.getTabsState();
  const existing = current?.tabs.find((tab) => tab.sessionId === command.sessionId);
  if (existing && context.controllers.has(existing.id)) {
    context.updateTabs((state) => {
      if (state.activeTabId !== existing.id) return state;
      const fallback = state.tabs.find((tab) => tab.id !== existing.id);
      return fallback ? selectTerminalTab(state, fallback.id) : state;
    });
    queueMicrotask(() => context.acknowledge({ ...command, status: "completed" }));
    return;
  }

  context.pendingOpenCommands.set(command.sessionId, command);
  context.updateTabs((state) => addAttachedTerminalTab(state, summary, { activate: false }));
}

function focusPresentation(
  command: RendererPresentationCommand,
  context: PresentationCommandContext,
): void {
  const current = context.getTabsState();
  const tab = current?.tabs.find((candidate) => candidate.sessionId === command.sessionId);
  const controller = tab ? context.controllers.get(tab.id) : undefined;
  if (!tab || !controller) {
    throw new Error("Terminal view is not open.");
  }

  context.updateTabs((state) => selectTerminalTab(state, tab.id));
  queueMicrotask(() => controller.focus());
  context.acknowledge({ ...command, status: "completed" });
}

async function removePresentation(
  command: RendererPresentationCommand,
  context: PresentationCommandContext,
): Promise<void> {
  const current = context.getTabsState();
  const tab = current?.tabs.find((candidate) => candidate.sessionId === command.sessionId);
  if (!tab) {
    context.acknowledge({ ...command, status: "completed" });
    return;
  }

  const controller = context.controllers.get(tab.id);
  if (controller && !(await controller.dispose())) {
    throw new Error("Terminal view could not be closed.");
  }
  context.updateTabs((state) => closeTerminalTab(state, tab.id));
  context.acknowledge({ ...command, status: "completed" });
}
