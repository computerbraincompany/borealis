import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, connectorsApi, type Connector } from "@/lib/api";
import { ConnectorsView } from "@/pages/ConnectorsView";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const connector = (sync_status: Connector["sync_status"]): Connector => ({
  id: "connector-1",
  name: "Ledger",
  type: "url_csv",
  config: { url: "https://example.test/data.csv" },
  target_table: "ledger",
  sync_status,
  sync_error: sync_status === "error" ? "Connector indexing failed." : null,
  last_sync: null,
  created_at: "2026-01-01T00:00:00Z",
  schedule: null,
});
const page = (items: Connector[], next_cursor: string | null = null) => ({ items, next_cursor });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const schedule = (overrides: Partial<NonNullable<Connector["schedule"]>> = {}): NonNullable<Connector["schedule"]> => ({
  automation_id: "auto-1",
  schedule_minutes: 60,
  state: "active",
  next_run_at: "2026-01-02T00:00:00Z",
  last_run_at: null,
  ...overrides,
});

describe("ConnectorsView status controls", () => {
  it.each(["syncing", "indexing"] as const)("renders %s and blocks duplicate sync/delete actions", async (status) => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([connector(status)]));
    const sync = vi.spyOn(connectorsApi, "sync");
    const remove = vi.spyOn(connectorsApi, "remove");

    render(<ConnectorsView />);
    const syncButton = await screen.findByRole("button", { name: "Syncing…" });
    const deleteButton = screen.getByRole("button", { name: "Delete Ledger" });

    expect(screen.getByText(status)).toBeInTheDocument();
    expect(syncButton).toBeDisabled();
    expect(deleteButton).toBeDisabled();
    fireEvent.click(syncButton);
    fireEvent.click(deleteButton);
    expect(sync).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("renders the terminal error returned by the typed status contract", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([connector("error")]));
    render(<ConnectorsView />);

    expect(await screen.findByText("Connector indexing failed.")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  it("marks a summary-only manual sync as transitional before reconciliation", async () => {
    const refreshed = deferred<ReturnType<typeof page>>();
    vi.spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([connector("idle")]))
      .mockReturnValueOnce(refreshed.promise);
    vi.spyOn(connectorsApi, "sync").mockResolvedValue({ synced: true, processing: true });

    render(<ConnectorsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("button", { name: "Syncing…" })).toBeDisabled();
    refreshed.resolve(page([connector("idle")]));
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
  });
});

describe("ConnectorsView schedule control", () => {
  it("renders the current schedule value and next run", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([{ ...connector("idle"), schedule: schedule() }]));
    render(<ConnectorsView />);

    const select = await screen.findByLabelText("Refresh schedule for Ledger");
    expect(select).toHaveValue("60");
    expect(screen.getByRole("option", { name: "Hourly" })).toBeInTheDocument();
    expect(screen.getByText(/^next /)).toBeInTheDocument();
  });

  it("flags a paused schedule", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(
      page([{ ...connector("idle"), schedule: schedule({ state: "paused", next_run_at: null }) }]),
    );
    render(<ConnectorsView />);

    expect(await screen.findByText("paused")).toBeInTheDocument();
  });

  it("sends the chosen interval and updates state from the response", async () => {
    const scheduled = { ...connector("idle"), schedule: schedule() };
    const updated = { ...connector("idle"), schedule: schedule({ schedule_minutes: 15 }) };
    vi.spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([scheduled]))
      .mockResolvedValue(page([updated]));
    const update = vi.spyOn(connectorsApi, "updateConnectorSchedule").mockResolvedValue(updated);

    render(<ConnectorsView />);
    const select = await screen.findByLabelText("Refresh schedule for Ledger");
    fireEvent.change(select, { target: { value: "15" } });

    await waitFor(() => expect(update).toHaveBeenCalledWith("connector-1", 15));
    await waitFor(() => expect(select).toHaveValue("15"));
  });

  it("removes the schedule when Off is selected", async () => {
    const scheduled = { ...connector("idle"), schedule: schedule({ schedule_minutes: 15 }) };
    const cleared = { ...connector("idle"), schedule: null };
    vi.spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([scheduled]))
      .mockResolvedValue(page([cleared]));
    const update = vi.spyOn(connectorsApi, "updateConnectorSchedule").mockResolvedValue(cleared);

    render(<ConnectorsView />);
    const select = await screen.findByLabelText("Refresh schedule for Ledger");
    fireEvent.change(select, { target: { value: "off" } });

    await waitFor(() => expect(update).toHaveBeenCalledWith("connector-1", null));
    await waitFor(() => expect(select).toHaveValue("off"));
  });

  it("surfaces a schedule conflict inline and keeps the previous value", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([{ ...connector("idle"), schedule: schedule() }]));
    vi.spyOn(connectorsApi, "updateConnectorSchedule").mockRejectedValue(
      new ApiError(409, "Multiple connector refresh automations target this connector. Clean them up in Automations."),
    );

    render(<ConnectorsView />);
    fireEvent.change(await screen.findByLabelText("Refresh schedule for Ledger"), { target: { value: "15" } });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Multiple connector refresh automations target this connector. Clean them up in Automations.",
    );
    expect(screen.getByLabelText("Refresh schedule for Ledger")).toHaveValue("60");
  });
});

