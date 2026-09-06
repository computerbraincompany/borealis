import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ConnectionConfigError } from "./store.js";

/**
 * Reusable server-side secret custody for external connections (MCP now,
 * WebDAV in M14). Credential material is separated from every SQLite DTO: the
 * ledger only ever references a connection, and this module's `read` result
 * is consumable exclusively by transport code, never by route serialization.
 *
 * Custody is an injectable key provider. Browser development uses an
 * operator-managed private key file plus encrypted atomic secret records
 * (mode `0600`, atomic same-directory rename, no symlink following). The
 * packaged desktop wires an OS-protected keychain through the main process:
 * that stage implements `ConnectionKeyCustody` in the desktop composition and
 * injects it here; nothing in this module ever touches a renderer. Missing or
 * unreadable custody is an actionable disconnected state
 * (`CONNECTION_CUSTODY_UNAVAILABLE`), never a crash, and plaintext never
 * reaches disk under any path.
 */

/**
 * Reserved namespace for MCP OAuth custody material (`server/src/mcp/oauth.ts`).
 * Entries under this prefix are credential material owned by the sign-in
 * lifecycle: they are never passed into a stdio child environment, and route
 * DTOs never serialize any of it (secrets never reach DTOs at all).
 */
export const OAUTH_ENV_PREFIX = "MCP_OAUTH_";

export const MAX_SECRET_HEADER_ENTRIES = 8;
export const MAX_SECRET_ENV_ENTRIES = 16;
export const MAX_SECRET_NAME_CHARS = 128;
export const MAX_SECRET_VALUE_CHARS = 4_096;
export const MAX_SECRET_TOTAL_BYTES = 24 * 1024;

export interface ConnectionSecrets {
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

export type ConnectionSecretRead =
  | { readonly state: "absent" }
  | { readonly state: "available"; readonly secrets: ConnectionSecrets }
  /** Custody or the encrypted record exists but cannot yield usable material. */
  | { readonly state: "unavailable"; readonly reason: "custody" | "record" };

export class ConnectionCustodyUnavailableError extends Error {
  readonly code = "CONNECTION_CUSTODY_UNAVAILABLE";
  readonly statusCode = 503;

  constructor() {
    super("connection credential custody is unavailable");
    this.name = "ConnectionCustodyUnavailableError";
  }
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function validateEntries(
  value: unknown,
  pattern: RegExp,
  maximum: number,
  forbidNewlines: boolean
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new ConnectionConfigError("connection credentials are invalid");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maximum) throw new ConnectionConfigError("connection credentials are invalid");
  const result: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!pattern.test(name) || typeof raw !== "string" || raw.length < 1 || raw.length > MAX_SECRET_VALUE_CHARS) {
      throw new ConnectionConfigError("connection credentials are invalid");
    }
    // NUL always; CR/LF additionally in HTTP header values (header injection).
    if (raw.includes("\0") || (forbidNewlines && /[\r\n]/.test(raw))) {
      throw new ConnectionConfigError("connection credentials are invalid");
    }
    result[name] = raw;
  }
  return result;
}

/** Strict runtime validation and canonicalization of credential material. */
export function connectionSecrets(value: unknown): ConnectionSecrets {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectionConfigError("connection credentials are invalid");
  }
  const input = value as { headers?: unknown; env?: unknown };
  if (Object.keys(input).some((key) => key !== "headers" && key !== "env")) {
    throw new ConnectionConfigError("connection credentials are invalid");
  }
  const headers = validateEntries(input.headers, HEADER_NAME_PATTERN, MAX_SECRET_HEADER_ENTRIES, true);
  const env = validateEntries(input.env, ENV_NAME_PATTERN, MAX_SECRET_ENV_ENTRIES, false);
  const canonical = { headers, env };
  if (Object.keys(headers).length + Object.keys(env).length < 1) {
    throw new ConnectionConfigError("connection credentials are invalid");
  }
  if (Buffer.byteLength(JSON.stringify(canonical), "utf8") > MAX_SECRET_TOTAL_BYTES) {
    throw new ConnectionConfigError("connection credentials are invalid");
  }
  return Object.freeze({
    headers: Object.freeze(headers),
    env: Object.freeze(env),
  });
}

