import { describe, expect, it, vi } from "vitest";

import { configureSingleInstance } from "../../src/main/single-instance";

describe("single-instance coordination", () => {
  it("quits a second process before it can own profile-scoped runtime files", () => {
    const quit = vi.fn();
    const onSecondInstance = vi.fn();

    const primary = configureSingleInstance({
      requestLock: () => false,
      onSecondInstance,
      quit,
      getWindows: () => [],
    });

    expect(primary).toBe(false);
    expect(quit).toHaveBeenCalledOnce();
    expect(onSecondInstance).not.toHaveBeenCalled();
  });

  it("restores and focuses the existing window for repeated launches", () => {
    const secondInstanceHandlers: Array<() => void> = [];
    const existingWindow = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };

    const primary = configureSingleInstance({
      requestLock: () => true,
      onSecondInstance: (handler) => {
        secondInstanceHandlers.push(handler);
      },
      quit: vi.fn(),
      getWindows: () => [existingWindow],
    });
    secondInstanceHandlers[0]?.();

    expect(primary).toBe(true);
    expect(existingWindow.restore).toHaveBeenCalledOnce();
    expect(existingWindow.show).toHaveBeenCalledOnce();
    expect(existingWindow.focus).toHaveBeenCalledOnce();
  });
});
