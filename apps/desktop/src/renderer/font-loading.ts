export type FontFaceSetLike = {
  check(font: string): boolean;
  load(font: string): Promise<unknown>;
  ready: Promise<unknown>;
};

export type FontLoadResult = "loaded" | "timeout" | "unavailable";

export type WaitForFontFacesOptions = {
  descriptors: readonly string[];
  fontFaceSet?: FontFaceSetLike | null;
  timeoutMs?: number;
};

const defaultFontLoadTimeoutMs = 1200;

export function browserFontFaceSet(): FontFaceSetLike | null {
  if (typeof document === "undefined" || !document.fonts) {
    return null;
  }
  return document.fonts;
}

export async function waitForFontFaces({
  descriptors,
  fontFaceSet = browserFontFaceSet(),
  timeoutMs = defaultFontLoadTimeoutMs,
}: WaitForFontFacesOptions): Promise<FontLoadResult> {
  const uniqueDescriptors = [...new Set(descriptors)];
  if (uniqueDescriptors.length === 0) {
    return "loaded";
  }
  if (!fontFaceSet) {
    return "unavailable";
  }

  const load = loadFontFaces(fontFaceSet, uniqueDescriptors)
    .then(() => "loaded" as const)
    .catch(() => "unavailable" as const);

  if (!Number.isFinite(timeoutMs)) {
    return load;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });

  const result = await Promise.race([load, timeout]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  return result;
}

async function loadFontFaces(
  fontFaceSet: FontFaceSetLike,
  descriptors: readonly string[],
): Promise<void> {
  await Promise.all(
    descriptors.map((descriptor) =>
      fontFaceSet.check(descriptor) ? Promise.resolve() : fontFaceSet.load(descriptor),
    ),
  );
  await fontFaceSet.ready;
}
