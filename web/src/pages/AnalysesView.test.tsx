import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  fromQuery: vi.fn(),
  listRuns: vi.fn(),
  run: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  listResults: vi.fn(),
  getResult: vi.fn(),
  removeResult: vi.fn(),
  compare: vi.fn(),
  resultChart: vi.fn(),
  downloadExport: vi.fn(),
  sourcesList: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    analysesApi: {
      list: mocks.list,
      create: mocks.create,
      get: mocks.get,
      update: mocks.update,
      remove: mocks.remove,
      fromQuery: mocks.fromQuery,
      listRuns: mocks.listRuns,
      run: mocks.run,
      getRun: mocks.getRun,
      cancelRun: mocks.cancelRun,
      listResults: mocks.listResults,
      getResult: mocks.getResult,
      removeResult: mocks.removeResult,
      compare: mocks.compare,
      resultChart: mocks.resultChart,
      downloadExport: mocks.downloadExport,
    },
    sourcesApi: { ...actual.sourcesApi, list: mocks.sourcesList },
  };
});

vi.mock("@/components/ChartCard", () => ({
  ChartCard: () => <div>chart preview</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, role }: { children: React.ReactNode; role?: string }) => (
    <div role={role}>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AnalysesView } from "@/pages/AnalysesView";
import type { Analysis, AnalysisRun } from "@/lib/api";

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    id: "analysis-1",
    current_revision: 3,
    title: "Monthly spend",
    description: "",
    sql: "SELECT month, total FROM spend WHERE month = ?",
    parameters: [{ name: "month", type: "string", required: true, nullable: false }],
    source_ids: ["source-1"],
    comparison_key: ["month"],
    origin: { chat_id: null, run_id: null, capture_id: null },
    revision_created_at: "2026-01-01T00:00:00.000Z",
    sources: [
      {
        source_id: "source-1",
        ready_generation: 2,
        content_identity: "g2|s10|p/x.csv",
        unavailable_at: null,
        bound_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

function catalogItem(id = "analysis-1", title = "Monthly spend") {
  return {
    id,
    title,
    description: "",
    current_revision: 3,
    source_count: 1,
    unavailable_source_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };
}

function storedRun(status: AnalysisRun["status"] = "queued"): AnalysisRun {
  return {
    id: "run-1",
    analysis_id: "analysis-1",
    revision: 3,
    status,
    cancel_requested: false,
    operation_id: null,
    schema_fingerprint: null,
    error_code: null,
    error_reason: null,
    created_at: "2026-01-03T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    parameter_values: [{ name: "month", type: "string", value: "2026-01" }],
    sources: [],
  };
}

function resultSummary(id = "result-1") {
  return {
    id,
    run_id: "run-0",
    revision: 2,
    returned_rows: 1,
    source_row_total: 1,
    row_count_exact: true,
    complete: true,
    completeness_reasons: [],
    schema_fingerprint: null,
    created_at: "2026-01-02T00:00:00.000Z",
  };
}

function resultDetail(id = "result-1", rows: unknown[][] = [["2026-01", 120]]) {
  return {
    id,
    analysis_id: "analysis-1",
    run_id: "run-0",
    revision: 2,
    columns: [
      { name: "month", type: "string" as const },
      { name: "total", type: "number" as const },
    ],
    rows,
    returned_rows: rows.length,
    source_row_total: rows.length,
    row_count_exact: true,
    completeness: { complete: true, reasons: [] },
    parameter_values: [{ name: "month", type: "string" as const, value: "2026-01" }],
    source_provenance: [{ source_id: "source-1", ready_generation: 1, content_identity: "g1|s5|p/x" }],
    schema_fingerprint: null,
    created_at: "2026-01-02T00:00:00.000Z",
  };
}

function baseMocks(): void {
  mocks.list.mockResolvedValue({ items: [catalogItem()], next_cursor: null });
  mocks.get.mockResolvedValue(analysis());
  mocks.listRuns.mockResolvedValue({ items: [], next_cursor: null });
  mocks.listResults.mockResolvedValue({ items: [resultSummary()], next_cursor: null });
  mocks.sourcesList.mockResolvedValue({
    items: [
      {
        id: "source-1",
        name: "spend",
        kind: "tabular",
        display_name: "spend.csv",
        mime: "text/csv",
        status: "ready",
        created_at: "2026-01-01T00:00:00.000Z",
        tabular: { rows: 10, table: "spend", original_name: "spend.csv" },
      },
    ],
    next_cursor: null,
  });
}

const LOAD_TIMEOUT = { timeout: 4_000 };

async function selectAnalysisCard(): Promise<void> {
  await screen.findByText("Monthly spend", {}, LOAD_TIMEOUT);
  await userEvent.click(screen.getByText("Monthly spend"));
  await screen.findByText("revision 3", {}, LOAD_TIMEOUT);
}

beforeEach(() => {
  vi.clearAllMocks();
  baseMocks();
  window.location.hash = "/analyses";
  window.sessionStorage.clear();
});

describe("AnalysesView catalog", () => {
  it("lists saved analyses and shows the empty state when there are none", async () => {
    render(<AnalysesView />);
    expect(await screen.findByText("Monthly spend")).toBeInTheDocument();

    vi.clearAllMocks();
    baseMocks();
    mocks.list.mockResolvedValue({ items: [], next_cursor: null });
    render(<AnalysesView />);
    expect(await screen.findByText(/No saved analyses yet/)).toBeInTheDocument();
  });

  it("loads the definition, run history, and result catalog on selection", async () => {
    render(<AnalysesView />);
    await selectAnalysisCard();

    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith("analysis-1", expect.anything()));
    expect(mocks.listRuns).toHaveBeenCalledWith("analysis-1");
    expect(mocks.listResults).toHaveBeenCalledWith("analysis-1");
    expect(screen.getByText(/rows · r2/)).toBeInTheDocument();
  });
});

describe("AnalysesView run execution", () => {
  it("runs with typed values, polls the exact target to terminal, and refreshes the catalog", async () => {
    vi.useFakeTimers();
    try {
      mocks.run.mockResolvedValue({ outcome: "queued", run: storedRun("queued") });
      mocks.getRun.mockResolvedValueOnce(storedRun("running")).mockResolvedValueOnce(storedRun("succeeded"));

      render(<AnalysesView />);
      await act(async () => undefined); // initial catalog load
      fireEvent.click(screen.getByText("Monthly spend"));
      await act(async () => undefined); // detail + runs + results

      fireEvent.change(screen.getByLabelText(/month/), { target: { value: "2026-01" } });
      fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
      await act(async () => undefined); // acceptance + quiet detail refresh

      expect(mocks.run).toHaveBeenCalledTimes(1);
      const runBody = mocks.run.mock.calls[0][1];
      expect(runBody.values).toEqual({ month: "2026-01" });
      expect(runBody.expected_revision).toBe(3);
      expect(runBody.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(screen.getByRole("button", { name: /Cancel/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Run now/ })).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(1_000); // poll 1 → running
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500); // poll 2 → succeeded + refreshes
      });

      expect(mocks.getRun).toHaveBeenCalledTimes(2);
      expect(mocks.getRun).toHaveBeenCalledWith("analysis-1", "run-1", expect.anything());
      expect(screen.getByText(/Last run run-1: Succeeded/)).toBeInTheDocument();
      // The terminal refresh refetched the results catalog.
      expect(mocks.listResults.mock.calls.length).toBeGreaterThanOrEqual(2);
      // The run button unlocks once the tracked run reaches a terminal state.
      expect(screen.getByRole("button", { name: /Run now/ })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests cancellation of the active run", async () => {
    mocks.run.mockResolvedValue({ outcome: "queued", run: storedRun("queued") });
    mocks.getRun.mockResolvedValue(storedRun("running"));
    mocks.cancelRun.mockResolvedValue({ ok: true, status: "running" });

    render(<AnalysesView />);
    await selectAnalysisCard();
    await userEvent.type(screen.getByLabelText(/month/), "2026-01");
    await userEvent.click(screen.getByRole("button", { name: /Run now/ }));

    await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }, LOAD_TIMEOUT));
    await waitFor(() => expect(mocks.cancelRun).toHaveBeenCalledWith("analysis-1", "run-1"));
  });

  it("surfaces run acceptance errors on the run panel", async () => {
    mocks.run.mockRejectedValue(new Error("ANALYSIS_ACTIVE_RUN"));
    render(<AnalysesView />);
    await selectAnalysisCard();
    await userEvent.type(screen.getByLabelText(/month/), "2026-01");
    await userEvent.click(screen.getByRole("button", { name: /Run now/ }));

    expect(await screen.findByText("Could not start the run")).toBeInTheDocument();
  });
});

