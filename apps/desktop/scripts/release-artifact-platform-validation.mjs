import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { smokeReleaseExecutable } from "./smoke-release-executable.mjs";

const execFileAsync = promisify(execFile);
const commandOptions = { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 };

export async function validatePlatformArtifacts(platform, artifacts) {
  if (platform === "macos") return validateMacArtifacts(artifacts.dmg);
  if (platform === "windows") return validateWindowsInstaller(artifacts.exe);
  return validateLinuxArtifacts(artifacts.appImage, artifacts.deb);
}

async function validateMacArtifacts(dmg) {
  await run("hdiutil", ["verify", dmg]);
  await run("codesign", ["--verify", "--verbose=2", dmg]);
  const mountRoot = await mkdtemp(join(tmpdir(), "terminal-release-dmg-"));
  let mounted = false;
  try {
    await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmg]);
    mounted = true;
    const app = await findOne(mountRoot, (path) => path.endsWith(".app"), "application in DMG");
    await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    await run("xcrun", ["stapler", "validate", app]);
    await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
    await findOne(
      app,
      (path) => path.endsWith(".node") && path.includes("node-pty"),
      "DMG application node-pty native module",
    );
    const executable = await findOne(
      join(app, "Contents", "MacOS"),
      (_path, entry) => entry.isFile(),
      "DMG application executable",
    );
    await smokeReleaseExecutable(executable);
  } finally {
    if (mounted) await run("hdiutil", ["detach", mountRoot]);
    await removeTemporaryDirectory(mountRoot);
  }
}

async function validateWindowsInstaller(installer) {
  await verifyWindowsAuthenticode(installer, "NSIS installer");

  const temporaryRoot = await mkdtemp(join(tmpdir(), "terminal-release-nsis-"));
  const installRoot = join(temporaryRoot, "installed");
  try {
    await run(installer, ["/S", `/D=${installRoot}`]);
    const applicationExecutable = await findOne(
      installRoot,
      (path) =>
        dirname(path) === installRoot &&
        path.toLowerCase().endsWith(".exe") &&
        !basename(path).toLowerCase().includes("uninstall"),
      "installed application executable",
    );
    await verifyWindowsAuthenticode(applicationExecutable, "installed application");
    await findOne(
      installRoot,
      (path) => path.toLowerCase().endsWith(".node") && path.toLowerCase().includes("node-pty"),
      "installed node-pty native module",
    );
    const uninstaller = await findOne(
      installRoot,
      (path) =>
        path.toLowerCase().endsWith(".exe") && basename(path).toLowerCase().includes("uninstall"),
      "NSIS uninstaller",
    );
    await smokeReleaseExecutable(applicationExecutable);
    await run(uninstaller, ["/S"]);
  } finally {
    await removeTemporaryDirectory(temporaryRoot);
  }
}

async function verifyWindowsAuthenticode(artifact, artifactLabel) {
  const signatureCommand = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $env:PCT_RELEASE_ARTIFACT;",
    "if ($signature.Status -ne 'Valid') {",
    '  throw "$env:PCT_RELEASE_ARTIFACT_LABEL Authenticode signature is not valid: $($signature.Status)"',
    "}",
  ].join(" ");
  await runPowerShell(
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", signatureCommand],
    artifact,
    artifactLabel,
  );
}

async function validateLinuxArtifacts(appImage, deb) {
  await access(appImage, constants.X_OK);
  const appImageRoot = await mkdtemp(join(tmpdir(), "terminal-release-appimage-"));
  const debRoot = await mkdtemp(join(tmpdir(), "terminal-release-deb-"));
  try {
    await run(appImage, ["--appimage-extract"], { cwd: appImageRoot });
    const appRun = await findOne(
      appImageRoot,
      (path) => basename(path) === "AppRun",
      "AppImage AppRun entrypoint",
    );
    await findOne(
      appImageRoot,
      (path) => path.endsWith(".node") && path.includes("node-pty"),
      "AppImage node-pty native module",
    );
    await smokeReleaseExecutable(appRun);
    await run("dpkg-deb", ["--info", deb]);
    await run("dpkg-deb", ["--extract", deb, debRoot]);
    const debExecutable = await findOne(
      debRoot,
      (path, entry) => entry.isFile() && basename(path) === "procontext-terminal",
      "deb application executable",
    );
    await findOne(
      debRoot,
      (path) => path.endsWith(".node") && path.includes("node-pty"),
      "deb node-pty native module",
    );
    await smokeReleaseExecutable(debExecutable);
  } finally {
    await removeTemporaryDirectory(appImageRoot);
    await removeTemporaryDirectory(debRoot);
  }
}

async function findOne(root, predicate, label) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (predicate(path, entry)) return path;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findOneOrNull(path, predicate);
      if (nested) return nested;
    }
  }
  throw new Error(`Could not find ${label} under ${root}.`);
}

async function findOneOrNull(root, predicate) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (predicate(path, entry)) return path;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nested = await findOneOrNull(path, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

async function run(file, args, options = {}) {
  try {
    await execFileAsync(file, args, { ...commandOptions, ...options });
  } catch (error) {
    throw new Error(`Release validation command failed: ${file} ${args.join(" ")}`, {
      cause: error,
    });
  }
}

async function runPowerShell(args, artifact, artifactLabel) {
  for (const executable of ["pwsh", "powershell.exe"]) {
    try {
      await execFileAsync(executable, args, {
        ...commandOptions,
        env: {
          ...process.env,
          PCT_RELEASE_ARTIFACT: artifact,
          PCT_RELEASE_ARTIFACT_LABEL: artifactLabel,
        },
      });
      return;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new Error(`Release validation command failed: ${executable} ${args.join(" ")}`, {
        cause: error,
      });
    }
  }
  throw new Error("Release validation requires PowerShell Core or Windows PowerShell.");
}

async function removeTemporaryDirectory(path) {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error(`Refusing to remove non-directory ${path}.`);
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
