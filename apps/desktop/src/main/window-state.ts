import { windowGeometrySchema, type WindowGeometry } from "@terminal/protocol";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowStateDisplay = {
  id: number;
  workArea: WindowBounds;
};

type GeometryWindow = {
  on(event: "move" | "resize" | "close", handler: () => void): void;
  removeListener(event: "move" | "resize" | "close", handler: () => void): void;
  getNormalBounds(): WindowBounds;
};

export type WindowGeometryPersistence = {
  pending(): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
};

export function resolveWindowBounds(
  geometry: WindowGeometry | null,
  displays: readonly WindowStateDisplay[],
  fallback: WindowBounds,
): WindowBounds {
  const parsed = windowGeometrySchema.safeParse(geometry);
  const display = parsed.success
    ? displays.find((candidate) => candidate.id === parsed.data.displayId)
    : undefined;
  if (!parsed.success || !display) return clampBounds(fallback, displays[0]?.workArea);
  return clampBounds(parsed.data, display.workArea);
}

export function captureWindowGeometry(bounds: WindowBounds, displayId: number): WindowGeometry {
  return windowGeometrySchema.parse({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    displayId,
  });
}

export function attachWindowGeometryPersistence({
  window,
  getDisplayMatching,
  saveGeometry,
  onError,
  debounceMs = 250,
}: {
  window: GeometryWindow;
  getDisplayMatching: (bounds: WindowBounds) => WindowStateDisplay;
  saveGeometry: (geometry: WindowGeometry) => Promise<void>;
  onError: (error: unknown) => void;
  debounceMs?: number;
}): WindowGeometryPersistence {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();

  const persist = (): void => {
    const bounds = window.getNormalBounds();
    const display = getDisplayMatching(bounds);
    let geometry: WindowGeometry;
    try {
      geometry = captureWindowGeometry(bounds, display.id);
    } catch (error: unknown) {
      onError(error);
      return;
    }
    pending = pending.then(() => saveGeometry(geometry)).catch(onError);
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      persist();
    }, debounceMs);
  };

  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    persist();
    return pending;
  };

  const handleClose = (): void => {
    void flush();
  };

  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("close", handleClose);

  return {
    pending: () => pending,
    flush,
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      window.removeListener("move", schedule);
      window.removeListener("resize", schedule);
      window.removeListener("close", handleClose);
    },
  };
}

function clampBounds(bounds: WindowBounds, workArea: WindowBounds | undefined): WindowBounds {
  if (!workArea) return bounds;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
