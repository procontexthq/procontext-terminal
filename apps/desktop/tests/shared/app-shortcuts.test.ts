import { describe, expect, it } from "vitest";

import { resolveAppShortcut, type AppShortcutInput } from "../../src/shared/app-shortcuts";

const baseInput: AppShortcutInput = {
  key: "",
  alt: false,
  control: false,
  meta: false,
  shift: false,
  type: "keyDown",
};

describe("app shortcut resolver", () => {
  it("uses macOS command tab shortcuts", () => {
    expect(resolveAppShortcut({ ...baseInput, key: "t", meta: true }, "darwin")).toBe("newTab");
    expect(resolveAppShortcut({ ...baseInput, key: "w", meta: true }, "darwin")).toBe("closeTab");
    expect(
      resolveAppShortcut(
        { ...baseInput, key: "{", code: "BracketLeft", meta: true, shift: true },
        "darwin",
      ),
    ).toBe("previousTab");
    expect(
      resolveAppShortcut(
        { ...baseInput, key: "}", code: "BracketRight", meta: true, shift: true },
        "darwin",
      ),
    ).toBe("nextTab");
  });

  it("uses Windows and Linux shortcuts without stealing plain Ctrl+W terminal input", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(
        resolveAppShortcut({ ...baseInput, key: "t", control: true, shift: true }, platform),
      ).toBe("newTab");
      expect(
        resolveAppShortcut({ ...baseInput, key: "w", control: true, shift: true }, platform),
      ).toBe("closeTab");
      expect(resolveAppShortcut({ ...baseInput, key: "PageUp", control: true }, platform)).toBe(
        "previousTab",
      );
      expect(resolveAppShortcut({ ...baseInput, key: "PageDown", control: true }, platform)).toBe(
        "nextTab",
      );
      expect(resolveAppShortcut({ ...baseInput, key: "w", control: true }, platform)).toBeNull();
    }
  });

  it("ignores key-up and repeated shortcut events", () => {
    expect(
      resolveAppShortcut({ ...baseInput, key: "w", meta: true, type: "keyUp" }, "darwin"),
    ).toBeNull();
    expect(
      resolveAppShortcut({ ...baseInput, key: "w", meta: true, isAutoRepeat: true }, "darwin"),
    ).toBeNull();
  });
});
