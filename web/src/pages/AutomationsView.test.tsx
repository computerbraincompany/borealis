import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runs: vi.fn(),
  connectorsList: vi.fn(),
  chatsList: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  automationsApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    update: apiMocks.update,
    remove: apiMocks.remove,
    runs: apiMocks.runs,
  },
  connectorsApi: { list: apiMocks.connectorsList },
  chatsApi: { list: apiMocks.chatsList },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AutomationsView } from "@/pages/AutomationsView";

const automation = {
  id: "auto-1",
  name: "Nightly ledger",
  kind: "connector_sync" as const,
  target_id: "conn-1",
  prompt: null,
  schedule_minutes: 60,
  state: "active" as const,
  consecutive_failures: 0,
  last_run_at: null,
  next_run_at: "2026-01-02T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AutomationsView", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.list.mockResolvedValue([automation]);
    apiMocks.connectorsList.mockResolvedValue([{ id: "conn-1", name: "Ledger feed" }]);
    apiMocks.chatsList.mockResolvedValue([{ id: "chat-1", title: "Digest chat" }]);
    apiMocks.runs.mockResolvedValue([
      {
        id: 1,
        outcome: "failed",
        detail: "the automation could not complete this run",
        started_at: "2026-01-02T00:00:00Z",
        finished_at: null,
      },
    ]);
  });

  it("lists automations with kind and schedule", async () => {
    render(<AutomationsView />);

    expect(await screen.findByText("Nightly ledger")).toBeInTheDocument();
    expect(screen.getByText("connector refresh")).toBeInTheDocument();
    expect(screen.getByText("every 60 min")).toBeInTheDocument();
  });

  it("creates a connector-refresh automation", async () => {
    apiMocks.create.mockResolvedValue({ ...automation, id: "auto-2", name: "Weekly sync" });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Weekly sync" } });
    fireEvent.change(screen.getByLabelText("Automation kind"), { target: { value: "connector_sync" } });
    fireEvent.change(screen.getByLabelText("Automation target"), { target: { value: "conn-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith({
        name: "Weekly sync",
        kind: "connector_sync",
        target_id: "conn-1",
        schedule_minutes: 60,
      }),
    );
  });

  it("shows durable run history with generic failure details", async () => {
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/the automation could not complete this run/)).toBeInTheDocument();
  });

  it("pauses and resumes an automation", async () => {
    apiMocks.update.mockResolvedValue({ ...automation, state: "paused" });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByTitle("Pause automation"));
    await waitFor(() => expect(apiMocks.update).toHaveBeenCalledWith("auto-1", { state: "paused" }));
  });

  it("deletes an automation", async () => {
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByTitle("Delete automation"));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("auto-1"));
    await waitFor(() => expect(screen.queryByText("Nightly ledger")).not.toBeInTheDocument());
  });
});
