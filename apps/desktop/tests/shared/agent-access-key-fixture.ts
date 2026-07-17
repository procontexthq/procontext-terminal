import { readFile, writeFile } from "node:fs/promises";

import {
  resolveAgentAccessKeyPath,
  type AgentAccessKeyCredential,
} from "../../src/main/agent-access-key-store";

export const TEST_AGENT_ACCESS_KEY = Buffer.alloc(32, 0x4b).toString("base64url");

const TEST_AGENT_ACCESS_KEY_CREATED_AT = "2026-01-01T00:00:00.000Z";

export async function preseedAgentAccessKey(userDataDir: string): Promise<void> {
  const credential: AgentAccessKeyCredential = {
    schemaVersion: 1,
    accessKey: TEST_AGENT_ACCESS_KEY,
    createdAt: TEST_AGENT_ACCESS_KEY_CREATED_AT,
  };

  await writeFile(resolveAgentAccessKeyPath(userDataDir), `${JSON.stringify(credential)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readPersistedAgentAccessKey(userDataDir: string): Promise<string> {
  const value = JSON.parse(
    await readFile(resolveAgentAccessKeyPath(userDataDir), "utf8"),
  ) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("accessKey" in value) ||
    typeof value.accessKey !== "string"
  ) {
    throw new Error("The persisted agent access key fixture is invalid.");
  }
  return value.accessKey;
}
