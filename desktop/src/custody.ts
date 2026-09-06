import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  asTransferableBytes,
  MAX_CUSTODY_KEY_BYTES,
  type BackendCustodyRequest,
  type CustodyFailureMessage,
  type CustodySuccessMessage,
} from "./contracts.js";

/**
 * The Electron-main custody vault (Connected agents stage 5).
 *
 * Main owns the OS-protected custody key entirely: it generates one 32-byte
 * data key, seals it at rest through Electron `safeStorage`, and answers the
 * backend utility process over the narrow `custody-request`/`custody-response`
 * pair defined in `contracts.ts` — `read` and `ensure` only; there is
 * deliberately no `list`, no per-record crypto, and no general secret API.
 * The utility process performs the AES-GCM record sealing itself with the
 * returned key, so neither plaintext secrets nor decrypted records ever
 * cross the channel, and durable record files stay identical to the
 * browser-development layout.
 *
 * `read` never creates the key (silent regeneration would orphan every record
 * sealed under the previous key); `ensure` creates it exactly once when
 * `safeStorage` is available. A restored seal from another machine cannot be
 * unsealed — that is the actionable custody/record failure the backend
 * reports as the disconnected state.
 *
 * The unsealed key is held in main memory for the process lifetime so a burst
 * of per-call custody re-checks during a durable turn does not hammer the OS
 * keychain; the cache lives at main's own trust tier (which already performs
 * the OS unseal), is a single bounded 32-byte entry, is zeroized on
 * `clear()`, and is never persisted. The sealed file lives outside the
 * archived workspace paths — keys are documented as non-portable.
 */

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const CUSTODY_KEY_BYTES = 32;

function failure(
  requestId: string,
  reason: "custody" | "record",
): CustodyFailureMessage {
  return { type: "custody-response", request_id: requestId, ok: false, reason };
}

function success(requestId: string, key: Buffer): CustodySuccessMessage {
  return {
    type: "custody-response",
    request_id: requestId,
    ok: true,
    data: asTransferableBytes(key),
  };
}

export class ConnectionKeyVault {
  readonly #storage: SafeStorageLike;
  readonly #keyFile: string;
  #cached: Buffer | undefined;

  constructor(storage: SafeStorageLike, keyFile: string) {
    if (!path.isAbsolute(keyFile))
      throw new TypeError("custody key file must be an absolute path");
    this.#storage = storage;
    this.#keyFile = keyFile;
  }

  /** Answer one schema-checked custody request from the backend. */
  async handle(
    request: BackendCustodyRequest,
  ): Promise<CustodySuccessMessage | CustodyFailureMessage> {
    return request.op === "read"
      ? this.#read(request.request_id)
      : this.#ensure(request.request_id);
  }

  /** Drop the in-memory key (app shutdown / backend restart). */
  clear(): void {
    this.#cached?.fill(0);
    this.#cached = undefined;
  }

  async #read(
    requestId: string,
  ): Promise<CustodySuccessMessage | CustodyFailureMessage> {
    if (this.#cached) return success(requestId, this.#cached);
    if (!this.#storage.isEncryptionAvailable())
      return failure(requestId, "custody");
    let sealed: Buffer;
    try {
      sealed = await readFile(this.#keyFile);
    } catch {
      // Absent or unreadable: no usable key. `read` must never create one.
      return failure(requestId, "custody");
    }
    try {
      const key = Buffer.from(this.#storage.decryptString(sealed), "base64");
      if (key.byteLength < 1 || key.byteLength > MAX_CUSTODY_KEY_BYTES)
        throw new Error("custody key is invalid");
      sealed.fill(0);
      this.#cached = key;
      return success(requestId, key);
    } catch {
      // Wrong machine/keychain, tampering, or corruption: an actionable
      // record failure. The backend reports the disconnected state from this.
      sealed.fill(0);
      return failure(requestId, "record");
    }
  }

  async #ensure(
    requestId: string,
  ): Promise<CustodySuccessMessage | CustodyFailureMessage> {
    const existing = await this.#read(requestId);
    if (existing.ok) return existing;
    if (!this.#storage.isEncryptionAvailable())
      return failure(requestId, "custody");
    try {
      const directory = path.dirname(this.#keyFile);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await stat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error("custody key directory is unsafe");
      }
      await chmod(directory, 0o700);
      // A lost key orphans every sealed record, so first publication is a
      // durable commit: exclusive temp write, `0600`, then one rename.
      const existingKey = await readFile(this.#keyFile).catch(() => undefined);
      if (existingKey) throw new Error("custody key appeared concurrently");
      const key = randomBytes(CUSTODY_KEY_BYTES);
      const sealed = Buffer.from(
        this.#storage.encryptString(key.toString("base64")),
      );
      const temporary = path.join(
        directory,
        `.key-${randomBytes(8).toString("hex")}.tmp`,
      );
      try {
        await writeFile(temporary, sealed, { mode: 0o600, flag: "wx" });
        await chmod(temporary, 0o600);
        await rename(temporary, this.#keyFile);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      sealed.fill(0);
      this.#cached = key;
      return success(requestId, key);
    } catch {
      // Any durable failure (permission, disk, keychain race) is an
      // actionable custody failure; nothing is retried implicitly.
      return failure(requestId, "custody");
    }
  }
}
