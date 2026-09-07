import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reviewMocks = vi.hoisted(() => ({
  list: vi.fn(),
  decide: vi.fn(),
  getRun: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (error: unknown, fallback: string) =>
    error instanceof Error && error.name === "ApiError" ? error.message : fallback,
  BRIEF_PIPELINE_STAGES: ["queued", "refreshing", "waiting_ready", "analyzing", "drafting", "awaiting_review"],
  briefReviewsApi: { list: reviewMocks.list, decide: reviewMocks.decide },
  briefsApi: { getRun: reviewMocks.getRun },
}));

import { BriefReviewsView } from "@/pages/BriefReviewsView";

function apiError(message: string, code: string, status = 409) {
  const error = new Error(message) as Error & { name: string; status: number; data: unknown };
  error.name = "ApiError";
  error.status = status;
  error.data = { code };
  return error;
}

function deferred<T = unknown>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const comparedSummary = {
  kind: "compared" as const,
  baseline_run_id: "ar-0",
  baseline_result_id: "res-0",
  current_result_id: "res-1",
  mode: "keyed" as const,
  key_columns: ["metric_label"],
  reason_code: null,
  reason_detail: null,
  exhaustive: true,
  added_total: 0,
  removed_total: 0,
  changed_total: 1,
  truncated: false,
  changed_sample: [{ key: ["total"], changes: [{ column: "value", delta: 25 }] }],
};

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    recipe_id: "brief-1",
    recipe_name: "Weekly finance",
    recipe_revision: 4,
    recipe_state: "active",
    recipe_paused_reason: null,
    trigger: "scheduled" as const,
    occurrence_key: "2026-09-07T09:00",
    coalesced_count: 0,
    missed_through_key: null,
    stage: "awaiting_review" as const,
    created_at: "2026-09-07T07:05:00Z",
    stage_updated_at: "2026-09-07T07:05:00Z",
    finished_at: null,
    analysis_run_id: "ar-1",
    baseline_run_id: "ar-0",
    comparison_summary: comparedSummary,
    refresh_receipts: [
      { source_id: "src-a", kind: "static", outcome: "no-change", generation: 3, label: "uses imported version" },
    ],
    document_id: "doc-1",
    document_revision_id: "draft-rev-1",
    document_head_revision_id: "draft-rev-1",
    head_moved: false,
    reviewed_revision_id: null,
    publication_operation_id: null,
    publication_error_code: null,
    publication_failure: null,
    review: null,
    ...overrides,
  };
}

const approvedRow = reviewRow({
  stage: "approved",
  reviewed_revision_id: "draft-rev-1",
  review: { decision: "approve", note: null, document_revision_id: "draft-rev-1", created_at: "2026-09-07T08:00:00Z" },
});

const rejectedRow = reviewRow({
  id: "run-4",
  stage: "rejected",
  review: {
    decision: "reject",
    note: "prose drifted from the numbers",
    document_revision_id: "draft-rev-1",
    created_at: "2026-09-07T08:10:00Z",
  },
});