describe("AnalysesView results", () => {
  it("ignores a stale result-detail response after a newer selection", async () => {
    let resolveSlow: ((value: ReturnType<typeof resultDetail>) => void) | null = null;
    mocks.getResult.mockImplementation(((_id: string, resultId: string) => {
      if (resultId === "result-1") {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      return Promise.resolve(resultDetail("result-2", [["2026-02", 220]]));
    }) as unknown as typeof mocks.getResult);
    mocks.listResults.mockResolvedValue({
      items: [resultSummary("result-2"), resultSummary("result-1")],
      next_cursor: null,
    });

    render(<AnalysesView />);
    await selectAnalysisCard();

    const resultButtons = await screen.findAllByRole("button", { name: /rows · r2/ });
    await userEvent.click(resultButtons[1]); // result-1: slow
    await userEvent.click(resultButtons[0]); // result-2: fast

    await waitFor(() => expect(screen.getByText("220")).toBeInTheDocument());
    await act(async () => {
      resolveSlow?.(resultDetail("result-1", [["2026-01", 120]]));
      await Promise.resolve();
    });
    expect(screen.queryByText("120")).not.toBeInTheDocument();
  });

  it("compares two selected results and renders the keyed diff", async () => {
    mocks.listResults.mockResolvedValue({
      items: [resultSummary("result-2"), resultSummary("result-1")],
      next_cursor: null,
    });
    mocks.compare.mockResolvedValue({
      left_result_id: "result-1",
      right_result_id: "result-2",
      mode: "keyed",
      key_columns: ["month"],
      reason_code: null,
      reason_detail: null,
      exhaustive: true,
      parameters: { same: true, changed: [] },
      sources: [],
      schema: { same: true, left_only: [], right_only: [], changed_types: [], order_changed: false },
      added: [["2026-02", 220]],
      removed: [],
      changed: [],
      added_total: 1,
      removed_total: 0,
      changed_total: 0,
      truncated: false,
      left_table: {
        columns: ["month", "total"],
        rows: [["2026-01", 120]],
        returned_rows: 1,
        complete: true,
        completeness_reasons: [],
        preview_truncated: false,
      },
      right_table: {
        columns: ["month", "total"],
        rows: [
          ["2026-01", 120],
          ["2026-02", 220],
        ],
        returned_rows: 2,
        complete: true,
        completeness_reasons: [],
        preview_truncated: false,
      },
    });

    render(<AnalysesView />);
    await selectAnalysisCard();

    const checkboxes = await screen.findAllByRole("checkbox");
    await userEvent.click(checkboxes[0]);
    await userEvent.click(checkboxes[1]);
    await userEvent.click(screen.getByRole("button", { name: /Compare selected \(2\/2\)/ }));

    await waitFor(() =>
      expect(mocks.compare).toHaveBeenCalledWith(
        "analysis-1",
        expect.any(String),
        expect.any(String),
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/Keyed on month/)).toBeInTheDocument();
    expect(screen.getByText("220")).toBeInTheDocument();
    expect(screen.getByText(/Added \(1\)/)).toBeInTheDocument();
  });

  it("deletes a result through a busy dialog and never resurrects it", async () => {
    let resolveDelete: ((value: { ok: true }) => void) | null = null;
    mocks.removeResult.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = resolve;
        }),
    );

    render(<AnalysesView />);
    await selectAnalysisCard();

    await userEvent.click(screen.getByRole("button", { name: /Delete result/ }));
    const dialog = screen.getByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.removeResult).toHaveBeenCalled());

    // Busy rule: the dialog cannot be dismissed while the delete is in flight.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => {
      resolveDelete?.({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.queryByText(/rows · r2/)).not.toBeInTheDocument();
  });
});

