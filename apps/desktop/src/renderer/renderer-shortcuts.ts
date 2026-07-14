import type { AppShortcutInput, AppShortcutPlatform } from "../shared/app-shortcuts";

export function keyboardEventShortcutInput(event: KeyboardEvent): AppShortcutInput {
  return {
    key: event.key,
    code: event.code,
    alt: event.altKey,
    control: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
    type: "keyDown",
    isAutoRepeat: event.repeat,
  };
}

export function rendererShortcutPlatform(): AppShortcutPlatform | null {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "darwin";
  if (platform.includes("win")) return "win32";
  if (platform.includes("linux") || platform.includes("x11")) return "linux";
  return null;
}
