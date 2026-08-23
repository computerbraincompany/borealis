import { fireEvent, render, screen } from "@testing-library/react";
import { connectorsApi, type Connector } from "@/lib/api";
import { ConnectorsView } from "@/pages/ConnectorsView";

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
});

describe("ConnectorsView status controls", () => {
  it.each(["syncing", "indexing"] as const)("renders %s and blocks duplicate sync/delete actions", async (status) => {
    vi.spyOn(connectorsApi, "list").mockResolvedValue([connector(status)]);
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
    vi.spyOn(connectorsApi, "list").mockResolvedValue([connector("error")]);
    render(<ConnectorsView />);

    expect(await screen.findByText("Connector indexing failed.")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });
});
