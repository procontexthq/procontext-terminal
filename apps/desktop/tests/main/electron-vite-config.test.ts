import { describe, expect, it } from "vitest";

import config from "../../electron.vite.config";

describe("electron vite config", () => {
  it("externalizes ws optional native peers in the main-process bundle", () => {
    expect(config.main?.build?.rollupOptions?.external).toEqual(
      expect.arrayContaining(["bufferutil", "utf-8-validate"]),
    );
  });
});
