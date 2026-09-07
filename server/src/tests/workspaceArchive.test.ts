import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";

import Database from "better-sqlite3";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LATEST_SQLITE_SCHEMA_VERSION } from "../db/migrations.js";
import { openSqliteLedger } from "../db/sqlite.js";
import {
  createWorkspaceArchive,
  inspectWorkspaceArchive,
  removeWorkspaceBackup,
  restoreWorkspaceArchive,
} from "../workspaceArchive.js";
import { acquireWorkspaceLock, WorkspaceLockedError } from "../workspaceLock.js";
import { verifyWorkspaceStores } from "../workspaceVerifier.js";
import { LanceVectorIndex } from "../vector/lance.js";

import { populateWaveLedger } from "./waveWorkspaceFixture.js";

const PASSPHRASE = "correct horse battery staple";
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

interface ManifestEntry {
  path: string;
  kind: "directory" | "file";
  size: number;
  mode: "directory" | "executable" | "file" | "secret";
  sha256: string;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-archive-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function makeWorkspace(parent: string, name = "workspace"): Promise<string> {
  const workspace = path.join(parent, name);
  await fs.mkdir(workspace);
  const exactWorkspace = await fs.realpath(workspace);
  const ledger = await openSqliteLedger({ path: path.join(exactWorkspace, "borealis.sqlite") });
  await ledger.close();
  const vectors = await LanceVectorIndex.open({
    directory: path.join(exactWorkspace, "lancedb"),
    dimension: 3,
    embeddingModel: "nomic-embed",
  });
  await vectors.close();
  await fs.mkdir(path.join(exactWorkspace, "uploads", "account", "source"), { recursive: true });
  await fs.writeFile(path.join(exactWorkspace, "uploads", "account", "source", "document.txt"), "private text\n");
  await fs.writeFile(path.join(exactWorkspace, "jwt.secret"), "not-a-real-jwt-secret\n", { mode: 0o600 });
  await fs.writeFile(path.join(exactWorkspace, "settings.json"), `${JSON.stringify({ embedding_dimension: 3 })}\n`, {
    mode: 0o600,
  });
  return exactWorkspace;
}

async function makeVerifiableWorkspace(parent: string, name: string): Promise<string> {
  return makeWorkspace(parent, name);
}

async function addReadyCsvDataset(workspace: string): Promise<{ accountId: string; sourceId: string; file: string }> {
  const accountId = randomUUID();
  const sourceId = randomUUID();
  const file = path.join(workspace, "uploads", accountId, sourceId, "ledger.csv");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "month,amount\n2026-01,42\n");
  const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
  try {
    await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      `${accountId}@example.test`,
      "not-a-real-password-hash",
    ]);
    await ledger.run(
      `INSERT INTO sources
         (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sourceId, accountId, "ledger", "tabular", "Ledger.csv", file, "text/csv", 27, "ready", "{}"]
    );
  } finally {
    await ledger.close();
  }
  return { accountId, sourceId, file };
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    stream as Readable,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    })
  );
  return Buffer.concat(chunks);
}

async function packEntry(
  pack: ReturnType<typeof tar.pack>,
  header: Parameters<tar.Pack["entry"]>[0],
  body: Buffer = Buffer.alloc(0)
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    pack.entry(header, body, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function plaintextHeader(): Buffer {
  const header = Buffer.alloc(64);
  Buffer.from("BOREALIS-WORKSP\0", "ascii").copy(header);
  header.writeUInt8(1, 16);
  return header;
}

async function writeCraftedPlaintextArchive(
  filename: string,
  entries: readonly ManifestEntry[],
  writeMembers?: (pack: ReturnType<typeof tar.pack>) => Promise<void>
): Promise<void> {
  await writeRawManifestPlaintextArchive(
    filename,
    Buffer.from(
      `${JSON.stringify({ version: 1, entries, total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0) })}\n`
    ),
    writeMembers
  );
}

async function writeRawManifestPlaintextArchive(
  filename: string,
  manifest: Buffer,
  writeMembers?: (pack: ReturnType<typeof tar.pack>) => Promise<void>
): Promise<void> {
  const pack = tar.pack();
  const collecting = collect(pack as unknown as NodeJS.ReadableStream);
  await packEntry(
    pack,
    {
      name: ".borealis-manifest.json",
      type: "file",
      size: manifest.length,
      mode: 0o600,
    },
    manifest
  );
  await writeMembers?.(pack);
  pack.finalize();
  const tarBytes = await collecting;
  await fs.writeFile(filename, Buffer.concat([plaintextHeader(), gzipSync(tarBytes)]), { mode: 0o600 });
}

interface ManifestDocument {
  entries: ManifestEntry[];
  total_bytes: number;
}

async function readPlaintextManifest(archive: string): Promise<ManifestDocument> {
  const bytes = await fs.readFile(archive);
  const stream = Readable.from(gunzipSync(bytes.subarray(64)));
  const extract = tar.extract();
  const transport = pipeline(stream, extract as unknown as Writable);
  let manifest: ManifestDocument | undefined;
  for await (const entry of extract) {
    const body = await collect(entry as unknown as NodeJS.ReadableStream);
    if (!manifest && entry.header.name === ".borealis-manifest.json") {
      manifest = JSON.parse(body.toString("utf8")) as ManifestDocument;
    }
  }
  await transport;
  if (!manifest) throw new Error("crafted archive has no manifest");
  return manifest;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  );
});

describe("portable workspace archives", () => {
  // Real native storage/CLI work needs room on shared CI; product deadlines stay unchanged.
  it("accepts the separator forwarded by the documented pnpm archive command", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "cli.borealis-workspace");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/workspaceArchiveCli.ts", "--", "create", "--workspace", workspace, "--output", archive],
      { cwd: process.cwd(), env: { ...process.env, BOREALIS_ARCHIVE_PASSPHRASE: PASSPHRASE }, timeout: 20_000 }
    );
    expect(JSON.parse(stdout)).toMatchObject({ status: "created", encrypted: true });
    await expect(inspectWorkspaceArchive({ archive, passphrase: PASSPHRASE })).resolves.toMatchObject({
      encrypted: true,
    });
  }, 30_000);

  it("round-trips an encrypted workspace and preserves an existing target as a recoverable backup", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "workspace.borealis-workspace");
    const target = path.join(parent, "restored");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old-marker"), "original workspace\n");

    const created = await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
    });
    expect(created).toMatchObject({ version: 1, encrypted: true });
    expect((await fs.stat(archive)).mode & 0o777).toBe(0o600);
    await expect(inspectWorkspaceArchive({ archive, passphrase: PASSPHRASE })).resolves.toEqual(created);

    const restored = await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });
    expect(restored).toEqual({ ...created, backup_created: true });
    expect(await fs.readFile(path.join(target, "uploads", "account", "source", "document.txt"), "utf8")).toBe(
      "private text\n"
    );
    expect((await fs.stat(path.join(target, "jwt.secret"))).mode & 0o777).toBe(0o600);

    const backups = (await fs.readdir(parent)).filter((name) => name.startsWith(".restored.backup."));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(parent, backups[0]!, "old-marker"), "utf8")).toBe("original workspace\n");
  });

  it("requires explicit opt-in at creation and at every read of a plaintext archive", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "plaintext.borealis-workspace");

    const created = await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      unsafePlaintext: true,
    });
    expect(created.encrypted).toBe(false);
    await expect(inspectWorkspaceArchive({ archive })).rejects.toThrow("workspace archive could not be verified");
    await expect(inspectWorkspaceArchive({ archive, allowUnsafePlaintext: true })).resolves.toEqual(created);
    await expect(
      restoreWorkspaceArchive({ archive, targetDirectory: path.join(parent, "blocked"), verifyStores: false })
    ).rejects.toThrow("workspace archive could not be verified");
    await expect(
      restoreWorkspaceArchive({
        archive,
        targetDirectory: path.join(parent, "allowed"),
        allowUnsafePlaintext: true,
        verifyStores: false,
      })
    ).resolves.toMatchObject({ encrypted: false, backup_created: false });
  });

  it("archives explicitly named relocated additions and restores conservative modes", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const relocatedInput = path.join(parent, "external-model-directory");
    await fs.mkdir(path.join(relocatedInput, "weights"), { recursive: true, mode: 0o755 });
    const relocated = await fs.realpath(relocatedInput);
    await fs.mkdir(path.join(relocated, "bin"), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(relocated, "weights", "model.gguf"), "model bytes\n", { mode: 0o644 });
    await fs.writeFile(path.join(relocated, "bin", "llama-server"), "engine bytes\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(workspace, "contained.json"),
      `${JSON.stringify({
        enabled: true,
        binary_path: path.join(relocated, "bin", "llama-server"),
        model_path: path.join(relocated, "weights", "model.gguf"),
        extra_args: [],
      })}\n`,
      { mode: 0o600 }
    );
    const archive = path.join(parent, "with-relocated.borealis-workspace");
    const target = path.join(parent, "restored-relocated");

    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
      additions: [{ name: "contained-model", path: relocated }],
    });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });

    expect(await fs.readFile(path.join(target, "relocated", "contained-model", "weights", "model.gguf"), "utf8")).toBe(
      "model bytes\n"
    );
    for (const directory of [
      target,
      path.join(target, "relocated"),
      path.join(target, "relocated", "contained-model"),
      path.join(target, "relocated", "contained-model", "weights"),
    ]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.stat(path.join(target, "uploads", "account", "source", "document.txt"))).mode & 0o777).toBe(0o600);
    expect(
      (await fs.stat(path.join(target, "relocated", "contained-model", "weights", "model.gguf"))).mode & 0o777
    ).toBe(0o600);
    expect((await fs.stat(path.join(target, "relocated", "contained-model", "bin", "llama-server"))).mode & 0o777).toBe(
      0o700
    );
    const exactTarget = await fs.realpath(target);
    await expect(fs.readFile(path.join(target, "contained.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      binary_path: path.join(exactTarget, "relocated", "contained-model", "bin", "llama-server"),
      model_path: path.join(exactTarget, "relocated", "contained-model", "weights", "model.gguf"),
    });
  });

  it("restores explicitly relocated core stores at their portable root paths", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeVerifiableWorkspace(parent, "relocated-core-source");
    const identity = await addReadyCsvDataset(workspace);
    const external = path.join(parent, "external-core");
    await fs.mkdir(external);
    const sqlite = path.join(external, "operator-ledger.sqlite");
    const lancedb = path.join(external, "operator-vectors");
    const uploads = path.join(external, "operator-uploads");
    const reports = path.join(external, "operator-reports");
    const models = path.join(external, "operator-models");
    const settings = path.join(external, "operator-settings.json");
    const contained = path.join(external, "operator-contained.json");
    const jwtSecret = path.join(external, "operator-jwt.key");
    const externalDataset = path.join(uploads, identity.accountId, identity.sourceId, path.basename(identity.file));
    const reportId = randomUUID();
    const cleanupReportId = randomUUID();
    const reportHtml = path.join(reports, `${reportId}.html`);
    const reportPdf = path.join(reports, `${reportId}.pdf`);
    const modelBinary = path.join(models, "bin", "llama-server");
    const modelWeights = path.join(models, "weights", "model.gguf");
    const cleanupLocation = path.join(uploads, "connector-cache", "old.csv");
    await Promise.all([
      fs.mkdir(reports),
      fs.mkdir(path.dirname(modelBinary), { recursive: true }),
      fs.mkdir(path.dirname(modelWeights), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(reportHtml, "<html>portable report</html>"),
      fs.writeFile(reportPdf, "%PDF-portable"),
      fs.writeFile(modelBinary, "engine bytes\n", { mode: 0o755 }),
      fs.writeFile(modelWeights, "model bytes\n", { mode: 0o600 }),
      fs.writeFile(
        contained,
        `${JSON.stringify({
          enabled: true,
          binary_path: modelBinary,
          model_path: modelWeights,
          extra_args: [],
        })}\n`,
        { mode: 0o600 }
      ),
    ]);

    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    try {
      await ledger.run("UPDATE sources SET file_path=? WHERE id=?", [externalDataset, identity.sourceId]);
      await ledger.run(
        "INSERT INTO reports (id,account_id,status,title,html_path,pdf_path) VALUES (?,?,'published','Portable',?,?)",
        [reportId, identity.accountId, reportHtml, reportPdf]
      );
      await ledger.run(
        "INSERT INTO report_artifact_cleanup_jobs (report_id,account_id,html_path,pdf_path) VALUES (?,?,?,?)",
        [cleanupReportId, identity.accountId, reportHtml, reportPdf]
      );
      await ledger.run("INSERT INTO dataset_cache_cleanup_jobs (account_id,name,location) VALUES (?,?,?)", [
        identity.accountId,
        "portable_cache",
        cleanupLocation,
      ]);
    } finally {
      await ledger.close();
    }
    await fs.rename(path.join(workspace, "borealis.sqlite"), sqlite);
    await fs.rename(path.join(workspace, "lancedb"), lancedb);
    await fs.rename(path.join(workspace, "uploads"), uploads);
    await fs.rename(path.join(workspace, "settings.json"), settings);
    await fs.rename(path.join(workspace, "jwt.secret"), jwtSecret);

    const archive = path.join(parent, "relocated-core.borealis-workspace");
    const target = path.join(parent, "relocated-core-restored");
    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
      additions: [
        { name: "borealis.sqlite", path: sqlite },
        { name: "lancedb", path: lancedb },
        { name: "uploads", path: uploads },
        { name: "reports", path: reports },
        { name: "models", path: models },
        { name: "settings.json", path: settings },
        { name: "contained.json", path: contained },
        { name: "jwt.secret", path: jwtSecret },
      ],
    });

    await expect(
      restoreWorkspaceArchive({
        archive,
        passphrase: PASSPHRASE,
        targetDirectory: target,
        embeddingDimension: 3,
      })
    ).resolves.toMatchObject({ backup_created: false });
    expect(await fs.readdir(target)).not.toContain("relocated");
    await expect(fs.readFile(path.join(target, "jwt.secret"), "utf8")).resolves.toBe("not-a-real-jwt-secret\n");
    await expect(fs.readFile(path.join(target, "settings.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      embedding_dimension: 3,
    });
    await expect(
      fs.readFile(path.join(target, "uploads", path.relative(uploads, externalDataset)), "utf8")
    ).resolves.toBe("month,amount\n2026-01,42\n");
    await expect(fs.readFile(path.join(target, "reports", path.basename(reportHtml)), "utf8")).resolves.toBe(
      "<html>portable report</html>"
    );
    expect((await fs.stat(path.join(target, "models", "bin", "llama-server"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target, "models", "weights", "model.gguf"))).mode & 0o777).toBe(0o600);
    const exactTarget = await fs.realpath(target);
    await expect(fs.readFile(path.join(target, "contained.json"), "utf8").then(JSON.parse)).resolves.toMatchObject({
      binary_path: path.join(exactTarget, "models", "bin", "llama-server"),
      model_path: path.join(exactTarget, "models", "weights", "model.gguf"),
    });
    const restoredLedger = await openSqliteLedger({ path: path.join(exactTarget, "borealis.sqlite") });
    try {
      await expect(
        restoredLedger.get<{ file_path: string }>("SELECT file_path FROM sources WHERE id=?", [identity.sourceId])
      ).resolves.toEqual({
        file_path: path.join(exactTarget, "uploads", path.relative(uploads, externalDataset)),
      });
      await expect(
        restoredLedger.get<{ html_path: string; pdf_path: string }>(
          "SELECT html_path,pdf_path FROM reports WHERE id=?",
          [reportId]
        )
      ).resolves.toEqual({
        html_path: path.join(exactTarget, "reports", path.basename(reportHtml)),
        pdf_path: path.join(exactTarget, "reports", path.basename(reportPdf)),
      });
      await expect(
        restoredLedger.get<{ html_path: string; pdf_path: string }>(
          "SELECT html_path,pdf_path FROM report_artifact_cleanup_jobs WHERE report_id=?",
          [cleanupReportId]
        )
      ).resolves.toEqual({
        html_path: path.join(exactTarget, "reports", path.basename(reportHtml)),
        pdf_path: path.join(exactTarget, "reports", path.basename(reportPdf)),
      });
      await expect(
        restoredLedger.get<{ location: string }>(
          "SELECT location FROM dataset_cache_cleanup_jobs WHERE account_id=? AND name=?",
          [identity.accountId, "portable_cache"]
        )
      ).resolves.toEqual({
        location: path.join(exactTarget, "uploads", path.relative(uploads, cleanupLocation)),
      });
    } finally {
      await restoredLedger.close();
    }
  });

  it("rejects reserved portable roots whose supplied entry has the wrong kind", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const lancedbFile = path.join(parent, "operator-vectors.file");
    const sqliteDirectory = path.join(parent, "operator-ledger.directory");
    await fs.writeFile(lancedbFile, "not a vector directory\n");
    await fs.mkdir(sqliteDirectory);

    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "wrong-lancedb-kind.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [{ name: "lancedb", path: lancedbFile }],
      })
    ).rejects.toThrow("addition lancedb must be a directory");
    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "wrong-sqlite-kind.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [{ name: "borealis.sqlite", path: sqliteDirectory }],
      })
    ).rejects.toThrow("addition borealis.sqlite must be a file");
  });

  it("rejects an external reserved root that collides with the canonical workspace root", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const externalLance = path.join(parent, "operator-vectors");
    await fs.mkdir(externalLance);

    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "canonical-root-collision.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [{ name: "lancedb", path: externalLance }],
      })
    ).rejects.toThrow("workspace path collision");
  });

  it("captures SQLite WAL and SHM sidecars for a relocated ledger", async () => {
    const parent = await temporaryDirectory();
    const workspace = path.join(parent, "sidecar-source");
    const external = path.join(parent, "sidecar-external");
    await fs.mkdir(workspace);
    await fs.mkdir(external);
    const sqlite = path.join(external, "custom-ledger.data");
    const lancedb = path.join(external, "custom-vectors");
    await fs.writeFile(sqlite, "not a live SQLite file\n");
    await fs.writeFile(`${sqlite}-wal`, "wal bytes\n");
    await fs.writeFile(`${sqlite}-shm`, "shm bytes\n");
    await fs.writeFile(`${sqlite}-journal`, "journal bytes\n");
    await fs.mkdir(lancedb);
    const archive = path.join(parent, "sidecars.borealis-workspace");
    const target = path.join(parent, "sidecars-restored");

    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
      additions: [
        { name: "borealis.sqlite", path: sqlite },
        { name: "lancedb", path: lancedb },
      ],
    });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });

    await expect(fs.readFile(path.join(target, "borealis.sqlite-wal"), "utf8")).resolves.toBe("wal bytes\n");
    await expect(fs.readFile(path.join(target, "borealis.sqlite-shm"), "utf8")).resolves.toBe("shm bytes\n");
    await expect(fs.readFile(path.join(target, "borealis.sqlite-journal"), "utf8")).resolves.toBe("journal bytes\n");
  });

  it("recovers a committed row that exists only in a relocated SQLite WAL", async () => {
    const parent = await temporaryDirectory();
    const liveDirectory = path.join(parent, "wal-live");
    const external = path.join(parent, "wal-copy");
    const workspace = path.join(parent, "wal-workspace");
    await Promise.all([fs.mkdir(liveDirectory), fs.mkdir(external), fs.mkdir(workspace)]);
    const liveSqlite = path.join(liveDirectory, "live.sqlite");
    const copiedSqlite = path.join(external, "copied-ledger.data");
    const database = new Database(liveSqlite);
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    database.exec("CREATE TABLE wal_probe (value TEXT NOT NULL); INSERT INTO wal_probe VALUES ('committed-in-wal')");
    expect((await fs.stat(`${liveSqlite}-wal`)).size).toBeGreaterThan(0);
    await fs.copyFile(liveSqlite, copiedSqlite);
    await fs.copyFile(`${liveSqlite}-wal`, `${copiedSqlite}-wal`);
    await fs.copyFile(`${liveSqlite}-shm`, `${copiedSqlite}-shm`);
    database.close();
    const lancedb = path.join(external, "vectors");
    await fs.mkdir(lancedb);
    const archive = path.join(parent, "real-wal.borealis-workspace");
    const target = path.join(parent, "real-wal-restored");

    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
      additions: [
        { name: "borealis.sqlite", path: copiedSqlite },
        { name: "lancedb", path: lancedb },
      ],
    });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });

    const restored = new Database(path.join(target, "borealis.sqlite"), { fileMustExist: true });
    try {
      expect(restored.prepare("SELECT value FROM wal_probe").get()).toEqual({ value: "committed-in-wal" });
    } finally {
      restored.close();
    }
  });

  it("rejects stale canonical SQLite sidecars instead of mixing ledger roots", async () => {
    const parent = await temporaryDirectory();
    const workspace = path.join(parent, "mixed-sidecar-workspace");
    const external = path.join(parent, "mixed-sidecar-external");
    await Promise.all([fs.mkdir(workspace), fs.mkdir(external)]);
    await fs.writeFile(path.join(workspace, "borealis.sqlite-wal"), "stale WAL\n");
    const sqlite = path.join(external, "external.sqlite");
    const lancedb = path.join(external, "vectors");
    await fs.writeFile(sqlite, "external ledger\n");
    await fs.mkdir(lancedb);

    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "mixed-sidecar.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [
          { name: "borealis.sqlite", path: sqlite },
          { name: "lancedb", path: lancedb },
        ],
      })
    ).rejects.toThrow("relocated SQLite files collide with the workspace root");
  });

  it("rebases durable paths written through a symlinked workspace parent", async () => {
    const parent = await temporaryDirectory();
    const canonicalParent = path.join(parent, "canonical-parent");
    const aliasParent = path.join(parent, "alias-parent");
    await fs.mkdir(canonicalParent);
    await fs.symlink(canonicalParent, aliasParent);
    const workspace = await makeVerifiableWorkspace(canonicalParent, "workspace");
    const aliasedWorkspace = path.join(aliasParent, path.basename(workspace));
    const identity = await addReadyCsvDataset(workspace);
    const aliasedFile = path.join(aliasedWorkspace, path.relative(workspace, identity.file));
    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    try {
      await ledger.run("UPDATE sources SET file_path=? WHERE id=?", [aliasedFile, identity.sourceId]);
    } finally {
      await ledger.close();
    }
    const archive = path.join(parent, "aliased.borealis-workspace");
    const target = path.join(parent, "restored-alias");

    await createWorkspaceArchive({
      workspaceDirectory: aliasedWorkspace,
      destination: archive,
      passphrase: PASSPHRASE,
    });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      embeddingDimension: 3,
    });

    const exactTarget = await fs.realpath(target);
    const restoredLedger = await openSqliteLedger({ path: path.join(exactTarget, "borealis.sqlite") });
    try {
      await expect(
        restoredLedger.get<{ file_path: string }>("SELECT file_path FROM sources WHERE id=?", [identity.sourceId])
      ).resolves.toEqual({
        file_path: path.join(exactTarget, path.relative(workspace, identity.file)),
      });
    } finally {
      await restoredLedger.close();
    }
  });

  it("produces deterministic plaintext archives for an unchanged workspace", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const first = path.join(parent, "first.borealis-workspace");
    const second = path.join(parent, "second.borealis-workspace");

    const firstSummary = await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: first,
      unsafePlaintext: true,
    });
    const secondSummary = await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: second,
      unsafePlaintext: true,
    });

    expect(secondSummary).toEqual(firstSummary);
    expect(await fs.readFile(second)).toEqual(await fs.readFile(first));
    const target = path.join(parent, "restored-deterministic");
    await restoreWorkspaceArchive({
      archive: first,
      targetDirectory: target,
      allowUnsafePlaintext: true,
      verifyStores: false,
    });
    await expect(verifyWorkspaceStores({ workspaceDirectory: target, embeddingDimension: 3 })).resolves.toMatchObject({
      chunks: 0,
      vectors: 0,
    });
  });

  it("refuses a destination anywhere inside the workspace and colliding addition names", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    await fs.mkdir(path.join(workspace, "reports"));
    const inside = path.join(workspace, "reports", "self.borealis-workspace");

    await expect(
      createWorkspaceArchive({ workspaceDirectory: workspace, destination: inside, passphrase: PASSPHRASE })
    ).rejects.toThrow("archive destination must be outside the workspace");
    await expect(fs.lstat(inside)).rejects.toMatchObject({ code: "ENOENT" });

    const addition = path.join(parent, "named-addition");
    await fs.mkdir(addition);
    const insideAddition = path.join(addition, "self.borealis-workspace");
    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: insideAddition,
        passphrase: PASSPHRASE,
        additions: [{ name: "model", path: addition }],
      })
    ).rejects.toThrow("archive destination must be outside named additions");
    await expect(fs.lstat(insideAddition)).rejects.toMatchObject({ code: "ENOENT" });

    const first = path.join(parent, "first-addition");
    const second = path.join(parent, "second-addition");
    await fs.writeFile(first, "first\n");
    await fs.writeFile(second, "second\n");
    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "collision.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [
          { name: "Model", path: first },
          { name: "model", path: second },
        ],
      })
    ).rejects.toThrow("workspace path collision");
  });

  it("rejects forward container and manifest versions", async () => {
    const parent = await temporaryDirectory();
    const forwardHeader = path.join(parent, "forward-header.borealis-workspace");
    await writeCraftedPlaintextArchive(forwardHeader, []);
    const headerBytes = await fs.readFile(forwardHeader);
    headerBytes.writeUInt8(2, 16);
    await fs.writeFile(forwardHeader, headerBytes);
    await expect(inspectWorkspaceArchive({ archive: forwardHeader, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );

    const forwardManifest = path.join(parent, "forward-manifest.borealis-workspace");
    await writeRawManifestPlaintextArchive(
      forwardManifest,
      Buffer.from(`${JSON.stringify({ version: 2, entries: [], total_bytes: 0 })}\n`)
    );
    await expect(inspectWorkspaceArchive({ archive: forwardManifest, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );
  });

  it("rejects oversized manifests, member tables, file declarations, totals, and compression claims", async () => {
    const parent = await temporaryDirectory();
    const candidates: Array<{ name: string; manifest: Buffer }> = [
      {
        name: "manifest-bytes",
        manifest: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
      },
      {
        name: "member-count",
        manifest: Buffer.from(
          `${JSON.stringify({ version: 1, entries: Array.from({ length: 250_000 }, () => null), total_bytes: 0 })}\n`
        ),
      },
      {
        name: "file-bytes",
        manifest: Buffer.from(
          `${JSON.stringify({
            version: 1,
            entries: [
              {
                path: "oversized",
                kind: "file",
                size: 50 * 1024 * 1024 * 1024 + 1,
                mode: "file",
                sha256: EMPTY_SHA256,
              },
            ],
            total_bytes: 50 * 1024 * 1024 * 1024 + 1,
          })}\n`
        ),
      },
      {
        name: "total-bytes",
        manifest: Buffer.from(
          `${JSON.stringify({
            version: 1,
            entries: Array.from({ length: 11 }, (_, index) => ({
              path: `large-${index}`,
              kind: "file",
              size: 50 * 1024 * 1024 * 1024,
              mode: "file",
              sha256: EMPTY_SHA256,
            })),
            total_bytes: 11 * 50 * 1024 * 1024 * 1024,
          })}\n`
        ),
      },
      {
        name: "compression-ratio",
        manifest: Buffer.from(
          `${JSON.stringify({
            version: 1,
            entries: [
              {
                path: "compressed-bomb",
                kind: "file",
                size: 1024 * 1024 * 1024,
                mode: "file",
                sha256: EMPTY_SHA256,
              },
            ],
            total_bytes: 1024 * 1024 * 1024,
          })}\n`
        ),
      },
    ];

    for (const candidate of candidates) {
      const archive = path.join(parent, `${candidate.name}.borealis-workspace`);
      await writeRawManifestPlaintextArchive(archive, candidate.manifest);
      await expect(inspectWorkspaceArchive({ archive, allowUnsafePlaintext: true }), candidate.name).rejects.toThrow(
        "workspace archive could not be verified"
      );
    }
  });

  it("rejects a concatenated gzip member that expands beyond the declared tar stream", async () => {
    const parent = await temporaryDirectory();
    const archive = path.join(parent, "trailing-decompression.borealis-workspace");
    const body = Buffer.from("portable\n");
    await writeCraftedPlaintextArchive(
      archive,
      [
        {
          path: "résumé.txt",
          kind: "file",
          size: body.byteLength,
          mode: "file",
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ],
      async (pack) => {
        await packEntry(pack, { name: "résumé.txt", type: "file", size: body.byteLength }, body);
      }
    );
    await expect(inspectWorkspaceArchive({ archive, allowUnsafePlaintext: true })).resolves.toMatchObject({
      files: 1,
      total_bytes: body.byteLength,
    });

    const trailing = gzipSync(Buffer.alloc(8 * 1024 * 1024));
    expect(trailing.byteLength).toBeLessThan(16 * 1024);
    await fs.appendFile(archive, trailing);

    await expect(inspectWorkspaceArchive({ archive, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );
  });

  it("returns one content-free error for wrong passphrases, corruption, and truncation", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "sensitive-name.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });

    const assertSafeFailure = async (candidate: string, passphrase: string) => {
      const error = await inspectWorkspaceArchive({ archive: candidate, passphrase }).catch(
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("workspace archive could not be verified");
      expect((error as Error).message).not.toContain(PASSPHRASE);
      expect((error as Error).message).not.toContain(parent);
      expect((error as Error).message).not.toContain("sensitive-name");
    };

    await assertSafeFailure(archive, "this is definitely the wrong passphrase");

    const bytes = await fs.readFile(archive);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    const corrupted = path.join(parent, "corrupted.borealis-workspace");
    await fs.writeFile(corrupted, bytes);
    await assertSafeFailure(corrupted, PASSPHRASE);

    const truncated = path.join(parent, "truncated.borealis-workspace");
    await fs.writeFile(truncated, bytes.subarray(0, 63));
    await assertSafeFailure(truncated, PASSPHRASE);
  });

  // Real native storage/CLI work needs room on shared CI; product deadlines stay unchanged.
  it("keeps CLI failure output free of passphrases, archive paths, and member details", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "secret-customer-name.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });
    const suppliedSecret = "wrong passphrase must never appear";

    const error = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/workspaceArchiveCli.ts", "inspect", "--archive", archive],
      {
        cwd: process.cwd(),
        env: { ...process.env, BOREALIS_ARCHIVE_PASSPHRASE: suppliedSecret },
        timeout: 20_000,
      }
    ).catch((reason: unknown) => reason as { stdout: string; stderr: string; code: number });
    expect(error).toMatchObject({ code: 1, stdout: "", stderr: "Workspace archive command failed.\n" });
    expect(`${error.stdout}${error.stderr}`).not.toContain(suppliedSecret);
    expect(`${error.stdout}${error.stderr}`).not.toContain(parent);
    expect(`${error.stdout}${error.stderr}`).not.toContain("secret-customer-name");
  }, 30_000);

  it("refuses traversal, link, and case-colliding archive structures before writing outside staging", async () => {
    const parent = await temporaryDirectory();
    const escaped = path.join(parent, "escaped");
    const traversal = path.join(parent, "traversal.borealis-workspace");
    await writeCraftedPlaintextArchive(traversal, [
      { path: "../escaped", kind: "file", size: 0, mode: "file", sha256: EMPTY_SHA256 },
    ]);
    await expect(
      restoreWorkspaceArchive({
        archive: traversal,
        targetDirectory: path.join(parent, "traversal-target"),
        allowUnsafePlaintext: true,
        verifyStores: false,
      })
    ).rejects.toThrow("workspace archive could not be verified");
    await expect(fs.lstat(escaped)).rejects.toMatchObject({ code: "ENOENT" });

    const collision = path.join(parent, "collision.borealis-workspace");
    await writeCraftedPlaintextArchive(collision, [
      { path: "lancedb", kind: "directory", size: 0, mode: "directory", sha256: EMPTY_SHA256 },
      { path: "LanceDB", kind: "directory", size: 0, mode: "directory", sha256: EMPTY_SHA256 },
    ]);
    await expect(inspectWorkspaceArchive({ archive: collision, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );

    const link = path.join(parent, "link.borealis-workspace");
    const sqliteHash = createHash("sha256").update("sqlite").digest("hex");
    await writeCraftedPlaintextArchive(
      link,
      [
        { path: "borealis.sqlite", kind: "file", size: 6, mode: "file", sha256: sqliteHash },
        { path: "lancedb", kind: "directory", size: 0, mode: "directory", sha256: EMPTY_SHA256 },
      ],
      async (pack) => {
        await packEntry(pack, {
          name: "borealis.sqlite",
          type: "symlink",
          linkname: "../escaped",
          size: 0,
        });
      }
    );
    await expect(inspectWorkspaceArchive({ archive: link, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );

    for (const type of ["link", "character-device", "block-device", "fifo"] as const) {
      const special = path.join(parent, `${type}.borealis-workspace`);
      await writeCraftedPlaintextArchive(
        special,
        [{ path: "special", kind: "file", size: 0, mode: "file", sha256: EMPTY_SHA256 }],
        async (pack) => {
          await packEntry(pack, {
            name: "special",
            type,
            size: 0,
            ...(type === "link" ? { linkname: "borealis.sqlite" } : {}),
          });
        }
      );
      await expect(inspectWorkspaceArchive({ archive: special, allowUnsafePlaintext: true }), type).rejects.toThrow(
        "workspace archive could not be verified"
      );
    }

    const duplicate = path.join(parent, "duplicate.borealis-workspace");
    await writeCraftedPlaintextArchive(
      duplicate,
      [{ path: "duplicate", kind: "file", size: 0, mode: "file", sha256: EMPTY_SHA256 }],
      async (pack) => {
        await packEntry(pack, { name: "duplicate", type: "file", size: 0 });
        await packEntry(pack, { name: "duplicate", type: "file", size: 0 });
      }
    );
    await expect(inspectWorkspaceArchive({ archive: duplicate, allowUnsafePlaintext: true })).rejects.toThrow(
      "workspace archive could not be verified"
    );
  });

  it("rejects manifests that rely on undeclared parent directories during extraction", async () => {
    const parent = await temporaryDirectory();
    const archive = path.join(parent, "implicit-parent.borealis-workspace");
    const sqlite = Buffer.from("sqlite");
    const nested = Buffer.from("nested");
    await writeCraftedPlaintextArchive(
      archive,
      [
        {
          path: "borealis.sqlite",
          kind: "file",
          size: sqlite.length,
          mode: "file",
          sha256: createHash("sha256").update(sqlite).digest("hex"),
        },
        { path: "lancedb", kind: "directory", size: 0, mode: "directory", sha256: EMPTY_SHA256 },
        {
          path: "uploads/account/source.txt",
          kind: "file",
          size: nested.length,
          mode: "file",
          sha256: createHash("sha256").update(nested).digest("hex"),
        },
      ],
      async (pack) => {
        await packEntry(pack, { name: "borealis.sqlite", type: "file", size: sqlite.length }, sqlite);
        await packEntry(pack, { name: "lancedb", type: "directory", size: 0 });
        await packEntry(pack, { name: "uploads/account/source.txt", type: "file", size: nested.length }, nested);
      }
    );

    await expect(
      restoreWorkspaceArchive({
        archive,
        targetDirectory: path.join(parent, "target"),
        allowUnsafePlaintext: true,
        verifyStores: false,
      })
    ).rejects.toThrow("workspace archive could not be verified");
  });

  it("refuses archive operations while the exact workspace lock is live", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });
    const lock = await acquireWorkspaceLock(workspace);
    try {
      await expect(
        createWorkspaceArchive({
          workspaceDirectory: workspace,
          destination: path.join(parent, "blocked.borealis-workspace"),
          passphrase: PASSPHRASE,
        })
      ).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      await lock.release();
    }

    const target = path.join(parent, "restore-target");
    const targetLock = await acquireWorkspaceLock(target);
    try {
      await expect(
        restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, verifyStores: false })
      ).rejects.toBeInstanceOf(WorkspaceLockedError);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await targetLock.release();
    }
  });

  it("rolls the original target back when installation fails after its backup rename", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "workspace.borealis-workspace");
    const target = path.join(parent, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old-marker"), "keep me\n");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });

    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".target.restore.") && String(to) === target) {
        throw Object.assign(new Error("simulated install failure"), { code: "EIO" });
      }
      return originalRename(from, to);
    });

    await expect(
      restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, verifyStores: false })
    ).rejects.toThrow("simulated install failure");
    expect(await fs.readFile(path.join(target, "old-marker"), "utf8")).toBe("keep me\n");
    expect((await fs.readdir(parent)).filter((name) => name.includes(".target.restore."))).toEqual([]);
    expect((await fs.readdir(parent)).filter((name) => name.includes(".target.backup."))).toEqual([]);
  });

  it("retains provenance when an installation failure cannot immediately roll the backup back", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeWorkspace(parent);
    const archive = path.join(parent, "workspace.borealis-workspace");
    const target = path.join(parent, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old-marker"), "recover me\n");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });

    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).includes(".target.restore.") && String(to) === target) {
        throw Object.assign(new Error("simulated install failure"), { code: "EIO" });
      }
      if (String(from).includes(".target.backup.") && String(to) === target) {
        throw Object.assign(new Error("simulated rollback failure"), { code: "EIO" });
      }
      return originalRename(from, to);
    });

    await expect(
      restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, verifyStores: false })
    ).rejects.toThrow();
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    expect(backupName).toBeDefined();
    const backup = path.join(parent, backupName!);
    expect(await fs.readFile(path.join(backup, "old-marker"), "utf8")).toBe("recover me\n");
    const marker = path.join(parent, `.borealis-backup-marker.${backupName}`);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it("removes only a verified generated backup and its exact provenance marker", async () => {
    const parent = await temporaryDirectory();
    const source = await makeVerifiableWorkspace(parent, "archive-source");
    const target = await makeVerifiableWorkspace(parent, "target");
    await addReadyCsvDataset(target);
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });

    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    expect(backupName).toBeDefined();
    const backup = path.join(parent, backupName!);
    const marker = path.join(parent, `.borealis-backup-marker.${backupName}`);
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);

    const liveLock = await acquireWorkspaceLock(target);
    try {
      await expect(removeWorkspaceBackup(target, backup, 3)).rejects.toBeInstanceOf(WorkspaceLockedError);
      await expect(fs.lstat(backup)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    } finally {
      await liveLock.release();
    }
    await removeWorkspaceBackup(target, backup, 3);
    await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.lstat(target)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("never recursively removes a replacement raced into the verified backup pathname", async () => {
    const parent = await temporaryDirectory();
    const source = await makeVerifiableWorkspace(parent, "archive-source");
    const target = await makeVerifiableWorkspace(parent, "target");
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    expect(backupName).toBeDefined();
    const backup = path.join(parent, backupName!);
    const replacementSentinel = path.join(backup, "replacement-must-survive");
    const originalRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (path.basename(String(from)) === backupName && String(to).includes(".target.backup-remove.")) {
        await fs.mkdir(backup);
        await fs.writeFile(replacementSentinel, "not the verified backup\n");
      }
    });

    await removeWorkspaceBackup(target, backup, 3);

    await expect(fs.readFile(replacementSentinel, "utf8")).resolves.toBe("not the verified backup\n");
  });

  it("resumes an identity-checked backup tombstone after recursive removal fails", async () => {
    const parent = await temporaryDirectory();
    const source = await makeVerifiableWorkspace(parent, "archive-source");
    const target = await makeVerifiableWorkspace(parent, "target");
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    const backup = path.join(parent, backupName!);
    const marker = path.join(parent, `.borealis-backup-marker.${backupName}`);
    const originalRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (filename, options) => {
      if (String(filename).includes(".target.backup-remove.")) {
        throw Object.assign(new Error("simulated recursive removal failure"), { code: "EIO" });
      }
      return originalRm(filename, options);
    });

    await expect(removeWorkspaceBackup(target, backup, 3)).rejects.toThrow("simulated recursive removal failure");
    expect(await fs.readdir(parent)).toContain(`.target.backup-remove.${backupName!.split(".backup.")[1]}`);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
    rm.mockRestore();

    await expect(removeWorkspaceBackup(target, backup, 3)).resolves.toBeUndefined();
    expect((await fs.readdir(parent)).filter((name) => name.includes("backup-remove"))).toEqual([]);
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes backup removal when a crash boundary leaves only its provenance marker", async () => {
    const parent = await temporaryDirectory();
    const source = await makeVerifiableWorkspace(parent, "archive-source");
    const target = await makeVerifiableWorkspace(parent, "target");
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    const backup = path.join(parent, backupName!);
    const marker = path.join(parent, `.borealis-backup-marker.${backupName}`);
    const originalUnlink = fs.unlink.bind(fs);
    const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (filename) => {
      if (String(filename).includes(".borealis-backup-marker.")) {
        throw Object.assign(new Error("simulated marker unlink failure"), { code: "EIO" });
      }
      return originalUnlink(filename);
    });

    await expect(removeWorkspaceBackup(target, backup, 3)).rejects.toThrow("simulated marker unlink failure");
    await expect(fs.lstat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(parent)).filter((name) => name.includes("backup-remove"))).toEqual([]);
    await expect(fs.lstat(marker)).resolves.toMatchObject({ isFile: expect.any(Function) });
    unlink.mockRestore();

    await expect(removeWorkspaceBackup(target, backup, 3)).resolves.toBeUndefined();
    await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the fallback backup when the installed workspace no longer verifies", async () => {
    const parent = await temporaryDirectory();
    const source = await makeVerifiableWorkspace(parent, "archive-source");
    const target = await makeVerifiableWorkspace(parent, "target");
    const archive = path.join(parent, "workspace.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      embeddingDimension: 3,
    });
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    expect(backupName).toBeDefined();
    const backup = path.join(parent, backupName!);
    await fs.writeFile(path.join(target, "borealis.sqlite"), "corrupted restored ledger\n");

    await expect(removeWorkspaceBackup(target, backup, 3)).rejects.toThrow();
    await expect(fs.lstat(backup)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("preserves forged or provenance-tampered backup directories", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "target");
    await fs.mkdir(target);
    const forged = path.join(parent, ".target.backup.forged");
    await fs.mkdir(path.join(forged, "lancedb"), { recursive: true });
    await fs.writeFile(path.join(forged, "borealis.sqlite"), "do not delete\n");
    const sentinel = path.join(forged, "sentinel");
    await fs.writeFile(sentinel, "keep me\n");

    await expect(removeWorkspaceBackup(target, forged, 3)).rejects.toThrow("workspace backup provenance is invalid");
    expect(await fs.readFile(sentinel, "utf8")).toBe("keep me\n");

    const source = await makeWorkspace(parent, "archive-source");
    const archive = path.join(parent, "workspace.borealis-workspace");
    await fs.writeFile(path.join(target, "old-marker"), "original\n");
    await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
    await restoreWorkspaceArchive({
      archive,
      passphrase: PASSPHRASE,
      targetDirectory: target,
      verifyStores: false,
    });
    const generatedName = (await fs.readdir(parent)).find(
      (name) => name.startsWith(".target.backup.") && name !== path.basename(forged)
    );
    expect(generatedName).toBeDefined();
    const generated = path.join(parent, generatedName!);
    const marker = path.join(parent, `.borealis-backup-marker.${generatedName}`);
    await fs.writeFile(marker, `${JSON.stringify({ version: 1, target: "different" })}\n`, { mode: 0o600 });

    await expect(removeWorkspaceBackup(target, generated, 3)).rejects.toThrow("workspace backup provenance is invalid");
    expect(await fs.readFile(path.join(generated, "old-marker"), "utf8")).toBe("original\n");
  });

  it("repairs archive, restored directory, file, and marker modes despite a restrictive umask", async () => {
    const parent = await temporaryDirectory();
    const source = await makeWorkspace(parent, "archive-source");
    const target = path.join(parent, "target");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "old-marker"), "original\n");
    const archive = path.join(parent, "workspace.borealis-workspace");
    const previousUmask = process.umask(0o777);
    try {
      await createWorkspaceArchive({ workspaceDirectory: source, destination: archive, passphrase: PASSPHRASE });
      await restoreWorkspaceArchive({
        archive,
        passphrase: PASSPHRASE,
        targetDirectory: target,
        verifyStores: false,
      });
    } finally {
      process.umask(previousUmask);
    }

    expect((await fs.stat(archive)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target, "uploads"))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(target, "uploads", "account", "source", "document.txt"))).mode & 0o777).toBe(0o600);
    const backupName = (await fs.readdir(parent)).find((name) => name.startsWith(".target.backup."));
    expect(backupName).toBeDefined();
    const marker = path.join(parent, `.borealis-backup-marker.${backupName}`);
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
  });
});

describe("offline workspace store verification", () => {
  it("opens a migrated empty SQLite/LanceDB pair with the persisted embedding dimension", async () => {
    const workspace = await temporaryDirectory();
    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    await ledger.close();
    const vectors = await LanceVectorIndex.open({
      directory: path.join(workspace, "lancedb"),
      dimension: 3,
      embeddingModel: "nomic-embed",
    });
    await vectors.close();
    await fs.writeFile(path.join(workspace, "settings.json"), `${JSON.stringify({ embedding_dimension: 3 })}\n`, {
      mode: 0o600,
    });

    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).resolves.toMatchObject({
      chunks: 0,
      vectors: 0,
      datasets: 0,
      embedding_dimension: 3,
    });
  });

  it("validates a preserved embedding identity marker even without a model override", async () => {
    const workspace = await temporaryDirectory();
    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    await ledger.close();
    const vectors = await LanceVectorIndex.open({
      directory: path.join(workspace, "lancedb"),
      dimension: 3,
      embeddingModel: "nomic-embed",
    });
    await vectors.close();
    await fs.writeFile(path.join(workspace, "settings.json"), `${JSON.stringify({ embedding_dimension: 3 })}\n`, {
      mode: 0o600,
    });

    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).resolves.toMatchObject({ vectors: 0 });
    const markerPath = path.join(workspace, "lancedb", ".borealis-embedding-index.json");
    const marker = await fs.readFile(markerPath, "utf8");
    await fs.unlink(markerPath);
    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).resolves.toMatchObject({ vectors: 0 });
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(markerPath, marker, { mode: 0o600 });
    await fs.writeFile(markerPath, "{}\n", {
      mode: 0o600,
    });
    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).rejects.toMatchObject({
      name: "LanceVectorEmbeddingIdentityError",
    });
  });

  it("rejects a populated Lance table with neither an identity marker nor binding receipt", async () => {
    const workspace = await temporaryDirectory();
    const accountId = randomUUID();
    const sourceId = randomUUID();
    const chunkId = randomUUID();
    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      accountId,
      `${accountId}@example.test`,
      "not-a-real-password-hash",
    ]);
    await ledger.run(
      `INSERT INTO sources
         (id,account_id,name,kind,display_name,file_path,mime,size_bytes,status,ready_generation,meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [sourceId, accountId, "legacy", "document", "Legacy", null, "text/plain", 0, "ready", 1, "{}"]
    );
    await ledger.run(
      `INSERT INTO chunks (id,account_id,source_id,generation,seq,source_name,content,meta)
       VALUES (?,?,?,?,?,?,?,?)`,
      [chunkId, accountId, sourceId, 1, 0, "Legacy", "legacy text", "{}"]
    );
    await ledger.close();
    const lanceDirectory = path.join(workspace, "lancedb");
    const vectors = await LanceVectorIndex.open({
      directory: lanceDirectory,
      dimension: 3,
      embeddingModel: "nomic-embed",
    });
    await vectors.upsert([{ chunkId, accountId, sourceId, generation: 1, vector: [1, 0, 0] }]);
    await vectors.close();
    await fs.unlink(path.join(lanceDirectory, ".borealis-embedding-index.json"));
    await fs.unlink(path.join(lanceDirectory, ".borealis-embedding-index-binding.json"));
    await fs.writeFile(path.join(workspace, "settings.json"), `${JSON.stringify({ embedding_dimension: 3 })}\n`, {
      mode: 0o600,
    });

    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).rejects.toMatchObject({
      name: "LanceVectorEmbeddingIdentityError",
    });
  });

  it("archives and restores a receipt-only crash state before exact-model startup repairs its marker", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeVerifiableWorkspace(parent, "receipt-only-source");
    const lanceDirectory = path.join(workspace, "lancedb");
    const bound = await LanceVectorIndex.open({
      directory: lanceDirectory,
      dimension: 3,
      embeddingModel: "nomic-embed",
    });
    await bound.close();
    const markerPath = path.join(lanceDirectory, ".borealis-embedding-index.json");
    const bindingPath = path.join(lanceDirectory, ".borealis-embedding-index-binding.json");
    const binding = await fs.readFile(bindingPath, "utf8");
    await fs.unlink(markerPath);
    const archive = path.join(parent, "receipt-only.borealis-workspace");
    const target = path.join(parent, "receipt-only-restored");

    await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
    });
    await expect(
      restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target })
    ).resolves.toMatchObject({ backup_created: false });
    const restoredLance = path.join(target, "lancedb");
    await expect(fs.readFile(path.join(restoredLance, ".borealis-embedding-index-binding.json"), "utf8")).resolves.toBe(
      binding
    );
    await expect(fs.stat(path.join(restoredLance, ".borealis-embedding-index.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const repaired = await LanceVectorIndex.open({
      directory: restoredLance,
      dimension: 3,
      embeddingModel: "nomic-embed",
    });
    await repaired.close();
    await expect(fs.readFile(path.join(restoredLance, ".borealis-embedding-index.json"), "utf8")).resolves.toBe(
      binding
    );
  });

  it("does not manufacture a missing Lance table while verifying an empty workspace", async () => {
    const workspace = await temporaryDirectory();
    const ledger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    await ledger.close();
    const lance = path.join(workspace, "lancedb");
    await fs.mkdir(lance);
    await fs.writeFile(path.join(workspace, "settings.json"), `${JSON.stringify({ embedding_dimension: 3 })}\n`, {
      mode: 0o600,
    });

    await expect(verifyWorkspaceStores({ workspaceDirectory: workspace })).rejects.toMatchObject({
      name: "LanceVectorSchemaError",
    });
  });

  it("reopens ready tabular artifacts through DuckDB and fails closed when one is missing", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeVerifiableWorkspace(parent, "tabular-source");
    const identity = await addReadyCsvDataset(workspace);
    const archive = path.join(parent, "tabular.borealis-workspace");
    const target = path.join(parent, "tabular-restored");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });

    await expect(
      restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, embeddingDimension: 3 })
    ).resolves.toMatchObject({ backup_created: false });
    await expect(verifyWorkspaceStores({ workspaceDirectory: target, embeddingDimension: 3 })).resolves.toMatchObject({
      chunks: 0,
      vectors: 0,
      datasets: 1,
    });

    const exactTarget = await fs.realpath(target);
    const restoredLedger = await openSqliteLedger({ path: path.join(exactTarget, "borealis.sqlite") });
    try {
      await expect(
        restoredLedger.get<{ file_path: string }>("SELECT file_path FROM sources WHERE id=?", [identity.sourceId])
      ).resolves.toEqual({
        file_path: path.join(exactTarget, "uploads", identity.accountId, identity.sourceId, "ledger.csv"),
      });
    } finally {
      await restoredLedger.close();
    }

    const restoredFile = path.join(exactTarget, "uploads", identity.accountId, identity.sourceId, "ledger.csv");
    await fs.unlink(restoredFile);
    await expect(verifyWorkspaceStores({ workspaceDirectory: target, embeddingDimension: 3 })).rejects.toThrow();

    const outside = path.join(parent, "outside.csv");
    await fs.writeFile(outside, "month,amount\n2026-02,99\n");
    await fs.symlink(outside, restoredFile);
    await expect(verifyWorkspaceStores({ workspaceDirectory: target, embeddingDimension: 3 })).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("month,amount\n2026-02,99\n");
  });
});

