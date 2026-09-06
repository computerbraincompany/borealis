import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  revisions: vi.fn(),
  saveRevision: vi.fn(),
  revision: vi.fn(),
  diff: vi.fn(),
  publications: vi.fn(),
  publish: vi.fn(),
  publicationExportPath: vi.fn(
    (id: string, publicationId: string, format: string) =>
      `/api/documents/${id}/publications/${publicationId}/export?format=${format}`,
  ),
  downloadBlob: vi.fn(async (): Promise<void> => undefined),
  openProtected: vi.fn(async (): Promise<void> => undefined),
  isPublicationError: vi.fn((_error: unknown, _code: string) => false),
  rewrites: vi.fn(),
  createRewrite: vi.fn(),
  acceptRewrite: vi.fn(),
  deleteRewrite: vi.fn(),
  templatesList: vi.fn(),
  templatesCreate: vi.fn(),
  formatApiError: (_error: unknown, fallback: string) => fallback,
  parseConflict: vi.fn((_error: unknown): DocumentConflictHead | null => null),
  parseStale: vi.fn((_error: unknown): DocumentConflictHead | null => null),
  isRewriteError: vi.fn((_error: unknown, _code: string) => false),
}));

vi.mock("@/lib/api", () => ({
  documentsApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    get: apiMocks.get,
    remove: apiMocks.remove,
    revisions: apiMocks.revisions,
    saveRevision: apiMocks.saveRevision,
    revision: apiMocks.revision,
    diff: apiMocks.diff,
    publications: apiMocks.publications,
    publish: apiMocks.publish,
    publicationExportPath: apiMocks.publicationExportPath,
    rewrites: apiMocks.rewrites,
    createRewrite: apiMocks.createRewrite,
    acceptRewrite: apiMocks.acceptRewrite,
    deleteRewrite: apiMocks.deleteRewrite,
  },
  documentTemplatesApi: { list: apiMocks.templatesList, create: apiMocks.templatesCreate },
  downloadBlob: apiMocks.downloadBlob,
  openProtected: apiMocks.openProtected,
  isDocumentPublicationErrorCode: apiMocks.isPublicationError,
  formatApiError: apiMocks.formatApiError,
  parseDocumentRevisionConflict: apiMocks.parseConflict,
  parseDocumentRewriteStale: apiMocks.parseStale,
  isDocumentRewriteErrorCode: apiMocks.isRewriteError,
  DOCUMENT_HEAD_MOVED_CODE: "DOCUMENT_HEAD_MOVED",
  DOCUMENT_PUBLICATION_ACTIVE_CODE: "DOCUMENT_PUBLICATION_ACTIVE",
  DOCUMENT_REWRITE_ACTIVE_CODE: "DOCUMENT_REWRITE_ACTIVE",
  DOCUMENT_REWRITE_QUOTA_CODE: "DOCUMENT_REWRITE_QUOTA_REACHED",
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { DocumentWorkbench } from "@/pages/DocumentWorkbench";
import type { DocumentConflictHead, DocumentRevisionDiff } from "@/lib/api";
import { failOnReactActWarning } from "@/test/console";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const HEAD_REVISION = {
  id: "rev-1",
  document_id: "doc-1",
  revision: 1,
  title: "Finance brief",
  author_kind: "user" as const,
  base_revision_id: null,
  payload: {
    title: "Finance brief",
    subtitle: "",
    verified: true,
    sections: [
      { id: "sec-1", heading: "Summary", markdown: "Stable spend [1] and note [9]." },
      { id: "sec-2", heading: "Flows", markdown: "Income steady" },
    ],
    charts: [{ id: "chart-1", spec: { type: "bar" } }],
    tables: [{ columns: ["month"], rows: [["jan"]], analysis: null }],
    evidence: [
      {
        id: "ev-1",
        source_id: "src-1",
        source_name: "ledger.csv",
        generation: 2,
        content_identity: "cid",
        locator: "row 3",
        excerpt: "January income 1200",
      },
      {
        id: "ev-2",
        source_id: "src-2",
        source_name: "manual note",
        generation: "unknown",
        content_identity: "unknown",
        locator: null,
        excerpt: "hand-typed claim",
      },
    ],
  },
  payload_chars: 512,
  created_at: "2026-01-01T00:00:00.000Z",
};

const SUMMARY = {
  id: "doc-1",
  title: "Finance brief",
  current_revision: 1,
  current_revision_id: "rev-1",
  head_author_kind: "user" as const,
  origin: { report_id: null, chat_id: null, run_id: null, analysis_result_id: null },
  latest_publication_version: null,
  revision_count: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const HISTORY = {
  items: [
    {
      id: "rev-1",
      revision: 1,
      title: "Finance brief",
      author_kind: "user" as const,
      base_revision_id: null,
      payload_chars: 512,
      published_version: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  next_cursor: null,
};

function emptyDiff(baseId: string, targetId: string): DocumentRevisionDiff {
  return {
    base: { revision_id: baseId, revision: 1, title: "a" },
    target: { revision_id: targetId, revision: 1, title: "a" },
    fields: { title_changed: false, subtitle_changed: false, verified_changed: false },
    sections: { added: [], removed: [], moved: [], modified: [] },
    text_diffs: [],
    charts: { added: [], removed: [], changed: [] },
    tables: { added: [], removed: [], changed: [] },
    evidence: { added: [], removed: [], changed: [] },
    truncated: false,
  };
}

beforeEach(() => {
  [
    apiMocks.list,
    apiMocks.create,
    apiMocks.get,
    apiMocks.remove,
    apiMocks.revisions,
    apiMocks.saveRevision,
    apiMocks.revision,
    apiMocks.diff,
    apiMocks.publications,
    apiMocks.publish,
    apiMocks.publicationExportPath,
    apiMocks.downloadBlob,
    apiMocks.openProtected,
    apiMocks.isPublicationError,
    apiMocks.templatesList,
    apiMocks.templatesCreate,
    apiMocks.parseConflict,
    apiMocks.rewrites,
    apiMocks.createRewrite,
    apiMocks.acceptRewrite,
    apiMocks.deleteRewrite,
    apiMocks.parseStale,
    apiMocks.isRewriteError,
  ].forEach((mock) => mock.mockReset());
  apiMocks.rewrites.mockResolvedValue({ items: [], next_cursor: null });
  apiMocks.isRewriteError.mockReturnValue(false);
  apiMocks.isPublicationError.mockReturnValue(false);
  apiMocks.publications.mockResolvedValue({ items: [], next_cursor: null });
  apiMocks.downloadBlob.mockResolvedValue(undefined);
  apiMocks.openProtected.mockResolvedValue(undefined);
  apiMocks.publicationExportPath.mockImplementation(
    (id: string, publicationId: string, format: string) =>
      `/api/documents/${id}/publications/${publicationId}/export?format=${format}`,
  );
  apiMocks.get.mockResolvedValue(SUMMARY);
  apiMocks.revision.mockResolvedValue(HEAD_REVISION);
  apiMocks.revisions.mockResolvedValue(HISTORY);
  apiMocks.diff.mockImplementation((_id: string, base: string, target: string) =>
    Promise.resolve(emptyDiff(base, target)),
  );
  apiMocks.parseConflict.mockReturnValue(null);
});

describe("DocumentWorkbench editor", () => {
  it("renders sections, the evidence inspector, and plain unresolved markers", async () => {
    render(<DocumentWorkbench documentId="doc-1" />);

    expect(await screen.findByDisplayValue("Stable spend [1] and note [9].")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Income steady")).toBeInTheDocument();

    // Evidence inspector shows contract-versioned provenance labels.
    expect(await screen.findByText("verified origin")).toBeInTheDocument();
    expect(screen.getByText(/generation 2/)).toBeInTheDocument();
    expect(screen.getByText("unknown provenance")).toBeInTheDocument();
    expect(screen.getByText("January income 1200")).toBeInTheDocument();
    // [9] exceeds the two-entry evidence array and stays plain text.
    expect(
      await screen.findByText(
        /Unresolved citation markers render as plain text and are never matched against other sources: \[9\]/,
      ),
    ).toBeInTheDocument();
  });

  it("marks unsaved changes, keeps frozen data untouched on save, and clears the badge", async () => {
    const user = userEvent.setup();
    apiMocks.saveRevision.mockResolvedValue({
      document: { ...SUMMARY, current_revision: 2, current_revision_id: "rev-2", revision_count: 2 },
      revision: { ...HEAD_REVISION, id: "rev-2", revision: 2 },
    });
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = await screen.findByDisplayValue("Income steady");

    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
    await user.type(markdown, " and steady");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save revision/ }));
    await waitFor(() => expect(apiMocks.saveRevision).toHaveBeenCalledTimes(1));
    const [documentId, body, signal] = apiMocks.saveRevision.mock.calls[0];
    expect(documentId).toBe("doc-1");
    expect(body.base_revision_id).toBe("rev-1");
    expect(body.tree.title).toBe("Finance brief");
    expect(body.tree.sections.map((section: { id: string }) => section.id)).toEqual(["sec-1", "sec-2"]);
    expect(body.tree.sections[1].markdown).toBe("Income steady and steady");
    // Frozen charts/tables/evidence pass through unchanged.
    expect(body.tree.charts).toEqual(HEAD_REVISION.payload.charts);
    expect(body.tree.tables).toEqual(HEAD_REVISION.payload.tables);
    expect(body.tree.evidence).toEqual(HEAD_REVISION.payload.evidence);
    expect(signal).toBeInstanceOf(AbortSignal);

    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
  });

  it("reorders sections by stable UUID with idempotent clamping and preserves ids on save", async () => {
    apiMocks.saveRevision.mockImplementation((_id: string, body: { tree: { sections: { id: string }[] } }) =>
      Promise.resolve({
        document: SUMMARY,
        revision: {
          ...HEAD_REVISION,
          payload: { ...HEAD_REVISION.payload, sections: body.tree.sections },
        },
      }),
    );
    render(<DocumentWorkbench documentId="doc-1" />);
    await screen.findByDisplayValue("Income steady");

    fireEvent.click(screen.getByRole("button", { name: /Add section/ }));
    expect(await screen.findByLabelText("Heading of section 3")).toBeInTheDocument();

    // Move "Summary" (first) down twice; the second move is idempotent at the end.
    const moveDown = () => screen.getByRole("button", { name: "Move Summary down" });
    fireEvent.click(moveDown());
    fireEvent.click(screen.getByRole("button", { name: "Move Summary down" }));
    const downButtons = screen.getAllByRole("button", { name: "Move Summary down" });
    expect(downButtons[0]).toBeDisabled(); // clamped at the last position
    fireEvent.click(downButtons[0]!);

    fireEvent.click(screen.getByRole("button", { name: /Save revision/ }));
    await waitFor(() => expect(apiMocks.saveRevision).toHaveBeenCalled());
    const tree = apiMocks.saveRevision.mock.calls[0][1].tree;
    // Summary moved down twice (second move clamped idempotently at the end).
    expect(tree.sections.map((section: { id: string }) => section.id)).toEqual([
      "sec-2",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      "sec-1",
    ]);
  });

  it("preserves the draft on a CAS conflict and reapplies only onto the new head", async () => {
    const conflictError = new Error("conflict");
    const conflictHead = {
      revision_id: "rev-9",
      revision: 9,
      title: "Other edit",
      author_kind: "automation" as const,
      updated_at: "2026-01-02T00:00:00.000Z",
    };
    apiMocks.parseConflict.mockImplementation((error: unknown) =>
      (error as Error).message === "conflict" ? conflictHead : null,
    );
    apiMocks.saveRevision.mockRejectedValueOnce(conflictError).mockResolvedValueOnce({
      document: { ...SUMMARY, current_revision: 10, current_revision_id: "rev-10", revision_count: 10 },
      revision: { ...HEAD_REVISION, id: "rev-10", revision: 10 },
    });
    apiMocks.diff.mockResolvedValue(emptyDiff("rev-1", "rev-9"));
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = await screen.findByDisplayValue("Income steady");
    await userEvent.type(markdown, " kept");

    fireEvent.click(screen.getByRole("button", { name: /Save revision/ }));
    expect(await screen.findByRole("heading", { name: "Revision conflict" })).toBeInTheDocument();
    // The local draft survives untouched and stays dirty.
    expect(screen.getByDisplayValue("Income steady kept")).toBeInTheDocument();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    // Explicit reapply onto the new head — never a silent merge.
    fireEvent.click(screen.getByRole("button", { name: /Reapply my draft onto revision 9/ }));
    await waitFor(() => expect(apiMocks.saveRevision).toHaveBeenCalledTimes(2));
    expect(apiMocks.saveRevision.mock.calls[1][1].base_revision_id).toBe("rev-9");
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument());
  });

  it("offers the server diff of the base against the conflicting head", async () => {
    const conflictError = new Error("conflict");
    apiMocks.parseConflict.mockImplementation((error: unknown) =>
      (error as Error).message === "conflict"
        ? { revision_id: "rev-9", revision: 9, title: "Other edit", author_kind: "automation", updated_at: "" }
        : null,
    );
    apiMocks.saveRevision.mockRejectedValue(conflictError);
    apiMocks.diff.mockResolvedValue(emptyDiff("rev-1", "rev-9"));
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = await screen.findByDisplayValue("Income steady");
    await userEvent.type(markdown, " kept");

    fireEvent.click(screen.getByRole("button", { name: /Save revision/ }));
    await screen.findByRole("heading", { name: "Revision conflict" });
    fireEvent.click(screen.getByRole("button", { name: /View diff against new head/ }));
    await waitFor(() => expect(apiMocks.diff).toHaveBeenCalledWith("doc-1", "rev-1", "rev-9", expect.any(AbortSignal)));
    // The local draft is still intact after choosing the diff option.
    expect(screen.getByDisplayValue("Income steady kept")).toBeInTheDocument();
  });

  it("ignores a stale diff response and aborts requests on unmount", async () => {
    const first = deferred<DocumentRevisionDiff>();
    const second = deferred<DocumentRevisionDiff>();
    apiMocks.diff.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { unmount } = render(<DocumentWorkbench documentId="doc-1" />);
    await screen.findByDisplayValue("Income steady");

    const compare = screen.getByRole("button", { name: /Compare revisions/ });
    fireEvent.click(compare);
    await waitFor(() => expect(apiMocks.diff).toHaveBeenCalledTimes(1));
    fireEvent.click(compare);
    await waitFor(() => expect(apiMocks.diff).toHaveBeenCalledTimes(2));
    const firstSignal = apiMocks.diff.mock.calls[0][3] as AbortSignal;

    await act(async () =>
      second.resolve({
        ...emptyDiff("a", "b"),
        sections: { ...emptyDiff("a", "b").sections, added: [{ id: "x", heading: "Second diff", index: 0 }] },
      }),
    );
    expect(await screen.findByText("+ Second diff")).toBeInTheDocument();
    await act(async () => first.resolve(emptyDiff("a", "b")));
    expect(screen.getByText("+ Second diff")).toBeInTheDocument();

    unmount();
    expect(firstSignal.aborted).toBe(true);
  });

  it("saves the current structure as a template without derived data", async () => {
    apiMocks.templatesCreate.mockResolvedValue({ id: "tpl-1", built_in: false, name: "Finance brief layout" });
    render(<DocumentWorkbench documentId="doc-1" />);
    await screen.findByDisplayValue("Income steady");

    fireEvent.click(screen.getByRole("button", { name: /Save as template/ }));
    const nameInput = await screen.findByLabelText("Name");
    fireEvent.submit(nameInput.closest("form")!);
    await waitFor(() =>
      expect(apiMocks.templatesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Finance brief layout", document_id: "doc-1" }),
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText(/Template saved/)).toBeInTheDocument();
  });

  it("shows a load failure without leaving the shell owner warnings", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation((...args) => failOnReactActWarning(args));
    apiMocks.get.mockRejectedValue(new Error("gone"));
    render(<DocumentWorkbench documentId="doc-404" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Could not load the document")).toBeInTheDocument();
    warn.mockRestore();
  });
});

describe("DocumentWorkbench catalog", () => {
  it("lists documents and deletes with a busy-blocked confirm that cannot be resurrected", async () => {
    apiMocks.list.mockResolvedValue({
      items: [
        { ...SUMMARY, id: "doc-a", title: "Alpha" },
        { ...SUMMARY, id: "doc-b", title: "Beta" },
      ],
      next_cursor: null,
    });
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<DocumentWorkbench />);

    await screen.findByText("Alpha");
    fireEvent.click(screen.getByLabelText("Delete Beta"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("doc-b", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText("Beta")).not.toBeInTheDocument());
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Stage 3: rewrite panel
// ---------------------------------------------------------------------------

import { sha256Hex } from "@/lib/sha256";

const SECTION_ONE_TEXT = "Stable spend [1] and note [9].";

function rewriteFixture(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "rw-1",
    document_id: "doc-1",
    base_revision_id: "rev-1",
    section_id: "sec-1",
    range_start: null,
    range_end: null,
    selection_sha256: sha256Hex(SECTION_ONE_TEXT),
    selection_chars: SECTION_ONE_TEXT.length,
    instruction: "Make it formal.",
    status: "completed",
    replacement: "Spend remained stable [1].",
    evidence_refs: ["ev-1", "ev-2"],
    model: "test-model",
    error_code: null,
    error_reason: null,
    cancel_requested: false,
    applied_revision_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: "2026-01-01T00:00:01.000Z",
    finished_at: "2026-01-01T00:00:05.000Z",
    updated_at: "2026-01-01T00:00:05.000Z",
    ...overrides,
  };
}

describe("DocumentWorkbench rewrites", () => {
  it("requests a whole-section rewrite with the exact selection hash and applies the proposal", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation((...args) => failOnReactActWarning(args));
    let serverRewrite: Record<string, unknown> | null = null;
    apiMocks.rewrites.mockImplementation(() =>
      Promise.resolve({
        items: serverRewrite ? [serverRewrite] : [],
        next_cursor: null,
      }),
    );
    apiMocks.createRewrite.mockImplementation((_id: string, body: Record<string, unknown>) => {
      serverRewrite = { ...rewriteFixture({}), ...body, status: "queued", replacement: null };
      return Promise.resolve(serverRewrite);
    });
    apiMocks.acceptRewrite.mockImplementation(() => {
      serverRewrite = { ...serverRewrite, status: "completed", applied_revision_id: "rev-2" };
      return Promise.resolve({
        document: { ...SUMMARY, current_revision: 2, current_revision_id: "rev-2", revision_count: 2 },
        revision: {
          ...HEAD_REVISION,
          id: "rev-2",
          revision: 2,
          author_kind: "model" as const,
          payload: {
            ...HEAD_REVISION.payload,
            sections: [
              { id: "sec-1", heading: "Summary", markdown: "Spend remained stable [1]." },
              HEAD_REVISION.payload.sections[1],
            ],
          },
        },
        rewrite: serverRewrite,
      });
    });
    render(<DocumentWorkbench documentId="doc-1" />);
    await screen.findByDisplayValue(SECTION_ONE_TEXT);

    await userEvent.type(screen.getByLabelText("Rewrite instruction"), "Make it formal.");
    fireEvent.click(screen.getByRole("button", { name: /Request rewrite/ }));
    await waitFor(() =>
      expect(apiMocks.createRewrite).toHaveBeenCalledWith(
        "doc-1",
        {
          base_revision_id: "rev-1",
          section_id: "sec-1",
          selection_sha256: sha256Hex(SECTION_ONE_TEXT),
          instruction: "Make it formal.",
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("queued", { selector: "*" })).toBeInTheDocument();

    // The scripted runner completes it; the visibility-aware poll picks the
    // completed proposal up and renders the reviewable diff.
    serverRewrite = rewriteFixture({});
    expect(await screen.findByText("Current selection", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(apiMocks.acceptRewrite).not.toHaveBeenCalled();
    expect(screen.getByText("+ Spend remained stable [1].", { exact: false })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    await waitFor(() => expect(apiMocks.acceptRewrite).toHaveBeenCalledWith("doc-1", "rw-1", expect.any(AbortSignal)));
    expect(await screen.findByDisplayValue("Spend remained stable [1].")).toBeInTheDocument();
    expect(screen.getByText(/Applied — the document now has a new model-authored revision/)).toBeInTheDocument();
    warn.mockRestore();
  }, 20000);

  it("shows refresh guidance when the head moved and renders the durable stale state", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation((...args) => failOnReactActWarning(args));
    let stale = false;
    apiMocks.rewrites.mockImplementation(() =>
      Promise.resolve({ items: [rewriteFixture({ status: stale ? "stale" : "completed" })], next_cursor: null }),
    );
    const staleError = new Error("stale");
    apiMocks.parseStale.mockImplementation((error: unknown) =>
      (error as Error).message === "stale"
        ? { revision_id: "rev-5", revision: 5, title: "Newer", author_kind: "user", updated_at: "" }
        : null,
    );
    apiMocks.acceptRewrite.mockRejectedValue(staleError);
    render(<DocumentWorkbench documentId="doc-1" />);
    expect(await screen.findByText("Current selection", {}, { timeout: 6000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    stale = true;
    // The failed acceptance refreshes the list; the proposal durably shows
    // its stale state with refresh guidance instead of a raw error.
    expect(await screen.findByText("stale", { selector: "*" }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText(/The document changed after this proposal was made/)).toBeInTheDocument();
    warn.mockRestore();
  }, 20000);

  it("rejects a retained proposal by explicit deletion", async () => {
    apiMocks.rewrites.mockResolvedValue({ items: [rewriteFixture({})], next_cursor: null });
    apiMocks.deleteRewrite.mockImplementation(() => Promise.resolve({ ok: true, action: "deleted" }));
    render(<DocumentWorkbench documentId="doc-1" />);
    expect(await screen.findByText("Current selection", {}, { timeout: 6000 })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(apiMocks.deleteRewrite).toHaveBeenCalledWith("doc-1", "rw-1", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText("Current selection")).not.toBeInTheDocument());
  }, 20000);

  it("blocks requesting a rewrite while the target section is dirty", async () => {
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = await screen.findByDisplayValue(SECTION_ONE_TEXT);
    await userEvent.type(markdown, " edited");

    expect(screen.getByText("Save this section first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request rewrite/ })).toBeDisabled();
  });

  it("uses the live textarea selection for a passage rewrite", async () => {
    let serverRewrite: Record<string, unknown> | null = null;
    apiMocks.rewrites.mockImplementation(() =>
      Promise.resolve({ items: serverRewrite ? [serverRewrite] : [], next_cursor: null }),
    );
    apiMocks.createRewrite.mockImplementation((_id: string, body: Record<string, unknown>) => {
      serverRewrite = { ...rewriteFixture({}), ...body, status: "running" };
      return Promise.resolve(serverRewrite);
    });
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = (await screen.findByDisplayValue(SECTION_ONE_TEXT)) as HTMLTextAreaElement;

    await userEvent.type(screen.getByLabelText("Rewrite instruction"), "Rewrite the opening.");
    markdown.setSelectionRange(0, 12);
    fireEvent.select(markdown);
    expect(await screen.findByText("12 selected characters")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Request rewrite/ }));
    await waitFor(() =>
      expect(apiMocks.createRewrite).toHaveBeenCalledWith(
        "doc-1",
        {
          base_revision_id: "rev-1",
          section_id: "sec-1",
          range_start: 0,
          range_end: 12,
          selection_sha256: sha256Hex(SECTION_ONE_TEXT.slice(0, 12)),
          instruction: "Rewrite the opening.",
        },
        expect.any(AbortSignal),
      ),
    );
  }, 20000);
});

describe("DocumentWorkbench publications", () => {
  const PUBLICATION = {
    id: "pub-1",
    document_id: "doc-1",
    revision_id: "rev-1",
    revision: 1,
    version: 1,
    title: "Finance brief",
    supersedes: null,
    created_at: "2026-01-02T00:00:00.000Z",
  };

  it("publishes the head with the expected revision and lists the frozen exports", async () => {
    apiMocks.publish.mockResolvedValue({ status: "published", replayed: false, publication: PUBLICATION });
    apiMocks.publications
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValue({ items: [PUBLICATION], next_cursor: null });
    render(<DocumentWorkbench documentId="doc-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(apiMocks.publish).toHaveBeenCalledTimes(1));
    const [documentId, revisionId, body] = apiMocks.publish.mock.calls[0];
    expect(documentId).toBe("doc-1");
    expect(revisionId).toBe("rev-1");
    expect(typeof body.operation_id).toBe("string");
    expect(body.expected_revision_id).toBe("rev-1");
    expect(body.allow_non_head_revision).toBeUndefined();

    expect(await screen.findByText("v1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /PDF/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Markdown/ })).toBeEnabled();
  });

  it("refuses to publish a dirty head without saving first", async () => {
    const user = userEvent.setup();
    render(<DocumentWorkbench documentId="doc-1" />);
    const markdown = await screen.findByDisplayValue("Income steady");
    await user.type(markdown, " extra");

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(apiMocks.publish).not.toHaveBeenCalled();
    expect(await screen.findByText(/Save the draft before publishing the head revision/)).toBeInTheDocument();
  });

  it("surfaces the stable active/head-moved publication conflicts", async () => {
    apiMocks.isPublicationError.mockImplementation(
      (error: unknown, code: string) => (error as { code?: string })?.code === code,
    );
    apiMocks.publish.mockRejectedValue({ code: "DOCUMENT_PUBLICATION_ACTIVE" });
    render(<DocumentWorkbench documentId="doc-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/Another publication is already active/)).toBeInTheDocument();

    apiMocks.publish.mockRejectedValue({ code: "DOCUMENT_HEAD_MOVED" });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(apiMocks.publish).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Review the newer head/)).toBeInTheDocument();
  });

  it("publishes an older history revision with the explicit non-head selection bit", async () => {
    apiMocks.get.mockResolvedValue({ ...SUMMARY, current_revision: 2, current_revision_id: "rev-2" });
    apiMocks.revision.mockResolvedValue({ ...HEAD_REVISION, id: "rev-2", revision: 2 });
    apiMocks.revisions.mockResolvedValue({
      items: [
        {
          id: "rev-2",
          revision: 2,
          title: "Finance brief",
          author_kind: "user" as const,
          base_revision_id: "rev-1",
          payload_chars: 512,
          published_version: null,
          created_at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "rev-1",
          revision: 1,
          title: "Finance brief",
          author_kind: "user" as const,
          base_revision_id: null,
          payload_chars: 512,
          published_version: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      next_cursor: null,
    });
    apiMocks.publish.mockResolvedValue({ status: "published", replayed: false, publication: PUBLICATION });
    render(<DocumentWorkbench documentId="doc-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish revision 1" }));
    await waitFor(() => expect(apiMocks.publish).toHaveBeenCalledTimes(1));
    const [, revisionId, body] = apiMocks.publish.mock.calls[0];
    expect(revisionId).toBe("rev-1");
    expect(body.allow_non_head_revision).toBe(true);
    expect(body.expected_revision_id).toBeUndefined();
  });

  it("reuses the operation UUID when retrying the same failed attempt", async () => {
    apiMocks.publish.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
      status: "published",
      replayed: false,
      publication: PUBLICATION,
    });
    apiMocks.publications
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValue({ items: [PUBLICATION], next_cursor: null });
    render(<DocumentWorkbench documentId="doc-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() => expect(apiMocks.publish).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("v1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(apiMocks.publish).toHaveBeenCalledTimes(2));
    expect(apiMocks.publish.mock.calls[1][2].operation_id).toBe(apiMocks.publish.mock.calls[0][2].operation_id);
    expect(await screen.findByText("v1")).toBeInTheDocument();
  });

  it("downloads frozen exports and previews the publication through the sandboxed report preview", async () => {
    const gate = deferred<void>();
    apiMocks.publications.mockResolvedValue({ items: [PUBLICATION], next_cursor: null });
    apiMocks.downloadBlob.mockReturnValue(gate.promise);
    render(<DocumentWorkbench documentId="doc-1" />);

    const pdfButton = await screen.findByRole("button", { name: /PDF/ });
    fireEvent.click(pdfButton);
    expect(apiMocks.downloadBlob).toHaveBeenCalledWith(
      "/api/documents/doc-1/publications/pub-1/export?format=pdf",
      "Finance brief-v1.pdf",
    );
    expect(pdfButton).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(pdfButton).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /Markdown/ }));
    expect(apiMocks.downloadBlob).toHaveBeenLastCalledWith(
      "/api/documents/doc-1/publications/pub-1/export?format=markdown",
      "Finance brief-v1.zip",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /Markdown/ })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: /Preview/ }));
    await waitFor(() =>
      expect(apiMocks.openProtected).toHaveBeenCalledWith(
        "html",
        "/api/documents/doc-1/publications/pub-1/export?format=html",
        "Finance brief-v1.html",
      ),
    );
  });
});
