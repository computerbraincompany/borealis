import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { FileConnectionSecretStore, type ConnectionKeyCustody, type ConnectionSecretStore } from "./secrets.js";

/**
 * Packaged-desktop connection secret custody (Connected agents stage 5).
 *
 * The Electron main process owns the OS-protected custody key: main generates
 * one 32-byte data key, seals it at rest through `safeStorage`, and answers
 * key requests over the one authenticated Electron utility parent port as a
 * narrow, strictly schema-checked request/response pair — never a general IPC
 * channel:
 *
 * - utility → main `{type:"custody-request", request_id, op:"read"|"ensure"}`
 * - main → utility `{type:"custody-response", request_id, ok, …}`
 *
 * `read` never creates custody (the same no-silent-regeneration rule as the
 * browser-development file custody: regenerating a key would orphan every
 * existing record); `ensure` creates the key exactly once when permitted.
 * `list`, per-record crypto, and anything else are deliberately absent: the
 * only thing main ever hands back is the data key, and the durable sealed
 * records stay in the one `FileConnectionSecretStore` envelope that browser
 * development already uses — the same encrypted record layout on both
 * platforms, and like browser custody those records (`secrets/`, `connections.key`)
 * are intentionally NONPORTABLE and excluded from workspace archives. The key is machine-bound: after a
 * restore on another machine the sealed key cannot be unsealed, reads report
 * the actionable `unavailable:custody` state, and reconnect is required —
 * exactly the documented archive/restore contract.
 *
 * When the utility parent port is not attached (browser development, tests)
 * every key request yields `undefined` and therefore the same actionable
 * disconnected custody state — never plaintext, never a crash, and the
 * browser-development file custody default is untouched.
 *
 * The module also owns the one-time system-browser open intent for desktop
 * OAuth: `authorize` mints an opaque token bound to the exact validated sign-in
 * URL; the hardened preload can ask main to open it, and main must have that
 * intent verified-and-consumed here (utility side) before
 * `shell.openExternal` runs. Unknown, expired, replayed, or URL-mismatched
 * intents are refused, so a renderer can never name an arbitrary URL.
 */

export interface DesktopCustodyPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): this;
  off?(event: "message", listener: (message: unknown) => void): this;
}

const CUSTODY_REQUEST_TIMEOUT_MS = 5_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CUSTODY_KEY_BYTES = 32;
const MAX_CUSTODY_KEY_BYTES = 64;

/** Same window as the sign-in session this token unlocks. */
export const DESKTOP_OPEN_INTENT_TTL_MS = 5 * 60_000;
const MAX_OPEN_INTENTS = 64;
const OPEN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_OPEN_URL_CHARS = 4_096;

interface CustodyResponse {
  readonly ok: boolean;
  readonly reason?: "custody" | "record";
  readonly key?: Uint8Array;
}

