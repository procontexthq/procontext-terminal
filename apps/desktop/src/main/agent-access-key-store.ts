import { createHash, randomBytes as createRandomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentAccessKeyMetadata } from "@terminal/protocol";

export type AgentAccessKeyCredential = {
  schemaVersion: 1;
  accessKey: string;
  createdAt: string;
};

export type AgentAccessKeyStore = {
  getAccessKey(): string;
  getMetadata(): AgentAccessKeyMetadata;
  copy(): void;
  regenerate(): Promise<AgentAccessKeyMetadata>;
};

type CredentialWarning = {
  type: "invalid_credential_replaced";
  credentialPath: string;
};

type CredentialLoadResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "loaded"; credential: AgentAccessKeyCredential };

const credentialFileName = "agent-access-key.json";
const accessKeyByteLength = 32;

export function resolveAgentAccessKeyPath(userDataPath: string): string {
  return join(userDataPath, credentialFileName);
}

export async function createAgentAccessKeyStore({
  credentialPath,
  now = () => new Date(),
  randomBytes = createRandomBytes,
  activateAccessKey,
  writeClipboard,
  onWarning,
  persistCredential = writeCredential,
  restrictCredentialPermissions = restrictPermissions,
}: {
  credentialPath: string;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  activateAccessKey: (accessKey: string) => void;
  writeClipboard: (accessKey: string) => void;
  onWarning?: (warning: CredentialWarning) => void;
  persistCredential?: (
    credentialPath: string,
    credential: AgentAccessKeyCredential,
  ) => Promise<void>;
  restrictCredentialPermissions?: (credentialPath: string) => Promise<void>;
}): Promise<AgentAccessKeyStore> {
  const loaded = await loadCredential(credentialPath);
  let credential: AgentAccessKeyCredential;

  if (loaded.status === "loaded") {
    credential = loaded.credential;
    await restrictCredentialPermissions(credentialPath);
  } else {
    credential = createCredential(now, randomBytes);
    await persistCredential(credentialPath, credential);
    if (loaded.status === "invalid") {
      onWarning?.({ type: "invalid_credential_replaced", credentialPath });
    }
  }

  let regenerationQueue: Promise<void> = Promise.resolve();

  return {
    getAccessKey: () => credential.accessKey,
    getMetadata: () => metadataFor(credential),
    copy() {
      writeClipboard(credential.accessKey);
    },
    regenerate() {
      const operation = regenerationQueue.then(async () => {
        const replacement = createCredential(now, randomBytes);
        await persistCredential(credentialPath, replacement);
        activateAccessKey(replacement.accessKey);
        credential = replacement;
        return metadataFor(replacement);
      });
      regenerationQueue = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

async function loadCredential(credentialPath: string): Promise<CredentialLoadResult> {
  let contents: string;
  try {
    contents = await readFile(credentialPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw error;
  }

  try {
    const credential = parseCredential(JSON.parse(contents) as unknown);
    return credential ? { status: "loaded", credential } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
  }
}

function createCredential(
  now: () => Date,
  randomBytes: (size: number) => Uint8Array,
): AgentAccessKeyCredential {
  const bytes = Buffer.from(randomBytes(accessKeyByteLength));
  if (bytes.byteLength !== accessKeyByteLength) {
    throw new Error("Agent access key generation returned an invalid byte length.");
  }
  return {
    schemaVersion: 1,
    accessKey: bytes.toString("base64url"),
    createdAt: now().toISOString(),
  };
}

function parseCredential(value: unknown): AgentAccessKeyCredential | null {
  if (!isObject(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (typeof value.accessKey !== "string" || !isValidAccessKey(value.accessKey)) return null;
  if (typeof value.createdAt !== "string" || !isIsoTimestamp(value.createdAt)) return null;
  return {
    schemaVersion: 1,
    accessKey: value.accessKey,
    createdAt: value.createdAt,
  };
}

function isValidAccessKey(value: string): boolean {
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === accessKeyByteLength && decoded.toString("base64url") === value;
}

function metadataFor(credential: AgentAccessKeyCredential): AgentAccessKeyMetadata {
  return {
    fingerprint: createHash("sha256").update(credential.accessKey).digest("hex").slice(0, 12),
    createdAt: credential.createdAt,
  };
}

async function writeCredential(
  credentialPath: string,
  credential: AgentAccessKeyCredential,
): Promise<void> {
  await mkdir(dirname(credentialPath), { recursive: true });
  const temporaryPath = `${credentialPath}.${process.pid}.${createRandomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(credential)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, credentialPath);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function restrictPermissions(credentialPath: string): Promise<void> {
  return chmod(credentialPath, 0o600);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