describe("ConnectorsView sync history", () => {
  it("opens the dialog and renders recorded syncs newest first", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([connector("idle")]));
    vi.spyOn(connectorsApi, "listConnectorSyncs").mockResolvedValue([
      {
        id: 2,
        trigger: "manual",
        outcome: "failed",
        detail: "the connector could not be refreshed",
        started_at: "2026-01-02T00:00:00Z",
        finished_at: "2026-01-02T00:00:05Z",
      },
      {
        id: 1,
        trigger: "create",
        outcome: "succeeded",
        detail: null,
        started_at: "2026-01-01T00:00:00Z",
        finished_at: "2026-01-01T00:00:05Z",
      },
    ]);

    render(<ConnectorsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync history" }));

    expect(await screen.findByText("manual")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByText("create")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("the connector could not be refreshed")).toBeInTheDocument();
    expect(screen.getByLabelText("Connector syncs")).toBeInTheDocument();
  });

  it("shows the empty state when no syncs are recorded", async () => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue(page([connector("idle")]));
    vi.spyOn(connectorsApi, "listConnectorSyncs").mockResolvedValue([]);

    render(<ConnectorsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync history" }));

    expect(await screen.findByText("No syncs yet.")).toBeInTheDocument();
  });
});

describe("ConnectorsView create dialog", () => {
  it("creates a connector when the Connect button is clicked with a valid draft", async () => {
    const created: Connector = { ...connector("idle"), id: "connector-2", name: "Ledger feed" };
    const create = vi.spyOn(connectorsApi, "create").mockResolvedValue(created);
    vi.spyOn(connectorsApi, "list")
      .mockResolvedValueOnce(page([]))
      .mockResolvedValue(page([created]));

    render(<ConnectorsView />);
    fireEvent.click(await screen.findByRole("button", { name: /New connector/i }));

    fireEvent.change(screen.getByLabelText("Dataset URL"), { target: { value: "https://example.test/data.csv" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ledger feed" } });
    fireEvent.change(screen.getByLabelText("DuckDB table"), { target: { value: "ledger_feed" } });
    // The footer submit button must stay associated with the form: a mouse
    // click on "Connect" has to reach create(), not just Enter in a field.
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        display_name: "Ledger feed",
        target_table: "ledger_feed",
        type: "url_csv",
        config: { url: "https://example.test/data.csv" },
      }),
    );
    expect(await screen.findByText("Ledger feed")).toBeInTheDocument();
  });
});