/**
 * Key custody seam. Implementations must never log, echo, or persist the key
 * outside the custody mechanism itself. Returning `undefined` is the
 * supported "custody unavailable" signal; throwing is reserved for bugs.
 */
export interface ConnectionKeyCustody {
  /** The custody key, or `undefined` when custody is currently unavailable. */
  readKey(): Promise<Buffer | undefined>;
  /** The custody key, creating custody once when creation is permitted. */
  ensureKey(): Promise<Buffer | undefined>;
}

const KEY_PATTERN = /^[0-9a-f]{64}$/;

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function openNoFollow(
  filename: string,
  flags: number,
  mode?: number
): Promise<import("node:fs/promises").FileHandle> {
  return mode === undefined ? fs.open(filename, flags) : fs.open(filename, flags, mode);
}

/**
 * Browser-development custody: an operator-managed private key file. Reads
 * never follow symlinks and repair a pre-existing widened mode; creation is a
 * single `0600` atomic write. A missing key on read is custody-unavailable
 * (the caller reports an actionable disconnected state); it is never silently
 * regenerated, which would orphan existing records.
 */
export class FileKeyCustody implements ConnectionKeyCustody {
  constructor(private readonly keyFile: string) {
    if (!path.isAbsolute(keyFile)) throw new TypeError("connection key file must be an absolute path");
  }

