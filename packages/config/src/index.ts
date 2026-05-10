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
    schemaVersion: 1,
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
    },
  };
}

export function parseTerminalConfig(value: unknown): ConfigParseResult {
  const schemaVersion = readSchemaVersion(value);
  if (schemaVersion !== undefined && schemaVersion !== 1) {
    return {
      config: defaultTerminalConfig(),
      warnings: [`Unsupported terminal settings schema version ${schemaVersion}; using defaults.`],
    };
  }

  const merged = {
    ...defaultTerminalConfig(),
    ...(isObject(value) ? value : {}),
    schemaVersion: 1,
    terminal: {
      ...defaultTerminalConfig().terminal,
      ...(isObject(value) && isObject(value.terminal) ? value.terminal : {}),
    },
    shell: {
      ...defaultTerminalConfig().shell,
      ...(isObject(value) && isObject(value.shell) ? value.shell : {}),
    },
  };
  const parsed = terminalConfigSchema.safeParse(merged);
  if (parsed.success) {
    return { config: parsed.data, warnings: [] };
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

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
