import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(desktopRoot, "dist");
const execFileAsync = promisify(execFile);

const layout = await resolvePackagedLayout(distDir, process.platform);
await assertFile(layout.executable, "packaged executable");
await assertFile(join(layout.resourcesDir, "icon.png"), "packaged app icon");
await assertPackagedAppResources(layout.resourcesDir);
const bundleMetadata = process.platform === "darwin" ? await assertMacBundleMetadata(layout) : null;

const nativeModules = await findFiles(layout.resourcesDir, (path) => {
  return (
    path.includes(`node_modules${pathSeparator()}node-pty${pathSeparator()}`) &&
    path.endsWith(".node")
  );
});

if (nativeModules.length === 0) {
  throw new Error(
    `Packaged resources do not contain a node-pty native module under ${layout.resourcesDir}.`,
  );
}

for (const nativeModule of nativeModules) {
  if (
    nativeModule.includes("app.asar" + pathSeparator()) &&
    !nativeModule.includes("app.asar.unpacked")
  ) {
    throw new Error(`node-pty native module must not be packed inside app.asar: ${nativeModule}`);
  }
}

const windowsBundledConpty =
  process.platform === "win32" ? await assertWindowsBundledConpty(nativeModules) : null;

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      executable: layout.executable,
      resourcesDir: layout.resourcesDir,
      appIcon: join(layout.resourcesDir, "icon.png"),
      bundleMetadata,
      nodePtyNativeModules: nativeModules,
      windowsBundledConpty,
    },
    null,
    2,
  ),
);

async function assertWindowsBundledConpty(nativeModules) {
  const separator = pathSeparator();
  const selectedPrebuildMarker =
    `${separator}prebuilds${separator}win32-${process.arch}${separator}`.toLowerCase();
  const selectedConptyModule = nativeModules.find((path) => {
    return (
      basename(path).toLowerCase() === "conpty.node" &&
      path.toLowerCase().includes(selectedPrebuildMarker)
    );
  });

  if (!selectedConptyModule) {
    throw new Error(
      `Packaged resources do not contain the selected win32-${process.arch} ConPTY native module.`,
    );
  }

  const bundledConptyDir = join(dirname(selectedConptyModule), "conpty");
  const conptyDll = join(bundledConptyDir, "conpty.dll");
  const openConsole = join(bundledConptyDir, "OpenConsole.exe");
  await assertFile(conptyDll, `packaged win32-${process.arch} bundled ConPTY DLL`);
  await assertFile(openConsole, `packaged win32-${process.arch} bundled OpenConsole executable`);

  return {
    nativeModule: selectedConptyModule,
    conptyDll,
    openConsole,
  };
}

async function resolvePackagedLayout(root, platform) {
  const entries = await directoryEntries(root);
  if (platform === "darwin") {
    for (const entry of entries) {
      if (!entry.isDirectory() || !basename(entry.name).startsWith("mac")) {
        continue;
      }
      const appBundle = await firstMatchingDirectory(join(root, entry.name), (name) =>
        name.endsWith(".app"),
      );
      if (!appBundle) {
        continue;
      }
      const executableName = basename(appBundle, ".app");
      return {
        appBundle,
        executable: join(appBundle, "Contents", "MacOS", executableName),
        resourcesDir: join(appBundle, "Contents", "Resources"),
      };
    }
  }

  if (platform === "linux") {
    const unpacked = await firstMatchingDirectory(root, (name) => name.endsWith("-unpacked"));
    if (unpacked) {
      return {
        appBundle: null,
        executable: join(unpacked, "procontext-terminal"),
        resourcesDir: join(unpacked, "resources"),
      };
    }
  }

  if (platform === "win32") {
    const unpacked = await firstMatchingDirectory(root, (name) => name.endsWith("-unpacked"));
    if (unpacked) {
      const executable = await firstMatchingFile(unpacked, (name) => {
        const lowerName = name.toLowerCase();
        return lowerName.endsWith(".exe") && !lowerName.includes("uninstall");
      });
      if (executable) {
        return {
          appBundle: null,
          executable,
          resourcesDir: join(unpacked, "resources"),
        };
      }
    }
  }

  throw new Error(`Could not find packaged app layout for ${platform} in ${root}.`);
}

async function assertMacBundleMetadata(layout) {
  if (!layout.appBundle) {
    throw new Error("Packaged macOS layout is missing its app bundle path.");
  }

  const packageJson = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
  if (typeof packageJson.productName !== "string" || packageJson.productName.length === 0) {
    throw new Error("Desktop package.json must declare a non-empty productName.");
  }

  const infoPlistPath = join(layout.appBundle, "Contents", "Info.plist");
  await assertFile(infoPlistPath, "packaged macOS Info.plist");
  await assertFile(join(layout.resourcesDir, "icon.icns"), "packaged macOS native icon");

  const { stdout } = await execFileAsync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    infoPlistPath,
  ]);
  const info = JSON.parse(stdout);
  const expected = {
    CFBundleName: packageJson.productName,
    CFBundleDisplayName: packageJson.productName,
    CFBundleExecutable: packageJson.productName,
    CFBundleIdentifier: "com.procontext.terminal",
    CFBundleIconFile: "icon.icns",
  };

  for (const [key, expectedValue] of Object.entries(expected)) {
    if (info[key] !== expectedValue) {
      throw new Error(
        `Packaged macOS ${key} must be ${JSON.stringify(expectedValue)}, received ${JSON.stringify(info[key])}.`,
      );
    }
  }

  return expected;
}

async function firstMatchingDirectory(root, predicate) {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isDirectory() && predicate(entry.name)) {
      return join(root, entry.name);
    }
  }
  return null;
}

async function firstMatchingFile(root, predicate) {
  const entries = await directoryEntries(root);
  for (const entry of entries) {
    if (entry.isFile() && predicate(entry.name)) {
      return join(root, entry.name);
    }
  }
  return null;
}

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Could not read directory ${path}. Run the package script first.`, {
      cause: error,
    });
  }
}

async function assertFile(path, label) {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      throw new Error(`${label} is not a file: ${path}`);
    }
  } catch (error) {
    throw new Error(`Missing ${label}: ${path}`, { cause: error });
  }
}

async function assertPackagedAppResources(resourcesDir) {
  const appAsarPath = join(resourcesDir, "app.asar");
  const unpackedAppPath = join(resourcesDir, "app");

  try {
    const appAsarStat = await stat(appAsarPath);
    if (appAsarStat.isFile()) {
      return;
    }
  } catch {
    // Fall through and check the unpacked app resources layout.
  }

  try {
    const unpackedAppStat = await stat(unpackedAppPath);
    if (unpackedAppStat.isDirectory()) {
      return;
    }
  } catch {
    // The explicit error below includes both supported layouts.
  }

  throw new Error(
    `Missing packaged app resources. Expected either ${appAsarPath} or ${unpackedAppPath}.`,
  );
}

async function findFiles(root, predicate) {
  const matches = [];
  await walk(root, matches, predicate);
  return matches;
}

async function walk(root, matches, predicate) {
  await access(root);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path, matches, predicate);
      continue;
    }
    if (entry.isFile() && predicate(path)) {
      matches.push(path);
    }
  }
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}
