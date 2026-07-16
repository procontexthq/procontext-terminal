import { z } from "zod";

const terminalLinkValueSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !containsControlCharacter(value), {
    message: "Terminal link targets cannot contain control characters.",
  });

const terminalUrlTargetSchema = terminalLinkValueSchema.superRefine((target, context) => {
  try {
    const url = new URL(target);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      context.addIssue({ code: "custom", message: "Unsupported terminal URL." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "Invalid terminal URL." });
  }
});

export const terminalLinkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), target: terminalUrlTargetSchema }).strict(),
  z.object({ kind: z.literal("path"), target: terminalLinkValueSchema }).strict(),
]);

export type TerminalLinkTarget = z.infer<typeof terminalLinkTargetSchema>;
export type TerminalLinkOpenResult = { status: "opened" };

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}
