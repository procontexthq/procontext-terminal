import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const smokeHelper = fileURLToPath(
  new URL("../../scripts/smoke-release-executable.mjs", import.meta.url),
);
const tempDirs: string[] = [];

describe("release executable smoke", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("launches an executable, waits for its renderer endpoint, and stops it", () => {
    const root = mkdtempSync(join(tmpdir(), "terminal-release-smoke-fixture-"));
    tempDirs.push(root);
    const fixture = join(root, "fake-electron.mjs");
    writeFileSync(
      fixture,
      [
        'import { createServer } from "node:http";',
        'const value = process.argv.find((argument) => argument.startsWith("--remote-debugging-port="));',
        'if (!value) throw new Error("Missing remote debugging port.");',
        'const port = Number(value.split("=")[1]);',
        "createServer((request, response) => {",
        '  response.setHeader("content-type", "application/json");',
        '  response.end(JSON.stringify({ Browser: "ReleaseSmokeFixture/1.0" }));',
        '}).listen(port, "127.0.0.1");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        smokeHelper,
        "--executable",
        process.execPath,
        "--argument",
        fixture,
        "--timeout-ms",
        "5000",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"status": "launched"');
    expect(result.stdout).toContain("ReleaseSmokeFixture/1.0");
  });
});
