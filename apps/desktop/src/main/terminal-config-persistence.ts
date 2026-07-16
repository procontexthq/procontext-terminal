import type {
  AgentPolicyConfig,
  FocusedTerminalSettings,
  TerminalConfig,
  UiThemePreference,
  WindowGeometry,
} from "@terminal/protocol";

export type TerminalConfigMutation =
  | { type: "ui-theme"; theme: UiThemePreference }
  | { type: "focused-settings"; settings: FocusedTerminalSettings }
  | { type: "agent-policy"; policy: AgentPolicyConfig }
  | { type: "window-geometry"; geometry: WindowGeometry };

export type QueuedTerminalConfigPersistence = {
  save(mutation: TerminalConfigMutation): Promise<TerminalConfig>;
  pending(): Promise<void>;
};

const terminalThemePresets: Record<
  UiThemePreference,
  Pick<TerminalConfig["terminal"], "fontFamily"> & { background: string }
> = {
  default: {
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    background: "#101214",
  },
  coder: {
    fontFamily:
      '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    background: "#091019",
  },
  gamer: {
    fontFamily:
      '"Share Tech Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    background: "#07100d",
  },
  classic: {
    fontFamily:
      '"IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    background: "#15130f",
  },
};

export function applyTerminalConfigMutation(
  current: TerminalConfig,
  mutation: TerminalConfigMutation,
): TerminalConfig {
  switch (mutation.type) {
    case "ui-theme": {
      const preset = terminalThemePresets[mutation.theme];
      return {
        ...current,
        ui: { ...current.ui, theme: mutation.theme },
        terminal: {
          ...current.terminal,
          fontFamily: preset.fontFamily,
          theme: { ...current.terminal.theme, background: preset.background },
        },
      };
    }
    case "focused-settings":
      return { ...current, ...mutation.settings };
    case "agent-policy":
      return { ...current, agentPolicy: mutation.policy };
    case "window-geometry":
      return { ...current, windowGeometry: mutation.geometry };
  }
}

export function createQueuedTerminalConfigPersistence({
  getConfig,
  setConfig,
  persist,
  onPersisted,
}: {
  getConfig: () => TerminalConfig;
  setConfig: (config: TerminalConfig) => void;
  persist: (config: TerminalConfig) => Promise<void>;
  onPersisted?: (config: TerminalConfig, mutation: TerminalConfigMutation) => void | Promise<void>;
}): QueuedTerminalConfigPersistence {
  let queue: Promise<void> = Promise.resolve();

  return {
    save(mutation) {
      const operation = queue.then(async () => {
        const nextConfig = applyTerminalConfigMutation(getConfig(), mutation);
        await persist(nextConfig);
        setConfig(nextConfig);
        await onPersisted?.(nextConfig, mutation);
        return nextConfig;
      });
      queue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
    pending: () => queue,
  };
}
