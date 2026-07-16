import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const validator = readFileSync(
  fileURLToPath(new URL("../../scripts/release-artifact-platform-validation.mjs", import.meta.url)),
  "utf8",
);

describe("native release artifact validation contract", () => {
  it("verifies and launches the mounted macOS application", () => {
    expect(validator).toContain('run("hdiutil", ["verify"');
    expect(validator).toContain('run("codesign", ["--verify"');
    expect(validator).toContain('run("xcrun", ["stapler", "validate"');
    expect(validator).toContain('run("spctl", ["--assess"');
    expect(validator).toContain('join(app, "Contents", "MacOS")');
    expect(validator).toContain("smokeReleaseExecutable(executable)");
  });

  it("verifies, installs, launches, and uninstalls the Windows application", () => {
    expect(validator).toContain("Get-AuthenticodeSignature");
    expect(validator).toContain('verifyWindowsAuthenticode(installer, "NSIS installer")');
    expect(validator).toContain('await run(installer, ["/S"');
    expect(validator).toContain(
      'verifyWindowsAuthenticode(applicationExecutable, "installed application")',
    );
    expect(validator).toContain("smokeReleaseExecutable(applicationExecutable)");
    expect(validator).toContain('await run(uninstaller, ["/S"]);');
    expect(validator).toContain("PCT_RELEASE_ARTIFACT_LABEL: artifactLabel");
    expect(validator).not.toContain("SignerCertificate.Thumbprint");
  });

  it("extracts, inspects, and launches both Linux artifact formats", () => {
    expect(validator).toContain('await run(appImage, ["--appimage-extract"]');
    expect(validator).toContain('await run("dpkg-deb", ["--info"');
    expect(validator).toContain("smokeReleaseExecutable(appRun)");
    expect(validator).toContain("smokeReleaseExecutable(debExecutable)");
  });
});
