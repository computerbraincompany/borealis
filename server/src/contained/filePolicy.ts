/**
 * Pre-spawn file proof for the contained engine.
 *
 * At the final proof the model must be a non-symlink regular file contained
 * below the canonical contained-model directory, and the binary must be a
 * non-symlink executable regular file whose recomputed SHA-256 matches the
 * configured digest. Both are opened without following the final symlink,
 * and the identity captured from the open handle is rechecked against the
 * canonical paths immediately before spawn.
 *
 * Threat-model boundary (plan 007): the final stat closes deterministic
 * application races. Node exposes no portable `fexecve` and macOS cannot
 * execute the current binary through `/dev/fd`, so this proves replacement
 * detection at the last pre-spawn boundary; it is not an OS sandbox and it
 * does not claim to defeat a hostile process with the same OS-user
 * filesystem authority in the remaining kernel-open window.
 */
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { ContainedConfigError, type ContainedConfig } from "./configStore.js";

/**
 * Internal download-partial directory basename, shared with Plan 008's
 * download manager. Together with the dot-only names and the
 * `.part` suffix below this forms one filename contract: change the
 * predicate and both suites together.
 */
export const RESERVED_PARTIALS_BASENAME = ".borealis-partials";

const DOT_ONLY_NAME = /^\.+$/;

/**
 * Reserved-artifact predicate (ASCII case-folded). A model basename can
 * never be dot-only, the reserved partials directory name, or end in
 * `.part`; an active or abandoned download partial can therefore never be
 * selected as a spawnable model file even when it is otherwise a regular
 * file below the root.
 */
export function isReservedArtifactBasename(basename: string): boolean {
  const folded = basename.toLowerCase();
  if (DOT_ONLY_NAME.test(folded)) return true;
  if (folded === RESERVED_PARTIALS_BASENAME) return true;
  return folded.endsWith(".part");
}

