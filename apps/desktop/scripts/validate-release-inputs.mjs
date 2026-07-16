import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const platform = normalizePlatform(args.platform);
const packageJsonPath = resolve(
  args.packageJson ?? fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const version = requireString(packageJson.version, "package version");
const expectedTag = `v${version}`;
const errors = [];

if (process.env.GITHUB_REF_TYPE !== "tag") {
  errors.push("GITHUB_REF_TYPE must be tag; dispatch releases from the version tag");
}
if (process.env.GITHUB_REF_NAME !== expectedTag) {
  errors.push(`expected release tag ${expectedTag} for package version ${version}`);
}
requireEnvironment(errors, "GITHUB_REPOSITORY");
if (!/^[0-9a-f]{40}$/i.test(process.env.GITHUB_SHA ?? "")) {
  errors.push("GITHUB_SHA must be a full 40-character commit hash for provenance");
}

if (platform === "macos" || platform === "windows") {
  requireEnvironment(errors, "CSC_LINK");
  requireEnvironment(errors, "CSC_KEY_PASSWORD");
}
if (platform === "macos") {
  for (const name of ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
    requireEnvironment(errors, name);
  }
}

if (errors.length > 0) {
  console.error(
    [
      `Release input validation failed for ${platform}:`,
      ...errors.map((error) => `- ${error}`),
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      {
        platform,
        packageVersion: version,
        tag: expectedTag,
        signing: platform === "linux" ? "not-applicable" : "required",
        notarization: platform === "macos" ? "required" : "not-applicable",
        provenance: "required",
      },
      null,
      2,
    ),
  );
}

function requireEnvironment(errors, name) {
  if (!hasEnvironment(name)) errors.push(`missing ${name}`);
}

function hasEnvironment(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
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
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--platform") parsed.platform = values[++index];
    else if (argument === "--package-json") parsed.packageJson = values[++index];
    else throw new Error(`Unknown argument ${argument}.`);
  }
  return parsed;
}
