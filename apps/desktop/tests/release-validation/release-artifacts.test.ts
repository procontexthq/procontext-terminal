import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifier = fileURLToPath(
  new URL("../../scripts/verify-release-artifacts.mjs", import.meta.url),
);
const tempDirs: string[] = [];

describe("release artifact verification", () => {
  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts and copies a structurally valid Windows NSIS installer", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.dist, "ProContext Terminal-0.1.0-win-x64.exe"), "MZinstaller");

    const result = runVerifier("windows", fixture.dist, fixture.output);

    expect(result.status).toBe(0);
    expect(
      readFileSync(join(fixture.output, "ProContext Terminal-0.1.0-win-x64.exe"), "utf8"),
    ).toBe("MZinstaller");
  });

  it("rejects unsigned-looking or malformed Windows artifacts before native checks", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.dist, "ProContext Terminal-0.1.0-win-x64.exe"), "not-pe");

    const result = runVerifier("windows", fixture.dist);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PE/COFF MZ header");
  });

  it("requires both AppImage and deb Linux artifacts", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.dist, "ProContext Terminal-0.1.0-linux-x64.AppImage"),
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01]),
    );

    const missing = runVerifier("linux", fixture.dist);
    writeFileSync(
      join(fixture.dist, "ProContext Terminal-0.1.0-linux-x64.deb"),
      "!<arch>\nfixture",
    );
    const complete = runVerifier("linux", fixture.dist);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(".deb");
    expect(complete.status).toBe(0);
  });

  it("validates the DMG UDIF trailer and versioned artifact name", () => {
    const fixture = createFixture();
    const dmg = Buffer.alloc(512);
    dmg.write("koly", 0, "ascii");
    writeFileSync(join(fixture.dist, "ProContext Terminal-0.1.0-mac-x64.dmg"), dmg);

    expect(runVerifier("macos", fixture.dist).status).toBe(0);

    rmSync(join(fixture.dist, "ProContext Terminal-0.1.0-mac-x64.dmg"));
    writeFileSync(join(fixture.dist, "ProContext Terminal-9.9.9-mac-x64.dmg"), dmg);
    const wrongVersion = runVerifier("macos", fixture.dist);
    expect(wrongVersion.status).toBe(1);
    expect(wrongVersion.stderr).toContain("version 0.1.0");
  });
});

function createFixture(): { root: string; dist: string; output: string } {
  const root = mkdtempSync(join(tmpdir(), "terminal-release-artifacts-"));
  tempDirs.push(root);
  const dist = join(root, "dist");
  const output = join(root, "release-artifacts");
  mkdirSync(dist);
  return { root, dist, output };
}

function runVerifier(platform: string, dist: string, output?: string) {
  const args = [
    verifier,
    "--platform",
    platform,
    "--dist",
    dist,
    "--package-json",
    join(desktopRoot, "package.json"),
    "--structure-only",
  ];
  if (output) args.push("--copy-to", output);
  return spawnSync(process.execPath, args, { cwd: desktopRoot, encoding: "utf8" });
}
