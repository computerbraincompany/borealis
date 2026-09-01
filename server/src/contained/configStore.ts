import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export const MAX_CONTAINED_EXTRA_ARGS = 32;
export const MAX_CONTAINED_ARG_CHARS = 200;

export interface ContainedConfig {
  readonly enabled: boolean;
  readonly binary_path: string;
  readonly model_path: string;
  readonly extra_args: readonly string[];
}

export class ContainedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainedConfigError";
  }
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
  if (!enabled) return { enabled: false, binary_path: "", model_path: "", extra_args: Object.freeze([]) };
  const binaryPath = requireAbsoluteFilePath(record.binary_path, "binary_path");
  const modelPath = requireAbsoluteFilePath(record.model_path, "model_path");
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
  return Object.freeze({ enabled: true, binary_path: binaryPath, model_path: modelPath, extra_args: extraArgs });
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
  extraArgs?: readonly string[];
}): Promise<ContainedConfig> {
  // Validate through the same decoder the reader uses so stored and read
  // shapes can never drift.
  const normalized = decode({
    enabled: input.enabled,
    binary_path: input.binaryPath ?? "",
    model_path: input.modelPath ?? "",
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
