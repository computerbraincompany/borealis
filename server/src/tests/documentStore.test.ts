import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { LATEST_SQLITE_SCHEMA_VERSION, SCHEMA_V20 } from "../db/migrations.js";
import { openSqliteLedger } from "../db/sqlite.js";
import type { SqliteLedger } from "../db/types.js";
import {
  DocumentHeadMovedError,
  DocumentNotFoundError,
  DocumentPublicationActiveError,
  DocumentPublicationStateError,
  DocumentRevisionConflictError,
  DocumentRevisionSelectionError,
  DocumentStore,
  DocumentUnavailableError,
  type DocumentStoreOptions,
  type StoredDocumentPublication,
  type StoredDocumentRevision,
} from "../db/stores/documentStore.js";
import { config } from "../config.js";
import {
  DocumentValidationError,
  buildEvidenceAppendix,
  resolveDocumentEvidenceMarkers,
  type DocumentEvidenceRef,
  type DocumentTreeInput,
} from "../documentTypes.js";
import {
  createDocumentPublicationDirectory,
  documentPublicationDirectory,
  removeDocumentArtifacts,
  removeDocumentPublicationArtifacts,
} from "../storageArtifacts.js";
import { createHistoricalSqliteFixture } from "./sqliteMigrationFixture.js";
import { createTempSqliteLedger, type TempSqliteLedger } from "./sqliteTestHarness.js";

const resources: TempSqliteLedger[] = [];
const extraLedgers: SqliteLedger[] = [];
const tempDirectories: string[] = [];
let previousReportDir: string | undefined;
let clock = Date.parse("2026-09-06T10:00:00.000Z");

afterEach(async () => {
  await Promise.all(extraLedgers.splice(0).map((ledger) => ledger.close()));
  await Promise.all(resources.splice(0).map((resource) => resource.cleanup()));
  for (const directory of tempDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  if (previousReportDir !== undefined) {
    config.reportDir = previousReportDir;
    previousReportDir = undefined;
  }
});

async function setup(options: DocumentStoreOptions = {}): Promise<{
  ledger: SqliteLedger;
  store: DocumentStore;
  filename: string;
}> {
  const resource = await createTempSqliteLedger();
  resources.push(resource);
  const now = options.now ?? (() => new Date((clock += 1_000)));
  return {
    ledger: resource.ledger,
    store: new DocumentStore(resource.ledger, { publicationDirectory: lexicalPublicationDirectory, ...options, now }),
    filename: resource.filename,
  };
}

function lexicalPublicationDirectory(accountId: string, documentId: string, publicationId: string): string {
  return path.join("/artifacts", accountId, documentId, publicationId);
}

async function secondLedger(filename: string): Promise<SqliteLedger> {
  const ledger = await openSqliteLedger({ path: filename });
  extraLedgers.push(ledger);
  return ledger;
}

async function insertUser(ledger: SqliteLedger, label: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    id,
    `${label}-${id}@example.test`,
    "test-hash",
  ]);
  return id;
}

async function insertChat(ledger: SqliteLedger, accountId: string): Promise<string> {
  const id = randomUUID();
  await ledger.run("INSERT INTO chats (id,account_id,title,model) VALUES (?,?,?,'fixture-model')", [
    id,
    accountId,
    "Fixture chat",
  ]);
  return id;
}

const CHART_SPEC = {
  type: "bar",
  title: "Revenue",
  subtitle: "",
  categories: ["Jul", "Aug"],
  series: [{ name: "revenue", data: [10, 12], color: "#6366F1" }],
  items: [],
  x_label: "",
  y_label: "",
} as const;

/** A legacy payload shaped exactly like the stored normalized report. */
function legacyReportPayload(chartId = "abcd1234efgh") {
  return {
    title: "Finance brief",
    subtitle: "Q3",
    generated_at: "2026-09-01 00:00:00 UTC",
    sections: [
      { heading: "Summary", markdown: "Revenue grew [1]." },
      { heading: "Detail", markdown: "Steady growth." },
    ],
    charts: [{ id: chartId, spec: CHART_SPEC }],
    tables: [
      {
        columns: ["month", "revenue"],
        rows: [
          ["2026-07", 10],
          ["2026-08", 12],
        ],
      },
    ],
  };
}

