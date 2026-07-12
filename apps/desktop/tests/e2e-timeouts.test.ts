import { describe, expect, it } from "vitest";

import { terminalUiTimeoutMs } from "./e2e/e2e-timeouts";

describe("Electron E2E timeouts", () => {
  it("allows slower terminal readiness on Windows", () => {
    expect(terminalUiTimeoutMs("win32")).toBe(30000);
  });

  it.each(["darwin", "linux"] satisfies NodeJS.Platform[])(
    "keeps the default terminal readiness timeout on %s",
    (platform) => {
      expect(terminalUiTimeoutMs(platform)).toBe(10000);
    },
  );
});
