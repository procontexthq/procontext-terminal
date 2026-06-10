import type { AppShortcutAction } from "@terminal/protocol";

export type AppShortcutPlatform = "darwin" | "win32" | "linux";

export type AppShortcutInput = {
  key: string;
  code?: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
  type?: string;
  isAutoRepeat?: boolean;
};

export function resolveAppShortcut(
  input: AppShortcutInput,
  platform: AppShortcutPlatform,
): AppShortcutAction | null {
  if (input.type && input.type !== "keyDown") {
    return null;
  }
  if (input.isAutoRepeat) {
    return null;
  }

  const key = input.key.toLowerCase();
  if (platform === "darwin") {
    if (!input.meta || input.control || input.alt) {
      return null;
    }
    if (!input.shift && key === "t") {
      return "newTab";
    }
    if (!input.shift && key === "w") {
      return "closeTab";
    }
    if (input.shift && isBracketLeft(input)) {
      return "previousTab";
    }
    if (input.shift && isBracketRight(input)) {
      return "nextTab";
    }
    return null;
  }

  if (!input.control || input.meta || input.alt) {
    return null;
  }
  if (input.shift && key === "t") {
    return "newTab";
  }
  if (input.shift && key === "w") {
    return "closeTab";
  }
  if (!input.shift && key === "pageup") {
    return "previousTab";
  }
  if (!input.shift && key === "pagedown") {
    return "nextTab";
  }
  return null;
}

function isBracketLeft(input: AppShortcutInput): boolean {
  return input.code === "BracketLeft" || input.key === "[" || input.key === "{";
}

function isBracketRight(input: AppShortcutInput): boolean {
  return input.code === "BracketRight" || input.key === "]" || input.key === "}";
}
