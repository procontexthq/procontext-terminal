import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifierScript = fileURLToPath(
  new URL("../../scripts/verify-electron-install.mjs", import.meta.url),
);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Electron install verifier", () => {
  it("fails clearly when Electron path.txt is missing", async () => {
    const electronPackageDir = await createElectronPackageDir();

    const result = await runVerifier(electronPackageDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Electron is not installed correctly for this platform.");
    expect(result.stderr).toContain("Electron binary marker is missing or invalid");
    expect(result.stderr).toContain("pnpm electron:install");
  });

  it("fails clearly when the Electron binary referenced by path.txt is missing", async () => {
    const electronPackageDir = await createElectronPackageDir();
    await writeFile(join(electronPackageDir, "path.txt"), "electron\n");

    const result = await runVerifier(electronPackageDir);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Electron is not installed correctly for this platform.");
    expect(result.stderr).toContain("Electron binary is missing or inaccessible");
    expect(result.stderr).toContain("pnpm electron:verify");
  });

  it("passes when path.txt points to an installed Electron binary", async () => {
    const electronPackageDir = await createElectronPackageDir();
    await mkdir(join(electronPackageDir, "dist"), { recursive: true });
    await writeFile(join(electronPackageDir, "path.txt"), "electron\n");
    await writeFile(join(electronPackageDir, "dist", "electron"), "");

    const result = await runVerifier(electronPackageDir);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Electron install verified:");
  });
});

async function createElectronPackageDir() {
  const directory = await mkdtemp(join(tmpdir(), "terminal-electron-install-"));
  tempDirs.push(directory);
  return directory;
}

async function runVerifier(electronPackageDir: string) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      verifierScript,
      electronPackageDir,
    ]);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}