/** High-resolution identity fields from a bigint stat. */
interface BigIntStatsLike {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Open-handle/path identity retained from the proof-time `fstat`. */
interface RetainedIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/**
 * Disposable proof returned to the engine manager. It carries only canonical
 * paths and the still-open handles; the caller closes it on every
 * success/failure/stop path.
 */
export interface EngineFileProof {
  readonly binaryPath: string;
  readonly modelPath: string;
  /**
   * Re-stat both canonical paths and compare device, inode, size, and
   * high-resolution modification/change timestamps against the retained
   * open-handle identities. Call immediately before spawn.
   */
  verifyIdentity(): Promise<void>;
  close(): Promise<void>;
}

function retained(stat: BigIntStatsLike): RetainedIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameIdentity(a: RetainedIdentity, b: RetainedIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function openNoFollow(filePath: string, field: string): Promise<fs.FileHandle> {
  try {
    // O_NOFOLLOW refuses to open the path when its final component is a
    // symlink; the explicit lstat checks below cover the rest of the walk.
    return await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new ContainedConfigError(`${field} does not exist`);
  }
}

async function handleIdentity(handle: fs.FileHandle, field: string, what: string): Promise<RetainedIdentity> {
  const stat = (await handle.stat({ bigint: true })) as unknown as BigIntStatsLike & { isFile(): boolean };
  if (!stat.isFile()) throw new ContainedConfigError(`${field} must be a regular ${what}`);
  return retained(stat);
}

/** Binary: exact resolution, non-symlink regular file, executable, digest. */
async function proveBinary(
  binaryPathRaw: string,
  expectedDigestHex: string
): Promise<{
  binaryPath: string;
  handle: fs.FileHandle;
  identity: RetainedIdentity;
}> {
  const binaryPath = path.resolve(binaryPathRaw);
  let real: string;
  try {
    real = await fs.realpath(binaryPath);
  } catch {
    throw new ContainedConfigError("binary_path does not exist");
  }
  // The final component may not be a symlink; canonicalize the parent so a
  // symlinked ancestor above the binary (allowed by the OS) is tolerated the
  // same way the model root tolerates it, while any final-link swap is caught.
  const expectedReal = path.join(path.dirname(real), path.basename(binaryPath));
  if (real !== expectedReal) throw new ContainedConfigError("binary_path must not be a symlink");
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(binaryPath);
  } catch {
    throw new ContainedConfigError("binary_path does not exist");
  }
  if (stat.isSymbolicLink()) throw new ContainedConfigError("binary_path must not be a symlink");
  if (!stat.isFile()) throw new ContainedConfigError("binary_path must be a regular binary");
  try {
    await fs.access(binaryPath, fsConstants.X_OK);
  } catch {
    throw new ContainedConfigError("binary_path is not executable");
  }
  const handle = await openNoFollow(binaryPath, "binary_path");
  try {
    const identity = await handleIdentity(handle, "binary_path", "binary");
    const hash = crypto.createHash("sha256");
    for await (const chunk of handle.createReadStream()) hash.update(chunk as Buffer);
    const expected = Buffer.from(expectedDigestHex, "hex");
    const actual = hash.digest();
    if (expected.length !== 32 || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw new ContainedConfigError("binary_path does not match its configured digest");
    }
    return { binaryPath, handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/** Model: reserved names rejected first, then containment below the root. */
async function proveModel(modelPathRaw: string): Promise<string> {
  const modelPath = path.resolve(modelPathRaw);
  const basename = path.basename(modelPath);
  if (isReservedArtifactBasename(basename)) {
    throw new ContainedConfigError("model_path selects a reserved partial or invalid artifact name");
  }
  const root = path.resolve(config.containedDir);
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    throw new ContainedConfigError("contained model root is unavailable");
  }
  if (rootStat.isSymbolicLink()) throw new ContainedConfigError("contained model root must not be a symlink");
  if (!rootStat.isDirectory()) throw new ContainedConfigError("contained model root must be a directory");
  const rootReal = await fs.realpath(root);
  const rel = path.relative(root, modelPath);
  if (rel === "" || rel === ".") throw new ContainedConfigError("model_path must not be the model root");
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ContainedConfigError("model_path must reside below the contained model directory");
  }
  const expectedParent = path.join(rootReal, path.dirname(rel));
  let realParent: string;
  try {
    realParent = await fs.realpath(path.dirname(modelPath));
  } catch {
    throw new ContainedConfigError("model_path does not exist");
  }
  // Any symlinked directory component resolves to a different real parent.
  if (realParent !== expectedParent) {
    throw new ContainedConfigError("model_path must not traverse symlinked directories");
  }
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(modelPath);
  } catch {
    throw new ContainedConfigError("model_path does not exist");
  }
  if (stat.isSymbolicLink()) throw new ContainedConfigError("model_path must not be a symlink");
  if (!stat.isFile()) throw new ContainedConfigError("model_path must be a regular file");
  return modelPath;
}

/**
 * Proves the enabled configuration's binary and model at the final
 * pre-spawn boundary and returns the retained proof. The caller runs its
 * port reservation and `verifyIdentity()` immediately before spawn.
 */
export async function proveEngineFiles(configValue: ContainedConfig): Promise<EngineFileProof> {
  const {
    binaryPath,
    handle: binaryHandle,
    identity: binaryIdentity,
  } = await proveBinary(configValue.binary_path, configValue.binary_sha256);
  let modelHandle: fs.FileHandle | undefined;
  try {
    const modelPath = await proveModel(configValue.model_path);
    modelHandle = await openNoFollow(modelPath, "model_path");
    const modelIdentity = await handleIdentity(modelHandle, "model_path", "file");
    let closed = false;
    return {
      binaryPath,
      modelPath,
      async verifyIdentity() {
        for (const [pathname, identity, field] of [
          [binaryPath, binaryIdentity, "binary_path"],
          [modelPath, modelIdentity, "model_path"],
        ] as const) {
          let stat: unknown;
          try {
            stat = await fs.stat(pathname, { bigint: true });
          } catch {
            throw new ContainedConfigError(`${field} changed during the pre-spawn proof`);
          }
          if (!sameIdentity(identity, retained(stat as BigIntStatsLike))) {
            throw new ContainedConfigError(`${field} changed during the pre-spawn proof`);
          }
        }
      },
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all([binaryHandle.close().catch(() => undefined), modelHandle?.close().catch(() => undefined)]);
      },
    };
  } catch (error) {
    await binaryHandle.close().catch(() => undefined);
    await modelHandle?.close().catch(() => undefined);
    throw error;
  }
}
