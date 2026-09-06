import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { signToken } from "../auth.js";
import { encodeJson } from "../db/codecs.js";
import { documentRoutes } from "../routes/documents.js";
import { installHttpBoundary } from "../httpErrors.js";
import { closeStorageRuntime, initializeStorageRuntime, storageRuntime } from "../storageRuntime.js";
import { BUILTIN_DOCUMENT_TEMPLATES } from "../documentTemplates.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ownerAuth = { authorization: `Bearer ${signToken({ userId: OWNER, email: "owner@example.test" })}` };
const foreignAuth = { authorization: `Bearer ${signToken({ userId: FOREIGN, email: "foreign@example.test" })}` };

const apps: FastifyInstance[] = [];
let runtimeDirectory = "";

beforeEach(async () => {
  runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "borealis-document-routes-"));
  const runtime = await initializeStorageRuntime({
    sqlitePath: path.join(runtimeDirectory, "ledger.sqlite"),
    lanceDirectory: path.join(runtimeDirectory, "lancedb"),
    embeddingDimension: 3,
  });
  for (const [id, email] of [
    [OWNER, "owner@example.test"],
    [FOREIGN, "foreign@example.test"],
  ] as const) {
    await runtime.ledger.run("INSERT INTO users (id,email,password_hash) VALUES (?,?,?)", [id, email, "hash"]);
  }
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await closeStorageRuntime();
  if (runtimeDirectory) await fs.rm(runtimeDirectory, { recursive: true, force: true });
  runtimeDirectory = "";
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installHttpBoundary(app);
  await app.register(documentRoutes);
  await app.ready();
  return app;
}

async function insertReport(input: {
  id: string;
  accountId: string;
  status: "pending" | "published";
  title: string;
  payload?: unknown;
}): Promise<void> {
  await storageRuntime().ledger.run(
    `INSERT INTO reports (id,account_id,status,title,html_path,pdf_path,payload) VALUES (?,?,?,?,?,?,?)`,
    [
      input.id,
      input.accountId,
      input.status,
      input.title,
      null,
      null,
      input.payload === undefined ? null : encodeJson(input.payload, "report payload"),
    ]
  );
}

const LEGACY_PAYLOAD = {
  title: "Q3 spend",
  subtitle: "",
  generated_at: "",
  sections: [{ heading: "Overview", markdown: "Spend rose 12% [1]." }],
  charts: [],
  tables: [{ columns: ["month", "amount"], rows: [["jul", 100]] }],
};

const richTree = () => ({
  title: "Sourced draft",
  subtitle: "with evidence",
  verified: true,
  sections: [
    { id: randomUUID(), heading: "Findings", markdown: "Net positive [1]." },
    { id: randomUUID(), heading: "Notes", markdown: "Manual claim, no citation." },
  ],
  charts: [
    {
      id: "chart-1",
      spec: {
        type: "bar",
        title: "Spend",
        categories: ["jul"],
        series: [{ name: "amount", data: [1234], color: "#6366F1" }],
      },
    },
  ],
  tables: [{ columns: ["month", "amount"], rows: [["jul", 1234]], analysis: null }],
  evidence: [
    {
      id: randomUUID(),
      source_id: randomUUID(),
      source_name: "ledger.csv",
      generation: 2,
      content_identity: "sha256:secret-content-id",
      locator: "row 7",
      excerpt: "TOP-SECRET-EXCERPT the quick brown fox",
    },
  ],
});

async function createDocument(
  app: FastifyInstance,
  body: Record<string, unknown>,
  headers = ownerAuth
): Promise<{ document: any; revision: any }> {
  const response = await app.inject({ method: "POST", url: "/api/documents", headers, body });
  expect(response.statusCode).toBe(201);
  return response.json();
}

