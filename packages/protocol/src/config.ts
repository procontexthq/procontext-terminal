import { z } from "zod";

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

export type TerminalConfig = {
  schemaVersion: 3;
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
  agentPolicy: AgentPolicyConfig;
};

export const terminalThemeSchema = z.object({
  background: z.string().min(1),
  foreground: z.string().min(1),
  cursor: z.string().min(1),
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
export const agentPermissionModeSchema = z.enum(["allow", "ask", "deny"]);
export const agentPolicyConfigSchema = z.object({
  observation: agentPermissionModeSchema,
  execution: agentPermissionModeSchema,
  interaction: agentPermissionModeSchema,
  presentation: agentPermissionModeSchema,
  recording: agentPermissionModeSchema,
  termination: agentPermissionModeSchema,
});

export const terminalConfigSchema = z.object({
  schemaVersion: z.literal(3),
  terminal: z.object({
    fontFamily: z.string().min(1),
    fontSize: z.number().int().min(8).max(40),
    scrollback: z.number().int().min(100).max(100_000),
    theme: terminalThemeSchema,
  }),
  shell: z.object({
    defaultProfile: z.string().min(1).nullable(),
    profiles: z.array(terminalShellProfileSchema),
  }),
  ui: z.object({ theme: uiThemePreferenceSchema }),
  recording: recordingConfigSchema,
  agentPolicy: agentPolicyConfigSchema,
});

export type SaveUiThemeRequest = { theme: UiThemePreference };
export type SaveAgentPolicyRequest = { policy: AgentPolicyConfig };
export const saveUiThemeRequestSchema = z.object({ theme: uiThemePreferenceSchema });
export const saveAgentPolicyRequestSchema = z.object({ policy: agentPolicyConfigSchema });

export function parseTerminalConfig(value: unknown): TerminalConfig {
  return terminalConfigSchema.parse(value);
}

export function parseSaveUiThemeRequest(value: unknown): SaveUiThemeRequest {
  return saveUiThemeRequestSchema.parse(value);
}

export function parseSaveAgentPolicyRequest(value: unknown): SaveAgentPolicyRequest {
  return saveAgentPolicyRequestSchema.parse(value);
}
