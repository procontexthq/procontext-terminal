import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/package/**/*.ts"],
    testTimeout: 120000,
  },
});