type WaveLedger = Awaited<ReturnType<typeof openSqliteLedger>>;

async function tableRows(ledger: WaveLedger, table: string, projection = "*"): Promise<unknown[][]> {
  const rows = await ledger.all<Record<string, unknown>>(`SELECT ${projection} FROM ${table} ORDER BY rowid`);
  return rows.map((row) => Object.values(row));
}

async function tableCounts(ledger: WaveLedger, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await ledger.get<{ count: number | bigint }>(`SELECT COUNT(*) AS count FROM ${table}`);
    counts[table] = Number(row?.count ?? -1);
  }
  return counts;
}

const WAVE_ROW_COUNTS: Record<string, number> = {
  connections: 2,
  connection_tool_snapshots: 1,
  query_captures: 1,
  analyses: 1,
  analysis_revisions: 1,
  analysis_sources: 1,
  analysis_runs: 1,
  analysis_run_sources: 1,
  analysis_results: 1,
  documents: 1,
  document_revisions: 1,
  document_publications: 1,
  document_publication_intents: 2,
  document_artifact_cleanup_jobs: 1,
  document_publication_cleanup_jobs: 1,
  document_templates: 1,
  knowledge_connections: 3,
  knowledge_items: 2,
  knowledge_previews: 1,
  knowledge_preview_entries: 2,
  knowledge_refreshes: 1,
  knowledge_refresh_items: 2,
};

