import { z } from "zod";

type Brand<TValue, TBrand extends string> = TValue & { readonly __brand: TBrand };

export type SessionId = Brand<string, "SessionId">;
export type OperationId = Brand<string, "OperationId">;
export type RequestId = Brand<string, "RequestId">;
export type DecisionId = Brand<string, "DecisionId">;

export const sessionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as SessionId);

export const operationIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as OperationId);

export const requestIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as RequestId);

export const decisionIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as DecisionId);

export function createSessionId(value = randomId("session")): SessionId {
  return sessionIdSchema.parse(value);
}

export function createOperationId(value = randomId("operation")): OperationId {
  return operationIdSchema.parse(value);
}

export function createRequestId(value = randomId("request")): RequestId {
  return requestIdSchema.parse(value);
}

export function createDecisionId(value = randomId("decision")): DecisionId {
  return decisionIdSchema.parse(value);
}

function randomId(prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && "randomUUID" in cryptoApi) {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
