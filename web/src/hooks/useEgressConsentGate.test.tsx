import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  acknowledge: vi.fn(),
  isRemoteEgressConsentError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  consentApi: { get: apiMocks.get, acknowledge: apiMocks.acknowledge },
  isRemoteEgressConsentError: apiMocks.isRemoteEgressConsentError,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { useEgressConsentGate } from "@/hooks/useEgressConsentGate";

const remoteState = {
  required: true,
  acknowledged_at: null,
  endpoint_host: "api.provider.example",
};

function Harness({ failure, onRetry }: { failure: unknown; onRetry: () => void }) {
  const { handleConsentError, dialog } = useEgressConsentGate();
  return (
    <div>
      <button type="button" onClick={() => handleConsentError(failure, onRetry)}>
        fail
      </button>
      {dialog}
    </div>
  );
}

describe("useEgressConsentGate", () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.acknowledge.mockReset();
    apiMocks.isRemoteEgressConsentError.mockReset();
  });

  it("leaves unrelated failures to the caller's error path", () => {
    apiMocks.isRemoteEgressConsentError.mockReturnValue(false);
    const onRetry = vi.fn();
    render(<Harness failure={new Error("boom")} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "fail" }));

    expect(screen.queryByText("Some data would leave this Mac")).not.toBeInTheDocument();
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it("shows the destination and payload classes, then acknowledges and retries the blocked action", async () => {
    apiMocks.isRemoteEgressConsentError.mockReturnValue(true);
    apiMocks.get.mockResolvedValue(remoteState);
    apiMocks.acknowledge.mockResolvedValue({ ...remoteState, acknowledged_at: "2026-08-29T00:00:00Z" });
    const onRetry = vi.fn();
    render(<Harness failure={new Error("consent required")} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "fail" }));
    expect(await screen.findByText("Some data would leave this Mac")).toBeInTheDocument();
    expect(screen.getByText("api.provider.example")).toBeInTheDocument();
    expect(screen.getByText(/upload and ingestion text, prompts, chat history/i)).toBeInTheDocument();
    const settingsLink = screen.getByRole("link", { name: /Open Settings/i });
    expect(settingsLink).toHaveAttribute("href", "#/settings");

    fireEvent.click(screen.getByRole("button", { name: "Acknowledge and continue" }));

    await waitFor(() => expect(apiMocks.acknowledge).toHaveBeenCalledOnce());
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("Some data would leave this Mac")).not.toBeInTheDocument());
  });

  it("closes without retrying when the user cancels", async () => {
    apiMocks.isRemoteEgressConsentError.mockReturnValue(true);
    apiMocks.get.mockResolvedValue(remoteState);
    const onRetry = vi.fn();
    render(<Harness failure={new Error("consent required")} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "fail" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByText("Some data would leave this Mac")).not.toBeInTheDocument());
    expect(apiMocks.acknowledge).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
