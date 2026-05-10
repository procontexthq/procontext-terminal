export type AppLogger = {
  info(component: string, event: string, context?: Record<string, unknown>): void;
  error(component: string, event: string, context?: Record<string, unknown>): void;
};

export function createAppLogger(): AppLogger {
  return {
    info(component, event, context = {}) {
      console.error(JSON.stringify(logRecord("info", component, event, context)));
    },
    error(component, event, context = {}) {
      console.error(JSON.stringify(logRecord("error", component, event, context)));
    },
  };
}

function logRecord(
  level: "info" | "error",
  component: string,
  event: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    ...context,
  };
}
