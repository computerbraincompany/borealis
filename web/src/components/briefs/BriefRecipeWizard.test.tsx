import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  analysesList: vi.fn(),
  analysesGet: vi.fn(),
  briefsCreate: vi.fn(),
  briefsPreview: vi.fn(),
  sourcesList: vi.fn(),
  connectorsList: vi.fn(),
  knowledgeList: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (error: unknown, fallback: string) =>
    error instanceof Error && error.name === "ApiError" ? error.message : fallback,
  analysesApi: { list: apiMocks.analysesList, get: apiMocks.analysesGet },
  briefsApi: { create: apiMocks.briefsCreate, previewSchedule: apiMocks.briefsPreview },
  sourcesApi: { list: apiMocks.sourcesList },
  connectorsApi: { list: apiMocks.connectorsList },
  knowledgeApi: { list: apiMocks.knowledgeList },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { BriefRecipeWizard } from "@/components/briefs/BriefRecipeWizard";

// Journey-F regression fixtures. The catalog summary DTO carries the nullable
// runtime shape (`active_run: null`) that once crashed the wizard with
// "Cannot read properties of null (reading 'parameters')", and its
// `current_revision`/`source_count` deliberately DISAGREE with the detail DTO:
// every rendered value must come from the fetched definition revision.
const summaryItem = {
  id: "analysis-1",
  title: "Monthly spend",
  description: "",
  current_revision: 2,
  source_count: 1,
  unavailable_source_count: 0,
  active_run: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const revisionDetail = {
  id: "analysis-1",
  current_revision: 3,
  title: "Monthly spend",
  description: "",
  sql: "SELECT ?",
  parameters: [
    { name: "label", type: "string", required: true, nullable: false, default: "total", label: "Metric label" },
    { name: "threshold", type: "integer", required: false, nullable: true },
  ],
  source_ids: ["src-a", "src-b"],
  comparison_key: null,
  origin: { chat_id: null, run_id: null, capture_id: null },
  revision_created_at: "2026-09-02T00:00:00Z",
  sources: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  active_run: null,
};

const sources = [
  {
    id: "src-a",
    name: "ledger.csv",
    display_name: "ledger.csv",
    kind: "tabular",
    mime: "text/csv",
    status: "ready",
    created_at: "2026-09-01T00:00:00Z",
    meta: null,
  },
  {
    id: "src-b",
    name: "credits.csv",
    display_name: "credits.csv",
    kind: "tabular",
    mime: "text/csv",
    status: "ready",
    created_at: "2026-09-01T00:00:00Z",
    meta: null,
  },
];

function apiError(message: string, status = 503) {
  const error = new Error(message) as Error & { name: string; status: number };
  error.name = "ApiError";
  error.status = status;
  return error;
}

async function renderWizard(onClose = vi.fn()) {
  const onSaved = vi.fn();
  render(<BriefRecipeWizard recipe={null} handleConsentError={() => false} onClose={onClose} onSaved={onSaved} />);
  // Drain the four catalog loads inside act so their state flushes are never
  // attributed to an unwrapped update.
  await act(async () => undefined);
  return { onClose, onSaved };
}

async function selectAnalysis() {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Saved analysis"), { target: { value: "analysis-1" } });
  });
}

