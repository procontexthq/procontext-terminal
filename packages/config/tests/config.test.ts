import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  defaultTerminalConfig,
  loadTerminalConfig,
  parseTerminalConfig,
  resolveTerminalConfigPath,
  saveTerminalConfig,
} from "../src/index";

describe("terminal config", () => {
  it("provides safe Phase 2A defaults", () => {
    expect(defaultTerminalConfig()).toMatchObject({
      schemaVersion: 2,
      terminal: {
        fontFamily:
          '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 5000,
      },
      shell: {
        defaultProfile: null,
        profiles: [],
      },
      ui: {
        theme: "default",
      },
      recording: {
        state: "disabled",
        redactedPatterns: [],
      },
    });
  });

  it("migrates legacy v1 settings without a schema version", () => {
    const parsed = parseTerminalConfig({
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      recording: { redactedPatterns: ["token"] },
    });

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.config).toMatchObject({
      schemaVersion: 2,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh", profiles: [] },
      ui: { theme: "default" },
      recording: { redactedPatterns: ["token"] },
    });
    expect(parsed.config).not.toHaveProperty("workspace");
  });

  it("drops invalid recording redaction patterns without discarding valid settings", () => {
    const parsed = parseTerminalConfig({
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      recording: { redactedPatterns: ["token", "(", ""] },
    });

    expect(parsed.config).toMatchObject({
      schemaVersion: 2,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh", profiles: [] },
      recording: { redactedPatterns: ["token"] },
    });
    expect(parsed.warnings).toEqual([
      "Invalid recording redaction pattern ignored: (",
      "Invalid recording redaction pattern ignored: ",
    ]);
  });

  it("migrates explicit schema version 1 settings to schema version 2", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 1,
      terminal: { fontSize: 15 },
      shell: { defaultProfile: "/bin/bash" },
    });

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.config).toMatchObject({
      schemaVersion: 2,
      terminal: { fontSize: 15 },
      shell: { defaultProfile: "/bin/bash" },
      ui: { theme: "default" },
    });
    expect(parsed.config).not.toHaveProperty("workspace");
  });

  it("ignores legacy workspace state without restoring tab layout", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 2,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      workspace: { tabs: [], activeTabIndex: 0 },
    });

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.config).toMatchObject({
      schemaVersion: 2,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      ui: { theme: "default" },
    });
    expect(parsed.config).not.toHaveProperty("workspace");
  });

  it("falls back to defaults for invalid settings", () => {
    const parsed = parseTerminalConfig({
      terminal: { fontSize: -1, scrollback: 0 },
    });

    expect(parsed.config).toEqual(defaultTerminalConfig());
    expect(parsed.warnings).toHaveLength(1);
  });

  it("rejects unknown future schema versions without downgrading silently", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 99,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
    });

    expect(parsed.config).toEqual(defaultTerminalConfig());
    expect(parsed.warnings[0]).toContain("Unsupported terminal settings schema version");
  });

  it("loads missing settings as defaults and writes settings atomically", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "terminal-config-"));
    try {
      const settingsPath = resolveTerminalConfigPath(tempDir);
      expect(settingsPath).toBe(join(tempDir, "settings.json"));
      await expect(loadTerminalConfig(settingsPath)).resolves.toEqual({
        config: defaultTerminalConfig(),
        warnings: [],
      });

      const config = {
        ...defaultTerminalConfig(),
        ui: { theme: "gamer" as const },
        terminal: {
          ...defaultTerminalConfig().terminal,
          fontSize: 16,
        },
      };
      await saveTerminalConfig(settingsPath, config);
      await expect(loadTerminalConfig(settingsPath)).resolves.toEqual({
        config,
        warnings: [],
      });
      await expect(readFile(settingsPath, "utf8")).resolves.toContain('"schemaVersion": 2');
      await expect(readFile(settingsPath, "utf8")).resolves.not.toContain('"workspace"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