describe("AnalysesView editor", () => {
  it("keeps the create dialog busy while saving and reports failures inside it", async () => {
    let resolveCreate: ((value: Error) => void) | null = null;
    mocks.create.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          resolveCreate = reject;
        }),
    );

    render(<AnalysesView />);
    await userEvent.click(await screen.findByRole("button", { name: /New analysis/ }, LOAD_TIMEOUT));

    await userEvent.type(screen.getByLabelText("Title"), "Fresh analysis");
    await userEvent.type(screen.getByLabelText(/^SQL/), "SELECT 1");
    await userEvent.click(screen.getByRole("button", { name: "Create analysis" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Saving…/ })).toBeDisabled();
    // The dialog stays mounted while pending, so the failure slot is visible.
    expect(screen.getByLabelText("Title")).toBeInTheDocument();

    await act(async () => {
      resolveCreate?.(new Error("boom"));
      await Promise.resolve();
    });
    expect(await screen.findByText("Could not create the analysis")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("creates from the promotion draft and honours selected-empty scope", async () => {
    mocks.create.mockResolvedValue(analysis({ id: "analysis-9", title: "Promoted" }));
    mocks.list.mockResolvedValue({ items: [catalogItem("analysis-9", "Promoted")], next_cursor: null });
    mocks.get.mockResolvedValue(analysis({ id: "analysis-9", title: "Promoted" }));
    window.sessionStorage.setItem(
      "borealis.analysis-promotion",
      JSON.stringify({ sql: "SELECT sliced FROM receipt /* draft */", stored_at: "2026-01-01T00:00:00.000Z" }),
    );
    window.location.hash = "/analyses?promote=1";

    render(<AnalysesView />);
    expect(await screen.findByText(/Receipt SQL may be a truncated preview/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("SELECT sliced FROM receipt /* draft */")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("borealis.analysis-promotion")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Create analysis" }));
    expect(await screen.findByText("A title and the complete SQL text are required.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Title"), "Promoted");
    await userEvent.click(screen.getByRole("button", { name: "Create analysis" }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    const body = mocks.create.mock.calls[0][0];
    expect(body.title).toBe("Promoted");
    expect(body.sql).toBe("SELECT sliced FROM receipt /* draft */");
    expect(body.source_ids).toEqual([]); // selected-empty stays empty
    expect(body.comparison_key).toBeNull();

    // The editor closes and the promoted analysis opens.
    await waitFor(() => expect(screen.queryByLabelText("Title")).not.toBeInTheDocument());
    expect(await screen.findByText("revision 3")).toBeInTheDocument();
  });

  it("reports a CAS edit conflict inside the open dialog", async () => {
    mocks.update.mockRejectedValue(new Error("ANALYSIS_REVISION_CONFLICT"));

    render(<AnalysesView />);
    await selectAnalysisCard();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    await userEvent.clear(screen.getByLabelText("Title"));
    await userEvent.type(screen.getByLabelText("Title"), "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save edit" }));

    expect(await screen.findByText("Could not save the edit")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Renamed");
  });
});
