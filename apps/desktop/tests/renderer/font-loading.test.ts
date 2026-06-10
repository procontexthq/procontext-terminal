import { afterEach, describe, expect, it, vi } from "vitest";

import { waitForFontFaces, type FontFaceSetLike } from "../../src/renderer/font-loading";

describe("font loading", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads unchecked font faces before resolving", async () => {
    const fontFaceSet: FontFaceSetLike = {
      check: vi.fn((descriptor) => descriptor === '400 13px "JetBrains Mono"'),
      load: vi.fn(() => Promise.resolve([])),
      ready: Promise.resolve(),
    };

    await expect(
      waitForFontFaces({
        descriptors: ['400 13px "JetBrains Mono"', '400 13px "Share Tech Mono"'],
        fontFaceSet,
        timeoutMs: 1000,
      }),
    ).resolves.toBe("loaded");

    expect(fontFaceSet.load).toHaveBeenCalledTimes(1);
    expect(fontFaceSet.load).toHaveBeenCalledWith('400 13px "Share Tech Mono"');
  });

  it("returns unavailable when the browser font loading API is not available", async () => {
    await expect(
      waitForFontFaces({
        descriptors: ['400 13px "Share Tech Mono"'],
        fontFaceSet: null,
      }),
    ).resolves.toBe("unavailable");
  });

  it("times out instead of blocking terminal startup indefinitely", async () => {
    vi.useFakeTimers();
    const fontFaceSet: FontFaceSetLike = {
      check: vi.fn(() => false),
      load: vi.fn(() => new Promise(() => undefined)),
      ready: new Promise(() => undefined),
    };

    const wait = waitForFontFaces({
      descriptors: ['400 13px "Share Tech Mono"'],
      fontFaceSet,
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(wait).resolves.toBe("timeout");
  });
});
