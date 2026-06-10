import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { terminalConfigSchema, type TerminalConfig, type TerminalTheme } from "@terminal/protocol";

export type { TerminalConfig, TerminalTheme };

export type ConfigParseResult = {
  config: TerminalConfig;
  warnings: string[];
};

export function defaultTerminalConfig(): TerminalConfig {
  return {
    schemaVersion: 2,
    terminal: {
      fontFamily: "Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: {
        background: "#101214",
        foreground: "#e8eaed",
        cursor: "#f8f8f2",
      },
    },
    shell: {
      defaultProfile: null,
      profiles: [],
    },
    recording: {
      state: "disabled",
      redactedPatterns: [],
    },
  };
}

export function parseTerminalConfig(value: unknown): ConfigParseResult {
  const schemaVersion = readSchemaVersion(value);
  if (schemaVersion !== undefined && schemaVersion !== 1 && schemaVersion !== 2) {
    return {
      config: defaultTerminalConfig(),
      warnings: [`Unsupported terminal settings schema version ${schemaVersion}; using defaults.`],
    };
  }

  const defaults = defaultTerminalConfig();
  const raw = isObject(value) ? value : {};
  const recording = parseRecordingConfig(raw.recording, defaults.recording);
  const merged = {
    ...defaults,
    ...raw,
    schemaVersion: 2,
    terminal: {
      ...defaults.terminal,
      ...(isObject(raw.terminal) ? raw.terminal : {}),
    },
    shell: {
      ...defaults.shell,
      ...(isObject(raw.shell) ? raw.shell : {}),
    },
    recording: recording.config,
  };
  const parsed = terminalConfigSchema.safeParse(merged);
  if (parsed.success) {
    return { config: parsed.data, warnings: recording.warnings };
  }

  return {
    config: defaultTerminalConfig(),
    warnings: ["Invalid terminal settings; using defaults."],
  };
}

export function resolveTerminalConfigPath(userDataPath: string): string {
  return join(userDataPath, "settings.json");
}

export async function loadTerminalConfig(settingsPath: string): Promise<ConfigParseResult> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { config: defaultTerminalConfig(), warnings: [] };
    }

    return {
      config: defaultTerminalConfig(),
      warnings: ["Could not read terminal settings; using defaults."],
    };
  }

  try {
    return parseTerminalConfig(JSON.parse(raw) as unknown);
  } catch {
    return {
      config: defaultTerminalConfig(),
      warnings: ["Could not parse terminal settings; using defaults."],
    };
  }
}

export async function saveTerminalConfig(
  settingsPath: string,
  config: TerminalConfig,
): Promise<void> {
  const parsed = terminalConfigSchema.parse(config);
  await mkdir(dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(temporaryPath, settingsPath);
}

function readSchemaVersion(value: unknown): number | undefined {
  if (!isObject(value) || !("schemaVersion" in value)) {
    return undefined;
  }

  return typeof value.schemaVersion === "number" ? value.schemaVersion : Number.NaN;
}

function parseRecordingConfig(
  value: unknown,
  defaults: TerminalConfig["recording"],
): {
  config: TerminalConfig["recording"];
  warnings: string[];
} {
  const raw = isObject(value) ? value : {};
  const merged = { ...defaults, ...raw };
  if (!Array.isArray(merged.redactedPatterns)) {
    return { config: merged, warnings: [] };
  }

  const warnings: string[] = [];
  const redactedPatterns = merged.redactedPatterns.filter((pattern): pattern is string => {
    if (typeof pattern !== "string" || !isValidRegexPattern(pattern)) {
      warnings.push(`Invalid recording redaction pattern ignored: ${String(pattern)}`);
      return false;
    }
    return true;
  });

  return {
    config: { ...merged, redactedPatterns },
    warnings,
  };
}

function isValidRegexPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, "gu");
    return true;
  } catch {
    return false;
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
