import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const alias = {
  "@terminal/config": fileURLToPath(new URL("../../packages/config/src/index.ts", import.meta.url)),
  "@terminal/protocol": fileURLToPath(
    new URL("../../packages/protocol/src/index.ts", import.meta.url),
  ),
  "@terminal/pty-host": fileURLToPath(
    new URL("../../packages/pty-host/src/index.ts", import.meta.url),
  ),
  "@terminal/recorder": fileURLToPath(
    new URL("../../packages/recorder/src/index.ts", import.meta.url),
  ),
  "@terminal/session-core": fileURLToPath(
    new URL("../../packages/session-core/src/index.ts", import.meta.url),
  ),
};

export default defineConfig({
  main: {
    resolve: { alias },
    ssr: {
      noExternal: true,
    },
    build: {
      externalizeDeps: { exclude: ["@terminal/recorder"] },
      rollupOptions: {
        external: ["electron", "node-pty"],
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    ssr: {
      noExternal: [/^@terminal\//],
    },
    build: {
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    resolve: { alias },
    plugins: [react()],
  },
});
