import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  terminalConfigSchema,
  windowGeometrySchema,
  type TerminalConfig,
  type TerminalTheme,
  type WindowGeometry,
} from "@terminal/protocol";

export type { TerminalConfig, TerminalTheme };

export type ConfigParseResult = {
  config: TerminalConfig;
  warnings: string[];
};

export function defaultTerminalConfig(): TerminalConfig {
  return {
    schemaVersion: 4,
    terminal: {
      fontFamily:
        '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
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
  };
}

export function parseTerminalConfig(value: unknown): ConfigParseResult {
  const schemaVersion = readSchemaVersion(value);
  if (
    schemaVersion !== undefined &&
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3 &&
    schemaVersion !== 4
  ) {
    return {
      config: defaultTerminalConfig(),
      warnings: [`Unsupported terminal settings schema version ${schemaVersion}; using defaults.`],
    };
  }

  const defaults = defaultTerminalConfig();
  const raw = isObject(value) ? value : {};
  const recording = parseRecordingConfig(raw.recording, defaults.recording);
  const windowGeometry = parseWindowGeometry(raw.windowGeometry);
  const merged = {
    ...defaults,
    ...raw,
    schemaVersion: 4,
    terminal: {
      ...defaults.terminal,
      ...(isObject(raw.terminal) ? raw.terminal : {}),
    },
    shell: {
      ...defaults.shell,
      ...(isObject(raw.shell) ? raw.shell : {}),
    },
    ui: {
      ...defaults.ui,
      ...(isObject(raw.ui) ? raw.ui : {}),
    },
    recording: recording.config,
    windowGeometry: windowGeometry.geometry,
    accessibility: {
      ...defaults.accessibility,
      ...(isObject(raw.accessibility) ? raw.accessibility : {}),
    },
    agentPolicy: {
      ...defaults.agentPolicy,
      ...(isObject(raw.agentPolicy) ? raw.agentPolicy : {}),
    },
  };
  const parsed = terminalConfigSchema.safeParse(merged);
  if (parsed.success) {
    return {
      config: parsed.data,
      warnings: [...recording.warnings, ...windowGeometry.warnings],
    };
  }

  return {
    config: defaultTerminalConfig(),
    warnings: ["Invalid terminal settings; using defaults."],
  };
}

function parseWindowGeometry(value: unknown): {
  geometry: WindowGeometry | null;
  warnings: string[];
} {
  if (value === undefined || value === null) return { geometry: null, warnings: [] };
  const parsed = windowGeometrySchema.safeParse(value);
  if (parsed.success) return { geometry: parsed.data, warnings: [] };
  return {
    geometry: null,
    warnings: ["Invalid window geometry ignored; using safe window defaults."],
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

  let invalidPatternCount = 0;
  const redactedPatterns = merged.redactedPatterns.filter((pattern): pattern is string => {
    if (typeof pattern !== "string" || pattern.length === 0 || !isValidRegexPattern(pattern)) {
      invalidPatternCount += 1;
      return false;
    }
    return true;
  });

  return {
    config: { ...merged, redactedPatterns },
    warnings:
      invalidPatternCount === 0
        ? []
        : [
            `${invalidPatternCount} invalid recording redaction pattern${invalidPatternCount === 1 ? "" : "s"} ignored.`,
          ],
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