  async readKey(): Promise<Buffer | undefined> {
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      handle = await fs.open(this.keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) return undefined;
      if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      const text = (await handle.readFile({ encoding: "utf8" })).trim();
      if (!KEY_PATTERN.test(text)) return undefined;
      return Buffer.from(text, "hex");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      // ELOOP (symlink), EPERM, and every other custody failure are
      // actionable unavailability, never a crash on the request path.
      return undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async ensureKey(): Promise<Buffer | undefined> {
    const existing = await this.readKey();
    if (existing) return existing;
    const directory = path.dirname(this.keyFile);
    try {
      await ensurePrivateDirectory(directory);
      const key = randomBytes(32);
      const temporary = path.join(directory, `.${path.basename(this.keyFile)}.${process.pid}.${randomUUID()}.tmp`);
      let handle: import("node:fs/promises").FileHandle | undefined;
      try {
        handle = await openNoFollow(
          temporary,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600
        );
        await handle.chmod(0o600);
        await handle.writeFile(`${key.toString("hex")}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        try {
          // `link` fails when a concurrent creator won the race; that winner
          // is authoritative and its key is read back.
          await fs.link(temporary, this.keyFile);
        } catch (error) {
          if (isNodeError(error, "EEXIST")) return this.readKey();
          throw error;
        }
        return key;
      } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    } catch {
      return undefined;
    }
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("connection secret directory is unsafe");
  if ((stat.mode & 0o777) !== 0o700) await fs.chmod(directory, 0o700);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function scopedPath(root: string, accountId: string, connectionId: string): string {
  if (!UUID_PATTERN.test(accountId) || !UUID_PATTERN.test(connectionId)) {
    throw new TypeError("connection secret scope must be canonical UUIDs");
  }
  return path.join(root, accountId, `${connectionId}.json`);
}

/** AAD binds each ciphertext to its exact account/connection scope. */
function scopeAad(accountId: string, connectionId: string): Buffer {
  return Buffer.from(`borealis-connection-secret:v1:${accountId}:${connectionId}`, "utf8");
}

interface EncryptedRecord {
  v: number;
  alg: string;
  iv: string;
  tag: string;
  ct: string;
}

function parseRecord(text: string): EncryptedRecord | undefined {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(raw).sort().join(",");
    if (keys !== "alg,ct,iv,tag,v" || raw.v !== 1 || raw.alg !== "AES-256-GCM") return undefined;
    if (typeof raw.iv !== "string" || typeof raw.tag !== "string" || typeof raw.ct !== "string") return undefined;
    return { v: 1, alg: "AES-256-GCM", iv: raw.iv, tag: raw.tag, ct: raw.ct };
  } catch {
    return undefined;
  }
}

/**
 * File-backed custody for browser development. Records are AES-256-GCM sealed
 * with the custody key, bound to their scope via AAD, and written atomically
 * with mode `0600`. A corrupt, tampered, or cross-scoped record reports
 * `unavailable` instead of failing the request or exposing content.
 */
export class FileConnectionSecretStore implements ConnectionSecretStore {
  readonly directory: string;
  private readonly custody: ConnectionKeyCustody;

  constructor(options: { directory: string; custody: ConnectionKeyCustody }) {
    if (!path.isAbsolute(options.directory)) throw new TypeError("connection secret directory must be absolute");
    this.directory = path.resolve(options.directory);
    this.custody = options.custody;
  }

  async put(accountId: string, connectionId: string, secrets: ConnectionSecrets): Promise<void> {
    const filename = scopedPath(this.directory, accountId, connectionId);
    const key = await this.custody.ensureKey();
    if (!key) throw new ConnectionCustodyUnavailableError();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(scopeAad(accountId, connectionId));
    const ct = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
    const record: EncryptedRecord = {
      v: 1,
      alg: "AES-256-GCM",
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ct: ct.toString("base64url"),
    };
    const directory = path.dirname(filename);
    await ensurePrivateDirectory(directory);
    const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
    let handle: import("node:fs/promises").FileHandle | undefined;
    try {
      handle = await openNoFollow(
        temporary,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600
      );
      // Every fallible hardening step precedes the rename, as in settings
      // writes: the rename is the single durable commit point.
      const temporaryStat = await handle.stat();
      if ((temporaryStat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, filename);
    } finally {
      await handle?.close().catch(() => {});
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async read(accountId: string, connectionId: string): Promise<ConnectionSecretRead> {
    const filename = scopedPath(this.directory, accountId, connectionId);
    let handle: import("node:fs/promises").FileHandle | undefined;
    let text: string;
    try {
      handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) return { state: "unavailable", reason: "record" };
      if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      text = await handle.readFile({ encoding: "utf8" });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { state: "absent" };
      return { state: "unavailable", reason: "record" };
    } finally {
      await handle?.close().catch(() => {});
    }
    const record = parseRecord(text);
    if (!record) return { state: "unavailable", reason: "record" };
    const key = await this.custody.readKey();
    if (!key) return { state: "unavailable", reason: "custody" };
    try {
      const iv = Buffer.from(record.iv, "base64url");
      const tag = Buffer.from(record.tag, "base64url");
      const ct = Buffer.from(record.ct, "base64url");
      if (iv.length !== 12 || tag.length !== 16) return { state: "unavailable", reason: "record" };
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(scopeAad(accountId, connectionId));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      return { state: "available", secrets: connectionSecrets(JSON.parse(plain.toString("utf8"))) };
    } catch {
      // Wrong key, tampering, or cross-scope substitution all land here.
      return { state: "unavailable", reason: "record" };
    }
  }

  async remove(accountId: string, connectionId: string): Promise<void> {
    const filename = scopedPath(this.directory, accountId, connectionId);
    try {
      await fs.unlink(filename);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }
}

/** Reusable surface consumed by the connection service and transports. */
export interface ConnectionSecretStore {
  put(accountId: string, connectionId: string, secrets: ConnectionSecrets): Promise<void>;
  remove(accountId: string, connectionId: string): Promise<void>;
  /** Transport-only read. Route DTOs must never await or serialize this. */
  read(accountId: string, connectionId: string): Promise<ConnectionSecretRead>;
}
