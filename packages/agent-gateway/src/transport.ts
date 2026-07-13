import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { dirname } from "node:path";

import type { RawData, WebSocketServer } from "ws";

import { createRequestId, type AgentGatewayDescriptor, type RequestId } from "@terminal/protocol";

export async function writeDescriptor(
  path: string,
  descriptor: AgentGatewayDescriptor,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function extractRequestIdFromRaw(data: RawData): RequestId {
  try {
    const value = JSON.parse(rawDataToString(data)) as unknown;
    if (isObject(value) && typeof value.requestId === "string") {
      return createRequestId(value.requestId);
    }
  } catch {
    // A generated request ID still gives malformed requests a correlatable response.
  }
  return createRequestId();
}

export function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === undefined
  );
}

export function randomId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function createWebSocketServer(server: Server): Promise<WebSocketServer> {
  // Keep ws out of eager startup paths that do not enable the agent gateway.
  const { WebSocketServer } = await import("ws");
  return new WebSocketServer({ server });
}

export function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