describe("BriefRecipeWizard (create path)", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.analysesList.mockResolvedValue({ items: [summaryItem], next_cursor: null });
    apiMocks.analysesGet.mockResolvedValue(revisionDetail);
    apiMocks.briefsPreview.mockResolvedValue({
      next_occurrences: [1, 2, 3].map((n) => ({
        occurrence_key: `2026-09-${n}T09:00`,
        civil: `2026-09-${n}T09:00`,
        utc_at: `2026-09-0${n}T07:00:00.000Z`,
      })),
    });
    apiMocks.briefsCreate.mockResolvedValue({ id: "brief-1", name: "Monday brief" });
    apiMocks.sourcesList.mockResolvedValue({ items: sources, next_cursor: null });
    apiMocks.connectorsList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.knowledgeList.mockResolvedValue({ items: [], next_cursor: null });
  });

  it("discards an older preview while a changed schedule is pending, and retries failures", async () => {
    await renderWizard();
    await selectAnalysis();
    fireEvent.change(screen.getByLabelText("Brief name"), { target: { value: "Preview brief" } });
    let resolveOld!: (value: unknown) => void;
    let rejectNew!: (reason: unknown) => void;
    apiMocks.briefsPreview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText("Hour (0-23)"), { target: { value: "10" } });
    const oldSignal = apiMocks.briefsPreview.mock.calls.at(-1)![1] as AbortSignal;
    apiMocks.briefsPreview.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectNew = reject;
        }),
    );
    fireEvent.change(screen.getByLabelText("Hour (0-23)"), { target: { value: "11" } });
    expect(oldSignal.aborted).toBe(true);
    const button = screen.getByRole("button", { name: "Create brief" });
    expect(button).toBeDisabled();
    await act(async () =>
      resolveOld({
        next_occurrences: [1, 2, 3].map((n) => ({ occurrence_key: `old-${n}`, civil: `OLD ${n}`, utc_at: `OLD ${n}` })),
      }),
    );
    expect(screen.queryByText("OLD 1")).not.toBeInTheDocument();
    expect(button).toBeDisabled();
    await act(async () => rejectNew(apiError("Preview unavailable")));
    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry schedule preview" }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(apiMocks.briefsPreview.mock.calls.at(-1)![0].hour).toBe(11);
  });

  it("derives typed parameter inputs and the membership mirror from the fetched revision, not the active_run:null summary", async () => {
    await renderWizard();
    expect(await screen.findByRole("option", { name: "Monthly spend (rev 2)" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Brief name"), { target: { value: "Monday brief" } });
    await selectAnalysis();

    // The pinned revision shown is the DETAIL's (3), never the summary's (2).
    expect(await screen.findByText(/pinned to definition revision/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();

    // Typed inputs render from the revision declarations (no crash on the
    // active_run:null payloads), seeded from declaration defaults only.
    expect(screen.getByLabelText("Parameter label")).toHaveValue("total");
    // Empty number input → valueAsNumber null: no declaration default seeds it.
    expect(screen.getByLabelText("Parameter threshold")).toHaveValue(null);

    // Membership mirrors the revision's exact selected set (two sources),
    // never the summary's source_count.
    const ledger = screen.getByRole("checkbox", { name: "Source ledger.csv" });
    const credits = screen.getByRole("checkbox", { name: "Source credits.csv" });
    expect(ledger).toBeChecked();
    expect(ledger).toBeDisabled();
    expect(credits).toBeChecked();
    expect(credits).toBeDisabled();
  });

  it("surfaces a failed revision fetch in-dialog with a retry affordance and keeps create closed until it loads", async () => {
    apiMocks.analysesGet.mockRejectedValueOnce(apiError("the analysis service is unavailable"));
    const { onClose, onSaved } = await renderWizard();
    await screen.findByRole("option", { name: "Monthly spend (rev 2)" });
    fireEvent.change(screen.getByLabelText("Brief name"), { target: { value: "Monday brief" } });
    await selectAnalysis();

    // The failure stays inside the open dialog; nothing closes and nothing
    // wedges: create is gated, an alert names the failure, and a retry exists.
    expect(await screen.findByRole("alert")).toHaveTextContent("the analysis service is unavailable");
    expect(screen.getByRole("heading", { name: "New reviewed brief" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create brief" })).toBeDisabled();
    expect(screen.queryByText("Parameter label")).not.toBeInTheDocument();

    // Retry re-loads the revision: the error clears, typed inputs render, and
    // create becomes submittable with the revision-derived payload.
    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "Monday summary" } });
    fireEvent.change(screen.getByLabelText("Draft instruction"), { target: { value: "Sum it up." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry loading the saved analysis" }));
    });

    expect(screen.getByLabelText("Parameter label")).toHaveValue("total");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const createButton = screen.getByRole("button", { name: "Create brief" });
    expect(createButton).toBeEnabled();
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(apiMocks.briefsCreate).toHaveBeenCalledTimes(1);
    const [body] = apiMocks.briefsCreate.mock.calls[0];
    expect(body.source_ids).toEqual(["src-a", "src-b"]);
    expect(body.parameter_values).toEqual({ label: "total" });
    // The create call submits the values derived from the fetched (pinned)
    // revision; the server pins that revision id at write.
    expect(body.analysis_id).toBe("analysis-1");
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("treats a null-schema revision detail as a failed fetch instead of dereferencing it", async () => {
    apiMocks.analysesGet.mockResolvedValueOnce(null as never);
    const { onClose } = await renderWizard();
    await screen.findByRole("option", { name: "Monthly spend (rev 2)" });
    fireEvent.change(screen.getByLabelText("Brief name"), { target: { value: "Monday brief" } });
    await selectAnalysis();

    // Exactly the journey-F crash signature ("Cannot read properties of null
    // (reading 'parameters')") must never reach the render tree: the wizard
    // fails closed to the retryable error state instead.
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the saved analysis");
    expect(screen.getByRole("heading", { name: "New reviewed brief" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create brief" })).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry loading the saved analysis" }));
    });
    expect(screen.getByLabelText("Parameter label")).toHaveValue("total");
    expect(screen.getByRole("button", { name: "Create brief" })).toBeEnabled();
  });
});