describe("BriefReviewsView", () => {
  beforeEach(() => {
    reviewMocks.list.mockReset();
    reviewMocks.decide.mockReset();
    reviewMocks.getRun.mockReset();
    reviewMocks.list.mockResolvedValue({ items: [reviewRow()], next_cursor: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows pending reviews first with honest comparison labels, freshness, and the draft deep link", async () => {
    reviewMocks.list.mockResolvedValue({
      items: [
        approvedRow,
        reviewRow({ comparison_summary: { kind: "unavailable", reason: "baseline-missing" } }),
        reviewRow({ id: "run-2", stage: "publishing" }),
        rejectedRow,
      ],
      next_cursor: null,
    });
    const { container } = render(<BriefReviewsView />);

    expect((await screen.findAllByText("Weekly finance")).length).toBeGreaterThan(0);
    const headings = Array.from(container.querySelectorAll("h2")).map((node) => node.textContent);
    expect(headings[0]).toContain("Awaiting review");
    expect(headings[1]).toContain("Decided");
    // The first-run series label is honest, not a silent "no change".
    expect(screen.getByText("first run / new series")).toBeInTheDocument();
    // Freshness receipts render the durable label.
    expect(screen.getAllByText(/uses imported version/).length).toBeGreaterThan(0);
    const draftLink = screen.getAllByRole("link", { name: /Open draft/ })[0];
    expect(draftLink).toHaveAttribute("href", "#/documents/doc-1");
    // Decided rows show the read-only ledger tail with the preserved note.
    expect(screen.getByText(/prose drifted from the numbers/)).toBeInTheDocument();
    // Pending actions appear only on awaiting_review rows; publishing is in
    // the pending group but has no pending decision (it renders already).
    expect(screen.getAllByRole("button", { name: /Approve this revision/ })).toHaveLength(1);
    expect(screen.getByText("rendering publication…")).toBeInTheDocument();
  });

  it("warns when the draft head moved past the review pointer", async () => {
    reviewMocks.list.mockResolvedValue({ items: [reviewRow({ head_moved: true })], next_cursor: null });
    render(<BriefReviewsView />);

    expect(await screen.findByText(/edited after this pointer/)).toBeInTheDocument();
    expect(screen.getByText(/Approving will conflict until the inbox is refreshed/)).toBeInTheDocument();
  });

  it("approves the exact revision, accepts 202 publishing, and confirms approved only after polling the commit", async () => {
    vi.useFakeTimers();
    const publishingResult = {
      status: "publishing",
      replayed: false,
      status_path: "/api/briefs/brief-1/runs/run-1",
      run: { id: "run-1", stage: "publishing" },
    };
    reviewMocks.decide.mockResolvedValue(publishingResult);
    // The poll resolves publication-committed on the first exact-ID status.
    reviewMocks.getRun.mockResolvedValue({ id: "run-1", stage: "approved" });
    // Inbox pages: initial awaiting → the accepted 202 state (publishing) →
    // the authoritative re-fetch once the publication committed.
    reviewMocks.list
      .mockResolvedValueOnce({ items: [reviewRow()], next_cursor: null })
      .mockResolvedValueOnce({ items: [reviewRow({ stage: "publishing" })], next_cursor: null })
      .mockResolvedValue({ items: [approvedRow], next_cursor: null });

    render(<BriefReviewsView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve this revision" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reviewMocks.decide).toHaveBeenCalledWith("run-1", {
      decision: "approve",
      document_revision_id: "draft-rev-1",
    });
    // 202 while rendering: the row shows the durable publishing state, not
    // an approved confirmation.
    expect(screen.getByText("rendering publication…")).toBeInTheDocument();
    expect(screen.queryByText(/Approved — the publication committed/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(reviewMocks.getRun).toHaveBeenCalledWith("brief-1", "run-1");
    expect(screen.getByText(/Approved — the publication committed/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    // Polling stops once nothing is publishing.
    expect(reviewMocks.getRun).toHaveBeenCalledTimes(1);
  });

  it("surfaces revision-conflict refresh guidance and reloads the inbox", async () => {
    reviewMocks.decide.mockRejectedValue(
      apiError(
        "the brief draft changed since this review; decide again on the current revision",
        "BRIEF_REVIEW_REVISION_CONFLICT",
      ),
    );
    render(<BriefReviewsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve this revision" }));

    expect(await screen.findByText(/Refresh the inbox and decide again on the current revision/)).toBeInTheDocument();
    const refreshesBefore = reviewMocks.list.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh inbox" }));
    await waitFor(() => expect(reviewMocks.list.mock.calls.length).toBeGreaterThan(refreshesBefore));
  });

  it("explains an accepted-approval run-state conflict without revoking it", async () => {
    reviewMocks.decide.mockRejectedValue(apiError("brief run state", "BRIEF_RUN_STATE"));
    render(<BriefReviewsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    fireEvent.click(screen.getByRole("button", { name: /Reject \(keeps the run and draft\)/ }));

    expect(await screen.findByText(/already accepted or committed and cannot be revoked/)).toBeInTheDocument();
  });

  it("rejects with an optional bounded note and keeps the run and draft visible", async () => {
    reviewMocks.decide.mockResolvedValue({
      status: "rejected",
      replayed: false,
      status_path: "",
      run: { id: "run-1" },
    });
    reviewMocks.list
      .mockResolvedValueOnce({ items: [reviewRow()], next_cursor: null })
      .mockResolvedValue({ items: [rejectedRow], next_cursor: null });
    render(<BriefReviewsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Reject…" }));
    fireEvent.change(screen.getByLabelText("Rejection note (optional)"), {
      target: { value: "prose drifted from the numbers" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Reject \(keeps the run and draft\)/ }));

    await waitFor(() =>
      expect(reviewMocks.decide).toHaveBeenCalledWith("run-1", {
        decision: "reject",
        document_revision_id: "draft-rev-1",
        note: "prose drifted from the numbers",
      }),
    );
    expect(await screen.findByText(/Rejection preserved the run and draft/)).toBeInTheDocument();
    // Rejected stays readable through the read-only ledger tail.
    expect(screen.getByText(/prose drifted from the numbers/)).toBeInTheDocument();
  });

  it("keeps an older decision response from mutating a newer decision", async () => {
    const older = deferred<{ status: string; replayed: boolean; status_path: string; run: unknown }>();
    reviewMocks.list
      .mockResolvedValueOnce({ items: [reviewRow({ id: "run-a" }), reviewRow({ id: "run-b" })], next_cursor: null })
      .mockResolvedValue({
        items: [reviewRow({ id: "run-b", stage: "approved", review: approvedRow.review })],
        next_cursor: null,
      });
    reviewMocks.decide.mockReturnValueOnce(older.promise).mockResolvedValueOnce({
      status: "approved",
      replayed: false,
      status_path: "",
      run: { id: "run-b" },
    });
    render(<BriefReviewsView />);

    const approveButtons = await screen.findAllByRole("button", { name: "Approve this revision" });
    fireEvent.click(approveButtons[0]);
    await waitFor(() => expect(reviewMocks.decide).toHaveBeenCalledTimes(1));
    fireEvent.click(approveButtons[1]);
    await waitFor(() => expect(reviewMocks.decide).toHaveBeenCalledTimes(2));

    // The newer decision settled; the refetched inbox owns the rows now.
    expect(await screen.findByText(/Approved — the publication committed/)).toBeInTheDocument();

    await act(async () =>
      older.resolve({ status: "publishing", replayed: false, status_path: "", run: { id: "run-a" } }),
    );
    // The stale approval response never puts run-a back into publishing.
    expect(screen.queryByText("rendering publication…")).not.toBeInTheDocument();
  });

  it("pages older reviews through the keyset cursor", async () => {
    reviewMocks.list
      .mockResolvedValueOnce({ items: [reviewRow()], next_cursor: "page-2" })
      .mockResolvedValueOnce({ items: [rejectedRow], next_cursor: null });
    render(<BriefReviewsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older reviews" }));
    await waitFor(() => expect(reviewMocks.list).toHaveBeenLastCalledWith({ cursor: "page-2", limit: 20 }));
    expect(await screen.findByText(/prose drifted from the numbers/)).toBeInTheDocument();
  });

  it("flags a failed publication with honest retry guidance", async () => {
    reviewMocks.list.mockResolvedValue({
      items: [
        reviewRow({
          publication_error_code: "RENDER_FAILED",
          publication_failure: {
            code: "RENDER_FAILED",
            message:
              "the draft could not be rendered for publication; review the current revision again to retry publication",
          },
        }),
      ],
      next_cursor: null,
    });
    render(<BriefReviewsView />);

    expect(await screen.findByText(/failed publication \(RENDER_FAILED\)/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing was published/)).toBeInTheDocument();
  });
});
