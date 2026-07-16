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
  it("provides backward-compatible permission defaults", () => {
    expect(defaultTerminalConfig()).toMatchObject({
      schemaVersion: 4,
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
      accessibility: {
        screenReaderMode: false,
        reducedMotion: false,
        minimumContrastRatio: 4.5,
      },
      defaultPresentation: "foreground",
      windowGeometry: null,
      agentPolicy: {
        observation: "allow",
        execution: "allow",
        interaction: "allow",
        presentation: "allow",
        recording: "allow",
        termination: "allow",
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
      schemaVersion: 4,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh", profiles: [] },
      ui: { theme: "default" },
      recording: { redactedPatterns: ["token"] },
      accessibility: { minimumContrastRatio: 4.5 },
      defaultPresentation: "foreground",
      windowGeometry: null,
      agentPolicy: { termination: "allow" },
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
      schemaVersion: 4,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh", profiles: [] },
      recording: { redactedPatterns: ["token"] },
    });
    expect(parsed.warnings).toEqual(["2 invalid recording redaction patterns ignored."]);
    expect(parsed.warnings.join(" ")).not.toContain("(");
  });

  it("migrates explicit schema version 1 settings to schema version 4", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 1,
      terminal: { fontSize: 15 },
      shell: { defaultProfile: "/bin/bash" },
    });

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.config).toMatchObject({
      schemaVersion: 4,
      terminal: { fontSize: 15 },
      shell: { defaultProfile: "/bin/bash" },
      ui: { theme: "default" },
    });
    expect(parsed.config).not.toHaveProperty("workspace");
  });

  it("ignores legacy workspace state without restoring tab layout", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 3,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      workspace: { tabs: [], activeTabIndex: 0 },
    });

    expect(parsed.warnings).toHaveLength(0);
    expect(parsed.config).toMatchObject({
      schemaVersion: 4,
      terminal: { fontSize: 14 },
      shell: { defaultProfile: "/bin/zsh" },
      ui: { theme: "default" },
    });
    expect(parsed.config).not.toHaveProperty("workspace");
  });

  it("migrates schema version 3 settings with safe focused-setting defaults", () => {
    const parsed = parseTerminalConfig({
      schemaVersion: 3,
      terminal: { fontSize: 15 },
      shell: { defaultProfile: null, profiles: [] },
      recording: { state: "enabled", redactedPatterns: ["secret"] },
      ui: { theme: "coder" },
      agentPolicy: defaultTerminalConfig().agentPolicy,
      tabs: [{ sessionId: "must-not-survive" }],
      sessions: [{ id: "must-not-survive" }],
    });

    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toMatchObject({
      schemaVersion: 4,
      terminal: { fontSize: 15 },
      accessibility: {
        screenReaderMode: false,
        reducedMotion: false,
        minimumContrastRatio: 4.5,
      },
      defaultPresentation: "foreground",
      windowGeometry: null,
    });
    expect(parsed.config).not.toHaveProperty("tabs");
    expect(parsed.config).not.toHaveProperty("sessions");
  });

  it("retains validated window geometry and isolates invalid geometry from valid settings", () => {
    const valid = parseTerminalConfig({
      ...defaultTerminalConfig(),
      windowGeometry: {
        x: -1200,
        y: 40,
        width: 1280,
        height: 800,
        displayId: 7,
      },
    });
    expect(valid.warnings).toEqual([]);
    expect(valid.config.windowGeometry).toEqual({
      x: -1200,
      y: 40,
      width: 1280,
      height: 800,
      displayId: 7,
    });

    const invalid = parseTerminalConfig({
      ...defaultTerminalConfig(),
      terminal: { ...defaultTerminalConfig().terminal, fontSize: 17 },
      ui: { theme: "coder" },
      windowGeometry: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        displayId: 1,
        tabs: ["forbidden"],
      },
    });
    expect(invalid.config).toMatchObject({
      terminal: { fontSize: 17 },
      ui: { theme: "coder" },
      windowGeometry: null,
    });
    expect(invalid.warnings).toEqual([
      "Invalid window geometry ignored; using safe window defaults.",
    ]);
  });

  it("falls back to defaults for invalid settings", () => {
    const parsed = parseTerminalConfig({
      terminal: { fontSize: -1, scrollback: 0 },
    });

    expect(parsed.config).toEqual(defaultTerminalConfig());
    expect(parsed.warnings).toHaveLength(1);
  });

  it("rejects terminal colors that cannot be shared by xterm, CSS, and Electron", () => {
    const parsed = parseTerminalConfig({
      ...defaultTerminalConfig(),
      terminal: {
        ...defaultTerminalConfig().terminal,
        theme: {
          ...defaultTerminalConfig().terminal.theme,
          background: "not-a-portable-color",
        },
      },
    });

    expect(parsed.config).toEqual(defaultTerminalConfig());
    expect(parsed.warnings).toEqual(["Invalid terminal settings; using defaults."]);
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
      await expect(readFile(settingsPath, "utf8")).resolves.toContain('"schemaVersion": 4');
      await expect(readFile(settingsPath, "utf8")).resolves.not.toContain('"workspace"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
