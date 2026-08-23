import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface OperationContext {
  requestId: string;
}

const operationContext = new AsyncLocalStorage<OperationContext>();

export function runWithRequestContext<T>(requestId: string | undefined, fn: () => T): T {
  return operationContext.run({ requestId: normalizeRequestId(requestId) }, fn);
}

export function currentRequestId(): string {
  return operationContext.getStore()?.requestId ?? randomUUID();
}

export function normalizeRequestId(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : randomUUID();
}
