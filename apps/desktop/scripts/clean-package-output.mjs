import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

await Promise.all([
  rm(resolve(desktopRoot, "dist"), { recursive: true, force: true }),
  rm(resolve(desktopRoot, "release-artifacts"), { recursive: true, force: true }),
]);
