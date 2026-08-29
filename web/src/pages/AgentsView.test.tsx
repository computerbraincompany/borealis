import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  agentsApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    get: apiMocks.get,
    update: apiMocks.update,
    remove: apiMocks.remove,
  },
  MAX_AGENT_INSTRUCTION_CHARS: 8_000,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AgentsView } from "@/pages/AgentsView";

const agent = {
  id: "agent-1",
  name: "Finance analyst",
  current_version: 2,
  instructions: "Reconcile totals first. Open with the executive summary.",
  instructions_chars: 62,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

describe("AgentsView", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.list.mockResolvedValue([agent]);
    apiMocks.get.mockResolvedValue({
      ...agent,
      revisions: [
        { version: 2, instructions: agent.instructions, created_at: "2026-01-02T00:00:00Z" },
        { version: 1, instructions: "Reconcile totals first.", created_at: "2026-01-01T00:00:00Z" },
      ],
    });
  });

  it("lists agents with version and instruction preview", async () => {
    render(<AgentsView />);

    expect(await screen.findByText("Finance analyst")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText(/Reconcile totals first/)).toBeInTheDocument();
  });

  it("creates an agent with name and instructions", async () => {
    apiMocks.create.mockResolvedValue({ ...agent, id: "agent-2", name: "Diligence" });
    render(<AgentsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New agent/i }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Diligence" } });
    fireEvent.change(screen.getByLabelText("Agent instructions"), {
      target: { value: "Ground every claim in the data room." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith("Diligence", "Ground every claim in the data room."),
    );
  });

  it("creates a new immutable revision on revise", async () => {
    apiMocks.update.mockResolvedValue({ ...agent, current_version: 3 });
    render(<AgentsView />);

    fireEvent.click(await screen.findByTitle("Revision history"));
    expect(await screen.findByText("v1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Revise/i }));
    const input = screen.getByLabelText("Agent instructions");
    fireEvent.change(input, { target: { value: "Always open with the executive summary." } });
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));

    await waitFor(() =>
      expect(apiMocks.update).toHaveBeenCalledWith("agent-1", {
        instructions: "Always open with the executive summary.",
      }),
    );
  });

  it("deletes an agent and notes that bound chats continue unbound", async () => {
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<AgentsView />);

    fireEvent.click(await screen.findByTitle("Delete agent"));

    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("agent-1"));
    await waitFor(() => expect(screen.queryByText("Finance analyst")).not.toBeInTheDocument());
  });
});