describe("document routes", () => {
  it("requires authentication on every documents and templates route", async () => {
    const app = await buildApp();
    const cases: Array<[string, string, unknown?]> = [
      ["GET", "/api/documents"],
      ["POST", "/api/documents", {}],
      ["GET", `/api/documents/${randomUUID()}`],
      ["DELETE", `/api/documents/${randomUUID()}`],
      ["GET", `/api/documents/${randomUUID()}/revisions`],
      ["POST", `/api/documents/${randomUUID()}/revisions`, { base_revision_id: randomUUID(), tree: {} }],
      ["GET", `/api/documents/${randomUUID()}/revisions/${randomUUID()}`],
      ["GET", `/api/documents/${randomUUID()}/diff?base=${randomUUID()}&target=${randomUUID()}`],
      ["GET", `/api/documents/${randomUUID()}/publications`],
      ["POST", `/api/documents/${randomUUID()}/revisions/${randomUUID()}/publish`, { operation_id: randomUUID() }],
      ["GET", "/api/document-templates"],
      ["POST", "/api/document-templates", { name: "x", document_id: randomUUID() }],
      ["GET", `/api/document-templates/${randomUUID()}`],
      ["PATCH", `/api/document-templates/${randomUUID()}`, { expected_revision: 1, name: "y" }],
      ["DELETE", `/api/document-templates/${randomUUID()}`, { expected_revision: 1 }],
    ];
    for (const [method, url, body] of cases) {
      const response = await app.inject({ method: method as any, url, ...(body ? { body } : {}) });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("creates blank drafts, lists, reads detail, and deletes with cleanup intent", async () => {
    const app = await buildApp();
    const { document, revision } = await createDocument(app, { title: "My brief" });
    expect(document).toMatchObject({ title: "My brief", current_revision: 1, revision_count: 1 });
    expect(revision.payload.sections).toEqual([]);
    expect(document.body ?? "").not.toContain("path");

    const list = await app.inject({ method: "GET", url: "/api/documents", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0]).toMatchObject({ id: document.id, title: "My brief" });
    expect(list.body).not.toContain("path");

    const detail = await app.inject({ method: "GET", url: `/api/documents/${document.id}`, headers: ownerAuth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: document.id, current_revision_id: revision.id });

    const foreign = await app.inject({ method: "GET", url: `/api/documents/${document.id}`, headers: foreignAuth });
    expect(foreign.statusCode).toBe(404);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/documents/${document.id}`,
      headers: ownerAuth,
    });
    expect(removed.statusCode).toBe(200);
    const gone = await app.inject({ method: "GET", url: `/api/documents/${document.id}`, headers: ownerAuth });
    expect(gone.statusCode).toBe(404);
    // The v20 delete trigger reserved the cleanup intent and the route's
    // eager cleanup consumed it (an unpublished document has no directory).
    const leftover = await storageRuntime().ledger.get("SELECT 1 AS hit FROM document_artifact_cleanup_jobs");
    expect(leftover).toBeFalsy();
  });

  it("creates a draft from a built-in template with structure only and no bindings", async () => {
    const app = await buildApp();
    const template = BUILTIN_DOCUMENT_TEMPLATES[0]!;
    const { document, revision } = await createDocument(app, { template_id: template.id });
    expect(document.origin).toMatchObject({ report_id: null, chat_id: null, run_id: null, analysis_result_id: null });
    expect(revision.payload.title).toBe(template.snapshot.title);
    expect(revision.payload.sections.map((section: { heading: string }) => section.heading)).toEqual(
      template.snapshot.sections.map((section) => section.heading)
    );
    expect(revision.payload.evidence).toEqual([]);
    expect(revision.payload.charts).toEqual([]);
    expect(revision.payload.tables).toEqual([]);
    expect(revision.payload.verified).toBe(false);
    // Applying a template assigns fresh document-local section UUIDs.
    for (const section of revision.payload.sections as Array<{ id: string }>) {
      expect(section.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Custom templates can also seed drafts.
    const custom = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "My brief template", document_id: document.id },
    });
    expect(custom.statusCode).toBe(201);
    const fromCustom = await createDocument(app, { template_id: custom.json().id, title: "Next month" });
    expect(fromCustom.document.title).toBe("Next month");
  });

  it("copies an owned published report verbatim and reports typed unavailable states", async () => {
    const reportId = randomUUID();
    await insertReport({
      id: reportId,
      accountId: OWNER,
      status: "published",
      title: "Q3 spend",
      payload: LEGACY_PAYLOAD,
    });
    const emptyReportId = randomUUID();
    await insertReport({ id: emptyReportId, accountId: OWNER, status: "published", title: "No payload" });
    const foreignReportId = randomUUID();
    await insertReport({
      id: foreignReportId,
      accountId: FOREIGN,
      status: "published",
      title: "Foreign",
      payload: LEGACY_PAYLOAD,
    });
    const pendingReportId = randomUUID();
    await insertReport({
      id: pendingReportId,
      accountId: OWNER,
      status: "pending",
      title: "Pending",
      payload: LEGACY_PAYLOAD,
    });
    const app = await buildApp();

    const before = await storageRuntime().ledger.get<{ payload: string; title: string }>(
      "SELECT payload,title FROM reports WHERE id=?",
      [reportId]
    );
    const copied = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: ownerAuth,
      body: { copy_from_report_id: reportId },
    });
    expect(copied.statusCode).toBe(201);
    const { document, revision } = copied.json();
    expect(document.origin.report_id).toBe(reportId);
    expect(revision.payload.sections[0]).toMatchObject({ heading: "Overview" });
    expect(revision.payload.verified).toBe(false);
    expect(revision.payload.evidence).toEqual([]);

    // The legacy row is byte-for-byte unchanged.
    const after = await storageRuntime().ledger.get<{ payload: string; title: string }>(
      "SELECT payload,title FROM reports WHERE id=?",
      [reportId]
    );
    expect(after).toEqual(before);

    const noPayload = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: ownerAuth,
      body: { copy_from_report_id: emptyReportId },
    });
    expect(noPayload.statusCode).toBe(409);
    expect(noPayload.json().code).toBe("DOCUMENT_UNAVAILABLE");

    const foreignCopy = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: ownerAuth,
      body: { copy_from_report_id: foreignReportId },
    });
    expect(foreignCopy.statusCode).toBe(404);

    const foreignAttempt = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: foreignAuth,
      body: { copy_from_report_id: reportId },
    });
    expect(foreignAttempt.statusCode).toBe(404);

    const pendingCopy = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: ownerAuth,
      body: { copy_from_report_id: pendingReportId },
    });
    expect(pendingCopy.statusCode).toBe(404);
  });

  it("saves revisions with base-revision CAS and returns head metadata on conflict", async () => {
    const app = await buildApp();
    const { document, revision } = await createDocument(app, { title: "Editable" });
    const tree = (markdown: string) => ({
      title: "Editable",
      sections: [{ id: revision.payload.sections[0]?.id, heading: "Body", markdown }],
    });

    const saved = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
      body: { base_revision_id: revision.id, tree: tree("first edit") },
    });
    expect(saved.statusCode).toBe(201);
    const second = saved.json();
    expect(second.revision.revision).toBe(2);

    const stale = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
      body: { base_revision_id: revision.id, tree: tree("conflicting edit") },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("DOCUMENT_REVISION_CONFLICT");
    expect(stale.json().current_head).toMatchObject({
      revision_id: second.revision.id,
      revision: 2,
      title: "Editable",
      author_kind: "user",
    });

    const reapply = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
      body: { base_revision_id: second.revision.id, tree: tree("first edit + reapply") },
    });
    expect(reapply.statusCode).toBe(201);
    expect(reapply.json().revision.revision).toBe(3);

    const history = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items.map((item: { revision: number }) => item.revision)).toEqual([3, 2, 1]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/revisions/${second.revision.id}`,
      headers: ownerAuth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().payload.sections[0].markdown).toBe("first edit");

    // Cross-account reads of revisions are invisible.
    const foreignHistory = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/revisions`,
      headers: foreignAuth,
    });
    expect(foreignHistory.statusCode).toBe(404);
    const foreignRevision = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/revisions/${second.revision.id}`,
      headers: foreignAuth,
    });
    expect(foreignRevision.statusCode).toBe(404);
    const foreignSave = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: foreignAuth,
      body: { base_revision_id: revision.id, tree: tree("intruder") },
    });
    expect(foreignSave.statusCode).toBe(404);
  });

  it("rejects oversize and invalid trees before persisting anything", async () => {
    const app = await buildApp();
    const { document, revision } = await createDocument(app, { title: "Bounded" });
    const oversize = Array.from({ length: 20 }, () => "x".repeat(10_005)).join("");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
      body: {
        base_revision_id: revision.id,
        tree: {
          title: "Bounded",
          sections: Array.from({ length: 20 }, (_, index) => ({
            heading: `s${index}`,
            markdown: oversize.slice(index * 10_005, (index + 1) * 10_005),
          })),
        },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("DOCUMENT_OVERSIZE");

    const invalid = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
      body: { base_revision_id: revision.id, tree: { title: "", sections: [] } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("DOCUMENT_INVALID");

    const history = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/revisions`,
      headers: ownerAuth,
    });
    expect(history.json().items).toHaveLength(1);
  });

  it("diffs revisions deterministically, bounds output, and hides foreign revisions", async () => {
    const app = await buildApp();
    const first = await createDocument(app, {
      title: "Diff doc",
      tree: {
        title: "Diff doc",
        sections: [{ heading: "A", markdown: "shared line\nold line\ntrailing" }],
      },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/documents/${first.document.id}/revisions`,
      headers: ownerAuth,
      body: {
        base_revision_id: first.revision.id,
        tree: {
          title: "Diff doc",
          sections: [
            { id: first.revision.payload.sections[0].id, heading: "A", markdown: "shared line\nnew line\ntrailing" },
            { heading: "B", markdown: "brand new section" },
          ],
        },
      },
    });
    const baseId = first.revision.id;
    const targetId = second.json().revision.id;
    const url = `/api/documents/${first.document.id}/diff?base=${baseId}&target=${targetId}`;

    const diffA = await app.inject({ method: "GET", url, headers: ownerAuth });
    expect(diffA.statusCode).toBe(200);
    expect(diffA.json().sections.added.map((entry: { heading: string }) => entry.heading)).toEqual(["B"]);
    expect(diffA.json().text_diffs.length).toBeGreaterThan(0);

    const diffB = await app.inject({ method: "GET", url, headers: ownerAuth });
    expect(diffB.body).toBe(diffA.body);

    const identical = await app.inject({
      method: "GET",
      url: `/api/documents/${first.document.id}/diff?base=${baseId}&target=${baseId}`,
      headers: ownerAuth,
    });
    expect(identical.statusCode).toBe(200);
    expect(identical.json().text_diffs).toEqual([]);
    expect(identical.json().truncated).toBe(false);

    // Bound: a huge replacement reports truncation instead of unbounded text.
    const hugeBase = Array.from({ length: 1_200 }, (_, i) => `l${i}`).join("\n");
    const hugeDoc = await createDocument(app, {
      title: "Huge",
      tree: { title: "Huge", sections: [{ heading: "H", markdown: hugeBase }] },
    });
    const hugeSave = await app.inject({
      method: "POST",
      url: `/api/documents/${hugeDoc.document.id}/revisions`,
      headers: ownerAuth,
      body: {
        base_revision_id: hugeDoc.revision.id,
        tree: {
          title: "Huge",
          sections: [
            {
              id: hugeDoc.revision.payload.sections[0].id,
              heading: "H",
              markdown: Array.from({ length: 1_200 }, (_, i) => `m${i}`).join("\n"),
            },
          ],
        },
      },
    });
    const bounded = await app.inject({
      method: "GET",
      url: `/api/documents/${hugeDoc.document.id}/diff?base=${hugeDoc.revision.id}&target=${hugeSave.json().revision.id}`,
      headers: ownerAuth,
    });
    expect(bounded.statusCode).toBe(200);
    expect(bounded.json().truncated).toBe(true);

    const foreignDiff = await app.inject({
      method: "GET",
      url,
      headers: foreignAuth,
    });
    expect(foreignDiff.statusCode).toBe(404);

    const missingEndpoint = await app.inject({
      method: "GET",
      url: `/api/documents/${first.document.id}/diff?base=${baseId}&target=${randomUUID()}`,
      headers: ownerAuth,
    });
    expect(missingEndpoint.statusCode).toBe(404);
  });

  it("lists an empty publication history and reserves publish with 501", async () => {
    const app = await buildApp();
    const { document, revision } = await createDocument(app, { title: "To publish" });
    const publications = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/publications`,
      headers: ownerAuth,
    });
    expect(publications.statusCode).toBe(200);
    expect(publications.json()).toEqual({ items: [], next_cursor: null });

    const publish = await app.inject({
      method: "POST",
      url: `/api/documents/${document.id}/revisions/${revision.id}/publish`,
      headers: ownerAuth,
      body: { operation_id: randomUUID() },
    });
    expect(publish.statusCode).toBe(501);
    expect(publish.json().code).toBe("PUBLICATION_NOT_READY");

    const foreignPublications = await app.inject({
      method: "GET",
      url: `/api/documents/${document.id}/publications`,
      headers: foreignAuth,
    });
    expect(foreignPublications.statusCode).toBe(404);
  });

  it("exposes three built-in templates and revision-checked custom template CRUD", async () => {
    const app = await buildApp();
    const list = await app.inject({ method: "GET", url: "/api/document-templates", headers: ownerAuth });
    expect(list.statusCode).toBe(200);
    const builtins = list.json().items.filter((item: { built_in: boolean }) => item.built_in);
    expect(builtins.map((item: { name: string }) => item.name)).toEqual([
      "Monthly financial brief",
      "Evidence memo",
      "Comparison report",
    ]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/document-templates/${BUILTIN_DOCUMENT_TEMPLATES[1]!.id}`,
      headers: ownerAuth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().name).toBe("Evidence memo");

    const immutable = await app.inject({
      method: "PATCH",
      url: `/api/document-templates/${BUILTIN_DOCUMENT_TEMPLATES[0]!.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, name: "Mangled" },
    });
    expect(immutable.statusCode).toBe(409);
    expect(immutable.json().code).toBe("BUILTIN_TEMPLATE_IMMUTABLE");
    const immutableDelete = await app.inject({
      method: "DELETE",
      url: `/api/document-templates/${BUILTIN_DOCUMENT_TEMPLATES[0]!.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1 },
    });
    expect(immutableDelete.statusCode).toBe(409);

    const { document } = await createDocument(app, { title: "Template source", tree: richTree() });
    const created = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "My layout", description: "reusable", document_id: document.id },
    });
    expect(created.statusCode).toBe(201);
    const template = created.json();
    expect(template.revision).toBe(1);
    expect(template.snapshot.sections.map((section: { heading: string }) => section.heading)).toEqual([
      "Findings",
      "Notes",
    ]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/document-templates/${template.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, name: "My layout v2" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "My layout v2", revision: 2 });

    const stalePatch = await app.inject({
      method: "PATCH",
      url: `/api/document-templates/${template.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1, name: "Mangled" },
    });
    expect(stalePatch.statusCode).toBe(409);
    expect(stalePatch.json()).toMatchObject({ code: "DOCUMENT_TEMPLATE_CONFLICT", current_revision: 2 });

    const staleDelete = await app.inject({
      method: "DELETE",
      url: `/api/document-templates/${template.id}`,
      headers: ownerAuth,
      body: { expected_revision: 1 },
    });
    expect(staleDelete.statusCode).toBe(409);
    expect(staleDelete.json()).toMatchObject({ code: "DOCUMENT_TEMPLATE_CONFLICT", current_revision: 2 });

    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/document-templates/${template.id}`,
      headers: foreignAuth,
    });
    expect(foreignRead.statusCode).toBe(404);
    const foreignDelete = await app.inject({
      method: "DELETE",
      url: `/api/document-templates/${template.id}`,
      headers: foreignAuth,
      body: { expected_revision: 2 },
    });
    expect(foreignDelete.statusCode).toBe(404);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/document-templates/${template.id}`,
      headers: ownerAuth,
      body: { expected_revision: 2 },
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("stores template snapshots with every excluded class stripped from the row", async () => {
    const app = await buildApp();
    const { document } = await createDocument(app, { title: "Template source", tree: richTree() });
    const created = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "Stripped", document_id: document.id },
    });
    expect(created.statusCode).toBe(201);
    const row = await storageRuntime().ledger.get<{ snapshot: string }>(
      "SELECT snapshot FROM document_templates WHERE id=? AND account_id=?",
      [created.json().id, OWNER]
    );
    expect(row).toBeTruthy();
    const snapshot = row!.snapshot;
    // Excerpts, source identities/locators, numeric results, chart values,
    // analysis provenance, and bindings must not appear in the stored row.
    expect(snapshot).not.toContain("TOP-SECRET-EXCERPT");
    expect(snapshot).not.toContain("sha256:secret-content-id");
    expect(snapshot).not.toContain("ledger.csv");
    expect(snapshot).not.toContain("row 7");
    expect(snapshot).not.toContain("1234");
    expect(snapshot).not.toContain("chart-1");
    const parsed = JSON.parse(snapshot);
    expect(Object.keys(parsed).sort()).toEqual(["sections", "subtitle", "title"]);
    for (const section of parsed.sections) expect(Object.keys(section).sort()).toEqual(["heading", "markdown"]);
  });

  it("enforces the 100-per-account custom template quota and name uniqueness", async () => {
    const app = await buildApp();
    const { document } = await createDocument(app, { title: "Quota source" });
    const first = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "Template 0", document_id: document.id },
    });
    expect(first.statusCode).toBe(201);
    const ownerDuplicate = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "Template 0", document_id: document.id },
    });
    expect(ownerDuplicate.statusCode).toBe(409);
    expect(ownerDuplicate.json().code).toBe("DOCUMENT_TEMPLATE_NAME_TAKEN");
    for (let index = 1; index < 100; index += 1) {
      const created = await app.inject({
        method: "POST",
        url: "/api/document-templates",
        headers: ownerAuth,
        body: { name: `Template ${index}`, document_id: document.id },
      });
      expect(created.statusCode, `template ${index}`).toBe(201);
    }
    const overflow = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: ownerAuth,
      body: { name: "Template 100", document_id: document.id },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().code).toBe("DOCUMENT_TEMPLATE_QUOTA_REACHED");

    // The quota is per account: another account starts empty, but a foreign
    // document id gives no material to snapshot.
    const foreign = await app.inject({
      method: "POST",
      url: "/api/document-templates",
      headers: foreignAuth,
      body: { name: "Template 0", document_id: document.id },
    });
    expect(foreign.statusCode).toBe(404);
  });
});
