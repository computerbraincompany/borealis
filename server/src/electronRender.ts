import { randomUUID } from "node:crypto";

export type ElectronRenderKind = "png" | "pdf";

interface ElectronRenderRequest {
  readonly type: "render-request";
  readonly request_id: string;
  readonly kind: ElectronRenderKind;
  readonly html: string;
}

interface ElectronRenderResponse {
  readonly type: "render-response";
  readonly request_id: string;
  readonly ok: boolean;
  readonly data?: Uint8Array;
}

export interface ElectronParentPort {
  postMessage(message: ElectronRenderRequest): void;
  on(event: "message", listener: (message: unknown) => void): this;
  off?(event: "message", listener: (message: unknown) => void): this;
}

interface PendingRender {
  readonly resolve: (value: Buffer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const RENDER_TIMEOUT_MS = 90_000;
const pending = new Map<string, PendingRender>();
let parentPort: ElectronParentPort | undefined;
let messageListener: ((message: unknown) => void) | undefined;

function opaqueRenderError(): Error {
  return new Error("Electron rendering failed");
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function settle(requestId: string): PendingRender | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
  return entry;
}

function isResponse(value: unknown): value is ElectronRenderResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ElectronRenderResponse>;
  return (
    candidate.type === "render-response" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.ok === "boolean"
  );
}

function receive(message: unknown): void {
  const payload =
    message && typeof message === "object" && "data" in message
      ? (message as { readonly data?: unknown }).data
      : message;
  if (!isResponse(payload)) return;
  const entry = settle(payload.request_id);
  if (!entry) return;
  if (!payload.ok || !(payload.data instanceof Uint8Array)) {
    entry.reject(opaqueRenderError());
    return;
  }
  entry.resolve(Buffer.from(payload.data));
}

/** Attach the one authenticated Electron utility-process message channel. */
export function configureElectronRenderPort(port: ElectronParentPort): void {
  if (parentPort === port) return;
  if (parentPort && messageListener) parentPort.off?.("message", messageListener);
  closeElectronRenderPort();
  parentPort = port;
  messageListener = receive;
  port.on("message", messageListener);
}

/** Reject outstanding jobs before the utility process exits. */
export function closeElectronRenderPort(): void {
  if (parentPort && messageListener) parentPort.off?.("message", messageListener);
  parentPort = undefined;
  messageListener = undefined;
  for (const requestId of [...pending.keys()]) settle(requestId)?.reject(opaqueRenderError());
}

export function requestElectronRender(kind: ElectronRenderKind, html: string, signal?: AbortSignal): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(abortError());
  const port = parentPort;
  if (!port) return Promise.reject(opaqueRenderError());
  const requestId = randomUUID();

  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => settle(requestId)?.reject(opaqueRenderError()), RENDER_TIMEOUT_MS);
    timer.unref();
    const entry: PendingRender = { resolve, reject, timer, signal };
    if (signal) {
      entry.onAbort = () => settle(requestId)?.reject(abortError());
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    pending.set(requestId, entry);
    try {
      port.postMessage({ type: "render-request", request_id: requestId, kind, html });
    } catch {
      settle(requestId)?.reject(opaqueRenderError());
    }
  });
}
