import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachWindowGeometryPersistence,
  captureWindowGeometry,
  resolveWindowBounds,
} from "../../src/main/window-state";

afterEach(() => {
  vi.useRealTimers();
});

describe("window state", () => {
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 1024 } },
  ];
  const fallback = { x: 100, y: 80, width: 1000, height: 700 };

  it("restores validated geometry on its recorded display", () => {
    expect(
      resolveWindowBounds(
        { x: -1200, y: 40, width: 1100, height: 800, displayId: 2 },
        displays,
        fallback,
      ),
    ).toEqual({ x: -1200, y: 40, width: 1100, height: 800 });
  });

  it("clamps size and position to the selected display work area", () => {
    expect(
      resolveWindowBounds(
        { x: -4000, y: -500, width: 4000, height: 3000, displayId: 2 },
        displays,
        fallback,
      ),
    ).toEqual({ x: -1280, y: 0, width: 1280, height: 1024 });
  });

  it("uses safe defaults when the recorded display is unavailable", () => {
    expect(
      resolveWindowBounds(
        { x: 9000, y: 9000, width: 1200, height: 800, displayId: 99 },
        displays,
        fallback,
      ),
    ).toEqual(fallback);
  });

  it("captures only validated size, position, and display placement", () => {
    expect(
      captureWindowGeometry(
        { x: 20, y: 30, width: 1280, height: 800, tabs: ["forbidden"] } as never,
        7,
      ),
    ).toEqual({ x: 20, y: 30, width: 1280, height: 800, displayId: 7 });
  });

  it("debounces move and resize persistence and flushes the latest bounds on close", async () => {
    vi.useFakeTimers();
    const window = new FakeWindow();
    const saveGeometry = vi.fn(() => Promise.resolve());
    const onError = vi.fn();
    const persistence = attachWindowGeometryPersistence({
      window,
      getDisplayMatching: () => displays[0]!,
      saveGeometry,
      onError,
      debounceMs: 250,
    });

    window.bounds = { x: 10, y: 20, width: 900, height: 600 };
    window.emit("move");
    window.bounds = { x: 30, y: 40, width: 1200, height: 760 };
    window.emit("resize");
    await vi.advanceTimersByTimeAsync(249);
    expect(saveGeometry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await persistence.pending();
    expect(saveGeometry).toHaveBeenLastCalledWith({
      x: 30,
      y: 40,
      width: 1200,
      height: 760,
      displayId: 1,
    });

    window.bounds = { x: 50, y: 60, width: 1300, height: 780 };
    window.emit("close");
    await persistence.pending();
    expect(saveGeometry).toHaveBeenLastCalledWith({
      x: 50,
      y: 60,
      width: 1300,
      height: 780,
      displayId: 1,
    });
    expect(onError).not.toHaveBeenCalled();
    persistence.dispose();
  });

  it("flushes scheduled geometry immediately and waits for the save to settle", async () => {
    vi.useFakeTimers();
    const window = new FakeWindow();
    let releaseSave!: () => void;
    const savePending = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveGeometry = vi.fn(() => savePending);
    const persistence = attachWindowGeometryPersistence({
      window,
      getDisplayMatching: () => displays[0]!,
      saveGeometry,
      onError: vi.fn(),
      debounceMs: 250,
    });

    window.bounds = { x: 70, y: 80, width: 1400, height: 900 };
    window.emit("resize");

    let flushSettled = false;
    const flush = persistence.flush().then(() => {
      flushSettled = true;
    });
    await Promise.resolve();

    expect(saveGeometry).toHaveBeenCalledOnce();
    expect(saveGeometry).toHaveBeenCalledWith({
      x: 70,
      y: 80,
      width: 1400,
      height: 900,
      displayId: 1,
    });
    expect(flushSettled).toBe(false);

    await vi.advanceTimersByTimeAsync(250);
    expect(saveGeometry).toHaveBeenCalledOnce();

    releaseSave();
    await flush;
    expect(flushSettled).toBe(true);
    persistence.dispose();
  });
});

type WindowEvent = "move" | "resize" | "close";

class FakeWindow {
  bounds = { x: 0, y: 0, width: 1000, height: 700 };
  private readonly handlers = new Map<WindowEvent, Set<() => void>>();

  on(event: WindowEvent, handler: () => void): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  removeListener(event: WindowEvent, handler: () => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  getNormalBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }

  emit(event: WindowEvent): void {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }
}
