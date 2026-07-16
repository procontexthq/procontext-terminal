import { copyFile, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validatePlatformArtifacts } from "./release-artifact-platform-validation.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.structureOnly === args.requireSignature) {
  throw new Error("Choose exactly one of --structure-only or --require-signature.");
}
const platform = normalizePlatform(args.platform);
const dist = resolve(args.dist ?? fileURLToPath(new URL("../dist", import.meta.url)));
const packageJsonPath = resolve(
  args.packageJson ?? fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const version = requireString(packageJson.version, "package version");
const entries = await readdir(dist, { withFileTypes: true });
const files = entries.filter((entry) => entry.isFile()).map((entry) => join(dist, entry.name));
const artifacts = selectArtifacts(platform, files, version);

await validateArtifactHeaders(platform, artifacts);
if (args.requireSignature) await validatePlatformArtifacts(platform, artifacts);
if (args.copyTo) await copyArtifacts(Object.values(artifacts), resolve(args.copyTo));

console.log(
  JSON.stringify(
    {
      platform,
      version,
      verification: args.requireSignature ? "native-release-artifact" : "structure-only",
      artifacts,
      copiedTo: args.copyTo ? resolve(args.copyTo) : null,
    },
    null,
    2,
  ),
);

function selectArtifacts(platform, files, version) {
  const requirements =
    platform === "macos"
      ? { dmg: ".dmg" }
      : platform === "windows"
        ? { exe: ".exe" }
        : { appImage: ".AppImage", deb: ".deb" };
  const artifacts = {};
  for (const [key, extension] of Object.entries(requirements)) {
    const matches = files.filter((path) => path.endsWith(extension));
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one ${extension} release artifact for ${platform}, found ${matches.length}.`,
      );
    }
    const path = matches[0];
    if (!basename(path).includes(version)) {
      throw new Error(
        `Release artifact ${basename(path)} does not include package version ${version}.`,
      );
    }
    artifacts[key] = path;
  }
  return artifacts;
}

async function validateArtifactHeaders(platform, artifacts) {
  if (platform === "windows") {
    await expectStart(artifacts.exe, Buffer.from("MZ", "ascii"), "PE/COFF MZ header");
    return;
  }
  if (platform === "linux") {
    await expectStart(artifacts.appImage, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "ELF header");
    await expectStart(artifacts.deb, Buffer.from("!<arch>\n", "ascii"), "Debian ar header");
    return;
  }
  const handle = await open(artifacts.dmg, "r");
  try {
    const { size } = await handle.stat();
    if (size < 512) throw new Error(`DMG artifact is too small: ${artifacts.dmg}.`);
    const trailer = Buffer.alloc(512);
    await handle.read(trailer, 0, trailer.length, size - trailer.length);
    if (!trailer.subarray(0, 4).equals(Buffer.from("koly", "ascii"))) {
      throw new Error(`DMG artifact is missing its UDIF koly trailer: ${artifacts.dmg}.`);
    }
  } finally {
    await handle.close();
  }
}

async function expectStart(path, expected, label) {
  const handle = await open(path, "r");
  try {
    const actual = Buffer.alloc(expected.length);
    const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
    if (bytesRead !== expected.length || !actual.equals(expected)) {
      throw new Error(`Release artifact is missing its ${label}: ${path}.`);
    }
  } finally {
    await handle.close();
  }
}

async function copyArtifacts(paths, destination) {
  await mkdir(destination, { recursive: true });
  const destinationInfo = await stat(destination);
  if (!destinationInfo.isDirectory()) {
    throw new Error(`Release artifact destination is not a directory: ${destination}.`);
  }
  for (const path of paths) {
    await copyFile(path, join(destination, basename(path)));
  }
}

function normalizePlatform(value) {
  const normalized = value?.toLowerCase();
  if (normalized === "macos" || normalized === "darwin") return "macos";
  if (normalized === "windows" || normalized === "win32") return "windows";
  if (normalized === "linux") return "linux";
  throw new Error(`Unsupported release platform ${JSON.stringify(value)}.`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected a non-empty ${label}.`);
  }
  return value;
}

function parseArgs(values) {
  const parsed = { structureOnly: false, requireSignature: false };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--platform") parsed.platform = values[++index];
    else if (argument === "--dist") parsed.dist = values[++index];
    else if (argument === "--package-json") parsed.packageJson = values[++index];
    else if (argument === "--copy-to") parsed.copyTo = values[++index];
    else if (argument === "--structure-only") parsed.structureOnly = true;
    else if (argument === "--require-signature") parsed.requireSignature = true;
    else throw new Error(`Unknown argument ${argument}.`);
  }
  return parsed;
}
