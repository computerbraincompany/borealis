import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { config } from "../config.js";
import { FileConnectionSecretStore, FileKeyCustody } from "../connections/secrets.js";
import { KnowledgeStore, type KnowledgeScanBounds } from "../db/stores/knowledgeStore.js";
import type { SqliteLedger } from "../db/types.js";
import { KnowledgeRefreshService } from "../knowledgeRefresh.js";
import {
  mapHrefToRelative,
  parseDavMultistatus,
  WEBDAV_APPLICATION_PASSWORD_ENV_KEY,
  WebDavKnowledgeAdapter,
} from "../knowledge/webdav.js";
import { makeIngestionSimulator } from "./knowledgeTransportFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

/**
 * The read-only WebDAV transport runs against the real authenticated fixture
 * (`scripts/e2e/fixtures/webdav.mjs`) over loopback: Basic auth happy/bad 401,
 * `PROPFIND Depth:1` traversal, malformed and hostile XML refusal, redirect
 * refusal, timeout injection, and partial failure retaining ready content —
 * plus redaction scans proving the application password never reaches a DTO.
 */

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const FIXTURE = path.join(REPO_ROOT, "scripts/e2e/fixtures/webdav.mjs");
const USER = "e2e-user";
const PASSWORD = "e2e-app-pass-42";

interface Running {
  readonly info: Record<string, string>;
  readonly pid: number;
  stop(): Promise<void>;
}
const spawnedPids: number[] = [];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return !(code === "ESRCH" || code === "EPERM");
  }
}

