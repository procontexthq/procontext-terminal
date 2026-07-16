import type { TerminalPresentationMode } from "@terminal/protocol";

export async function openNewHumanTerminal(
  presentation: TerminalPresentationMode,
  actions: {
    addVisibleTab(activate: boolean): void;
    createHeadless(): Promise<unknown>;
  },
): Promise<void> {
  if (presentation === "headless") {
    await actions.createHeadless();
    return;
  }

  actions.addVisibleTab(presentation === "foreground");
}
