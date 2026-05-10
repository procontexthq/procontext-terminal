import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@terminal/config": fileURLToPath(new URL("./packages/config/src/index.ts", import.meta.url)),
      "@terminal/protocol": fileURLToPath(
        new URL("./packages/protocol/src/index.ts", import.meta.url),
      ),
      "@terminal/pty-host": fileURLToPath(
        new URL("./packages/pty-host/src/index.ts", import.meta.url),
      ),
      "@terminal/session-core": fileURLToPath(
        new URL("./packages/session-core/src/index.ts", import.meta.url),
      ),
      "@terminal/test-fixtures": fileURLToPath(
        new URL("./packages/test-fixtures/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts", "apps/desktop/tests/**/*.test.ts"],
    exclude: ["apps/desktop/tests/e2e/**/*.test.ts"],
    testTimeout: 10000,
  },
});
