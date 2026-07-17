import { z } from "zod";

export const agentAccessKeyMetadataSchema = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{12}$/u),
    createdAt: z.string().refine(isIsoTimestamp, "Expected an ISO timestamp."),
  })
  .strict();

export type AgentAccessKeyMetadata = z.infer<typeof agentAccessKeyMetadataSchema>;

export function parseAgentAccessKeyMetadata(value: unknown): AgentAccessKeyMetadata {
  return agentAccessKeyMetadataSchema.parse(value);
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
