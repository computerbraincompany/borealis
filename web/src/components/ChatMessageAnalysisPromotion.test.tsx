import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  fromQuery: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    analysesApi: { ...actual.analysesApi, fromQuery: mocks.fromQuery },
  };
});

vi.mock("@/components/ChartCard", () => ({
  ChartCard: () => <div>chart</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { ChatMessage } from "@/components/ChatMessage";
import { parseQueryResultArtifacts, type QueryResultArtifact } from "@/lib/api";

const CAPTURE_ID = "11111111-1111-4111-8111-111111111111";

function artifact(overrides: Partial<QueryResultArtifact> = {}): QueryResultArtifact {
  return {
    id: "query-1",
    sql: "SELECT month, SUM(amount) FROM ledger GROUP BY month",
    columns: ["month", "total"],
    rows: [["2026-01", 120]],
    row_count: 1,
    truncated: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  window.location.hash = "";
});

describe("parseQueryResultArtifacts — capture affordance", () => {
  it("keeps capture_id only alongside an explicit can_save_analysis flag and a valid UUID", () => {
    const [verified] = parseQueryResultArtifacts([{ ...artifact(), capture_id: CAPTURE_ID, can_save_analysis: true }]);
    expect(verified.capture_id).toBe(CAPTURE_ID);
    expect(verified.can_save_analysis).toBe(true);

    const [legacy] = parseQueryResultArtifacts([{ ...artifact(), capture_id: "not-a-uuid", can_save_analysis: true }]);
    expect(legacy.capture_id).toBeUndefined();
    expect(legacy.can_save_analysis).toBeUndefined();

    const [unflagged] = parseQueryResultArtifacts([{ ...artifact(), capture_id: CAPTURE_ID }]);
    expect(unflagged.capture_id).toBeUndefined();
  });
});

describe("ChatMessage analysis promotion affordance", () => {
  it("offers direct promotion for a verified capture and saves with a chosen title", async () => {
    mocks.fromQuery.mockResolvedValue({ id: "analysis-1" });
    render(
      <ChatMessage
        role="assistant"
        content="Done."
        queryResults={[artifact({ capture_id: CAPTURE_ID, can_save_analysis: true })]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save query as analysis" }));
    await userEvent.type(screen.getByLabelText("Analysis title"), "Monthly totals");
    await userEvent.click(screen.getByRole("button", { name: "Save analysis" }));

    await waitFor(() => expect(mocks.fromQuery).toHaveBeenCalledWith(CAPTURE_ID, "Monthly totals", expect.anything()));
    expect(await screen.findByRole("link", { name: /Saved — open in Analyses/ })).toHaveAttribute("href", "#/analyses");
  });

  it("shows promotion failures inside the dialog and keeps it open", async () => {
    mocks.fromQuery.mockRejectedValue(new Error("boom"));
    render(
      <ChatMessage
        role="assistant"
        content="Done."
        queryResults={[artifact({ capture_id: CAPTURE_ID, can_save_analysis: true })]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save query as analysis" }));
    await userEvent.type(screen.getByLabelText("Analysis title"), "Broken");
    await userEvent.click(screen.getByRole("button", { name: "Save analysis" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save this query as an analysis");
    expect(screen.getByLabelText("Analysis title")).toBeInTheDocument();
  });

  it("sends no verified button for legacy receipts and hands the editor a draft instead", async () => {
    render(<ChatMessage role="assistant" content="Done." queryResults={[artifact()]} />);

    expect(screen.queryByRole("button", { name: "Save query as analysis" })).not.toBeInTheDocument();
    const legacy = screen.getByRole("button", { name: "Save as analysis (requires complete SQL)" });
    await userEvent.click(legacy);

    expect(window.location.hash.replace(/^#/, "")).toBe("/analyses?promote=1");
    const stash = JSON.parse(window.sessionStorage.getItem("borealis.analysis-promotion") || "null");
    expect(stash.sql).toBe(artifact().sql);
  });

  it("abandons an in-flight promotion on unmount without acting on the response", async () => {
    let resolveSave: ((value: unknown) => void) | null = null;
    mocks.fromQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const view = render(
      <ChatMessage
        role="assistant"
        content="Done."
        queryResults={[artifact({ capture_id: CAPTURE_ID, can_save_analysis: true })]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save query as analysis" }));
    await userEvent.type(screen.getByLabelText("Analysis title"), "Late");
    await userEvent.click(screen.getByRole("button", { name: "Save analysis" }));
    await waitFor(() => expect(mocks.fromQuery).toHaveBeenCalled());

    act(() => {
      view.unmount();
      resolveSave?.({ id: "late" });
    });
    await act(async () => {
      await Promise.resolve();
    });
    // No act warnings: the late resolution found a closed target.
    expect(screen.queryByRole("link", { name: /Saved/ })).not.toBeInTheDocument();
  });
});
