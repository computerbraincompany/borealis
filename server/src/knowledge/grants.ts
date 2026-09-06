import fs from "node:fs/promises";
import path from "node:path";

/**
 * Desktop folder-selection grants (M14 stage 2).
 *
 * The Electron main process owns the native directory dialog. On a real
 * selection it mints one opaque grant (a 64-hex one-time token), resolves the
 * chosen path to its canonical real path, and forwards `{grant_id, root_path,
 * display_label}` to the backend over the private utility-process channel —
 * this module is the only reader of that message. The renderer receives only
 * the opaque `grant_id`, a label, and bounded preview metadata; the resolved
 * path never reaches renderer code.
 *
 * Guarantees enforced here:
 * - grants live only in backend process memory (never SQLite, never disk);
 * - uncommitted grants expire after 10 minutes;
 * - consumption is once-and-for-all and records the consuming account, so a
 *   grant can never authorize a second connection or a second account;
 * - a desktop_folder connection therefore exists only if a grant was
 *   consumed for its account — no HTTP endpoint accepts a raw absolute path;
 * - hostile or malformed protocol messages are refused without throwing and
 *   without touching the filesystem.
 */

export const DESKTOP_FOLDER_GRANT_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_DESKTOP_FOLDER_GRANTS = 64;
export const DESKTOP_FOLDER_GRANT_MESSAGE_TYPE = "folder-grant";

const GRANT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ROOT_PATH_BYTES = 4_096;
const MAX_LABEL_CHARS = 120;

export class DesktopFolderGrantUnavailableError extends Error {
  readonly code = "DESKTOP_FOLDER_GRANT_INVALID";
  readonly statusCode = 400;

  constructor(message = "the folder selection grant is missing, expired, or already used") {
    super(message);
    this.name = "DesktopFolderGrantUnavailableError";
  }
}

export interface DesktopFolderGrantConsumption {
  readonly root_path: string;
  readonly display_label: string;
}

interface GrantRecord {
  readonly rootPath: string;
  readonly displayLabel: string;
  readonly expiresAt: number;
}

function validLabelText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    Array.from(value).length <= MAX_LABEL_CHARS &&
    !value.includes("\0") &&
    !/[\r\n]/.test(value)
  );
}

function validRootPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_ROOT_PATH_BYTES) return false;
  if (!path.isAbsolute(value) || value.includes("\0") || /[\r\n]/.test(value)) return false;
  return path.normalize(value) === value;
}

export class DesktopFolderGrantRegistry {
  private readonly grants = new Map<string, GrantRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get pendingCount(): number {
    return this.grants.size;
  }

  /** Drop every expired grant; returns how many were swept. */
  sweepExpired(): number {
    const at = this.now();
    let removed = 0;
    for (const [id, record] of this.grants) {
      if (record.expiresAt <= at) {
        this.grants.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Register one grant minted by main. The root path must already be main's
   * canonical real path: `realpath` must round-trip it and the leaf must be a
   * real directory. Hostile input (bad id shape, symlinked or non-canonical
   * path, missing directory) fails closed to `false` with no side effects.
   */
  async register(input: { grantId: string; rootPath: string; displayLabel: string; ttlMs?: number }): Promise<boolean> {
    if (typeof input.grantId !== "string" || !GRANT_ID_PATTERN.test(input.grantId)) return false;
    if (!validRootPath(input.rootPath) || !validLabelText(input.displayLabel)) return false;
    if (this.grants.has(input.grantId)) return false;
    try {
      const stat = await fs.lstat(input.rootPath);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const real = await fs.realpath(input.rootPath);
      if (real !== input.rootPath) return false;
    } catch {
      return false;
    }
    this.sweepExpired();
    if (this.grants.size >= MAX_PENDING_DESKTOP_FOLDER_GRANTS) return false;
    const ttl = input.ttlMs === undefined ? DESKTOP_FOLDER_GRANT_TTL_MS : input.ttlMs;
    if (!Number.isSafeInteger(ttl) || ttl < 1) return false;
    this.grants.set(input.grantId, {
      rootPath: input.rootPath,
      displayLabel: input.displayLabel,
      expiresAt: this.now() + ttl,
    });
    return true;
  }

  /**
   * Consume a grant for one authenticated account. Consume-once: the record
   * is destroyed here regardless of outcome, and the consuming account id is
   * recorded by the caller's connection-creation transaction. Expired or
   * unknown grants raise the single actionable error; there is deliberately
   * no way to distinguish "expired" from "already used" to a caller.
   */
  async consume(accountId: string, grantId: string): Promise<DesktopFolderGrantConsumption> {
    if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new DesktopFolderGrantUnavailableError();
    }
    if (typeof grantId !== "string" || !GRANT_ID_PATTERN.test(grantId)) {
      throw new DesktopFolderGrantUnavailableError();
    }
    const record = this.grants.get(grantId);
    this.grants.delete(grantId);
    if (!record || record.expiresAt <= this.now()) throw new DesktopFolderGrantUnavailableError();
    return Object.freeze({ root_path: record.rootPath, display_label: record.displayLabel });
  }

  clearForTesting(): void {
    this.grants.clear();
  }
}

/** The process-wide backend registry; main never sees its contents. */
export const desktopFolderGrants = new DesktopFolderGrantRegistry();

export interface DesktopGrantHandoff {
  readonly grantId: string;
  readonly rootPath: string;
  readonly displayLabel: string;
}

/**
 * Strictly parse one main→backend utility-process message. Returns the
 * handoff fields only for an exactly well-formed, exactly four-key
 * `folder-grant` message; every other value (malformed, oversized, hostile,
 * or a different protocol kind) narrows to `null` without throwing.
 */
export function parseDesktopGrantMessage(message: unknown): DesktopGrantHandoff | null {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.type !== DESKTOP_FOLDER_GRANT_MESSAGE_TYPE) return null;
  const keys = Object.keys(record);
  if (keys.length !== 4 || !keys.every((key) => ["type", "grant_id", "root_path", "display_label"].includes(key))) {
    return null;
  }
  const grantId = record.grant_id;
  const rootPath = record.root_path;
  const displayLabel = record.display_label;
  if (
    typeof grantId !== "string" ||
    !GRANT_ID_PATTERN.test(grantId) ||
    !validRootPath(rootPath) ||
    !validLabelText(displayLabel)
  ) {
    return null;
  }
  return Object.freeze({ grantId, rootPath, displayLabel });
}

/**
 * Accept one handoff message and register it as a pending grant. The path
 * proof is asynchronous; `false` means the message or the path failed closed.
 * The desktop host fires this without awaiting (a bad grant is simply
 * absent when a connection attempt asks for it); tests await it for
 * determinism.
 */
export function acceptDesktopGrantMessage(
  message: unknown,
  registry: DesktopFolderGrantRegistry = desktopFolderGrants
): Promise<boolean> {
  const handoff = parseDesktopGrantMessage(message);
  if (!handoff) return Promise.resolve(false);
  return registry
    .register({ grantId: handoff.grantId, rootPath: handoff.rootPath, displayLabel: handoff.displayLabel })
    .catch(() => false);
}
