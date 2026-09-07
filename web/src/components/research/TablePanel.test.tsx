import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ResearchRunDetail, ResearchRunSummary, ResearchTableView } from "@/lib/api";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  getTable: vi.fn(),
  listEvidence: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    researchApi: {
      ...actual.researchApi,
      getTable: mocks.getTable,
      listEvidence: mocks.listEvidence,
    },
  };
});

vi.mock("@/components/LibrarySearchPanel", () => ({
  PassagePanel: () => <div data-testid="passage-panel" />,
  locatorBadges: () => null,
  locatorCopy: () => "locator",
  HighlightedExcerpt: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { TablePanel } from "@/components/research/TablePanel";

const COLUMN = {
  id: "price",
  label: "Price",
  question: "What is the price?",
  type: "number" as const,
  unit: "USD",
  choices: null,
};

function view(withRow: boolean): ResearchTableView {
  return {
    run_id: "r1",
    columns: [COLUMN],
    items: withRow
      ? [
          {
            row_source_id: SOURCE_ID,
            row_generation: 2,
            cells: [
              {
                column_id: "price",
                row_source_id: SOURCE_ID,
                row_generation: 2,
                origin: "machine",
                value: 1200,
                status: "supported",
                evidence_refs: [],
                explanation: null,
                corrected_at: null,
                corrected_from_run_id: null,
                created_at: "",
                updated_at: "",
              },
            ],
          },
        ]
      : [],
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
  } as unknown as ResearchTableView;
}

function run(status: ResearchRunDetail["status"]): ResearchRunDetail {
  return {
    id: "r1",
    definition_id: "d1",
    definition_revision: 1,
    status,
    cancel_requested: false,
    chat_model: "model-a",
    provider_locality: "local",
    rerun_of: null,
    review_revision: 1,
    error_code: null,
    created_at: "",
    started_at: "",
    finished_at: null,
    error_reason: null,
    sources: [],
    budgets: { steps: 8, searches: 32, model_requests: 40, evidence: 100, evidence_chars: 200000, wall_ms: 900000 },
    usage: { searches: 0, model_requests: 0 },
    rerun_selection: null,
    steps: [],
    claims: [],
    counts: { evidence_count: 0, claim_count: 0, gap_count: 0, table_column_count: 1, table_row_count: 1 },
  } as unknown as ResearchRunDetail;
}

function props(status: ResearchRunDetail["status"]) {
  return {
    title: "Comparison",
    run: run(status),
    runHistory: [] as ResearchRunSummary[],
    sourceLabels: new Map<string, string>([[SOURCE_ID, "Acme Proposal"]]),
    reviewBusy: false,
    rerunBusy: false,
    onReview: async () => true,
    onRerun: async () => undefined,
  };
}

describe("TablePanel terminal-status refetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEvidence.mockResolvedValue({ items: [], next_cursor: null });
  });

  it("materializes table cells when a mounted run reaches a terminal status", async () => {
    mocks.getTable.mockResolvedValue(view(false));
    const { rerender } = render(<TablePanel {...props("running")} />);
    await waitFor(() => expect(mocks.getTable).toHaveBeenCalled());
    expect(document.body.textContent ?? "").not.toContain("Acme Proposal");
    mocks.getTable.mockResolvedValue(view(true));
    rerender(<TablePanel {...props("completed")} />);
    await waitFor(() => expect(document.body.textContent ?? "").toContain("Acme Proposal"), { timeout: 3000 });
  });

  it("refetches once at the live→terminal transition, not within the live phase", async () => {
    mocks.getTable.mockResolvedValue(view(false));
    const { rerender } = render(<TablePanel {...props("running")} />);
    await waitFor(() => expect(mocks.getTable).toHaveBeenCalled());
    const beforeLive = mocks.getTable.mock.calls.length;
    rerender(<TablePanel {...props("cancelling")} />);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(mocks.getTable).toHaveBeenCalledTimes(beforeLive);
    rerender(<TablePanel {...props("needs_review")} />);
    await waitFor(() => expect(mocks.getTable).toHaveBeenCalledTimes(beforeLive + 1));
  });
});
