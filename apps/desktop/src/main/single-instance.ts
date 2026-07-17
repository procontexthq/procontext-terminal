type ExistingWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export function configureSingleInstance({
  requestLock,
  onSecondInstance,
  quit,
  getWindows,
}: {
  requestLock: () => boolean;
  onSecondInstance: (handler: () => void) => void;
  quit: () => void;
  getWindows: () => ExistingWindow[];
}): boolean {
  if (!requestLock()) {
    quit();
    return false;
  }

  onSecondInstance(() => {
    const window = getWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
