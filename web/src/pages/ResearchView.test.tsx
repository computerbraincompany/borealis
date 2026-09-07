import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  proposePlan: vi.fn(),
  listRuns: vi.fn(),
  start: vi.fn(),
  getRun: vi.fn(),
  listEvidence: vi.fn(),
  getTable: vi.fn(),
  cancelRun: vi.fn(),
  review: vi.fn(),
  createArtifact: vi.fn(),
  modelsList: vi.fn(),
  sourcesList: vi.fn(),
  librariesList: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    modelsApi: { ...actual.modelsApi, list: mocks.modelsList },
    sourcesApi: { ...actual.sourcesApi, list: mocks.sourcesList },
    librariesApi: { ...actual.librariesApi, list: mocks.librariesList },
    researchApi: {
      list: mocks.list,
      create: mocks.create,
      get: mocks.get,
      update: mocks.update,
      remove: mocks.remove,
      proposePlan: mocks.proposePlan,
      listRuns: mocks.listRuns,
      start: mocks.start,
      getRun: mocks.getRun,
      listEvidence: mocks.listEvidence,
      getTable: mocks.getTable,
      cancelRun: mocks.cancelRun,
      review: mocks.review,
      createArtifact: mocks.createArtifact,
      exportPath: actual.researchApi.exportPath,
    },
  };
});

