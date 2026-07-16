import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const releaseWorkflow = read("../../../../.github/workflows/release.yml");
const localBuilderConfig = read("../../electron-builder.yml");
const releaseBuilderConfig = read("../../electron-builder.release.yml");

describe("release workflow contract", () => {
  it("keeps local packaging unsigned while requiring signing for release artifacts", () => {
    expect(localBuilderConfig).toMatch(/identity:\s*null/);
    expect(localBuilderConfig).toMatch(/dmg:\s*\n\s*sign:\s*false/);
    expect(releaseBuilderConfig).not.toMatch(/identity:\s*null/);
    expect(releaseBuilderConfig).toMatch(/notarize:\s*true/);
    expect(releaseBuilderConfig).toMatch(/dmg:\s*\n\s*sign:\s*true/);
    expect(releaseBuilderConfig).toMatch(/electronDist:\s*node_modules\/electron\/dist/);
    expect(releaseBuilderConfig).toMatch(/npmRebuild:\s*false/);
  });

  it("gates release builds on tag, provenance, and platform credential validation", () => {
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(releaseWorkflow).toContain("validate-release-inputs.mjs");
    expect(releaseWorkflow).toContain("GITHUB_REF_TYPE");
    expect(releaseWorkflow).toContain("MACOS_CSC_LINK");
    expect(releaseWorkflow).toContain("WINDOWS_CSC_LINK");
    expect(releaseWorkflow).toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(releaseWorkflow.indexOf("validate-release-inputs.mjs")).toBeLessThan(
      releaseWorkflow.indexOf("pnpm install --frozen-lockfile"),
    );
  });

  it("verifies distributable installers before upload", () => {
    expect(releaseWorkflow).toContain("verify-release-artifacts.mjs");
    expect(releaseWorkflow).toContain("--require-signature");
    expect(releaseWorkflow).not.toContain("--structure-only");
    expect(releaseWorkflow.indexOf("verify-release-artifacts.mjs")).toBeLessThan(
      releaseWorkflow.indexOf("actions/upload-artifact"),
    );
  });

  it("creates and verifies GitHub artifact attestations", () => {
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("attestations: write");
    expect(releaseWorkflow).toContain("actions/attest@v4");
    expect(releaseWorkflow).toContain("gh attestation verify");
    expect(releaseWorkflow.indexOf("actions/attest@v4")).toBeLessThan(
      releaseWorkflow.indexOf("gh attestation verify"),
    );
  });
});

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
