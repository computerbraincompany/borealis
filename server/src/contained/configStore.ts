import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export const MAX_CONTAINED_EXTRA_ARGS = 32;
export const MAX_CONTAINED_ARG_CHARS = 200;

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * An enabled contained configuration. `binary_sha256` is the operator-declared
 * expected SHA-256 of the engine binary, recomputed and verified against the
 * open file handle immediately before every spawn. It is durable state: it is
 * never returned through HTTP and never logged.
 */
export interface ContainedConfig {
  readonly enabled: boolean;
  readonly binary_path: string;
  readonly model_path: string;
  readonly binary_sha256: string;
  readonly extra_args: readonly string[];
}

export class ContainedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainedConfigError";
  }
}

/**
 * llama-server flags that restate or override fixed process authority: the
 * model selection and the listen address/port. The manager always passes the
 * canonical `-m <model> --host 127.0.0.1 --port <n>` prefix, so any spelling
 * of these flags in `extra_args` is rejected: the bare token (covering its
 * following-value form), the `--flag=value` form, and the short `-m=value`
 * form. Legitimate tuning flags such as `-ngl`, `-t`, or `-mlock` stay
 * allowed.
 */
const RESERVED_EXTRA_ARG_TOKENS = new Set(["-m", "--model", "--host", "--port"]);
const RESERVED_EXTRA_ARG_PREFIXES = ["-m=", "--model=", "--host=", "--port="];

/** Throws unless no argument can override the fixed model/host/port flags. */
export function assertContainedExtraArgs(args: readonly string[]): void {
  for (const argument of args) {
    if (RESERVED_EXTRA_ARG_TOKENS.has(argument)) {
      throw new ContainedConfigError("extra_args cannot restate the reserved model, host, or port flags");
    }
    for (const prefix of RESERVED_EXTRA_ARG_PREFIXES) {
      if (argument.startsWith(prefix)) {
        throw new ContainedConfigError("extra_args cannot restate the reserved model, host, or port flags");
      }
    }
  }
}

function requireBinaryDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    // Generic reconfiguration failure: it names the problem without echoing
    // the (possibly corrupt) stored digest.
    throw new ContainedConfigError(
      "contained configuration requires reconfiguration: an enabled engine needs a verified 64-character binary_sha256"
    );
  }
  return value.toLowerCase();
}

function containedConfigFile(): string {
  return path.join(config.storageDir, "contained.json");
}

function requireAbsoluteFilePath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ContainedConfigError(`${field} must be a path string`);
  if (value.includes("\0") || value.includes("~")) throw new ContainedConfigError(`${field} must not contain ~ or NUL`);
  if (!path.isAbsolute(value)) throw new ContainedConfigError(`${field} must be an absolute path`);
  return path.resolve(value);
}

function decode(raw: unknown): ContainedConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ContainedConfigError("contained config is malformed");
  const record = raw as Record<string, unknown>;
  const enabled = record.enabled;
  if (typeof enabled !== "boolean") throw new ContainedConfigError("contained config needs a boolean enabled flag");
  if (!enabled)
    return { enabled: false, binary_path: "", model_path: "", binary_sha256: "", extra_args: Object.freeze([]) };
  const binaryPath = requireAbsoluteFilePath(record.binary_path, "binary_path");
  const modelPath = requireAbsoluteFilePath(record.model_path, "model_path");
  // Enabled configs predate the digest only by failing closed: a missing or
  // malformed digest can never reach a spawn.
  const binarySha256 = requireBinaryDigest(record.binary_sha256);
  const rawArgs = record.extra_args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_CONTAINED_EXTRA_ARGS) {
    throw new ContainedConfigError(`extra_args must hold at most ${MAX_CONTAINED_EXTRA_ARGS} items`);
  }
  const extraArgs = rawArgs.map((argument) => {
    if (
      typeof argument !== "string" ||
      argument.length < 1 ||
      argument.length > MAX_CONTAINED_ARG_CHARS ||
      argument.includes("\0")
    ) {
      throw new ContainedConfigError("each extra_arg must be 1-200 characters");
    }
    return argument;
  });
  assertContainedExtraArgs(extraArgs);
  return Object.freeze({
    enabled: true,
    binary_path: binaryPath,
    model_path: modelPath,
    binary_sha256: binarySha256,
    extra_args: extraArgs,
  });
}

/** Reads the contained configuration; a malformed file fails closed. */
export async function readContainedConfig(): Promise<ContainedConfig | null> {
  try {
    const raw = await fs.readFile(containedConfigFile(), "utf8");
    if (raw.length > 64 * 1024) throw new ContainedConfigError("contained config is too large");
    return decode(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ContainedConfigError) throw error;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new ContainedConfigError("contained config is not valid JSON");
    throw error;
  }
}

/** Same-directory fsync hardening, matching the settings-store writer. */
async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch {
    // The file itself was fsynced; directory fsync is a best-effort portability hardening.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Same-directory atomic replacement modeled on the settings-store writer: the
 * payload lands in a uniquely named temp file created with mode 0600 and is
 * then renamed over the target, so readers only ever see a complete file and a
 * pre-existing widened mode is repaired by the fresh 0600 inode.
 */
async function writeContainedConfigFileAtomically(filename: string, payload: string): Promise<void> {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(payload, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filename);
    await fs.chmod(filename, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeContainedConfig(input: {
  enabled: boolean;
  binaryPath?: string;
  modelPath?: string;
  binarySha256?: string;
  extraArgs?: readonly string[];
}): Promise<ContainedConfig> {
  // Validate through the same decoder the reader uses so stored and read
  // shapes can never drift.
  const normalized = decode({
    enabled: input.enabled,
    binary_path: input.binaryPath ?? "",
    model_path: input.modelPath ?? "",
    binary_sha256: input.binarySha256 ?? "",
    extra_args: input.extraArgs ?? [],
  });
  if (!normalized) throw new ContainedConfigError("an enabled config needs binary and model paths");
  await writeContainedConfigFileAtomically(containedConfigFile(), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/** Test seam: forget the stored configuration. */
export async function clearContainedConfig(): Promise<void> {
  await fs.rm(containedConfigFile(), { force: true });
}
