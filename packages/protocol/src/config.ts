import { z } from "zod";

import { terminalPresentationModeSchema, type TerminalPresentationMode } from "./operations.js";

export type RecordingState = "disabled" | "enabled";
export type UiThemePreference = "default" | "coder" | "gamer" | "classic";
export const agentPermissionCategories = [
  "observation",
  "execution",
  "interaction",
  "presentation",
  "recording",
  "termination",
] as const;
export type AgentPermissionCategory = (typeof agentPermissionCategories)[number];
export type AgentPermissionMode = "allow" | "ask" | "deny";
export type AgentPolicyConfig = Record<AgentPermissionCategory, AgentPermissionMode>;

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
};

export type TerminalShellProfile = {
  id: string;
  name: string;
  shell: string;
  cwd: string | null;
  env: Record<string, string>;
};

export type RecordingConfig = {
  state: RecordingState;
  redactedPatterns: string[];
};

export type TerminalAccessibilityConfig = {
  screenReaderMode: boolean;
  reducedMotion: boolean;
  minimumContrastRatio: number;
};

export type WindowGeometry = {
  x: number;
  y: number;
  width: number;
  height: number;
  displayId: number;
};

export type FocusedTerminalSettings = {
  terminal: TerminalConfig["terminal"];
  shell: TerminalConfig["shell"];
  accessibility: TerminalAccessibilityConfig;
  recording: RecordingConfig;
  defaultPresentation: TerminalPresentationMode;
};

export type TerminalConfig = {
  schemaVersion: 4;
  terminal: {
    fontFamily: string;
    fontSize: number;
    scrollback: number;
    theme: TerminalTheme;
  };
  shell: {
    defaultProfile: string | null;
    profiles: TerminalShellProfile[];
  };
  ui: {
    theme: UiThemePreference;
  };
  recording: RecordingConfig;
  accessibility: TerminalAccessibilityConfig;
  defaultPresentation: TerminalPresentationMode;
  windowGeometry: WindowGeometry | null;
  agentPolicy: AgentPolicyConfig;
};

export const terminalColorSchema = z
  .string()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu, "Expected a hexadecimal RGB color.");

export const terminalThemeSchema = z.object({
  background: terminalColorSchema,
  foreground: terminalColorSchema,
  cursor: terminalColorSchema,
});

export const uiThemePreferenceSchema = z.enum(["default", "coder", "gamer", "classic"]);

export const terminalShellProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shell: z.string().min(1),
  cwd: z.string().min(1).nullable(),
  env: z.record(z.string(), z.string()),
});

export const recordingConfigSchema = z.object({
  state: z.enum(["disabled", "enabled"]),
  redactedPatterns: z.array(z.string()),
});
export const terminalAccessibilityConfigSchema = z.object({
  screenReaderMode: z.boolean(),
  reducedMotion: z.boolean(),
  minimumContrastRatio: z.number().min(1).max(21),
});
export const windowGeometrySchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
    width: z.number().int().min(640).max(16_384),
    height: z.number().int().min(420).max(16_384),
    displayId: z.number().int(),
  })
  .strict();
export const agentPermissionModeSchema = z.enum(["allow", "ask", "deny"]);
export const agentPolicyConfigSchema = z.object({
  observation: agentPermissionModeSchema,
  execution: agentPermissionModeSchema,
  interaction: agentPermissionModeSchema,
  presentation: agentPermissionModeSchema,
  recording: agentPermissionModeSchema,
  termination: agentPermissionModeSchema,
});

export const terminalSettingsSchema = z.object({
  fontFamily: z.string().min(1),
  fontSize: z.number().int().min(8).max(40),
  scrollback: z.number().int().min(100).max(100_000),
  theme: terminalThemeSchema,
});

export const terminalShellConfigSchema = z.object({
  defaultProfile: z.string().min(1).nullable(),
  profiles: z.array(terminalShellProfileSchema),
});

export const focusedTerminalSettingsSchema = z
  .object({
    terminal: terminalSettingsSchema,
    shell: terminalShellConfigSchema,
    accessibility: terminalAccessibilityConfigSchema,
    recording: recordingConfigSchema,
    defaultPresentation: terminalPresentationModeSchema,
  })
  .strict();

export const terminalConfigSchema = z.object({
  schemaVersion: z.literal(4),
  terminal: terminalSettingsSchema,
  shell: terminalShellConfigSchema,
  ui: z.object({ theme: uiThemePreferenceSchema }),
  recording: recordingConfigSchema,
  accessibility: terminalAccessibilityConfigSchema,
  defaultPresentation: terminalPresentationModeSchema,
  windowGeometry: windowGeometrySchema.nullable(),
  agentPolicy: agentPolicyConfigSchema,
});

export type SaveUiThemeRequest = { theme: UiThemePreference };
export type SaveAgentPolicyRequest = { policy: AgentPolicyConfig };
export type SaveFocusedSettingsRequest = { settings: FocusedTerminalSettings };
export const saveUiThemeRequestSchema = z.object({ theme: uiThemePreferenceSchema });
export const saveAgentPolicyRequestSchema = z.object({ policy: agentPolicyConfigSchema });
export const saveFocusedSettingsRequestSchema = z
  .object({ settings: focusedTerminalSettingsSchema })
  .strict();

export function parseTerminalConfig(value: unknown): TerminalConfig {
  return terminalConfigSchema.parse(value);
}

export function parseSaveUiThemeRequest(value: unknown): SaveUiThemeRequest {
  return saveUiThemeRequestSchema.parse(value);
}

export function parseSaveAgentPolicyRequest(value: unknown): SaveAgentPolicyRequest {
  return saveAgentPolicyRequestSchema.parse(value);
}

export function parseSaveFocusedSettingsRequest(value: unknown): SaveFocusedSettingsRequest {
  return saveFocusedSettingsRequestSchema.parse(value);
}
