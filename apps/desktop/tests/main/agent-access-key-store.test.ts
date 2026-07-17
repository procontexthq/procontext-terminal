import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAgentAccessKeyStore,
  resolveAgentAccessKeyPath,
  type AgentAccessKeyCredential,
} from "../../src/main/agent-access-key-store";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("agent access key store", () => {
  it("generates and persists one 256-bit key on first use, then reuses it", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    const createdAt = "2026-07-16T08:00:00.000Z";
    const generatedBytes = Buffer.alloc(32, 0x11);
    const generatedKey = generatedBytes.toString("base64url");
    const randomBytes = vi.fn(() => generatedBytes);

    const first = await createAgentAccessKeyStore({
      credentialPath,
      now: () => new Date(createdAt),
      randomBytes,
      activateAccessKey: vi.fn(),
      writeClipboard: vi.fn(),
    });

    expect(randomBytes).toHaveBeenCalledOnce();
    expect(randomBytes).toHaveBeenCalledWith(32);
    expect(first.getAccessKey()).toBe(generatedKey);
    expect(first.getMetadata()).toMatchObject({ createdAt });
    expect(first.getMetadata().fingerprint).toMatch(/^[0-9a-f]{12}$/u);
    await expect(readCredential(credentialPath)).resolves.toEqual({
      schemaVersion: 1,
      accessKey: generatedKey,
      createdAt,
    });
    if (process.platform !== "win32") {
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    }

    const reusedRandomBytes = vi.fn(() => Buffer.alloc(32, 0x22));
    const reused = await createAgentAccessKeyStore({
      credentialPath,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      randomBytes: reusedRandomBytes,
      activateAccessKey: vi.fn(),
      writeClipboard: vi.fn(),
    });

    expect(reusedRandomBytes).not.toHaveBeenCalled();
    expect(reused.getAccessKey()).toBe(generatedKey);
    expect(reused.getMetadata()).toEqual(first.getMetadata());
  });

  it("replaces invalid credential data and emits a key-free structured warning", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    const invalidAccessKey = "INVALID_OLD_ACCESS_KEY_MUST_NOT_BE_REPORTED";
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        schemaVersion: 1,
        accessKey: invalidAccessKey,
        createdAt: "not-a-date",
      })}\n`,
      "utf8",
    );
    const replacementBytes = Buffer.alloc(32, 0x33);
    const replacementKey = replacementBytes.toString("base64url");
    const onWarning = vi.fn();

    const store = await createAgentAccessKeyStore({
      credentialPath,
      now: () => new Date("2026-07-16T08:05:00.000Z"),
      randomBytes: () => replacementBytes,
      activateAccessKey: vi.fn(),
      writeClipboard: vi.fn(),
      onWarning,
    });

    expect(store.getAccessKey()).toBe(replacementKey);
    await expect(readCredential(credentialPath)).resolves.toEqual({
      schemaVersion: 1,
      accessKey: replacementKey,
      createdAt: "2026-07-16T08:05:00.000Z",
    });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith({
      type: "invalid_credential_replaced",
      credentialPath,
    });
    const serializedWarning = JSON.stringify(onWarning.mock.calls);
    expect(serializedWarning).not.toContain(invalidAccessKey);
    expect(serializedWarning).not.toContain(replacementKey);
  });

  it("normalizes restrictive permissions when loading an existing valid credential", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    await writeCredential(credentialPath, {
      schemaVersion: 1,
      accessKey: keyForByte(0x32),
      createdAt: "2026-07-16T08:03:00.000Z",
    });
    if (process.platform !== "win32") await chmod(credentialPath, 0o644);
    const restrictCredentialPermissions = vi.fn((path: string) => chmod(path, 0o600));

    await createAgentAccessKeyStore({
      credentialPath,
      randomBytes: () => Buffer.alloc(32, 0x33),
      activateAccessKey: vi.fn(),
      writeClipboard: vi.fn(),
      restrictCredentialPermissions,
    });

    expect(restrictCredentialPermissions).toHaveBeenCalledOnce();
    expect(restrictCredentialPermissions).toHaveBeenCalledWith(credentialPath);
    if (process.platform !== "win32") {
      expect((await stat(credentialPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("fails closed when the credential cannot be read or initially persisted", async () => {
    const unreadableDirectory = await temporaryDirectory();
    const unreadablePath = resolveAgentAccessKeyPath(unreadableDirectory);
    await mkdir(unreadablePath);
    const randomBytes = vi.fn(() => Buffer.alloc(32, 0x34));
    const activateAccessKey = vi.fn();

    await expect(
      createAgentAccessKeyStore({
        credentialPath: unreadablePath,
        randomBytes,
        activateAccessKey,
        writeClipboard: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(randomBytes).not.toHaveBeenCalled();
    expect(activateAccessKey).not.toHaveBeenCalled();

    const unwritableDirectory = await temporaryDirectory();
    const persistCredential = vi.fn(() => Promise.reject(new Error("storage unavailable")));
    await expect(
      createAgentAccessKeyStore({
        credentialPath: resolveAgentAccessKeyPath(unwritableDirectory),
        randomBytes: () => Buffer.alloc(32, 0x35),
        activateAccessKey,
        writeClipboard: vi.fn(),
        persistCredential,
      }),
    ).rejects.toThrow("storage unavailable");
    expect(activateAccessKey).not.toHaveBeenCalled();
  });

  it("exposes only metadata and copies the key through the injected native clipboard boundary", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    const accessKey = keyForByte(0x44);
    const createdAt = "2026-07-16T08:10:00.000Z";
    await writeCredential(credentialPath, { schemaVersion: 1, accessKey, createdAt });
    const writeClipboard = vi.fn();
    const store = await createAgentAccessKeyStore({
      credentialPath,
      randomBytes: () => Buffer.alloc(32, 0x55),
      activateAccessKey: vi.fn(),
      writeClipboard,
    });

    const metadata = store.getMetadata();
    const copyResult = store.copy();

    expect(Object.keys(metadata).sort()).toEqual(["createdAt", "fingerprint"]);
    expect(metadata).toMatchObject({ createdAt });
    expect(metadata.fingerprint).toMatch(/^[0-9a-f]{12}$/u);
    expect(JSON.stringify(metadata)).not.toContain(accessKey);
    expect(copyResult).toBeUndefined();
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard).toHaveBeenCalledWith(accessKey);
  });

  it("persists a regenerated key before activation and rolls back cleanly when persistence fails", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    const initialCredential: AgentAccessKeyCredential = {
      schemaVersion: 1,
      accessKey: keyForByte(0x66),
      createdAt: "2026-07-16T08:15:00.000Z",
    };
    await writeCredential(credentialPath, initialCredential);
    const replacementKey = keyForByte(0x77);
    const persistence = deferred<void>();
    const persistCredential = vi.fn(() => persistence.promise);
    const activateAccessKey = vi.fn();
    const writeClipboard = vi.fn();
    const store = await createAgentAccessKeyStore({
      credentialPath,
      now: () => new Date("2026-07-16T08:20:00.000Z"),
      randomBytes: () => Buffer.alloc(32, 0x77),
      persistCredential,
      activateAccessKey,
      writeClipboard,
    });

    const regeneration = store.regenerate();
    await vi.waitFor(() => expect(persistCredential).toHaveBeenCalledOnce());

    expect(persistCredential).toHaveBeenCalledWith(credentialPath, {
      schemaVersion: 1,
      accessKey: replacementKey,
      createdAt: "2026-07-16T08:20:00.000Z",
    });
    expect(activateAccessKey).not.toHaveBeenCalled();
    expect(store.getAccessKey()).toBe(initialCredential.accessKey);
    expect(store.getMetadata().createdAt).toBe(initialCredential.createdAt);

    persistence.reject(new Error("credential persistence failed"));
    await expect(regeneration).rejects.toThrow("credential persistence failed");

    expect(activateAccessKey).not.toHaveBeenCalled();
    expect(store.getAccessKey()).toBe(initialCredential.accessKey);
    store.copy();
    expect(writeClipboard).toHaveBeenLastCalledWith(initialCredential.accessKey);
  });

  it("serializes regeneration through persistence and activation", async () => {
    const directory = await temporaryDirectory();
    const credentialPath = resolveAgentAccessKeyPath(directory);
    const initialCredential: AgentAccessKeyCredential = {
      schemaVersion: 1,
      accessKey: keyForByte(0x88),
      createdAt: "2026-07-16T08:25:00.000Z",
    };
    await writeCredential(credentialPath, initialCredential);
    const firstPersistence = deferred<void>();
    const secondPersistence = deferred<void>();
    const persisted: AgentAccessKeyCredential[] = [];
    const events: string[] = [];
    const persistCredential = vi.fn(
      (_path: string, credential: AgentAccessKeyCredential): Promise<void> => {
        persisted.push(credential);
        events.push(`persist:${credential.accessKey}`);
        return persisted.length === 1 ? firstPersistence.promise : secondPersistence.promise;
      },
    );
    const activateAccessKey = vi.fn((accessKey: string) => {
      events.push(`activate:${accessKey}`);
    });
    const generatedBytes = [Buffer.alloc(32, 0x99), Buffer.alloc(32, 0xaa)];
    const randomBytes = vi.fn(() => {
      const next = generatedBytes.shift();
      if (!next) throw new Error("Unexpected extra access-key generation.");
      return next;
    });
    const creationTimes = [
      new Date("2026-07-16T08:30:00.000Z"),
      new Date("2026-07-16T08:35:00.000Z"),
    ];
    const store = await createAgentAccessKeyStore({
      credentialPath,
      now: () => creationTimes.shift() ?? new Date("2026-07-16T08:40:00.000Z"),
      randomBytes,
      persistCredential,
      activateAccessKey,
      writeClipboard: vi.fn(),
    });

    const firstRegeneration = store.regenerate();
    const secondRegeneration = store.regenerate();
    await vi.waitFor(() => expect(persistCredential).toHaveBeenCalledOnce());

    expect(randomBytes).toHaveBeenCalledOnce();
    expect(activateAccessKey).not.toHaveBeenCalled();

    firstPersistence.resolve();
    await vi.waitFor(() => expect(persistCredential).toHaveBeenCalledTimes(2));

    const firstKey = keyForByte(0x99);
    const secondKey = keyForByte(0xaa);
    expect(events).toEqual([`persist:${firstKey}`, `activate:${firstKey}`, `persist:${secondKey}`]);
    expect(store.getAccessKey()).toBe(firstKey);

    secondPersistence.resolve();
    const [firstMetadata, secondMetadata] = await Promise.all([
      firstRegeneration,
      secondRegeneration,
    ]);

    expect(activateAccessKey.mock.calls).toEqual([[firstKey], [secondKey]]);
    expect(persisted.at(-1)?.accessKey).toBe(secondKey);
    expect(store.getAccessKey()).toBe(secondKey);
    expect(firstMetadata.createdAt).toBe("2026-07-16T08:30:00.000Z");
    expect(secondMetadata).toEqual(store.getMetadata());
    expect(JSON.stringify([firstMetadata, secondMetadata])).not.toContain(firstKey);
    expect(JSON.stringify([firstMetadata, secondMetadata])).not.toContain(secondKey);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-agent-access-key-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function keyForByte(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

async function readCredential(path: string): Promise<AgentAccessKeyCredential> {
  return JSON.parse(await readFile(path, "utf8")) as AgentAccessKeyCredential;
}

async function writeCredential(path: string, credential: AgentAccessKeyCredential): Promise<void> {
  await writeFile(path, `${JSON.stringify(credential)}\n`, "utf8");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    promise,
    resolve: (value) => resolve(value as T),
    reject,
  };
}
