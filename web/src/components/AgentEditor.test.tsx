import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, type ConnectionDetailDto } from "@/lib/api";

const editorApiMocks = vi.hoisted(() => ({
  skillsList: vi.fn(),
  agentsCreate: vi.fn(),
  agentsUpdate: vi.fn(),
  connectionsList: vi.fn(),
  connectionsGet: vi.fn(),
  librariesList: vi.fn(),
  jobsList: vi.fn(),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    agentsApi: {
      ...actual.agentsApi,
      create: editorApiMocks.agentsCreate,
      update: editorApiMocks.agentsUpdate,
    },
    agentSkillsApi: { ...actual.agentSkillsApi, list: editorApiMocks.skillsList },
    connectionsApi: {
      ...actual.connectionsApi,
      list: editorApiMocks.connectionsList,
      get: editorApiMocks.connectionsGet,
    },
    librariesApi: { ...actual.librariesApi, list: editorApiMocks.librariesList },
    jobsApi: { list: editorApiMocks.jobsList },
  };
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AgentEditor } from "@/components/AgentEditor";

function connection(overrides: Partial<ConnectionDetailDto> = {}): ConnectionDetailDto {
  return {
    id: "conn-1",
    name: "Ops tools",
    kind: "mcp_http",
    revision: 1,
    discovery_revision: 2,
    enabled: true,
    status: "ready",
    status_code: null,
    config: { kind: "mcp_http", url: "https://ops.example.test/mcp" },
    credential_state: "none",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    tools: [{ tool_id: "tool-search", name: "search_docs", description: "Search tickets", input_schema: {} }],
    ...overrides,
  };
}

function fillIdentity() {
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Ops agent" } });
  fireEvent.change(screen.getByLabelText("Agent instructions"), { target: { value: "Triage tickets." } });
}

describe("AgentEditor connected tools and job setup", () => {
  beforeEach(() => {
    Object.values(editorApiMocks).forEach((mock) => mock.mockReset());
    editorApiMocks.skillsList.mockResolvedValue({ items: [] });
    editorApiMocks.connectionsList.mockResolvedValue({
      items: [connection(), connection({ id: "conn-off", name: "Retired", enabled: false, discovery_revision: 0 })],
      next_cursor: null,
    });
    editorApiMocks.connectionsGet.mockResolvedValue(connection());
    editorApiMocks.librariesList.mockResolvedValue({
      items: [{ id: "lib-a", name: "Finance library", member_count: 3 }],
      next_cursor: null,
    });
    editorApiMocks.jobsList.mockResolvedValue([]);
    editorApiMocks.agentsCreate.mockResolvedValue({ id: "agent-new", name: "Ops agent" });
  });

  it("binds only enabled published connections with their discovery revision", async () => {
    const user = userEvent.setup();
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);
    fillIdentity();
    await user.click(await screen.findByRole("tab", { name: "Connected" }));

    expect(await screen.findByRole("checkbox", { name: "Select connected tool search_docs" })).toBeEnabled();
    // The disabled/unpublished connection is filtered before detail loading.
    expect(editorApiMocks.connectionsGet).toHaveBeenCalledTimes(1);
    expect(editorApiMocks.connectionsGet).toHaveBeenCalledWith("conn-1", expect.anything());
    fireEvent.click(screen.getByRole("checkbox", { name: "Select connected tool search_docs" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(editorApiMocks.agentsCreate).toHaveBeenCalled());
    const configuration = editorApiMocks.agentsCreate.mock.calls[0][2];
    expect(configuration.mcp_tools).toEqual([
      { connection_id: "conn-1", tool_id: "tool-search", discovery_revision: 2 },
    ]);
  });

  it("offers the writing allowance only after the server flags a tool write-oriented", async () => {
    const user = userEvent.setup();
    editorApiMocks.connectionsGet.mockResolvedValue(
      connection({
        tools: [
          { tool_id: "tool-search", name: "search_docs", description: "Search tickets", input_schema: {} },
          { tool_id: "tool-send", name: "send_email", description: "Send mail", input_schema: {} },
        ],
      }),
    );
    editorApiMocks.agentsCreate
      .mockRejectedValueOnce(
        new ApiError(400, 'The connected tool "send_email" looks write-oriented and needs the writing allowance.'),
      )
      .mockResolvedValueOnce({ id: "agent-new" });
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);
    fillIdentity();
    await user.click(await screen.findByRole("tab", { name: "Connected" }));
    await screen.findByRole("checkbox", { name: "Select connected tool send_email" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Select connected tool search_docs" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select connected tool send_email" }));
    // Default-deny: no allow checkbox exists before the server says why.
    expect(screen.queryByRole("checkbox", { name: "Allow writing for connected tool send_email" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/write-oriented/i);

    // The flagged tool is now visibly write-oriented with the explicit
    // acknowledgement affordance; the unflagged one never gets one.
    expect(
      await screen.findByRole("checkbox", { name: "Allow writing for connected tool send_email" }),
    ).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Allow writing for connected tool search_docs" })).toBeNull();
    expect(screen.getAllByText("write-oriented").length).toBe(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "Allow writing for connected tool send_email" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(editorApiMocks.agentsCreate).toHaveBeenCalledTimes(2));
    const configuration = editorApiMocks.agentsCreate.mock.calls[1][2];
    const sendBinding = configuration.mcp_tools.find((binding: { tool_id: string }) => binding.tool_id === "tool-send");
    expect(sendBinding).toEqual(
      expect.objectContaining({ connection_id: "conn-1", discovery_revision: 2, allow_write: true }),
    );
    const searchBinding = configuration.mcp_tools.find(
      (binding: { tool_id: string }) => binding.tool_id === "tool-search",
    );
    expect(searchBinding).not.toHaveProperty("allow_write");
  });

  it("drops and visibly refuses a tool whose schema the workspace rejects", async () => {
    const user = userEvent.setup();
    editorApiMocks.connectionsGet.mockResolvedValue(
      connection({
        tools: [{ tool_id: "tool-weird", name: "weird_tool", description: "Odd", input_schema: {} }],
      }),
    );
    editorApiMocks.agentsCreate
      .mockRejectedValueOnce(
        new ApiError(400, 'The connected tool "weird_tool" uses a schema this workspace refuses to execute.'),
      )
      .mockResolvedValueOnce({ id: "agent-new" });
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);
    fillIdentity();
    await user.click(await screen.findByRole("tab", { name: "Connected" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select connected tool weird_tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/refuses to execute/i);
    const checkbox = (await screen.findByRole("checkbox", {
      name: "Select connected tool weird_tool",
    })) as HTMLInputElement;
    expect(checkbox).toBeDisabled();
    expect(checkbox.checked).toBe(false);
    expect(await screen.findByText(/Unsupported schema/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(editorApiMocks.agentsCreate).toHaveBeenCalledTimes(2));
    expect(editorApiMocks.agentsCreate.mock.calls[1][2].mcp_tools).toEqual([]);
  });

  it("caps the connected-tool selection at sixteen", async () => {
    const user = userEvent.setup();
    editorApiMocks.connectionsGet.mockResolvedValue(
      connection({
        tools: Array.from({ length: 17 }, (_unused, index) => ({
          tool_id: `tool-${index}`,
          name: `tool_${index}`,
          description: "",
          input_schema: {},
        })),
      }),
    );
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);
    fillIdentity();
    await user.click(await screen.findByRole("tab", { name: "Connected" }));
    await screen.findByRole("checkbox", { name: "Select connected tool tool_0" });

    for (let index = 0; index < 16; index += 1) {
      const box = screen.getByRole("checkbox", { name: `Select connected tool tool_${index}` });
      expect(box).toBeEnabled();
      fireEvent.click(box);
    }
    expect(screen.getByRole("checkbox", { name: "Select connected tool tool_16" })).toBeDisabled();
    expect(screen.getByText(/16 of 16 connected tools selected/i)).toBeInTheDocument();
  });

  it("normalizes the job setup on save and blocks an empty enabled template", async () => {
    const user = userEvent.setup();
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);
    fillIdentity();
    await user.click(await screen.findByRole("tab", { name: "Job" }));

    fireEvent.click(screen.getByRole("button", { name: /Add prompt/i }));
    fireEvent.change(screen.getByLabelText("Starter prompt 1"), { target: { value: "Analyze spend" } });
    fireEvent.click(screen.getByRole("button", { name: /Add prompt/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Apply an output template" }));

    // An enabled-but-empty template blocks the save with a visible reason.
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(editorApiMocks.agentsCreate).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Output template instruction"), {
      target: { value: "End with a one-page summary." },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Suggest library Finance library" }));
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => expect(editorApiMocks.agentsCreate).toHaveBeenCalled());
    const setup = editorApiMocks.agentsCreate.mock.calls[0][2].job_setup;
    // The blank second prompt never ships.
    expect(setup.starter_prompts).toEqual(["Analyze spend"]);
    expect(setup.output_template).toEqual({ kind: "instruction", instruction: "End with a one-page summary." });
    expect(setup.library_ids).toEqual(["lib-a"]);
  });

  it("seeds a new agent from a bundled editable starter job", async () => {
    const user = userEvent.setup();
    editorApiMocks.jobsList.mockResolvedValue([
      {
        id: "finance-analysis",
        name: "Finance analysis",
        description: "Personal finance review",
        icon: "chart",
        color: "blue",
        instructions: "You are a careful personal-finance analyst.",
        tools: ["retrieve", "query_data"],
        job_setup: { starter_prompts: ["Summarize my spending"], output_template: null, library_ids: [] },
      },
    ]);
    render(<AgentEditor onClose={() => undefined} onSaved={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: "Start from the Finance analysis job" }));
    expect(screen.getByLabelText("Agent name")).toHaveValue("Finance analysis");
    expect(screen.getByLabelText("Agent instructions")).toHaveValue("You are a careful personal-finance analyst.");
    // Everything remains editable and the setup lands in the Job tab.
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "My finance analyst" } });
    await user.click(screen.getByRole("tab", { name: "Job" }));
    expect(screen.getByLabelText("Starter prompt 1")).toHaveValue("Summarize my spending");
  });
});