interface PendingRequest {
  readonly resolve: (value: CustodyResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface OpenIntent {
  readonly url: string;
  readonly connectionKey: string;
  readonly expiresAtMs: number;
}

let parentPort: DesktopCustodyPort | undefined;
let messageListener: ((message: unknown) => void) | undefined;
const pending = new Map<string, PendingRequest>();
const openIntents = new Map<string, OpenIntent>();
let custodySingleton: DesktopSafeStorageKeyCustody | undefined;
let storeSingleton: ConnectionSecretStore | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageData(message: unknown): unknown {
  return isRecord(message) && "data" in message ? message.data : message;
}

function settle(requestId: string): PendingRequest | undefined {
  const entry = pending.get(requestId);
  if (!entry) return undefined;
  pending.delete(requestId);
  clearTimeout(entry.timer);
  return entry;
}

/**
 * Strict main→utility response check; anything malformed is ignored. The
 * `data` field is the custody data key (main's `CustodySuccessMessage`
 * contract); failures carry `custody`/`record` with no payload.
 */
function parseCustodyResponse(
  payload: Record<string, unknown>
): { requestId: string; response: CustodyResponse } | undefined {
  const requestId = payload.request_id;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return undefined;
  if (payload.ok === false) {
    const reason = payload.reason === "custody" || payload.reason === "record" ? payload.reason : "custody";
    if (payload.data !== undefined) return undefined;
    return { requestId, response: { ok: false, reason } };
  }
  if (payload.ok !== true) return undefined;
  if (
    payload.data instanceof Uint8Array &&
    payload.data.byteLength === CUSTODY_KEY_BYTES &&
    payload.reason === undefined
  ) {
    return { requestId, response: { ok: true, key: payload.data } };
  }
  return undefined;
}

function isPlainHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1") return true;
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
}

/** Exact https (or explicit loopback/.local development http) open target. */
function isAllowedOpenUrl(url: string): boolean {
  if (url.length < 1 || url.length > MAX_OPEN_URL_CHARS) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:")
    return parsed.hostname.length > 0 && parsed.username.length === 0 && parsed.password.length === 0;
  if (parsed.protocol === "http:")
    return isPlainHttpHost(parsed.hostname) && parsed.username.length === 0 && parsed.password.length === 0;
  return false;
}

/**
 * Verify-and-consume one system-browser open intent (main → utility request).
 * The first successful verification consumes the token; replays, expiry, and
 * any URL mismatch fail closed.
 */
export function consumeDesktopBrowserOpenIntent(token: unknown, url: unknown): boolean {
  if (typeof token !== "string" || !OPEN_TOKEN_PATTERN.test(token)) return false;
  if (typeof url !== "string" || !isAllowedOpenUrl(url)) return false;
  const intent = openIntents.get(token);
  if (!intent) return false;
  openIntents.delete(token);
  if (intent.expiresAtMs <= Date.now()) return false;
  return intent.url === url;
}

function handleOpenVerifyRequest(payload: Record<string, unknown>): void {
  const requestId = payload.request_id;
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return;
  const ok = consumeDesktopBrowserOpenIntent(payload.token, payload.url);
  parentPort?.postMessage({ type: "open-verify-response", request_id: requestId, ok });
}

function receive(message: unknown): void {
  const payload = messageData(message);
  if (!isRecord(payload) || typeof payload.type !== "string") return;
  if (payload.type === "custody-response") {
    const parsed = parseCustodyResponse(payload);
    if (!parsed) return;
    settle(parsed.requestId)?.resolve(parsed.response);
    return;
  }
  if (payload.type === "open-verify-request") {
    handleOpenVerifyRequest(payload);
  }
}

/** Attach the one authenticated Electron utility parent port. */
export function configureDesktopCustodyPort(port: DesktopCustodyPort): void {
  if (parentPort === port) return;
  closeDesktopCustodyPort();
  parentPort = port;
  messageListener = receive;
  port.on("message", messageListener);
}

/** Reject outstanding custody work and forget the port (utility close). */
export function closeDesktopCustodyPort(): void {
  if (parentPort && messageListener) parentPort.off?.("message", messageListener);
  parentPort = undefined;
  messageListener = undefined;
  for (const requestId of [...pending.keys()]) settle(requestId)?.resolve({ ok: false, reason: "custody" });
  openIntents.clear();
}

/** True while the packaged-desktop custody channel is attached. */
export function desktopCustodyActive(): boolean {
  return parentPort !== undefined;
}

function requestCustody(op: "read" | "ensure"): Promise<CustodyResponse> {
  const port = parentPort;
  if (!port) return Promise.resolve({ ok: false, reason: "custody" });
  const requestId = randomUUID();
  return new Promise<CustodyResponse>((resolve) => {
    const timer = setTimeout(
      () => settle(requestId)?.resolve({ ok: false, reason: "custody" }),
      CUSTODY_REQUEST_TIMEOUT_MS
    );
    timer.unref?.();
    pending.set(requestId, { resolve, timer });
    try {
      port.postMessage({ type: "custody-request", request_id: requestId, op });
    } catch {
      settle(requestId)?.resolve({ ok: false, reason: "custody" });
    }
  });
}

/**
 * `ConnectionKeyCustody` over the main-owned custody pair. A missing,
 * unavailable, or unanswerable key is reported as `undefined` — the same
 * custody-unavailable signal the browser-development file custody uses — and
 * never as plaintext or an exception on the request path.
 */
export class DesktopSafeStorageKeyCustody implements ConnectionKeyCustody {
  async readKey(): Promise<Buffer | undefined> {
    return this.#request("read");
  }

  async ensureKey(): Promise<Buffer | undefined> {
    return this.#request("ensure");
  }

  async #request(op: "read" | "ensure"): Promise<Buffer | undefined> {
    const response = await requestCustody(op);
    if (!response.ok || !(response.key instanceof Uint8Array)) return undefined;
    if (response.key.byteLength < 1 || response.key.byteLength > MAX_CUSTODY_KEY_BYTES) return undefined;
    return Buffer.from(response.key);
  }
}

/**
 * The desktop secret-store composition: the exact same AES-256-GCM scoped
 * envelope as browser development, with the key held only by main's
 * `safeStorage`. The constructor is path-only; durable directories are
 * created lazily by the store's atomic writes.
 */
export function desktopCustodySecretStore(): ConnectionSecretStore {
  if (!storeSingleton) {
    custodySingleton ??= new DesktopSafeStorageKeyCustody();
    storeSingleton = new FileConnectionSecretStore({
      directory: path.resolve(config.connectionSecretsDir),
      custody: custodySingleton,
    });
  }
  return storeSingleton;
}

/** Test seam: drop the composed store singleton (composition order stays main's). */
export function resetDesktopCustodyStore(): void {
  storeSingleton = undefined;
  custodySingleton = undefined;
}

/**
 * Mint the one-time open intent for a fresh `authorize` session. Returns
 * `undefined` off-desktop (no parent port) or when the validated URL cannot
 * be opened by main, so the browser-development DTO is unchanged.
 */
export function mintDesktopBrowserOpenIntent(
  connectionKey: string,
  url: string
): { readonly token: string; readonly expiresAt: string } | undefined {
  if (!parentPort || !isAllowedOpenUrl(url)) return undefined;
  for (const [token, intent] of openIntents) {
    if (intent.connectionKey === connectionKey || intent.expiresAtMs <= Date.now()) openIntents.delete(token);
  }
  while (openIntents.size >= MAX_OPEN_INTENTS) {
    const oldest = openIntents.keys().next();
    if (oldest.done) break;
    openIntents.delete(oldest.value);
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAtMs = Date.now() + DESKTOP_OPEN_INTENT_TTL_MS;
  openIntents.set(token, { url, connectionKey, expiresAtMs });
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

/** Test/close helper: drop every pending intent. */
export function clearDesktopBrowserOpenIntents(): void {
  openIntents.clear();
}