async function expectGone(pid: number, budget = 10_000): Promise<void> {
  const deadline = Date.now() + budget;
  for (;;) {
    if (!pidAlive(pid)) return;
    if (Date.now() >= deadline) throw new Error(`fixture ${pid} survived (leaked process)`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function startFixture(env: Record<string, string>): Promise<Running> {
  const child: ChildProcess = spawn(process.execPath, [FIXTURE], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("no fixture pid");
  spawnedPids.push(pid);
  child.stderr?.resume();
  return new Promise<Running>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture ready timeout")), 15_000);
    timer.unref?.();
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (piece: string) => {
      buffer += piece;
      const line = buffer.split("\n").find((candidate) => candidate.trim().length > 0);
      if (!line) return;
      clearTimeout(timer);
      try {
        const info = JSON.parse(line) as Record<string, string>;
        resolve({
          info,
          pid,
          async stop() {
            child.kill("SIGTERM");
            await expectGone(pid);
          },
        });
      } catch (error) {
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early: ${String(code)}`));
    });
  });
}

afterEach(async () => {
  const pids = spawnedPids.splice(0);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    await expectGone(pid);
  }
});

// ------------------------------------------------------------ XML unit tests

describe("strict multistatus parser", () => {
  it("accepts a well-formed DAV body and refuses malformed, DOCTYPE, and entity bodies", () => {
    const good =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/team/a.md</d:href><d:propstat><d:prop>' +
      "<d:resourcetype/><d:getcontentlength>4</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>";
    const parsed = parseDavMultistatus(good);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({ href: "/team/a.md", collection: false, contentLength: 4 });

    expect(parseDavMultistatus("<d:multistatus><d:response><d:href>/x")).toBeNull(); // unterminated
    expect(
      parseDavMultistatus(
        '<!DOCTYPE d:multistatus [<!ENTITY e SYSTEM "file:///etc/passwd">]><d:multistatus></d:multistatus>'
      )
    ).toBeNull();
    expect(
      parseDavMultistatus("<d:multistatus><d:response><d:href>&evil;</d:href></d:response></d:multistatus>")
    ).toBeNull();
    // Predefined and numeric references expand.
    const refs = parseDavMultistatus(
      "<d:multistatus><d:response><d:href>/a&amp;b&#65;.md</d:href></d:response></d:multistatus>"
    );
    expect(refs?.[0]?.href).toBe("/a&bA.md");
    // Nested responses are structurally invalid.
    expect(
      parseDavMultistatus("<d:multistatus><d:response><d:response></d:response></d:response></d:multistatus>")
    ).toBeNull();
    expect(parseDavMultistatus("")).toBeNull();
  });

  it("maps hrefs to managed relative identity and refuses traversal, hidden, and foreign paths", () => {
    expect(mapHrefToRelative("/team/a.md", "/team")).toEqual({ kind: "path", relative: "a.md" });
    expect(mapHrefToRelative("/team", "/team").kind).toBe("self");
    expect(mapHrefToRelative("/team/", "/team").kind).toBe("self");
    expect(mapHrefToRelative("/team/.hidden/x", "/team").kind).toBe("hidden");
    expect(mapHrefToRelative("/other/x", "/team").kind).toBe("foreign");
    expect(mapHrefToRelative("/team/../etc/passwd", "/team").kind).toBe("foreign");
    expect(mapHrefToRelative("relative-no-slash", "/team").kind).toBe("foreign");
  });
});

// ------------------------------------------------------- fixture integration

const originalUploadDir = config.uploadDir;
let uploadRoot = "";

beforeEach(async () => {
  uploadRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-webdav-uploads-")));
  config.uploadDir = uploadRoot;
});

afterEach(async () => {
  config.uploadDir = originalUploadDir;
  if (uploadRoot) await fs.rm(uploadRoot, { recursive: true, force: true }).catch(() => {});
});

const bounds: KnowledgeScanBounds = {
  maxEntries: 100,
  maxDepth: 10,
  maxVisited: 1_000,
  maxAggregateBytes: 64 * 1024 * 1024,
};

async function seedLedger(): Promise<{
  ledger: SqliteLedger;
  cleanup(): Promise<void>;
  account: string;
  libraryId: string;
}> {
  const resource: TempSqliteLedger = await createTempSqliteLedger();
  const account = randomUUID();
  await resource.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    account,
    `${account}@e.test`,
    "h",
  ]);
  const libraryId = randomUUID();
  await resource.ledger.run("INSERT INTO libraries (id,account_id,name) VALUES (?,?,?)", [
    libraryId,
    account,
    `Lib-${account.slice(0, 6)}`,
  ]);
  return { ledger: resource.ledger, cleanup: resource.cleanup, account, libraryId };
}

async function withFixture(
  tree: Record<string, string>,
  fixtureEnv: Record<string, string> = {},
  work: (fixture: Running, rootDir: string) => Promise<void>
): Promise<void> {
  const rootDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-webdav-root-")));
  for (const [relative, content] of Object.entries(tree)) {
    const target = path.join(rootDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  const fixture = await startFixture({
    E2E_WEBDAV_ROOT: rootDir,
    E2E_WEBDAV_USER: USER,
    E2E_WEBDAV_PASS: PASSWORD,
    ...fixtureEnv,
  });
  try {
    await work(fixture, rootDir);
  } finally {
    await fixture.stop();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function makeService(ledger: SqliteLedger, adapter: WebDavKnowledgeAdapter) {
  const secretsDir = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-webdav-secrets-"));
  const store = new KnowledgeStore(ledger);
  const secrets = new FileConnectionSecretStore({
    directory: path.join(secretsDir, "secrets"),
    custody: new FileKeyCustody(path.join(secretsDir, "connections.key")),
  });
  const ingestion = { calls: 0, generations: [] as number[], autoPromote: true };
  const service = new KnowledgeRefreshService({
    store: () => store,
    adapter: (kind) => (kind === "webdav" ? adapter : undefined),
    reingest: makeIngestionSimulator(ledger, ingestion),
    secrets: () => secrets,
    pollIntervalMs: 10,
  });
  return { store, secrets, service, ingestion, secretsDir };
}

function webdavConnectionInput(url: string, libraryId: string) {
  return {
    name: "WebDAV",
    kind: "webdav" as const,
    config: { url, username: USER },
    library_id: libraryId,
  };
}

const hash = (content: string): string => createHash("sha256").update(content, "utf8").digest("hex");

describe("WebDAV transport against the authenticated fixture", () => {
  it("imports through the real sign-in path: scan, hash, stage, and promote", async () => {
    await withFixture(
      { "readme.md": "# Team\n", "ledger.csv": "date,amount\n2026-01-05,10.00\n", "notes/gamma.txt": "gamma\n" },
      {},
      async (fixture) => {
        const { ledger, cleanup, account, libraryId } = await seedLedger();
        try {
          const { store, secrets, service, ingestion, secretsDir } = await makeService(
            ledger,
            new WebDavKnowledgeAdapter()
          );
          try {
            const connection = await store.createConnection(
              account,
              webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
            );
            await secrets.put(account, connection.id, {
              headers: {},
              env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
            });
            await store.setCredentialConfigured(account, connection.id, true);

            const preview = await service.createPreview(account, connection.id, bounds);
            const byPath = new Map(preview.entries.map((entry) => [entry.relative_path, entry]));
            expect(byPath.get("readme.md")?.classification).toBe("new");
            expect(byPath.get("notes/gamma.txt")?.classification).toBe("new");
            expect(byPath.get("readme.md")?.content_hash).toBe(hash("# Team\n"));

            const applied = await service.applyPreview(account, preview.preview.id, {
              expected_revision: preview.preview.revision,
              selections: preview.entries
                .filter((entry) => entry.classification === "new")
                .map((entry) => ({ entry_id: entry.entry_id, selection_token: entry.selection_token })),
            });
            const promoted = await service.refreshAndWaitReady({
              accountId: account,
              connections: [{ connection_id: connection.id, expected_connection_revision: connection.revision }],
            });
            expect(promoted.fully_ready).toBe(true);
            expect(ingestion.generations).toHaveLength(3);
            // Staged bytes are real and inside the account/source upload dir.
            const stagedSource = applied.items.find((item) => item.relative_path === "readme.md")!;
            const filePath = (await store.sourceIngestionState(account, stagedSource.source_id))!.filePath!;
            expect(filePath.startsWith(path.join(uploadRoot, account, stagedSource.source_id))).toBe(true);
            expect(await fs.readFile(filePath, "utf8")).toBe("# Team\n");
            // credential_configured is a boolean only; no secret in the DTO.
            const dto = await store.requireConnection(account, connection.id);
            expect(dto.credential_configured).toBe(true);
            expect(JSON.stringify(dto)).not.toContain(PASSWORD);
          } finally {
            await fs.rm(secretsDir, { recursive: true, force: true });
          }
        } finally {
          await cleanup();
        }
      }
    );
  });

  it("bad credentials fail with an actionable disconnected state; reconnect succeeds", async () => {
    await withFixture({ "doc.md": "content" }, {}, async (fixture) => {
      const { ledger, cleanup, account, libraryId } = await seedLedger();
      try {
        const { store, secrets, service, secretsDir } = await makeService(ledger, new WebDavKnowledgeAdapter());
        try {
          const connection = await store.createConnection(
            account,
            webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
          );
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: "wrong-password" },
          });
          await expect(service.createPreview(account, connection.id, bounds)).rejects.toMatchObject({
            code: "KNOWLEDGE_UPSTREAM_UNAUTHORIZED",
          });
          expect((await store.requireConnection(account, connection.id)).status).toBe("disconnected");

          // Reconnect: replace the credential; only future snapshots change.
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
          });
          const preview = await service.createPreview(account, connection.id, bounds);
          expect(preview.entries[0]).toMatchObject({ relative_path: "doc.md", classification: "new" });
          expect((await store.requireConnection(account, connection.id)).status).toBe("ready");
        } finally {
          await fs.rm(secretsDir, { recursive: true, force: true });
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("refuses malformed and hostile PROPFIND bodies", async () => {
    for (const mode of ["malformed", "hostile"] as const) {
      await withFixture({ "x.md": "body" }, { E2E_WEBDAV_XML_MODE: mode }, async (fixture) => {
        const { ledger, cleanup, account, libraryId } = await seedLedger();
        try {
          const { store, secrets, service, secretsDir } = await makeService(ledger, new WebDavKnowledgeAdapter());
          try {
            const connection = await store.createConnection(
              account,
              webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
            );
            await secrets.put(account, connection.id, {
              headers: {},
              env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
            });
            await expect(service.createPreview(account, connection.id, bounds)).rejects.toMatchObject({
              code: "KNOWLEDGE_UPSTREAM_XML_INVALID",
            });
            const previews = await store.listPreviews(account, connection.id, { limit: 5, after: null });
            expect(previews.items[0]?.status).toBe("failed");
          } finally {
            await fs.rm(secretsDir, { recursive: true, force: true });
          }
        } finally {
          await cleanup();
        }
      });
    }
  });

  it("refuses redirects so credentials never continue to another origin", async () => {
    await withFixture({ "doc.md": "content" }, {}, async (fixture) => {
      const { ledger, cleanup, account, libraryId } = await seedLedger();
      try {
        const { store, secrets, service, secretsDir } = await makeService(ledger, new WebDavKnowledgeAdapter());
        try {
          // Point at the fixture's redirect-prefixed path; after auth it 301s.
          const connection = await store.createConnection(
            account,
            webdavConnectionInput(`${fixture.info.origin}/redirect/collection`, libraryId)
          );
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
          });
          await expect(service.createPreview(account, connection.id, bounds)).rejects.toMatchObject({
            code: "KNOWLEDGE_UPSTREAM_REDIRECT_REFUSED",
          });
        } finally {
          await fs.rm(secretsDir, { recursive: true, force: true });
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("honors the per-request time budget (timeout injection)", async () => {
    await withFixture({ "slow.md": "content" }, { E2E_WEBDAV_DELAY_MS: "400" }, async (fixture) => {
      const { ledger, cleanup, account, libraryId } = await seedLedger();
      try {
        const { store, secrets, service, secretsDir } = await makeService(
          ledger,
          new WebDavKnowledgeAdapter({ requestTimeoutMs: 60 })
        );
        try {
          const connection = await store.createConnection(
            account,
            webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
          );
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
          });
          await expect(service.createPreview(account, connection.id, bounds)).rejects.toMatchObject({
            code: "KNOWLEDGE_UPSTREAM_TIMEOUT",
          });
        } finally {
          await fs.rm(secretsDir, { recursive: true, force: true });
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("partial remote failure retains ready content with per-item status", async () => {
    await withFixture({ "keep.md": "keep", "drop.md": "drop" }, {}, async (fixture) => {
      const { ledger, cleanup, account, libraryId } = await seedLedger();
      try {
        const { store, secrets, service, secretsDir } = await makeService(ledger, new WebDavKnowledgeAdapter());
        try {
          const connection = await store.createConnection(
            account,
            webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
          );
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
          });
          const preview = await service.createPreview(account, connection.id, bounds);
          const applied = await service.applyPreview(account, preview.preview.id, {
            expected_revision: preview.preview.revision,
            selections: preview.entries.map((entry) => ({
              entry_id: entry.entry_id,
              selection_token: entry.selection_token,
            })),
          });
          await service.refreshAndWaitReady({
            accountId: account,
            connections: [{ connection_id: connection.id, expected_connection_revision: connection.revision }],
          });
          // Remove one upstream file; a subsequent refresh reports it missing
          // while the other stays ready with its last promoted generation.
          await fs.rm(path.join(fixture.info.root, "drop.md"));
          const result = await service.refreshAndWaitReady({
            accountId: account,
            connections: [{ connection_id: connection.id, expected_connection_revision: connection.revision }],
          });
          const byPath = new Map(result.refreshes[0]?.items.map((item) => [item.relative_path, item.outcome]));
          expect(byPath.get("drop.md")).toBe("missing");
          expect(byPath.get("keep.md")).toBe("unchanged");
          const dropItem = applied.items.find((item) => item.relative_path === "drop.md")!;
          expect((await store.sourceIngestionState(account, dropItem.source_id))?.readyGeneration).toBe(1);
        } finally {
          await fs.rm(secretsDir, { recursive: true, force: true });
        }
      } finally {
        await cleanup();
      }
    });
  });

  it("never leaks the application password into any DTO or scan error", async () => {
    await withFixture({ "secret-doc.md": "value" }, { E2E_WEBDAV_PASS: PASSWORD }, async (fixture) => {
      const { ledger, cleanup, account, libraryId } = await seedLedger();
      try {
        const { store, secrets, service, secretsDir } = await makeService(ledger, new WebDavKnowledgeAdapter());
        try {
          const connection = await store.createConnection(
            account,
            webdavConnectionInput(`${fixture.info.origin}/`, libraryId)
          );
          await secrets.put(account, connection.id, {
            headers: {},
            env: { [WEBDAV_APPLICATION_PASSWORD_ENV_KEY]: PASSWORD },
          });
          const preview = await service.createPreview(account, connection.id, bounds);
          const surfaces: unknown[] = [
            await store.requireConnection(account, connection.id),
            preview.preview,
            preview.entries,
          ];
          for (const surface of surfaces) {
            const text = JSON.stringify(surface);
            expect(text).not.toContain(PASSWORD);
            expect(text.toLowerCase()).not.toContain("authorization");
          }
        } finally {
          await fs.rm(secretsDir, { recursive: true, force: true });
        }
      } finally {
        await cleanup();
      }
    });
  });
});