describe("wave-era durable state in workspace archives", () => {
  // Real native storage/CLI work needs room on shared CI; product deadlines stay unchanged.
  it("carries every new ledger row and artifact tree while excluding machine-bound custody", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeVerifiableWorkspace(parent, "wave-source");
    const tabular = await addReadyCsvDataset(workspace);
    const fixture = await populateWaveLedger(workspace, tabular);

    const sourceLedger = await openSqliteLedger({ path: path.join(workspace, "borealis.sqlite") });
    const sourceVersion = await sourceLedger.get<{ user_version: number | bigint }>("PRAGMA user_version");
    expect(Number(sourceVersion?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
    expect(await tableCounts(sourceLedger, Object.keys(WAVE_ROW_COUNTS))).toEqual(WAVE_ROW_COUNTS);
    const sourceRows = new Map<string, unknown[][]>();
    for (const table of [
      "connection_tool_snapshots",
      "query_captures",
      "analyses",
      "analysis_revisions",
      "analysis_sources",
      "analysis_runs",
      "analysis_run_sources",
      "analysis_results",
      "documents",
      "document_revisions",
      "document_templates",
      "document_artifact_cleanup_jobs",
      "knowledge_items",
      "knowledge_previews",
      "knowledge_preview_entries",
      "knowledge_refreshes",
    ]) {
      sourceRows.set(table, await tableRows(sourceLedger, table));
    }
    const sourceConnections = await tableRows(
      sourceLedger,
      "connections",
      "id,account_id,name,kind,revision,discovery_revision,config,enabled"
    );
    const sourceKnowledgeConfigs = await tableRows(
      sourceLedger,
      "knowledge_connections",
      "id,account_id,kind,name,config,revision,watch_enabled"
    );
    await sourceLedger.close();

    // Custody material may not be smuggled in as an explicit addition either.
    const decoyCustody = path.join(parent, "external-custody");
    await fs.mkdir(decoyCustody);
    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "reserved-secrets.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [{ name: "secrets", path: decoyCustody }],
      })
    ).rejects.toThrow("connection custody material is never portable");
    await expect(
      createWorkspaceArchive({
        workspaceDirectory: workspace,
        destination: path.join(parent, "reserved-key.borealis-workspace"),
        passphrase: PASSPHRASE,
        additions: [{ name: "connections.key", path: decoyCustody }],
      })
    ).rejects.toThrow("connection custody material is never portable");

    const archive = path.join(parent, "wave.borealis-workspace");
    const created = await createWorkspaceArchive({
      workspaceDirectory: workspace,
      destination: archive,
      passphrase: PASSPHRASE,
    });
    await expect(inspectWorkspaceArchive({ archive, passphrase: PASSPHRASE })).resolves.toEqual(created);

    // A plaintext copy of the same stopped workspace exposes the manifest.
    const plaintext = path.join(parent, "wave-plaintext.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: plaintext, unsafePlaintext: true });
    const manifest = await readPlaintextManifest(plaintext);
    expect(
      manifest.entries.some((entry) => entry.path === "secrets" || entry.path.startsWith("secrets/")),
      "secrets/ is never archived"
    ).toBe(false);
    expect(
      manifest.entries.some((entry) => entry.path === "connections.key" || entry.path.startsWith("connections.key/")),
      "connections.key is never archived"
    ).toBe(false);
    const publicationHtmlMember = `reports/documents/${fixture.accountId}/${fixture.documentId}/${fixture.publicationId}/index.html`;
    const publicationHtmlEntry = manifest.entries.find((entry) => entry.path === publicationHtmlMember);
    expect(publicationHtmlEntry, "publication HTML rides the report-artifact class").toMatchObject({
      kind: "file",
      mode: "file",
    });
    expect(publicationHtmlEntry?.sha256).toBe(
      createHash("sha256")
        .update(await fs.readFile(fixture.publicationHtml))
        .digest("hex")
    );
    expect(
      manifest.entries.some(
        (entry) => entry.path === `uploads/${fixture.accountId}/${fixture.stagedSourceId}/staged-candidate.bin`
      )
    ).toBe(true);

    const target = path.join(parent, "wave-restored");
    await expect(
      restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, embeddingDimension: 3 })
    ).resolves.toMatchObject({ backup_created: false });
    const exactTarget = await fs.realpath(target);

    const restoredNames = await fs.readdir(target);
    expect(restoredNames).not.toContain("secrets");
    expect(restoredNames).not.toContain("connections.key");
    expect(restoredNames).toContain("jwt.secret");
    expect(restoredNames).toContain("settings.json");

    const restoredLedger = await openSqliteLedger({ path: path.join(exactTarget, "borealis.sqlite") });
    try {
      const restoredVersion = await restoredLedger.get<{ user_version: number | bigint }>("PRAGMA user_version");
      expect(Number(restoredVersion?.user_version)).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(await tableCounts(restoredLedger, Object.keys(WAVE_ROW_COUNTS))).toEqual(WAVE_ROW_COUNTS);
      for (const [table, rows] of sourceRows) {
        expect(await tableRows(restoredLedger, table), table).toEqual(rows);
      }
      expect(
        await tableRows(
          restoredLedger,
          "knowledge_connections",
          "id,account_id,kind,name,config,revision,watch_enabled"
        )
      ).toEqual(sourceKnowledgeConfigs);
      expect(
        await tableRows(
          restoredLedger,
          "connections",
          "id,account_id,name,kind,revision,discovery_revision,config,enabled"
        )
      ).toEqual(sourceConnections);

      // Custody material is gone from the restored tree, so no attested
      // connection state may silently survive: the restore transitions the
      // attested rows into explicit actionable states.
      const restoredConnections = await restoredLedger.all<{ id: string; status: string; status_code: string | null }>(
        "SELECT id,status,status_code FROM connections ORDER BY id"
      );
      expect(restoredConnections).toContainEqual({
        id: fixture.mcpReadyId,
        status: "disconnected",
        status_code: "CONNECTION_RESTORE_RECONNECT_REQUIRED",
      });
      expect(restoredConnections).toContainEqual({
        id: fixture.mcpUntestedId,
        status: "untested",
        status_code: null,
      });
      const restoredKnowledge = (
        await restoredLedger.all<{
          id: string;
          kind: string;
          status: string;
          status_code: string | null;
          credential_configured: number | bigint;
        }>("SELECT id,kind,status,status_code,credential_configured FROM knowledge_connections ORDER BY id")
      ).map((row) => ({ ...row, credential_configured: Number(row.credential_configured) }));
      expect(restoredKnowledge).toContainEqual({
        id: fixture.webdavReadyId,
        kind: "webdav",
        status: "disconnected",
        status_code: "KNOWLEDGE_RESTORE_RECONNECT_REQUIRED",
        credential_configured: 0,
      });
      expect(restoredKnowledge).toContainEqual({
        id: fixture.folderReadyId,
        kind: "desktop_folder",
        status: "disconnected",
        status_code: "KNOWLEDGE_FOLDER_RESELECT_REQUIRED",
        credential_configured: 0,
      });
      expect(restoredKnowledge).toContainEqual({
        id: fixture.webdavUntestedId,
        kind: "webdav",
        status: "untested",
        status_code: null,
        credential_configured: 0,
      });

      // Workspace-scoped artifact columns rebase onto the restored root.
      const rebase = (stored: string) => path.join(exactTarget, path.relative(workspace, stored));
      const publication = await restoredLedger.get<{ html_path: string; pdf_path: string }>(
        "SELECT html_path,pdf_path FROM document_publications WHERE id=?",
        [fixture.publicationId]
      );
      expect(publication).toEqual({
        html_path: rebase(fixture.publicationHtml),
        pdf_path: rebase(fixture.publicationPdf),
      });
      const intents = await restoredLedger.all<{ id: string; artifact_directory: string; html_path: string | null }>(
        "SELECT id,artifact_directory,html_path FROM document_publication_intents ORDER BY artifact_directory"
      );
      expect(intents).toHaveLength(2);
      expect(intents[0]).toEqual({
        id: expect.any(String),
        artifact_directory: rebase(fixture.publicationDirectory),
        html_path: rebase(fixture.publicationHtml),
      });
      expect(intents[1]).toEqual({
        id: fixture.renderingIntentId,
        artifact_directory: rebase(fixture.renderingDirectory),
        html_path: null,
      });
      const cleanup = await restoredLedger.get<{ artifact_directory: string }>(
        "SELECT artifact_directory FROM document_publication_cleanup_jobs WHERE id=?",
        [fixture.cleanupJobId]
      );
      expect(cleanup).toEqual({ artifact_directory: rebase(fixture.cleanupDirectory) });
      const staged = await restoredLedger.get<{ candidate_path: string }>(
        "SELECT candidate_path FROM knowledge_refresh_items WHERE item_id=?",
        [fixture.stagedItemId]
      );
      expect(staged).toEqual({ candidate_path: rebase(fixture.candidateFile) });

      // The publications immutability trigger survives the restore rewrite.
      // The ledger facade normalizes `SQLITE_CONSTRAINT_TRIGGER` as a generic
      // constraint error, so the RAISE text is asserted from the cause chain.
      const forgedUpdate = await restoredLedger
        .run("UPDATE document_publications SET title='forged' WHERE id=?", [fixture.publicationId])
        .then(() => undefined)
        .catch(
          (error: unknown) =>
            error as {
              message?: string;
              cause?: { message?: string; cause?: { message?: string } };
            }
        );
      expect(
        `${forgedUpdate?.message ?? ""} ${forgedUpdate?.cause?.message ?? ""} ${forgedUpdate?.cause?.cause?.message ?? ""}`
      ).toMatch(/immutable/);

      // Artifact content survived hash verification.
      await expect(fs.readFile(rebase(fixture.publicationHtml), "utf8")).resolves.toBe("<html>wave publication</html>");
      await expect(fs.readFile(rebase(fixture.publicationPdf))).resolves.toEqual(Buffer.from("%PDF-wave-publication"));
      await expect(fs.readFile(rebase(fixture.candidateFile), "utf8")).resolves.toBe("staged knowledge bytes\n");

      // The externally granted folder path is machine provenance outside
      // workspace custody: preserved verbatim, never rebased.
      const folderConfig = await restoredLedger.get<{ config: string }>(
        "SELECT config FROM knowledge_connections WHERE id=?",
        [fixture.folderReadyId]
      );
      expect(JSON.parse(folderConfig!.config)).toEqual({
        root_path: fixture.grantedRoot,
        display_label: "Granted Folder",
      });
    } finally {
      await restoredLedger.close();
    }

    // Re-archiving a restored workspace is stable: already-actionable rows
    // keep their state and custody stays excluded.
    const second = path.join(parent, "wave-second.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: exactTarget, destination: second, passphrase: PASSPHRASE });
    const secondTarget = path.join(parent, "wave-restored-again");
    await restoreWorkspaceArchive({
      archive: second,
      passphrase: PASSPHRASE,
      targetDirectory: secondTarget,
      embeddingDimension: 3,
    });
    const secondLedger = await openSqliteLedger({
      path: path.join(await fs.realpath(secondTarget), "borealis.sqlite"),
    });
    try {
      expect(await tableCounts(secondLedger, Object.keys(WAVE_ROW_COUNTS))).toEqual(WAVE_ROW_COUNTS);
      expect(
        await secondLedger.get<{ status: string; status_code: string | null }>(
          "SELECT status,status_code FROM connections WHERE id=?",
          [fixture.mcpReadyId]
        )
      ).toEqual({ status: "disconnected", status_code: "CONNECTION_RESTORE_RECONNECT_REQUIRED" });
    } finally {
      await secondLedger.close();
    }
    expect(await fs.readdir(secondTarget)).not.toContain("secrets");
  }, 30_000);

  it("still refuses archive and restore while a wave-era workspace lock is live", async () => {
    const parent = await temporaryDirectory();
    const workspace = await makeVerifiableWorkspace(parent, "wave-live-source");
    await populateWaveLedger(workspace, await addReadyCsvDataset(workspace));
    const archive = path.join(parent, "wave-live.borealis-workspace");
    await createWorkspaceArchive({ workspaceDirectory: workspace, destination: archive, passphrase: PASSPHRASE });

    const sourceLock = await acquireWorkspaceLock(workspace);
    try {
      await expect(
        createWorkspaceArchive({
          workspaceDirectory: workspace,
          destination: path.join(parent, "wave-live-blocked.borealis-workspace"),
          passphrase: PASSPHRASE,
        })
      ).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      await sourceLock.release();
    }

    const target = path.join(parent, "wave-live-target");
    const targetLock = await acquireWorkspaceLock(target);
    try {
      await expect(
        restoreWorkspaceArchive({ archive, passphrase: PASSPHRASE, targetDirectory: target, verifyStores: false })
      ).rejects.toBeInstanceOf(WorkspaceLockedError);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await targetLock.release();
    }
  });
});
