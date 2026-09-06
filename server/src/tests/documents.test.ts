/**
 * M13 stage 4 — publication compile matrix and lifecycle.
 *
 * The compile matrix runs against an injected renderer (deterministic,
 * offline) plus one real-Playwright proof that the shipped default renderer
 * seam produces the same verified contract. The lifecycle tests drive the
 * durable intent protocol through the service: operation replay, head
 * movement, explicit non-head selection, crash recovery, one-active renders,
 * explicit per-format failures with cleanup, and owner-only exports.
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import mammoth from "mammoth";

import { config } from "../config.js";
import {
  compileDocumentPublication,
  DocumentFormatError,
  hasPdfMagic,
  hasZipMagic,
  isOoxmlDocument,
  readZipMembers,
  type DocumentRenderers,
} from "../data/documents.js";
import { DocumentHeadMovedError, DocumentPublicationActiveError } from "../db/stores/documentStore.js";
import { repairDocumentArtifactCleanup, repairDocumentPublications } from "../documentCleanup.js";
import {
  getDocumentPublicationExport,
  publishDocumentRevision,
  deleteDocumentWithCleanup,
} from "../documentService.js";
import {
  buildPublicationValidity,
  DOCUMENT_SECTIONS_MAX,
  normalizeDocumentTree,
  type DocumentTree,
  type DocumentTreeInput,
} from "../documentTypes.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from("ihdr-payload-for-tests")]);
const FAKE_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");

function fakeRenderers(overrides: Partial<DocumentRenderers> = {}): DocumentRenderers {
  return {
    renderChartPng: async () => FAKE_PNG,
    renderReportPdf: async () => FAKE_PDF,
    ...overrides,
  };
}

const ACCOUNT = randomUUID();

function fixtureTreeInput(): DocumentTreeInput {
  return {
    title: "Quarterly finance brief",
    subtitle: "Q3 review",
    verified: true,
    sections: [
      {
        heading: "Findings",
        markdown:
          "Net positive [1]; manual claim [9] must stay plain text; unresolved [42] too.\n\n" +
          "See the trend ![trend](chart:chart-1).\n\n" +
          "Inline table:\n| k | v |\n|---|---|\n| a | 1 |",
      },
      { heading: "Method", markdown: "Deterministic numbering per revision." },
    ],
    charts: [
      {
        id: "chart-1",
        spec: {
          type: "bar",
          title: "Monthly spend",
          categories: ["jul", "aug"],
          series: [{ name: "amount", data: [1000, 1234], color: "#6366F1" }],
        },
      },
    ],
    tables: [
      {
        columns: ["month", "amount"],
        rows: [
          ["jul", 1000],
          ["aug", 1234],
        ],
        analysis: {
          analysis_id: randomUUID(),
          analysis_revision: 3,
          result_id: randomUUID(),
          parameters: [{ name: "month", type: "string", value: "jul" }],
          source_generations: [
            { source_id: randomUUID(), ready_generation: 2, content_identity: "sha256:generation-content" },
          ],
          columns: [
            { name: "month", type: "string" },
            { name: "amount", type: "number" },
          ],
          completeness: { complete: false, reasons: ["row limit reached"] },
          schema_fingerprint: "fp-test-1",
        },
      },
    ],
    evidence: [
      {
        id: randomUUID(),
        source_id: randomUUID(),
        source_name: "ledger.csv",
        generation: 2,
        content_identity: "sha256:verified-content",
        locator: "row 7",
        excerpt: "verified provenance excerpt",
      },
      {
        id: randomUUID(),
        source_id: randomUUID(),
        source_name: "legacy-note.pdf",
        generation: "unknown",
        content_identity: "unknown",
        locator: null,
        excerpt: "unverified excerpt with UNKNOWN-PROVENANCE marker",
      },
    ],
  };
}

function fixtureTree(): DocumentTree {
  return normalizeDocumentTree(fixtureTreeInput()).tree;
}

async function compileFixture(
  tree: DocumentTree,
  renderers: DocumentRenderers,
  generatedAt = "2026-09-06 12:00 UTC",
  meta?: { documentId: string; revisionId: string; revision: number; version: number }
) {
  const directory = await fs.mkdtemp(path.join(tempRoot, "compile-"));
  return await compileDocumentPublication({
    accountId: ACCOUNT,
    directory,
    tree,
    meta: meta ?? { documentId: randomUUID(), revisionId: randomUUID(), revision: 1, version: 1 },
    generatedAt,
    renderers,
  });
}

let tempRoot = "";
const tempDirectories: string[] = [];

beforeEach(async () => {
  tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "borealis-documents-")));
  tempDirectories.push(tempRoot);
  config.reportDir = path.join(tempRoot, "reports");
  await initializeStorageRuntime({
    sqlitePath: path.join(tempRoot, "ledger.sqlite"),
    lanceDirectory: path.join(tempRoot, "lancedb"),
    embeddingDimension: 3,
  });
  await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
    ACCOUNT,
    "owner@example.test",
    "hash",
  ]);
});

afterEach(async () => {
  await closeStorageRuntime();
  for (const directory of tempDirectories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  tempRoot = "";
});

describe("document publication compile matrix", () => {
  it("compiles one frozen revision into all four verified formats", async () => {
    const tree = fixtureTree();
    const meta = { documentId: randomUUID(), revisionId: randomUUID(), revision: 1, version: 1 };
    const compiled = await compileFixture(tree, fakeRenderers(), "2026-09-06 12:00 UTC", meta);

    // PDF: magic bytes only (opaque bytes from the injected backend).
    expect(hasPdfMagic(compiled.pdf)).toBe(true);

    // HTML: self-contained — embedded chart PNG, appendix, validity, no
    // external resource references, unresolved tokens as plain text.
    const html = compiled.html.toString("utf8");
    expect(html).toContain("Net positive [1]");
    expect(html).toContain("unresolved [42] too.");
    expect(html).toContain("data:image/png;base64," + FAKE_PNG.toString("base64"));
    expect(html).toContain("provenance verified");
    expect(html).toContain("UNKNOWN-PROVENANCE marker");
    expect(html).toContain("Evidence: 1 provenance verified, 1 unknown");
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/href="https?:[^"]*"\s*rel="stylesheet/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toContain("<script");

    // Markdown ZIP: exact member list, relative assets, no absolute paths,
    // no remote references, provenance manifest, real .md.
    const members = readZipMembers(compiled.markdownZip);
    expect([...members.keys()].sort()).toEqual(["assets/chart-1.png", "document.md", "manifest.json"]);
    const markdown = members.get("document.md")!.toString("utf8");
    expect(markdown).toContain("# Quarterly finance brief");
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("![Monthly spend](assets/chart-1.png)");
    expect(markdown).toContain("| jul | 1000 |");
    expect(markdown).toContain("incomplete: row limit reached");
    expect(markdown).toContain("## Evidence");
    expect(markdown).toContain("[1] ledger.csv · row 7 · provenance verified · generation 2");
    expect(markdown).toContain("[2] legacy-note.pdf · provenance unknown");
    expect(markdown).toContain("manual claim [9] must stay plain text");
    expect(markdown).not.toMatch(/\((?:https?:|\/|file:|\\\\)/);
    expect(markdown).not.toContain("http");
    expect(members.get("assets/chart-1.png")!.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    const manifest = JSON.parse(members.get("manifest.json")!.toString("utf8"));
    expect(manifest.contract).toBe("borealis-document-export/1");
    expect(manifest.validity).toBe(buildPublicationValidity(fixtureTree()));
    expect(manifest.evidence.map((entry: { verified: boolean }) => entry.verified)).toEqual([true, false]);
    expect(manifest.charts[0]).toMatchObject({ number: 1, file: "assets/chart-1.png", id: "chart-1" });
    expect(manifest.tables[0].provenance).toMatchObject({ analysis_revision: 3, complete: false });

    // DOCX: readable OOXML with native headings, table, embedded PNG, and
    // the citations/appendix; unresolved tokens stay plain text.
    expect(isOoxmlDocument(compiled.docx)).toBe(true);
    const docxMembers = readZipMembers(compiled.docx);
    expect([...docxMembers.keys()].some((name) => name.startsWith("word/media/") && name.endsWith(".png"))).toBe(true);
    const docxText = (await mammoth.extractRawText({ buffer: compiled.docx })).value;
    expect(docxText).toContain("Quarterly finance brief");
    expect(docxText).toContain("Net positive [1]");
    expect(docxText).toContain("unresolved [42] too.");
    expect(docxText).toContain("UNKNOWN-PROVENANCE marker");
    const docxHtml = (await mammoth.convertToHtml({ buffer: compiled.docx })).value;
    expect(docxHtml).toMatch(/<h1[^>]*>Quarterly finance brief/);
    expect(docxHtml).toMatch(/<h2[^>]*>Findings/);
    expect(docxHtml).toContain("<table>");
    expect(docxHtml).toMatch(/<h2[^>]*>Evidence/);

    // Same frozen revision, same generated time → byte-identical text
    // formats (deterministic numbering and serialization).
    const again = await compileFixture(tree, fakeRenderers(), "2026-09-06 12:00 UTC", meta);
    expect(again.html.equals(compiled.html)).toBe(true);
    expect(readZipMembers(again.markdownZip).get("document.md")!.equals(members.get("document.md")!)).toBe(true);
    expect(readZipMembers(again.markdownZip).get("manifest.json")!.equals(members.get("manifest.json")!)).toBe(true);
  });

  it("compiles a 20-section revision plus a large evidence appendix without export failure", async () => {
    const input = fixtureTreeInput();
    input.sections = Array.from({ length: DOCUMENT_SECTIONS_MAX }, (_, index) => ({
      heading: `Section ${index + 1}`,
      markdown: `Body ${index + 1} citing [1] and unresolved [77].`,
    }));
    input.evidence = Array.from({ length: 40 }, (_, index) => ({
      id: randomUUID(),
      source_id: randomUUID(),
      source_name: `source-${index}.csv`,
      generation: index % 2 === 0 ? index : ("unknown" as const),
      content_identity: index % 2 === 0 ? `sha256:${index}` : ("unknown" as const),
      locator: null,
      excerpt: `excerpt ${index} ${"x".repeat(200)}`,
    }));
    const tree = normalizeDocumentTree(input).tree;
    const compiled = await compileFixture(tree, fakeRenderers());
    expect(hasPdfMagic(compiled.pdf)).toBe(true);
    expect(isOoxmlDocument(compiled.docx)).toBe(true);
    const members = readZipMembers(compiled.markdownZip);
    const markdown = members.get("document.md")!.toString("utf8");
    expect(markdown).toContain("## Section 20");
    expect(markdown).toContain("[40] source-39.csv · provenance unknown");
    expect(markdown).toContain("unresolved [77]");
  });

  it("rejects invalid artifact magic bytes with explicit per-format failures", async () => {
    await expect(
      compileFixture(fixtureTree(), fakeRenderers({ renderReportPdf: async () => Buffer.from("NOT-A-PDF") }))
    ).rejects.toMatchObject({ name: "DocumentFormatError", code: "PUBLICATION_PDF_FAILED", format: "pdf" });

    await expect(
      compileFixture(fixtureTree(), fakeRenderers({ renderChartPng: async () => Buffer.from("NOT-A-PNG") }))
    ).rejects.toMatchObject({ name: "DocumentFormatError", code: "PUBLICATION_RENDER_FAILED" });

    await expect(
      compileFixture(
        fixtureTree(),
        fakeRenderers({
          renderChartPng: async () => {
            throw new Error("render queue full");
          },
        })
      )
    ).rejects.toBeInstanceOf(DocumentFormatError);
  });

  it("produces the same verified contract through the shipped default renderer", async () => {
    const tree = fixtureTree();
    const directory = await fs.mkdtemp(path.join(tempRoot, "real-render-"));
    const compiled = await compileDocumentPublication({
      accountId: ACCOUNT,
      directory,
      tree,
      meta: { documentId: randomUUID(), revisionId: randomUUID(), revision: 1, version: 1 },
      generatedAt: "2026-09-06 12:00 UTC",
    });
    expect(hasPdfMagic(compiled.pdf)).toBe(true);
    const html = compiled.html.toString("utf8");
    expect(html).toContain("data:image/png;base64,");
    expect(html).not.toMatch(/src="https?:/i);
    expect(isOoxmlDocument(compiled.docx)).toBe(true);
    expect(readZipMembers(compiled.markdownZip).has("assets/chart-1.png")).toBe(true);
  });
});

describe("document publication lifecycle", () => {
  async function createDocument(title = "Lifecycle brief", tree?: DocumentTreeInput) {
    return storageRuntime().documents.createDocument(ACCOUNT, {
      title,
      tree: tree ?? fixtureTreeInput(),
    });
  }

  async function publishedFixture() {
    const created = await createDocument();
    const outcome = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId: randomUUID(),
      renderers: fakeRenderers(),
    });
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") throw new Error("unreachable");
    return { created, publication: outcome.publication };
  }

  function publicationDirectoryFor(accountId: string, documentId: string, intentId: string): string {
    return path.join(config.reportDir, "documents", accountId, documentId, intentId);
  }

  it("assigns transactional versions only after artifacts exist and replays by operation UUID", async () => {
    const created = await createDocument();
    const operationId = randomUUID();
    const first = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId,
      renderers: fakeRenderers(),
    });
    expect(first.kind).toBe("published");
    if (first.kind !== "published") throw new Error("unreachable");
    expect(first.publication).toMatchObject({ version: 1, revision: 1 });

    // All four artifacts exist on disk inside the exact attempt directory.
    const intent = await storageRuntime().documents.getDocumentPublicationIntent(
      ACCOUNT,
      created.document.id,
      operationId
    );
    const directory = publicationDirectoryFor(ACCOUNT, created.document.id, intent!.id);
    expect((await fs.readdir(directory)).sort()).toEqual([
      "document.docx",
      "document.html",
      "document.pdf",
      "document.zip",
    ]);
    expect(first.publication.htmlPath).toBe(path.join(directory, "document.html"));

    const replay = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId,
      renderers: fakeRenderers(),
    });
    expect(replay.kind).toBe("published");
    if (replay.kind !== "published") throw new Error("unreachable");
    expect(replay.replayed).toBe(true);
    expect(replay.publication.id).toBe(first.publication.id);

    // A second published revision chains versions and supersedes.
    const saved = await storageRuntime().documents.saveDocumentRevision(ACCOUNT, created.document.id, {
      baseRevisionId: created.revision.id,
      tree: fixtureTreeInput(),
      authorKind: "user",
    });
    const second = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: saved.revision.id,
      operationId: randomUUID(),
      renderers: fakeRenderers(),
    });
    expect(second.kind).toBe("published");
    if (second.kind !== "published") throw new Error("unreachable");
    expect(second.publication).toMatchObject({ version: 2, revision: 2, supersedes: first.publication.id });

    const history = await storageRuntime().documents.listDocumentPublications(ACCOUNT, created.document.id);
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
  });

  it("rejects a moved head for the default action and requires an explicit non-head selection", async () => {
    const created = await createDocument();

    // Begin the default publication of the head, then move the head before
    // completion: the completion transaction rejects and records a durable
    // retryable failure without publishing unseen content.
    const begin = await storageRuntime().documents.beginDocumentPublication(ACCOUNT, created.document.id, {
      operationId: randomUUID(),
      revisionId: created.revision.id,
    });
    await fs.mkdir(begin.intent.artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(begin.intent.artifactDirectory, "document.html"), "<html></html>");
    await storageRuntime().documents.saveDocumentRevision(ACCOUNT, created.document.id, {
      baseRevisionId: created.revision.id,
      tree: fixtureTreeInput(),
      authorKind: "user",
    });
    await storageRuntime().documents.markDocumentPublicationReady(
      ACCOUNT,
      created.document.id,
      begin.intent.operationId,
      {
        htmlPath: path.join(begin.intent.artifactDirectory, "document.html"),
        pdfPath: path.join(begin.intent.artifactDirectory, "document.pdf"),
      }
    );
    await expect(
      storageRuntime().documents.completeDocumentPublication(ACCOUNT, created.document.id, begin.intent.operationId)
    ).rejects.toBeInstanceOf(DocumentHeadMovedError);
    const failed = await storageRuntime().documents.getDocumentPublicationIntent(
      ACCOUNT,
      created.document.id,
      begin.intent.operationId
    );
    expect(failed).toMatchObject({ status: "failed", errorCode: "DOCUMENT_HEAD_MOVED" });
    expect((await storageRuntime().documents.listDocumentPublications(ACCOUNT, created.document.id)).items).toEqual([]);

    // Publishing the stale revision now requires the explicit selection bit;
    // with it, the exactly reviewed revision publishes.
    await expect(
      publishDocumentRevision({
        accountId: ACCOUNT,
        documentId: created.document.id,
        revisionId: created.revision.id,
        operationId: randomUUID(),
        renderers: fakeRenderers(),
      })
    ).rejects.toMatchObject({ name: "DocumentRevisionSelectionError" });
    const explicit = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId: randomUUID(),
      allowNonHeadRevision: true,
      renderers: fakeRenderers(),
    });
    expect(explicit.kind).toBe("published");
    if (explicit.kind !== "published") throw new Error("unreachable");
    expect(explicit.publication).toMatchObject({ revision: 1, version: 1 });
  });

  it("recovers interrupted renders at startup without ever auto-publishing", async () => {
    const created = await createDocument();
    const begin = await storageRuntime().documents.beginDocumentPublication(ACCOUNT, created.document.id, {
      operationId: randomUUID(),
    });
    // Simulate a crash mid-render: partial bytes exist and the row is stuck.
    await fs.mkdir(begin.intent.artifactDirectory, { recursive: true });
    await fs.writeFile(path.join(begin.intent.artifactDirectory, "document.html"), "<html>partial");
    await storageRuntime().documents.markDocumentPublicationReady(
      ACCOUNT,
      created.document.id,
      begin.intent.operationId,
      {
        htmlPath: path.join(begin.intent.artifactDirectory, "document.html"),
        pdfPath: path.join(begin.intent.artifactDirectory, "document.pdf"),
      }
    );

    const summary = await repairDocumentPublications();
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    const intent = await storageRuntime().documents.getDocumentPublicationIntent(
      ACCOUNT,
      created.document.id,
      begin.intent.operationId
    );
    expect(intent).toMatchObject({ status: "failed", errorCode: "SERVER_RESTARTED" });
    await expect(fs.lstat(begin.intent.artifactDirectory)).rejects.toThrow();
    expect((await storageRuntime().documents.listDocumentPublications(ACCOUNT, created.document.id)).items).toEqual([]);
    expect(await storageRuntime().documents.listDocumentPublicationCleanupJobs()).toEqual([]);

    // The draft and head are untouched and a fresh publication works after
    // the recovered failure.
    const document = await storageRuntime().documents.getDocument(ACCOUNT, created.document.id);
    expect(document?.currentRevisionId).toBe(created.revision.id);
    const published = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId: randomUUID(),
      renderers: fakeRenderers(),
    });
    expect(published.kind).toBe("published");
  });

  it("keeps one active publication per document and cleans failed attempts", async () => {
    const created = await createDocument();
    const begin = await storageRuntime().documents.beginDocumentPublication(ACCOUNT, created.document.id, {
      operationId: randomUUID(),
    });
    await expect(
      publishDocumentRevision({
        accountId: ACCOUNT,
        documentId: created.document.id,
        revisionId: created.revision.id,
        operationId: randomUUID(),
        renderers: fakeRenderers(),
      })
    ).rejects.toBeInstanceOf(DocumentPublicationActiveError);
    await storageRuntime().documents.failDocumentPublication(ACCOUNT, created.document.id, begin.intent.operationId, {
      errorCode: "TEST_CLEANUP",
    });

    // A per-format failure is recorded durably, the exact partial directory
    // is removed, and a retry with a new operation succeeds.
    let attempted = 0;
    await expect(
      publishDocumentRevision({
        accountId: ACCOUNT,
        documentId: created.document.id,
        revisionId: created.revision.id,
        operationId: randomUUID(),
        renderers: fakeRenderers({
          renderReportPdf: async () => {
            attempted += 1;
            return Buffer.from("NOT-A-PDF");
          },
        }),
      })
    ).rejects.toMatchObject({ name: "DocumentPublicationRenderError", code: "PUBLICATION_PDF_FAILED" });
    expect(attempted).toBe(1);
    const failed = await storageRuntime().documents.getLatestDocumentPublicationIntent(ACCOUNT, created.document.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "PUBLICATION_PDF_FAILED" });
    await expect(fs.lstat(failed!.artifactDirectory)).rejects.toThrow();

    const retry = await publishDocumentRevision({
      accountId: ACCOUNT,
      documentId: created.document.id,
      revisionId: created.revision.id,
      operationId: randomUUID(),
      renderers: fakeRenderers(),
    });
    expect(retry.kind).toBe("published");
  });

  it("serves exact frozen exports to the owner only and defers cleanly when artifacts vanish", async () => {
    const { created, publication } = await publishedFixture();
    for (const format of ["html", "pdf", "markdown", "docx"] as const) {
      const result = await getDocumentPublicationExport(ACCOUNT, created.document.id, publication.id, format);
      expect(result).toBeDefined();
      const bytes = await fs.readFile(result!.filePath);
      expect(bytes.length).toBeGreaterThan(0);
      if (format === "pdf") expect(hasPdfMagic(bytes)).toBe(true);
      if (format === "markdown") expect(hasZipMagic(bytes)).toBe(true);
      if (format === "docx") expect(isOoxmlDocument(bytes)).toBe(true);
    }

    const FOREIGN = randomUUID();
    await storageRuntime().ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [
      FOREIGN,
      "foreign@example.test",
      "hash",
    ]);
    expect(await getDocumentPublicationExport(FOREIGN, created.document.id, publication.id, "pdf")).toBeUndefined();

    // A vanished artifact is a miss, not a fallback to other paths.
    await fs.unlink(publication.htmlPath);
    expect(await getDocumentPublicationExport(ACCOUNT, created.document.id, publication.id, "html")).toBeUndefined();
  });

  it("completes durable document-deletion cleanup intents at startup repair", async () => {
    const { created } = await publishedFixture();
    const documentsRoot = path.join(config.reportDir, "documents", ACCOUNT, created.document.id);
    await fs.lstat(documentsRoot);
    const outcome = await deleteDocumentWithCleanup(ACCOUNT, created.document.id);
    expect(outcome).toBe("deleted");
    await expect(fs.lstat(documentsRoot)).rejects.toThrow();

    // A second document whose cleanup was interrupted reserves the intent via
    // the delete trigger; startup repair completes it.
    const second = await createDocument("Interrupted");
    await storageRuntime().documents.deleteDocument(ACCOUNT, second.document.id);
    const directory = path.join(config.reportDir, "documents", ACCOUNT, second.document.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "stray.txt"), "x");
    const summary = await repairDocumentArtifactCleanup();
    expect(summary.completed).toBeGreaterThanOrEqual(1);
    await expect(fs.lstat(directory)).rejects.toThrow();
    expect(await storageRuntime().documents.listDocumentArtifactCleanupIntents()).toEqual([]);
  });
});