async function insertPublishedReport(
  ledger: SqliteLedger,
  accountId: string,
  options: { chatId?: string | null; payload?: unknown | null; status?: "pending" | "published" } = {}
): Promise<string> {
  const id = randomUUID();
  const payload = options.payload === null ? null : JSON.stringify(options.payload ?? legacyReportPayload());
  await ledger.run(
    `INSERT INTO reports
       (id,account_id,chat_id,run_id,status,title,subtitle,html_path,pdf_path,payload)
     VALUES (?,?,?,NULL,?,?,?,'report.html','report.pdf',?)`,
    [
      id,
      accountId,
      options.chatId === undefined ? null : options.chatId,
      options.status ?? "published",
      "Finance brief",
      "Q3",
      payload,
    ]
  );
  return id;
}

function evidenceRef(overrides: Partial<DocumentEvidenceRef> = {}): DocumentEvidenceRef {
  return {
    id: randomUUID(),
    source_id: randomUUID(),
    source_name: "Sales.csv",
    generation: 3,
    content_identity: "g3|s100|p/data.csv",
    locator: "page 2",
    excerpt: "revenue grew 20 percent",
    ...overrides,
  };
}

function tree(title = "Quarterly brief", overrides: Partial<DocumentTreeInput> = {}): DocumentTreeInput {
  return {
    title,
    subtitle: "Q3",
    sections: [{ heading: "Summary", markdown: "Revenue grew [1]." }],
    charts: [{ id: "abcd1234efgh", spec: CHART_SPEC }],
    tables: [
      {
        columns: ["month", "revenue"],
        rows: [
          ["2026-07", 10],
          ["2026-08", 12],
        ],
      },
    ],
    evidence: [evidenceRef()],
    ...overrides,
  };
}

async function createDocument(store: DocumentStore, account: string, title = "Quarterly brief") {
  return store.createDocument(account, { title, tree: tree(title) });
}

