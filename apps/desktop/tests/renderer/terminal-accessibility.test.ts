import { describe, expect, it } from "vitest";

import { terminalAccessibilityOptions } from "../../src/renderer/terminal-accessibility";

describe("terminal accessibility options", () => {
  it("enables xterm screen-reader support and configured contrast", () => {
    expect(
      terminalAccessibilityOptions({
        screenReaderMode: true,
        reducedMotion: false,
        minimumContrastRatio: 7,
      }),
    ).toEqual({
      cursorBlink: true,
      minimumContrastRatio: 7,
      screenReaderMode: true,
    });
  });

  it("stops cursor animation when reduced motion is requested", () => {
    expect(
      terminalAccessibilityOptions({
        screenReaderMode: false,
        reducedMotion: true,
        minimumContrastRatio: 4.5,
      }),
    ).toEqual({
      cursorBlink: false,
      minimumContrastRatio: 4.5,
      screenReaderMode: false,
    });
  });
});
