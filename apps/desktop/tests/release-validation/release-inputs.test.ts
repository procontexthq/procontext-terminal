import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));
const validator = fileURLToPath(
  new URL("../../scripts/validate-release-inputs.mjs", import.meta.url),
);

describe("release input validation", () => {
  it("rejects manual release dispatches from a branch", () => {
    const result = runValidator("linux", {
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITHUB_REF_TYPE must be tag");
    expect(result.stderr).toContain("expected release tag v0.1.0");
  });

  it("rejects a release whose tag does not match the package version", () => {
    const result = runValidator("linux", { GITHUB_REF_NAME: "v9.9.9" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected release tag v0.1.0");
  });

  it("reports missing macOS signing and notarization inputs without printing values", () => {
    const result = runValidator("macos", {
      CSC_LINK: "secret-certificate",
      CSC_KEY_PASSWORD: "",
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "",
      APPLE_TEAM_ID: "TEAMVALUE",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CSC_KEY_PASSWORD");
    expect(result.stderr).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(result.stderr).not.toContain("secret-certificate");
    expect(result.stderr).not.toContain("release@example.com");
    expect(result.stderr).not.toContain("TEAMVALUE");
  });

  it("accepts complete macOS certificate and Apple ID credentials", () => {
    const result = runValidator("macos", {
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
      APPLE_ID: "release@example.com",
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_TEAM_ID: "TEAMID",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"platform": "macos"');
    expect(result.stdout).not.toContain("certificate");
    expect(result.stdout).not.toContain("release@example.com");
  });

  it("requires Windows code-signing credentials", () => {
    const missing = runValidator("windows");
    const complete = runValidator("windows", {
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("CSC_LINK");
    expect(missing.stderr).toContain("CSC_KEY_PASSWORD");
    expect(complete.status).toBe(0);
  });

  it("requires provenance context but no signing secret for Linux artifacts", () => {
    const complete = runValidator("linux");
    const missingRepository = runValidator("linux", { GITHUB_REPOSITORY: "" });

    expect(complete.status).toBe(0);
    expect(missingRepository.status).toBe(1);
    expect(missingRepository.stderr).toContain("GITHUB_REPOSITORY");
  });
});

function runValidator(platform: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.1.0",
    GITHUB_REPOSITORY: "procontexthq/procontext-terminal",
    GITHUB_SHA: "a".repeat(40),
    CSC_LINK: "",
    CSC_KEY_PASSWORD: "",
    APPLE_ID: "",
    APPLE_APP_SPECIFIC_PASSWORD: "",
    APPLE_TEAM_ID: "",
    ...overrides,
  };
  return spawnSync(
    process.execPath,
    [validator, "--platform", platform, "--package-json", `${desktopRoot}/package.json`],
    { cwd: desktopRoot, env, encoding: "utf8" },
  );
}