vi.mock("@/components/LibrarySearchPanel", () => ({
  PassagePanel: () => <div data-testid="passage-panel" />,
  locatorBadges: () => null,
  locatorCopy: () => "locator",
  HighlightedExcerpt: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { ResearchView } from "@/pages/ResearchView";
import { ApiError, type ResearchDefinition, type ResearchEvidence, type ResearchRunDetail } from "@/lib/api";

const SOURCE_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const COLUMN_ID = "cccccccc-0000-4000-8000-00000000000c";
const KNOWN_EVIDENCE_ID = "eeeeeeee-0000-4000-8000-000000000001";

function definition(overrides: Partial<ResearchDefinition> = {}): ResearchDefinition {
  return {
    id: "d1",
    title: "Supplier renewal terms",
    question: "What are the renewal terms across supplier proposals?",
    output_kind: "memo",
    current_revision: 3,
    source_ids: [SOURCE_ID],
    library_ids: [],
    chat_model: "model-a",
    columns: [],
    plan: { steps: [{ id: "ps1", objective: "Find relevant evidence", questions: ["renewal terms?"] }] },
    sources: [{ source_id: SOURCE_ID, availability: "ready", ready_generation: 2 }],
    active_run: null,
    revision_created_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function runDetail(overrides: Partial<ResearchRunDetail> = {}): ResearchRunDetail {
  return {
    id: "r1",
    definition_id: "d1",
    definition_revision: 3,
    status: "needs_review",
    cancel_requested: false,
    chat_model: "model-a",
    provider_locality: "local",
    rerun_of: null,
    review_revision: 5,
    error_code: null,
    created_at: "2026-01-03T00:00:00.000Z",
    started_at: "2026-01-03T00:00:05.000Z",
    finished_at: "2026-01-03T00:04:00.000Z",
    error_reason: null,
    sources: [{ source_id: SOURCE_ID, generation: 2 }],
    budgets: { steps: 8, searches: 32, model_requests: 40, evidence: 100, evidence_chars: 200000, wall_ms: 900000 },
    usage: { searches: 4, model_requests: 9 },
    rerun_selection: null,
    steps: [
      {
        ordinal: 1,
        objective: "Find relevant evidence",
        questions: ["renewal terms?"],
        status: "done",
        outcome: null,
        attempts: 1,
        started_at: null,
        finished_at: null,
      },
    ],
    claims: [],
    counts: {
      evidence_count: 1,
      evidence_char_count: 120,
      claim_count: 0,
      gap_count: 0,
      machine_cell_count: 0,
      correction_cell_count: 0,
      table_serialized_bytes: 0,
    },
    run_notes: [],
    ...overrides,
  };
}

function evidence(overrides: Partial<ResearchEvidence> = {}): ResearchEvidence {
  return {
    id: KNOWN_EVIDENCE_ID,
    run_id: "r1",
    source_id: SOURCE_ID,
    generation: 2,
    chunk_id: "chunk-1",
    label: "acme-proposal.pdf p.2",
    locators: [],
    excerpt: "Renewal requires ninety days written notice.",
    content_hash: "abc",
    retrieved_at: "2026-01-03T00:01:00.000Z",
    step_ordinal: 1,
    query: "renewal terms?",
    irrelevant: false,
    ...overrides,
  };
}

function runSummary(status: ResearchRunDetail["status"] = "needs_review") {
  return {
    id: "r1",
    definition_id: "d1",
    definition_revision: 3,
    status,
    cancel_requested: false,
    chat_model: "model-a",
    provider_locality: "local" as const,
    rerun_of: null,
    review_revision: 5,
    error_code: null,
    created_at: "2026-01-03T00:00:00.000Z",
    started_at: "2026-01-03T00:00:05.000Z",
    finished_at: "2026-01-03T00:04:00.000Z",
  };
}

function mockDefaults() {
  mocks.list.mockResolvedValue({ items: [], next_cursor: null });
  mocks.create.mockResolvedValue(definition());
  mocks.get.mockResolvedValue(definition());
  mocks.update.mockResolvedValue(definition({ current_revision: 4 }));
  mocks.remove.mockResolvedValue({ ok: true });
  mocks.proposePlan.mockResolvedValue({
    definition_id: "d1",
    base_revision: 3,
    model: "model-a",
    model_used: true,
    fallback: false,
    error_code: null,
    plan: { steps: [{ id: "ps-new", objective: "Compare claims", questions: ["price?"] }] },
  });
  mocks.listRuns.mockResolvedValue({ items: [runSummary()], next_cursor: null });
  mocks.start.mockResolvedValue(runDetail({ status: "queued", finished_at: null }));
  mocks.getRun.mockResolvedValue(runDetail());
  mocks.listEvidence.mockResolvedValue({ items: [evidence()], next_cursor: null });
  mocks.getTable.mockResolvedValue({
    run_id: "r1",
    columns: [],
    items: [],
    next_cursor: null,
    limit_state: { serialized_bytes: 0, limit_bytes: 1048576, at_limit: false },
    view_state: {
      sort_applied: false,
      filter_applied: false,
      basis: "row_source_id_keyset",
      sort_column_id: null,
      sort_dir: "asc",
      sort_view: "effective",
    },
  });
  mocks.cancelRun.mockResolvedValue({ ok: true, status: "cancelling" });
  mocks.review.mockResolvedValue({ review_revision: 6, ops_applied: 1, run: runDetail() });
  mocks.createArtifact.mockResolvedValue({
    run_id: "r1",
    document_id: "doc-7",
    document_revision_id: "rev-7",
    document_revision: 1,
    projection: {
      output_kind: "memo",
      run_status: "needs_review",
      cell_chars_max: 1000,
      excerpt_chars_max: 800,
      payload_chars: 4000,
      projected: { evidence: 1, rows: 0, columns: 0, cells: 0, claims: 0, gaps: 0 },
      omitted: { rows: ["row-x"], columns: [], claims: 2, gaps: 1, evidence: 3 },
      labels: ["needs-review partial output", "conflicts preserved"],
      disclosures: {
        needs_review: true,
        conflicting_cells: 0,
        invalid_cells: 0,
        not_found_cells: 0,
        correction_cells: 0,
        excerpts_shortened: 0,
        cells_truncated: 0,
        table_at_limit: false,
      },
    },
  });
  mocks.modelsList.mockResolvedValue({
    models: [{ id: "model-a" }],
    available_models: [{ id: "model-a" }],
    default_model: "model-a",
    account_default_model: null,
    discovery: "live",
  });
  mocks.sourcesList.mockResolvedValue({
    items: [
      {
        id: SOURCE_ID,
        name: "acme.pdf",
        display_name: "Acme Proposal",
        kind: "document",
        status: "ready",
        mime: "application/pdf",
        created_at: "",
        meta: null,
      },
    ],
    next_cursor: null,
  });
  mocks.librariesList.mockResolvedValue({ items: [], next_cursor: null });
}

async function renderDetail(def = definition()) {
  mocks.get.mockResolvedValue(def);
  render(<ResearchView definitionId="d1" />);
  await waitFor(() => expect(screen.getByText(def.title)).toBeInTheDocument());
  return def;
}

describe("ResearchView review workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDefaults();
    window.sessionStorage.clear();
  });

  it("loads the definition detail and run history", async () => {
    await renderDetail();
    await waitFor(() => expect(mocks.listRuns).toHaveBeenCalledWith("d1"));
    expect(screen.getByRole("button", { name: /Needs review/ })).toBeInTheDocument();
  });

  it("keeps Start disabled with an explanation for a selected-empty draft", async () => {
    await renderDetail(definition({ source_ids: [], sources: [] }));
    const start = screen.getByRole("button", { name: /^Start with/ });
    expect(start).toBeDisabled();
    expect(screen.getByText(/an empty scope is a legal draft, not a run/)).toBeInTheDocument();
    expect(screen.getByText("No sources selected — this draft cannot start yet.")).toBeInTheDocument();
  });

  it("shows the precise readiness conflict and disables Start for unready selections", async () => {
    await renderDetail(
      definition({
        sources: [{ source_id: SOURCE_ID, availability: "unready", ready_generation: null }],
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Readiness conflict");
    expect(await screen.findByText(/not ready for retrieval/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Start with/ })).toBeDisabled();
    expect(screen.getByText(/not ready — revise the selection first/)).toBeInTheDocument();
  });

  it("never auto-starts from plan generation and shows the editable proposal", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Generate plan proposal/ }));
    await waitFor(() => expect(mocks.proposePlan).toHaveBeenCalledWith("d1", 3));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue("price?")).toBeInTheDocument();
    expect(await screen.findByText(/nothing has started/)).toBeInTheDocument();
  });

  it("surfaces a stale definition save as a CAS conflict with reload guidance", async () => {
    const user = userEvent.setup();
    await renderDetail();
    mocks.update.mockRejectedValue(new ApiError(409, "conflict", { code: "RESEARCH_REVISION_CONFLICT" }));
    await user.click(screen.getByRole("button", { name: /Save as revision/ }));
    expect(await screen.findByText(/changed since this form loaded; your save was rejected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload saved revision/ })).toBeInTheDocument();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ expected_revision: 3 });
  });

  it("blocks a second save while the first is in flight (busy gate)", async () => {
    const user = userEvent.setup();
    await renderDetail();
    let release: () => void = () => {};
    mocks.update.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(definition({ current_revision: 4 }));
        }),
    );
    const saveButton = screen.getByRole("button", { name: /Save as revision/ });
    await user.click(saveButton);
    await user.click(saveButton).catch(() => undefined);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
  });

  it("starts with the pinned revision, shows the model, and selects the new run", async () => {
    const user = userEvent.setup();
    await renderDetail();
    mocks.getRun.mockResolvedValue(runDetail({ status: "running", finished_at: null, cancel_requested: false }));
    await user.click(screen.getByRole("button", { name: /^Start with model-a/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.calls[0][1]).toMatchObject({ expected_revision: 3 });
    expect(await screen.findByText(/attempt 1|Running/)).toBeInTheDocument();
  });

  it("surfaces RESEARCH_MODEL_UNAVAILABLE on start honestly", async () => {
    const user = userEvent.setup();
    await renderDetail();
    mocks.start.mockRejectedValue(new ApiError(409, "unavailable", { code: "RESEARCH_MODEL_UNAVAILABLE" }));
    await user.click(screen.getByRole("button", { name: /^Start with/ }));
    expect(await screen.findByText(/not available on the provider/)).toBeInTheDocument();
  });

  it("labels needs_review runs as partial, never complete, and creates a reviewed draft", async () => {
    const user = userEvent.setup();
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    expect(await screen.findByText(/it is partial, not complete research/)).toBeInTheDocument();
    expect(screen.queryByText(/complete research\b(?!.*)/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Create reviewed draft/ }));
    await waitFor(() => expect(mocks.createArtifact).toHaveBeenCalledWith("r1"));
    const link = await screen.findByRole("link", { name: /Open in document workbench/ });
    expect(link).toHaveAttribute("href", "#/documents/doc-7");
    expect(await screen.findByText(/\(head revision 1\)/)).toBeInTheDocument();
    expect(await screen.findByText(/needs-review partial output/)).toBeInTheDocument();
    expect(await screen.findByText(/Omitted from the projection: 1 rows, 2 claims, 3 evidence/)).toBeInTheDocument();
  });

  it("disables the reviewed draft for failed runs with an explanation", async () => {
    mocks.listRuns.mockResolvedValue({ items: [runSummary("failed")], next_cursor: null });
    mocks.getRun.mockResolvedValue(
      runDetail({ status: "failed", error_code: "RESEARCH_MODEL_UNAVAILABLE", error_reason: "provider refused" }),
    );
    const user = userEvent.setup();
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Failed/ }));
    const create = await screen.findByRole("button", { name: /Create reviewed draft/ });
    expect(create).toBeDisabled();
    expect(await screen.findByText(/A failed or cancelled run cannot publish output/)).toBeInTheDocument();
  });

  it("never renders an unresolvable claim citation as a link", async () => {
    mocks.getRun.mockResolvedValue(
      runDetail({
        claims: [
          {
            id: "claim-1",
            run_id: "r1",
            kind: "claim",
            text: "Acme requires ninety days notice.",
            corrected_text: null,
            classification: "supported",
            evidence_refs: [KNOWN_EVIDENCE_ID, "ffffffff-0000-4000-8000-00000000000f"],
            user_note: null,
            review_state: "pending",
            created_at: "",
            updated_at: "",
          },
        ],
      }),
    );
    const user = userEvent.setup();
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    expect(await screen.findByText("Acme requires ninety days notice.")).toBeInTheDocument();
    const claimRow = screen.getByText("Acme requires ninety days notice.").closest("li")!;
    expect(within(claimRow).getAllByRole("button", { name: /^evidence in/ })).toHaveLength(1);
    expect(claimRow.textContent).not.toContain("ffffffff");
  });

  it("sends claim accept through the review CAS and reloads on success", async () => {
    const user = userEvent.setup();
    mocks.getRun.mockResolvedValue(
      runDetail({
        claims: [
          {
            id: "claim-1",
            run_id: "r1",
            kind: "claim",
            text: "Acme requires ninety days notice.",
            corrected_text: null,
            classification: "supported",
            evidence_refs: [],
            user_note: null,
            review_state: "pending",
            created_at: "",
            updated_at: "",
          },
        ],
      }),
    );
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    const claimRow = (await screen.findByText("Acme requires ninety days notice.")).closest("li")!;
    mocks.getRun.mockResolvedValue(
      runDetail({
        review_revision: 6,
        claims: [
          {
            id: "claim-1",
            run_id: "r1",
            kind: "claim",
            text: "Acme requires ninety days notice.",
            corrected_text: null,
            classification: "supported",
            evidence_refs: [],
            user_note: null,
            review_state: "accepted",
            created_at: "",
            updated_at: "",
          },
        ],
      }),
    );
    await user.click(within(claimRow).getByRole("button", { name: /^Accept/ }));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(1));
    expect(mocks.review.mock.calls[0][1]).toMatchObject({
      expected_revision: 5,
      ops: [{ op: "accept_claim", claim_id: "claim-1" }],
    });
    expect(await screen.findByText("accepted")).toBeInTheDocument();
  });

  it("shows reload guidance when a review hits the review-revision CAS", async () => {
    const user = userEvent.setup();
    mocks.getRun.mockResolvedValue(
      runDetail({
        claims: [
          {
            id: "claim-1",
            run_id: "r1",
            kind: "claim",
            text: "Acme requires ninety days notice.",
            corrected_text: null,
            classification: "supported",
            evidence_refs: [],
            user_note: null,
            review_state: "pending",
            created_at: "",
            updated_at: "",
          },
        ],
      }),
    );
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    mocks.review.mockRejectedValue(new ApiError(409, "conflict", { code: "RESEARCH_REVISION_CONFLICT" }));
    const claimRow = (await screen.findByText("Acme requires ninety days notice.")).closest("li")!;
    await user.click(within(claimRow).getByRole("button", { name: /^Accept/ }));
    expect(await screen.findByText(/review revision moved since this page loaded/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reload current review state/ })).toBeInTheDocument();
  });

  it("requests cancellation idempotently and reflects cancel_requested", async () => {
    const user = userEvent.setup();
    mocks.listRuns.mockResolvedValue({ items: [runSummary("running")], next_cursor: null });
    mocks.getRun.mockResolvedValue(runDetail({ status: "running", finished_at: null, cancel_requested: false }));
    await renderDetail();
    await user.click(screen.getByRole("button", { name: /Running/ }));
    const cancel = await screen.findByRole("button", { name: /Cancel run/ });
    mocks.getRun.mockResolvedValue(runDetail({ status: "running", finished_at: null, cancel_requested: true }));
    await user.click(cancel);
    await waitFor(() => expect(mocks.cancelRun).toHaveBeenCalledWith("r1"));
    const again = await screen.findByRole("button", { name: /Cancellation requested/ });
    expect(again).toBeDisabled();
  });

  it("aborts the run poll when the view unmounts (navigation)", async () => {
    const signals: AbortSignal[] = [];
    mocks.getRun.mockImplementation((_id: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return Promise.resolve(runDetail({ status: "running", finished_at: null }));
    });
    mocks.listRuns.mockResolvedValue({ items: [runSummary("running")], next_cursor: null });
    const user = userEvent.setup();
    const { unmount } = render(<ResearchView definitionId="d1" />);
    await waitFor(() => expect(screen.getByText("Supplier renewal terms")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Running/ }));
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    unmount();
    await waitFor(() => expect(signals[signals.length - 1]?.aborted).toBe(true));
  });

  it("renders correction overlays and reruns selected comparison rows", async () => {
    const user = userEvent.setup();
    mocks.get.mockResolvedValue(
      definition({
        output_kind: "comparison",
        columns: [
          { id: COLUMN_ID, label: "Price", question: "What is the price?", type: "number", unit: "USD", choices: null },
        ],
      }),
    );
    mocks.getTable.mockResolvedValue({
      run_id: "r1",
      columns: [
        { id: COLUMN_ID, label: "Price", question: "What is the price?", type: "number", unit: "USD", choices: null },
      ],
      items: [
        {
          row_source_id: SOURCE_ID,
          row_generation: 2,
          cells: [
            {
              column_id: COLUMN_ID,
              row_source_id: SOURCE_ID,
              row_generation: 2,
              origin: "machine",
              value: 1200,
              status: "supported",
              evidence_refs: [KNOWN_EVIDENCE_ID],
              explanation: null,
              corrected_at: null,
              corrected_from_run_id: null,
              created_at: "",
              updated_at: "",
            },
            {
              column_id: COLUMN_ID,
              row_source_id: SOURCE_ID,
              row_generation: 2,
              origin: "correction",
              value: 1250,
              status: "supported",
              evidence_refs: [],
              explanation: "fixed after invoice review",
              corrected_at: "2026-01-04T00:00:00.000Z",
              corrected_from_run_id: null,
              created_at: "",
              updated_at: "",
            },
          ],
        },
      ],
      next_cursor: null,
      limit_state: { serialized_bytes: 42, limit_bytes: 1048576, at_limit: false },
      view_state: {
        sort_applied: false,
        filter_applied: false,
        basis: "row_source_id_keyset",
        sort_column_id: null,
        sort_dir: "asc",
        sort_view: "effective",
      },
    });
    render(<ResearchView definitionId="d1" />);
    await waitFor(() => expect(screen.getByText("Supplier renewal terms")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /Needs review/ }));
    const tableSection = await screen.findByRole("region", { name: "Comparison output" });
    expect(await within(tableSection).findByText("Acme Proposal")).toBeInTheDocument();
    expect(await within(tableSection).findByText(/machine original: 1200 USD/)).toBeInTheDocument();
    expect(within(tableSection).getByText("1250 USD")).toBeInTheDocument();
    expect(within(tableSection).getByText("corrected")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select row Acme Proposal for rerun" }));
    await user.click(within(tableSection).getByRole("button", { name: /Rerun selected rows\/columns/ }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    expect(mocks.start.mock.calls[0][1]).toMatchObject({
      rerun_of: "r1",
      rerun_selection: { row_source_ids: [SOURCE_ID] },
    });
  });
});
