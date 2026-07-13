import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, shouldSetDevelopmentDockIcon } from "../../src/main/app-branding";

describe("app branding", () => {
  it("uses the product name in desktop package metadata", async () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      productName?: unknown;
    };

    expect(packageJson.productName).toBe(PRODUCT_NAME);
  });

  it("sets a runtime Dock icon only for an unpackaged macOS app", () => {
    expect(shouldSetDevelopmentDockIcon("darwin", false)).toBe(true);
    expect(shouldSetDevelopmentDockIcon("darwin", true)).toBe(false);
    expect(shouldSetDevelopmentDockIcon("linux", false)).toBe(false);
    expect(shouldSetDevelopmentDockIcon("win32", false)).toBe(false);
  });
});