async function publishHead(
  store: DocumentStore,
  account: string,
  documentId: string,
  operationId: string,
  beginInput: { revisionId?: string; allowNonHeadRevision?: boolean } = {}
): Promise<StoredDocumentPublication> {
  const begun = await store.beginDocumentPublication(account, documentId, { operationId, ...beginInput });
  expect(begun.replayed).toBe(false);
  await store.markDocumentPublicationReady(account, documentId, operationId, {
    htmlPath: path.join(begun.intent.artifactDirectory, "document.html"),
    pdfPath: path.join(begun.intent.artifactDirectory, "document.pdf"),
  });
  const completed = await store.completeDocumentPublication(account, documentId, operationId);
  expect(completed.replayed).toBe(false);
  return completed.publication;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("DocumentStore", () => {
  it("ships a byte-identical v020 fixture and applies it to an upgraded v18 installation", async () => {
    const fixtureSql = await fs.readFile(fileURLToPath(new URL("./fixtures/sqlite/v020.sql", import.meta.url)), "utf8");
    expect(fixtureSql).toBe(SCHEMA_V20);

    const historical = await createHistoricalSqliteFixture(18);
    try {
      const ledger = await openSqliteLedger({ path: historical.filename });
      try {
        await expect(ledger.get<{ user_version: bigint }>("PRAGMA user_version")).resolves.toEqual({
          user_version: BigInt(LATEST_SQLITE_SCHEMA_VERSION),
        });
        await expect(ledger.all("PRAGMA foreign_key_check")).resolves.toEqual([]);
        const account = historical.seed.accountId;
        const store = new DocumentStore(ledger, { publicationDirectory: lexicalPublicationDirectory });
        const created = await createDocument(store, account, "Upgraded document");
        expect(created.document.currentRevision).toBe(1);
        const saved = await store.saveDocumentRevision(account, created.document.id, {
          baseRevisionId: created.revision.id,
          tree: tree("Upgraded document v2"),
          authorKind: "user",
        });
        expect(saved.document.currentRevision).toBe(2);
        await store.recoverInterruptedDocumentPublications();
      } finally {
        await ledger.close();
      }
    } finally {
      await historical.cleanup();
    }
  });

  it("creates owner-scoped blank documents and full-tree revisions with stable block UUIDs", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const blank = await store.createDocument(account, { title: "Blank" });
    expect(blank.document.currentRevision).toBe(1);
    expect(blank.revision.payload.sections).toEqual([]);
    expect(blank.revision.payload.verified).toBe(true);
    expect(blank.document.origin).toEqual({ reportId: null, chatId: null, runId: null, analysisResultId: null });

    const created = await createDocument(store, account);
    expect(created.revision.payload.sections).toHaveLength(1);
    expect(created.revision.payload.sections[0]!.id).toMatch(UUID_RE);
    expect(created.revision.payload.charts[0]!.id).toBe("abcd1234efgh");
    expect(created.revision.payload.evidence[0]!.excerpt).toBe("revenue grew 20 percent");

    const foreign = await insertUser(ledger, "foreign");
    await expect(store.getDocument(foreign, created.document.id)).resolves.toBeUndefined();
    await expect(store.deleteDocument(foreign, created.document.id)).resolves.toBeNull();
    await expect(
      store.saveDocumentRevision(foreign, created.document.id, {
        baseRevisionId: created.revision.id,
        tree: tree("stolen"),
        authorKind: "user",
      })
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    const page = await store.listDocuments(account);
    expect(page.items.map((item) => item.id)).toContain(created.document.id);
    await expect(store.listDocuments(foreign)).resolves.toMatchObject({ items: [] });
  });

  it("rejects origin links the account does not own", async () => {
    const { ledger, store } = await setup();
    const owner = await insertUser(ledger, "owner");
    const foreign = await insertUser(ledger, "foreign");
    const foreignChat = await insertChat(ledger, foreign);
    await expect(
      store.createDocument(owner, { title: "Linked", origin: { chatId: foreignChat } })
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    const ownedChat = await insertChat(ledger, owner);
    const linked = await store.createDocument(owner, { title: "Linked", origin: { chatId: ownedChat } });
    expect(linked.document.origin.chatId).toBe(ownedChat);
  });

  it("applies base-revision CAS: stale writes conflict with head metadata and write nothing", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);

    const first = await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: revision.id,
      tree: tree("Head one"),
      authorKind: "model",
    });
    expect(first.document.currentRevision).toBe(2);
    expect(first.revision.baseRevisionId).toBe(revision.id);
    expect(first.document.headAuthorKind).toBe("model");
    expect(first.document.title).toBe("Head one");

    const rejected = await store
      .saveDocumentRevision(account, document.id, {
        baseRevisionId: revision.id,
        tree: tree("Head lost"),
        authorKind: "user",
      })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(DocumentRevisionConflictError);
    expect((rejected as DocumentRevisionConflictError).currentHead).toMatchObject({
      revisionId: first.revision.id,
      revision: 2,
      title: "Head one",
      authorKind: "model",
    });
    const unchanged = await store.getDocument(account, document.id);
    expect(unchanged?.currentRevision).toBe(2);
    expect(unchanged?.revisionCount).toBe(2);
    const titles = (await store.listDocumentRevisions(account, document.id)).items.map((item) => item.title);
    expect(titles).not.toContain("Head lost");
  });

  it("serializes concurrent saves from the same base so exactly one wins", async () => {
    const { ledger, store, filename } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const other = new DocumentStore(await secondLedger(filename), {
      publicationDirectory: lexicalPublicationDirectory,
    });

    const results = await Promise.allSettled([
      store.saveDocumentRevision(account, document.id, {
        baseRevisionId: revision.id,
        tree: tree("Winner A"),
        authorKind: "user",
      }),
      other.saveDocumentRevision(account, document.id, {
        baseRevisionId: revision.id,
        tree: tree("Winner B"),
        authorKind: "user",
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(DocumentRevisionConflictError);
    expect((loser.reason as DocumentRevisionConflictError).currentHead.revision).toBe(2);
    const head = await store.getDocument(account, document.id);
    expect(head?.currentRevision).toBe(2);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ revision: StoredDocumentRevision }>).value;
    const titles = (await store.listDocumentRevisions(account, document.id)).items.map((item) => item.title);
    expect(titles).toHaveLength(2);
    expect(titles).toContain(winner.revision.title);
    expect(titles).toContain("Quarterly brief");
  });

  it("makes revisions immutable: raw UPDATE fails closed, appends are the only write path", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);

    const updateAttempt: unknown = await ledger
      .run("UPDATE document_revisions SET title='tampered' WHERE id=?", [revision.id])
      .catch((error: unknown) => error);
    expect(updateAttempt).toBeInstanceOf(Error);
    const attemptError = updateAttempt as { message?: string; cause?: { message?: string } };
    expect(String(attemptError.cause?.message ?? attemptError.message ?? "")).toMatch(/immutable/i);
    await expect(
      ledger.run("UPDATE document_revisions SET payload='{}' WHERE id=?", [revision.id])
    ).rejects.toBeDefined();

    const stored = await store.getDocumentRevision(account, document.id, revision.id);
    expect(stored?.title).toBe("Quarterly brief");
    expect(stored?.payload.title).toBe("Quarterly brief");
  });

  it("enforces the durable 400k payload CHECK as the last line for raw writers", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document } = await createDocument(store, account);
    const bigPayload = JSON.stringify({
      title: "x",
      subtitle: "",
      verified: false,
      sections: [{ id: randomUUID(), heading: "", markdown: "m".repeat(400_001) }],
      charts: [],
      tables: [],
      evidence: [],
    });
    expect(bigPayload.length).toBeGreaterThan(400_000);
    await expect(
      ledger.run(
        `INSERT INTO document_revisions
           (id,document_id,revision,account_id,title,payload,author_kind,created_at)
         VALUES (?,?,2,?,?,?,'user','2026-09-06T10:00:00.000Z')`,
        [randomUUID(), document.id, account, "x", bigPayload]
      )
    ).rejects.toBeDefined();
  });

  it("rejects oversize edits before saving, including the evidence-inclusive text budget", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const fat = "x".repeat(10_000);
    const sections20 = (markdown: string) =>
      Array.from({ length: 20 }, (_, index) => ({ heading: `S${index}`, markdown }));

    // 20 full sections sit exactly at the shared 200,000-char text budget…
    const atBudget = await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: revision.id,
      tree: tree("At budget", { sections: sections20(fat), evidence: [] }),
      authorKind: "user",
    });
    expect(atBudget.document.currentRevision).toBe(2);

    // …and the evidence appendix is charged against the same budget, so the
    // identical tree WITH evidence is rejected before the transaction.
    const rejected = await store
      .saveDocumentRevision(account, document.id, {
        baseRevisionId: atBudget.revision.id,
        tree: tree("Over budget", { sections: sections20(fat), evidence: [evidenceRef()] }),
        authorKind: "user",
      })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(DocumentValidationError);
    expect((rejected as DocumentValidationError).code).toBe("DOCUMENT_OVERSIZE");

    // Nothing was written for the rejected save.
    const head = await store.getDocument(account, document.id);
    expect(head?.currentRevision).toBe(2);
    expect(head?.revisionCount).toBe(2);

    // A slightly smaller tree with evidence still saves (reserve respected).
    const fit = await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: atBudget.revision.id,
      tree: tree("Fit", { sections: sections20("y".repeat(9_950)), evidence: [evidenceRef()] }),
      authorKind: "user",
    });
    expect(fit.document.currentRevision).toBe(3);
  });

  it("bounds evidence references and serialized evidence", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);

    const tooMany = await store
      .saveDocumentRevision(account, document.id, {
        baseRevisionId: revision.id,
        tree: tree("Too many", { evidence: Array.from({ length: 101 }, () => evidenceRef()) }),
        authorKind: "user",
      })
      .catch((error: unknown) => error);
    expect(tooMany).toBeInstanceOf(DocumentValidationError);

    const fatEvidence = Array.from({ length: 90 }, () =>
      evidenceRef({ locator: "p".repeat(500), excerpt: "e".repeat(800) })
    );
    const oversized = await store
      .saveDocumentRevision(account, document.id, {
        baseRevisionId: revision.id,
        tree: tree("Fat evidence", { evidence: fatEvidence }),
        authorKind: "user",
      })
      .catch((error: unknown) => error);
    expect(oversized).toBeInstanceOf(DocumentValidationError);
    expect((oversized as DocumentValidationError).code).toBe("DOCUMENT_OVERSIZE");
  });

  it("gives unresolved markers plain-text status and deterministic per-revision numbers", () => {
    const first = evidenceRef();
    const second = evidenceRef({ source_name: "Ops.md" });
    const appendix = buildEvidenceAppendix([first, second]);
    expect(appendix).toBe(buildEvidenceAppendix([first, second]));
    expect(appendix).toContain("[1] Sales.csv");
    expect(appendix).toContain("[2] Ops.md");

    const resolved = resolveDocumentEvidenceMarkers("[2] and [1] plus [9] plus [0]", [first, second]);
    expect(resolved.map((entry) => entry.n)).toEqual([1, 2]);

    // Reordering keeps identities and renumbers deterministically.
    const reordered = buildEvidenceAppendix([second, first]);
    expect(reordered).toContain("[1] Ops.md");
    expect(reordered).toContain("[2] Sales.csv");
    expect(buildEvidenceAppendix([])).toBe("");
    expect(resolveDocumentEvidenceMarkers("[1]", [])).toEqual([]);
  });

  it("renames through a title-only revision so published exports keep frozen titles", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const publication = await publishHead(store, account, document.id, randomUUID());

    const renamed = await store.renameDocument(account, document.id, {
      expectedRevisionId: revision.id,
      title: "Renamed brief",
    });
    expect(renamed.document.currentRevision).toBe(2);
    expect(renamed.document.title).toBe("Renamed brief");
    expect(renamed.revision.payload.sections).toEqual(revision.payload.sections);

    const oldRevision = await store.getDocumentRevision(account, document.id, revision.id);
    expect(oldRevision?.title).toBe("Quarterly brief");
    const published = await store.listDocumentPublications(account, document.id);
    expect(published.items[0]?.title).toBe("Quarterly brief");
    expect(publication.title).toBe("Quarterly brief");

    // A rename is revision-checked: a stale expected head conflicts.
    await expect(
      store.renameDocument(account, document.id, { expectedRevisionId: revision.id, title: "Stale" })
    ).rejects.toMatchObject({
      name: "DocumentRevisionConflictError",
      currentHead: { revision: 2, title: "Renamed brief" },
    });
  });

  it("copies owned legacy reports frozen into revision 1 without touching the report chain", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const chatId = await insertChat(ledger, account);
    const reportId = await insertPublishedReport(ledger, account, { chatId, payload: legacyReportPayload() });

    const copied = await store.createEditableCopy(account, reportId);
    expect(copied.document.origin).toEqual({ reportId, chatId, runId: null, analysisResultId: null });
    expect(copied.document.title).toBe("Finance brief");
    const payload = copied.revision.payload;
    expect(payload.verified).toBe(false);
    expect(payload.evidence).toEqual([]);
    expect(payload.sections).toHaveLength(2);
    expect(payload.sections[0]!.id).toMatch(UUID_RE);
    // The model-garbled 12-character chart id survives verbatim.
    expect(payload.charts[0]!.id).toBe("abcd1234efgh");
    expect(payload.tables[0]!.rows[1]).toEqual(["2026-08", 12]);
    expect(payload.tables[0]!.analysis).toBeNull();

    // The legacy row is byte-identical and its chain fields are untouched.
    const report = await ledger.get<{ title: string; version: bigint; payload: string; supersedes: string | null }>(
      "SELECT title,version,payload,supersedes FROM reports WHERE id=?",
      [reportId]
    );
    expect(report).toMatchObject({ title: "Finance brief", supersedes: null });
    expect(Number(report?.version)).toBe(1);
    expect(JSON.parse(report!.payload).sections[0].markdown).toBe("Revenue grew [1].");

    // Deleting report/chat/source after copying keeps the frozen copy readable.
    await ledger.run("DELETE FROM chats WHERE id=?", [chatId]);
    await ledger.run("DELETE FROM reports WHERE id=?", [reportId]);
    const surviving = await store.getDocumentRevision(account, copied.document.id, copied.revision.id);
    expect(surviving?.payload.charts[0]!.id).toBe("abcd1234efgh");
    expect(surviving?.payload.tables[0]!.columns).toEqual(["month", "revenue"]);
    const stillDocumented = await store.getDocument(account, copied.document.id);
    expect(stillDocumented?.origin.reportId).toBe(reportId);
  });

  it("refuses editable copies for missing payloads, foreign, or non-published reports", async () => {
    const { ledger, store } = await setup();
    const owner = await insertUser(ledger, "owner");
    const other = await insertUser(ledger, "other");

    const missingPayload = await insertPublishedReport(ledger, owner, { payload: null });
    await expect(store.createEditableCopy(owner, missingPayload)).rejects.toBeInstanceOf(DocumentUnavailableError);

    const owned = await insertPublishedReport(ledger, owner, { payload: legacyReportPayload() });
    // A same-instance share recipient never owns the row, so the copy fails
    // the same owner-only way — no payload leaks through the copy path.
    await expect(store.createEditableCopy(other, owned)).rejects.toBeInstanceOf(DocumentNotFoundError);

    const pending = await insertPublishedReport(ledger, owner, {
      payload: legacyReportPayload(),
      status: "pending",
    });
    await expect(store.createEditableCopy(owner, pending)).rejects.toBeInstanceOf(DocumentNotFoundError);
    await expect(store.createEditableCopy(owner, randomUUID())).rejects.toBeInstanceOf(DocumentNotFoundError);
  });

  it("records durable artifact cleanup on deletion and refuses while a render is active", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document } = await createDocument(store, account);
    await publishHead(store, account, document.id, randomUUID());

    const begun = await store.beginDocumentPublication(account, document.id, { operationId: randomUUID() });
    await expect(store.deleteDocument(account, document.id)).rejects.toBeInstanceOf(DocumentPublicationActiveError);
    await store.failDocumentPublication(account, document.id, begun.intent.operationId);

    const intent = await store.deleteDocument(account, document.id);
    expect(intent).toMatchObject({ documentId: document.id, accountId: account });
    await expect(store.deleteDocument(account, document.id)).resolves.toBeNull();
    expect(await store.getDocument(account, document.id)).toBeUndefined();
    await expect(ledger.all("SELECT 1 FROM document_revisions")).resolves.toEqual([]);
    await expect(ledger.all("SELECT 1 FROM document_publications")).resolves.toEqual([]);

    const intents = await store.listDocumentArtifactCleanupIntents();
    expect(intents.map((job) => job.documentId)).toContain(document.id);
    await store.recordDocumentArtifactCleanupFailure(account, document.id, "DOCUMENT_ARTIFACT_CLEANUP_FAILED");
    expect((await store.listDocumentArtifactCleanupIntents())[0]?.attempts).toBe(1);
    expect(await store.clearDocumentArtifactCleanupIntent(account, document.id)).toBe(true);
    expect(await store.listDocumentArtifactCleanupIntents()).toEqual([]);
  });

  it("publishes version chains idempotently with artifact-path and head guards", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const operationId = randomUUID();

    const begun = await store.beginDocumentPublication(account, document.id, {
      operationId,
      expectedRevisionId: revision.id,
    });
    expect(begun.intent.status).toBe("rendering");
    expect(begun.intent.artifactDirectory).toBe(path.join("/artifacts", account, document.id, begun.intent.id));

    // The same operation UUID is idempotent while the render is in flight.
    const replay = await store.beginDocumentPublication(account, document.id, { operationId });
    expect(replay.replayed).toBe(true);
    expect(replay.intent.id).toBe(begun.intent.id);

    // A second operation may not open a second active publication.
    await expect(
      store.beginDocumentPublication(account, document.id, { operationId: randomUUID() })
    ).rejects.toBeInstanceOf(DocumentPublicationActiveError);

    // Escaped artifact paths fail closed.
    await expect(
      store.markDocumentPublicationReady(account, document.id, operationId, {
        htmlPath: "/artifacts/elsewhere/document.html",
        pdfPath: path.join(begun.intent.artifactDirectory, "document.pdf"),
      })
    ).rejects.toBeInstanceOf(DocumentPublicationStateError);
    // Completion before the render records artifacts fails closed.
    await expect(store.completeDocumentPublication(account, document.id, operationId)).rejects.toBeInstanceOf(
      DocumentPublicationStateError
    );

    await store.markDocumentPublicationReady(account, document.id, operationId, {
      htmlPath: path.join(begun.intent.artifactDirectory, "document.html"),
      pdfPath: path.join(begun.intent.artifactDirectory, "document.pdf"),
    });
    const first = await store.completeDocumentPublication(account, document.id, operationId);
    expect(first.publication).toMatchObject({ version: 1, revision: 1, supersedes: null, title: "Quarterly brief" });

    // Completion replays the original publication for the same operation.
    const replayComplete = await store.completeDocumentPublication(account, document.id, operationId);
    expect(replayComplete.replayed).toBe(true);
    expect(replayComplete.publication.id).toBe(first.publication.id);

    const second = await publishHead(store, account, document.id, randomUUID());
    expect(second.version).toBe(2);
    expect(second.supersedes).toBe(first.publication.id);

    // Failed renders are retryable through the same operation UUID.
    const failedOp = randomUUID();
    await store.beginDocumentPublication(account, document.id, { operationId: failedOp });
    await store.failDocumentPublication(account, document.id, failedOp, { errorCode: "RENDER_UNAVAILABLE" });
    const rearmed = await store.beginDocumentPublication(account, document.id, { operationId: failedOp });
    expect(rearmed.replayed).toBe(false);
    expect(rearmed.intent.status).toBe("rendering");
    expect(rearmed.intent.attempts).toBe(1);
    expect(rearmed.intent.errorCode).toBeNull();

    const history = await store.listDocumentPublications(account, document.id);
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
  });

  it("rejects a default head publication whose head moved before completion", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const headOp = randomUUID();
    await store.beginDocumentPublication(account, document.id, { operationId: headOp });

    // The head advances while the render is running.
    await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: revision.id,
      tree: tree("New head"),
      authorKind: "user",
    });
    const intent = (await store.getDocumentPublicationIntent(account, document.id, headOp))!;
    await store.markDocumentPublicationReady(account, document.id, headOp, {
      htmlPath: path.join(intent.artifactDirectory, "document.html"),
      pdfPath: path.join(intent.artifactDirectory, "document.pdf"),
    });
    await expect(store.completeDocumentPublication(account, document.id, headOp)).rejects.toBeInstanceOf(
      DocumentHeadMovedError
    );
    const failed = await store.getDocumentPublicationIntent(account, document.id, headOp);
    expect(failed).toMatchObject({ status: "failed", errorCode: "DOCUMENT_HEAD_MOVED" });
    expect((await store.listDocumentPublications(account, document.id)).items).toEqual([]);
    // The moved head blocks retrying the same default operation too.
    await expect(store.beginDocumentPublication(account, document.id, { operationId: headOp })).rejects.toBeInstanceOf(
      DocumentHeadMovedError
    );
  });

  it("requires explicit selection for non-head revisions and publishes it when allowed", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: revision.id,
      tree: tree("Head two"),
      authorKind: "user",
    });

    await expect(
      store.beginDocumentPublication(account, document.id, { operationId: randomUUID(), revisionId: revision.id })
    ).rejects.toBeInstanceOf(DocumentRevisionSelectionError);

    const operationId = randomUUID();
    const begun = await store.beginDocumentPublication(account, document.id, {
      operationId,
      revisionId: revision.id,
      allowNonHeadRevision: true,
    });
    expect(begun.intent.explicitRevisionSelection).toBe(true);
    await store.markDocumentPublicationReady(account, document.id, operationId, {
      htmlPath: path.join(begun.intent.artifactDirectory, "document.html"),
      pdfPath: path.join(begun.intent.artifactDirectory, "document.pdf"),
    });
    const completed = await store.completeDocumentPublication(account, document.id, operationId);
    expect(completed.publication).toMatchObject({ version: 1, revision: 1, title: "Quarterly brief" });
    const listed = await store.listDocumentRevisions(account, document.id);
    expect(listed.items.find((item) => item.revision === 1)?.publishedVersion).toBe(1);
    expect(listed.items.find((item) => item.revision === 2)?.publishedVersion).toBeNull();
  });

  it("recovers interrupted renders as durable failures reserving exact-directory cleanup", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document } = await createDocument(store, account);
    const operationId = randomUUID();
    const begun = await store.beginDocumentPublication(account, document.id, { operationId });

    expect(await store.recoverInterruptedDocumentPublications()).toBe(1);
    const recovered = await store.getDocumentPublicationIntent(account, document.id, operationId);
    expect(recovered).toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    const jobs = await store.listDocumentPublicationCleanupJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ accountId: account, documentId: document.id });
    expect(jobs[0]!.artifactDirectory).toBe(begun.intent.artifactDirectory);
    // Repeated recovery is a no-op and re-queues nothing.
    expect(await store.recoverInterruptedDocumentPublications()).toBe(0);

    // The operation can be retried once its crash cleanup is consumed.
    expect(await store.clearDocumentPublicationCleanupJob(account, jobs[0]!.id)).toBe(true);
    const rearmed = await store.beginDocumentPublication(account, document.id, { operationId });
    expect(rearmed.intent.status).toBe("rendering");
    expect(rearmed.intent.attempts).toBe(1);
  });

  it("guards begin with an expected head revision", async () => {
    const { ledger, store } = await setup();
    const account = await insertUser(ledger, "owner");
    const { document, revision } = await createDocument(store, account);
    const saved = await store.saveDocumentRevision(account, document.id, {
      baseRevisionId: revision.id,
      tree: tree("New head"),
      authorKind: "user",
    });
    await expect(
      store.beginDocumentPublication(account, document.id, {
        operationId: randomUUID(),
        expectedRevisionId: revision.id,
      })
    ).rejects.toMatchObject({
      name: "DocumentRevisionConflictError",
      currentHead: { revisionId: saved.revision.id, revision: 2 },
    });
  });

  it("proves filesystem ownership for document publication artifact directories", async () => {
    // Canonicalize: macOS tmpdir is a symlinked path and the ownership
    // proofs compare lexical against canonical locations.
    const reportRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-document-artifacts-")));
    tempDirectories.push(reportRoot);
    previousReportDir = config.reportDir;
    config.reportDir = reportRoot;

    const account = randomUUID();
    const documentId = randomUUID();
    const publicationId = randomUUID();
    const directory = await createDocumentPublicationDirectory(account, documentId, publicationId);
    expect(directory).toBe(documentPublicationDirectory(account, documentId, publicationId));
    await fs.writeFile(path.join(directory, "document.html"), "<html></html>");
    expect(await removeDocumentPublicationArtifacts({ accountId: account, documentId, publicationId, directory })).toBe(
      true
    );
    expect(await fs.lstat(path.join(reportRoot, "documents", account)).catch(() => "gone")).toBe("gone");

    // A mismatched stored directory fails closed without deleting anything.
    const other = randomUUID();
    const created = await createDocumentPublicationDirectory(account, documentId, other);
    await fs.writeFile(path.join(created, "document.pdf"), "%PDF");
    expect(
      await removeDocumentPublicationArtifacts({
        accountId: account,
        documentId,
        publicationId: other,
        directory: path.join(created, "intruder"),
      })
    ).toBe(false);
    await fs.lstat(created);
    expect(
      await removeDocumentPublicationArtifacts({
        accountId: account,
        documentId,
        publicationId: other,
        directory: created,
      })
    ).toBe(true);

    // Document-level removal wipes the exact document namespace only.
    const survivor = randomUUID();
    const doomed = randomUUID();
    await createDocumentPublicationDirectory(account, survivor, publicationId);
    await createDocumentPublicationDirectory(account, doomed, publicationId);
    expect(await removeDocumentArtifacts({ accountId: account, documentId: doomed })).toBe(true);
    await fs.lstat(path.join(reportRoot, "documents", account, survivor));
    // Already-gone stays a satisfied idempotent success.
    expect(await removeDocumentArtifacts({ accountId: account, documentId: doomed })).toBe(true);
  });
});
