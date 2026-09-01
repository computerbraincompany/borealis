import { timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";

import {
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  removeWorkspaceBackup,
  restoreWorkspaceArchive,
  type WorkspaceArchiveAddition,
} from "./workspaceArchive.js";
import { acquireWorkspaceLock } from "./workspaceLock.js";
import { verifyWorkspaceStores } from "./workspaceVerifier.js";

interface ParsedArguments {
  readonly command: "create" | "inspect" | "restore" | "verify" | "remove-backup";
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const unsafePlaintext = parsed.flags.has("unsafe-plaintext");
  const passphrase = unsafePlaintext ? undefined : await readPassphrase(parsed);
  try {
    switch (parsed.command) {
      case "create": {
        const summary = await createWorkspaceArchive({
          workspaceDirectory: one(parsed, "workspace"),
          destination: one(parsed, "output"),
          ...(passphrase ? { passphrase } : {}),
          unsafePlaintext,
          additions: additions(parsed),
        });
        writeSummary("created", summary);
        break;
      }
      case "inspect": {
        const summary = await inspectWorkspaceArchive({
          archive: one(parsed, "archive"),
          ...(passphrase ? { passphrase } : {}),
          allowUnsafePlaintext: unsafePlaintext,
        });
        writeSummary("verified", summary);
        break;
      }
      case "restore": {
        const dimension = optionalDimension(parsed);
        const summary = await restoreWorkspaceArchive({
          archive: one(parsed, "archive"),
          targetDirectory: one(parsed, "target"),
          ...(passphrase ? { passphrase } : {}),
          allowUnsafePlaintext: unsafePlaintext,
          ...(dimension === undefined ? {} : { embeddingDimension: dimension }),
        });
        writeSummary("restored", summary);
        break;
      }
      case "verify": {
        const workspace = one(parsed, "workspace");
        const lock = await acquireWorkspaceLock(workspace);
        try {
          const result = await verifyWorkspaceStores({
            workspaceDirectory: workspace,
            ...(optionalDimension(parsed) === undefined ? {} : { embeddingDimension: optionalDimension(parsed) }),
          });
          process.stdout.write(`${JSON.stringify({ status: "verified", ...result })}\n`);
        } finally {
          await lock.release();
        }
        break;
      }
      case "remove-backup": {
        await removeWorkspaceBackup(one(parsed, "target"), one(parsed, "backup"), optionalDimension(parsed));
        process.stdout.write(`${JSON.stringify({ status: "removed" })}\n`);
        break;
      }
    }
  } finally {
    passphrase?.fill(0);
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (!["create", "inspect", "restore", "verify", "remove-backup"].includes(command ?? "")) {
    throw new TypeError("invalid command");
  }
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const allowedFlags = new Set(["unsafe-plaintext"]);
  const allowedValues = new Set([
    "workspace",
    "output",
    "archive",
    "target",
    "backup",
    "dimension",
    "include",
    "passphrase-fd",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new TypeError("invalid argument");
    const name = token.slice(2);
    if (allowedFlags.has(name)) {
      if (flags.has(name)) throw new TypeError("duplicate flag");
      flags.add(name);
      continue;
    }
    if (!allowedValues.has(name)) throw new TypeError("unknown option");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new TypeError("missing option value");
    const existing = values.get(name) ?? [];
    if (name !== "include" && existing.length) throw new TypeError("duplicate option");
    existing.push(value);
    values.set(name, existing);
  }
  return Object.freeze({ command: command as ParsedArguments["command"], values, flags });
}

async function readPassphrase(parsed: ParsedArguments): Promise<Buffer | undefined> {
  if (parsed.command === "verify" || parsed.command === "remove-backup") return undefined;
  const descriptorValue = parsed.values.get("passphrase-fd")?.[0];
  if (descriptorValue !== undefined) {
    if (!/^\d+$/.test(descriptorValue)) throw new TypeError("passphrase descriptor is invalid");
    const descriptor = Number(descriptorValue);
    if (!Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 1_024) {
      throw new TypeError("passphrase descriptor is invalid");
    }
    const handle = await fs.open(`/dev/fd/${descriptor}`, "r");
    try {
      return normalizePassphrase(await handle.readFile());
    } finally {
      await handle.close();
    }
  }
  const environment = process.env.BOREALIS_ARCHIVE_PASSPHRASE;
  if (environment !== undefined) return normalizePassphrase(Buffer.from(environment, "utf8"));
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const first = await promptForPassphrase("Archive passphrase: ");
    if (parsed.command !== "create") return first;
    const confirmation = await promptForPassphrase("Confirm archive passphrase: ");
    const matches = first.length === confirmation.length && timingSafeEqual(first, confirmation);
    confirmation.fill(0);
    if (matches) return first;
    first.fill(0);
    throw new TypeError("archive passphrases do not match");
  }
  throw new TypeError("archive passphrase is unavailable");
}

async function promptForPassphrase(prompt: string): Promise<Buffer> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function")
    throw new TypeError("interactive terminal is unavailable");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const wasRaw = input.isRaw;
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  let result: Buffer | undefined;
  try {
    result = await new Promise<Buffer>((resolve, reject) => {
      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
        for (const byte of buffer) {
          if (byte === 3) {
            input.off("data", onData);
            reject(new Error("passphrase entry cancelled"));
            return;
          }
          if (byte === 10 || byte === 13) {
            input.off("data", onData);
            resolve(Buffer.concat(chunks, bytes));
            return;
          }
          if (byte === 8 || byte === 127) {
            const prior = chunks.pop();
            if (prior) bytes -= prior.length;
            continue;
          }
          if (bytes >= 4_096) {
            input.off("data", onData);
            reject(new Error("passphrase is too long"));
            return;
          }
          const value = Buffer.from([byte]);
          chunks.push(value);
          bytes += 1;
        }
      };
      input.on("data", onData);
    });
    return result;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write("\n");
  }
}

function normalizePassphrase(input: Buffer): Buffer {
  const result = Buffer.from(input.toString("utf8").replace(/[\r\n]+$/, ""), "utf8");
  input.fill(0);
  return result;
}

function one(parsed: ParsedArguments, name: string): string {
  const values = parsed.values.get(name);
  if (!values || values.length !== 1) throw new TypeError(`missing ${name}`);
  return values[0]!;
}

function optionalDimension(parsed: ParsedArguments): number | undefined {
  const value = parsed.values.get("dimension")?.[0];
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new TypeError("dimension is invalid");
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 16_384) {
    throw new TypeError("dimension is invalid");
  }
  return dimension;
}

function additions(parsed: ParsedArguments): readonly WorkspaceArchiveAddition[] {
  return Object.freeze(
    (parsed.values.get("include") ?? []).map((value) => {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) throw new TypeError("include is invalid");
      return Object.freeze({ name: value.slice(0, separator), path: value.slice(separator + 1) });
    })
  );
}

function writeSummary(status: string, summary: object): void {
  process.stdout.write(`${JSON.stringify({ status, ...summary })}\n`);
}

await main().catch(() => {
  process.stderr.write("Workspace archive command failed.\n");
  process.exitCode = 1;
});
