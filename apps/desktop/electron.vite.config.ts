import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const alias = {
  "@terminal/agent-gateway": fileURLToPath(
    new URL("../../packages/agent-gateway/src/index.ts", import.meta.url),
  ),
  "@terminal/config": fileURLToPath(new URL("../../packages/config/src/index.ts", import.meta.url)),
  "@terminal/policy-engine": fileURLToPath(
    new URL("../../packages/policy-engine/src/index.ts", import.meta.url),
  ),
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

const workspacePackages = Object.keys(alias);

export default defineConfig({
  main: {
    resolve: { alias },
    ssr: {
      noExternal: true,
    },
    build: {
      externalizeDeps: { exclude: workspacePackages },
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
