import { render, screen } from "@testing-library/react";

const useWorkspaceStatus = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useWorkspaceStatus", () => ({
  useWorkspaceStatus,
}));

import { WorkspaceStatus } from "@/components/WorkspaceStatus";

function mockStatus(overrides: Partial<Parameters<typeof useWorkspaceStatus>[0]> = {}) {
  useWorkspaceStatus.mockReturnValue({ status: null, checking: true, error: null, refresh: vi.fn(), ...overrides });
}

const localStatus = {
  locality: "local" as const,
  endpoint_reachable: true,
  lm_studio_reachable: null,
  chat_model: "qwen3-32b",
  embed_model: "bge-m3",
  contained: null,
  checked_at: "2026-08-29T10:00:00.000Z",
  latency_ms: 12,
};

describe("WorkspaceStatus", () => {
  it("renders a neutral checking state before the first snapshot", () => {
    mockStatus();
    render(<WorkspaceStatus />);

    expect(screen.getByLabelText("Model locality and health")).toBeInTheDocument();
    expect(screen.getByText("Checking locality…")).toBeInTheDocument();
    expect(screen.getByText("Checking endpoint…")).toBeInTheDocument();
    expect(screen.queryByText(/data leaves this Mac/i)).not.toBeInTheDocument();
  });

  it("presents the local machine state with model presence", () => {
    mockStatus({ status: localStatus, checking: false });
    render(<WorkspaceStatus />);

    expect(screen.getByText("On this Mac")).toBeInTheDocument();
    expect(screen.getByText("Endpoint reachable · 12 ms")).toBeInTheDocument();
    expect(screen.getByTitle("Chat qwen3-32b · Embed bge-m3")).toBeInTheDocument();
    expect(screen.queryByText(/data leaves this Mac/i)).not.toBeInTheDocument();
  });

  it("discloses egress and links to Settings for a remote provider", () => {
    mockStatus({ status: { ...localStatus, locality: "remote" }, checking: false });
    render(<WorkspaceStatus />);

    expect(screen.getByText("Remote provider")).toBeInTheDocument();
    const disclosure = screen.getByText(/Some data leaves this Mac\./);
    const link = screen.getByRole("link", { name: "See Settings" });
    expect(link).toHaveAttribute("href", "#/settings");
    expect(disclosure.closest("p")).toHaveAttribute(
      "title",
      expect.stringContaining(
        "The upload and ingestion text, prompts, chat history, retrieval queries, and selected tool context",
      ),
    );
  });

  it("keeps the shell standing when the status surface fails", () => {
    mockStatus({ status: null, checking: false, error: "Workspace status is temporarily unavailable." });
    render(<WorkspaceStatus />);

    expect(screen.getByText("Checking locality…")).toBeInTheDocument();
    expect(screen.getByText("Endpoint status unavailable")).toBeInTheDocument();
  });

  it("shows the contained engine state when healthy", () => {
    mockStatus({
      status: {
        ...localStatus,
        contained: {
          state: "healthy",
          model: "qwen3-8b.gguf",
          endpoint_host: "127.0.0.1:51129",
          endpoint_managed_by_env: false,
        },
      },
      checking: false,
    });
    render(<WorkspaceStatus />);

    expect(screen.getByText("On this Mac · contained")).toBeInTheDocument();
    expect(screen.getByTitle("Contained model qwen3-8b.gguf")).toBeInTheDocument();
  });

  it("names the environment stand-down when the engine cannot switch the endpoint", () => {
    mockStatus({
      status: {
        ...localStatus,
        contained: {
          state: "healthy",
          model: "qwen3-8b.gguf",
          endpoint_host: "127.0.0.1:51129",
          endpoint_managed_by_env: true,
        },
      },
      checking: false,
    });
    render(<WorkspaceStatus />);

    expect(screen.getByText("On this Mac · contained")).toBeInTheDocument();
    expect(screen.getByTitle(/endpoint is managed by an environment override/)).toBeInTheDocument();
  });

  it("marks an unreachable endpoint without pretending it is healthy", () => {
    mockStatus({ status: { ...localStatus, endpoint_reachable: false }, checking: false });
    render(<WorkspaceStatus />);

    expect(screen.getByText("Endpoint unreachable")).toBeInTheDocument();
  });
});
