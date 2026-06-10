import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

try {
  const electronPackageDir = process.argv[2] ?? dirname(require.resolve("electron/package.json"));
  const pathFile = join(electronPackageDir, "path.txt");
  const relativeExecutablePath = await readRequiredTextFile(pathFile);
  const executablePath = join(electronPackageDir, "dist", relativeExecutablePath);

  await assertExecutableFile(executablePath);
  console.log(`Electron install verified: ${executablePath}`);
} catch (error) {
  console.error(formatFailure(error));
  process.exit(1);
}

async function readRequiredTextFile(path) {
  try {
    const value = await readFile(path, "utf8");
    if (value.trim().length === 0) {
      throw new Error("file is empty");
    }
    return value.trim();
  } catch (error) {
    throw new Error(`Electron binary marker is missing or invalid: ${path}`, { cause: error });
  }
}

async function assertExecutableFile(path) {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      throw new Error("path is not a file");
    }
    await access(path);
  } catch (error) {
    throw new Error(`Electron binary is missing or inaccessible: ${path}`, { cause: error });
  }
}

function formatFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    "Electron is not installed correctly for this platform.",
    detail,
    "",
    "Try:",
    "  unset ELECTRON_SKIP_BINARY_DOWNLOAD",
    "  pnpm electron:install",
    "  pnpm electron:verify",
    "",
    "If this keeps failing, verify that you are using Node.js 24 and reinstall dependencies:",
    "  nvm install 24 && nvm use",
    "  rm -rf node_modules apps/desktop/node_modules",
    "  pnpm install",
  ].join("\n");
}
