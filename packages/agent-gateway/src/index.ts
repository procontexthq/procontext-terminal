import { join } from "node:path";

export { startAgentGateway } from "./gateway.js";
export type { AgentGateway, AgentGatewayOptions, AgentTerminalService } from "./types.js";

export function resolveAgentGatewayDescriptorPath(userDataPath: string): string {
  return join(userDataPath, "agent-gateway.json");
}
