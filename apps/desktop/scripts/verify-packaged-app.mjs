import { access, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = join(desktopRoot, "dist");

const layout = await resolvePackagedLayout(distDir, process.platform);
await assertFile(layout.executable, "packaged executable");
await assertFile(join(layout.resourcesDir, "icon.png"), "packaged app icon");
await assertPackagedAppResources(layout.resourcesDir);

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

console.log(
  JSON.stringify(
    {
      platform: process.platform,
      executable: layout.executable,
      resourcesDir: layout.resourcesDir,
      appIcon: join(layout.resourcesDir, "icon.png"),
      nodePtyNativeModules: nativeModules,
    },
    null,
    2,
  ),
);

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
        executable: join(appBundle, "Contents", "MacOS", executableName),
        resourcesDir: join(appBundle, "Contents", "Resources"),
      };
    }
  }

  if (platform === "linux") {
    const unpacked = await firstMatchingDirectory(root, (name) => name.endsWith("-unpacked"));
    if (unpacked) {
      return {
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
          executable,
          resourcesDir: join(unpacked, "resources"),
        };
      }
    }
  }

  throw new Error(`Could not find packaged app layout for ${platform} in ${root}.`);
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
