import { describe, expect, it, vi } from "vitest";

import { openNewHumanTerminal } from "../../src/renderer/new-human-terminal";

describe("new human terminal presentation", () => {
  it.each([
    ["foreground", true],
    ["background", false],
  ] as const)(
    "opens a %s renderer view with the expected activation",
    async (presentation, activate) => {
      const addVisibleTab = vi.fn();
      const createHeadless = vi.fn(() => Promise.resolve());

      await openNewHumanTerminal(presentation, { addVisibleTab, createHeadless });

      expect(addVisibleTab).toHaveBeenCalledWith(activate);
      expect(createHeadless).not.toHaveBeenCalled();
    },
  );

  it("creates a headless human session without adding a renderer tab", async () => {
    const addVisibleTab = vi.fn();
    const createHeadless = vi.fn(() => Promise.resolve());

    await openNewHumanTerminal("headless", { addVisibleTab, createHeadless });

    expect(createHeadless).toHaveBeenCalledOnce();
    expect(addVisibleTab).not.toHaveBeenCalled();
  });
});
