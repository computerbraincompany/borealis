import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { connectionsApi, type ConnectionDetailDto, type ConnectionDto } from "@/lib/api";
import { hasDesktopSignInLinkBridge, openDesktopSignInLink } from "@/lib/desktopBootstrap";

vi.mock("@/lib/desktopBootstrap", () => ({
  hasDesktopSignInLinkBridge: vi.fn(() => false),
  openDesktopSignInLink: vi.fn(async () => true),
}));

import { ConnectionsPanel } from "@/components/ConnectionsPanel";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function connectionRow(overrides: Partial<ConnectionDto> = {}): ConnectionDto {
  return {
    id: "conn-1",
    name: "Ops tools",
    kind: "mcp_http",
    revision: 3,
    discovery_revision: 0,
    enabled: true,
    status: "untested",
    status_code: null,
    config: { kind: "mcp_http", url: "https://mcp.example.test/mcp" },
    credential_state: "none",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function detailRow(overrides: Partial<ConnectionDetailDto> = {}): ConnectionDetailDto {
  return { ...connectionRow(), tools: [], ...overrides };
}

describe("ConnectionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasDesktopSignInLinkBridge).mockReturnValue(false);
    vi.spyOn(connectionsApi, "list").mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    vi.spyOn(connectionsApi, "get").mockResolvedValue(detailRow());
    vi.spyOn(connectionsApi, "create").mockResolvedValue(detailRow());
    vi.spyOn(connectionsApi, "update").mockResolvedValue(detailRow());
    vi.spyOn(connectionsApi, "test").mockResolvedValue(connectionRow({ status: "ready" }));
    vi.spyOn(connectionsApi, "discover").mockResolvedValue(detailRow({ discovery_revision: 1 }));
    vi.spyOn(connectionsApi, "authorize").mockResolvedValue({
      authorize_url: "https://idp.example.test/authorize?session=one",
      expires_at: new Date(Date.now() + 120_000).toISOString(),
      desktop_open_token: "open-intent-token",
    });
    vi.spyOn(connectionsApi, "revoke").mockResolvedValue(connectionRow({ credential_state: "none" }));
    vi.spyOn(connectionsApi, "remove").mockResolvedValue({ ok: true });
  });

  it("renders the catalog with status badges, endpoint summary, and credential copy", async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue({
      items: [
        connectionRow({
          id: "conn-t",
          name: "Timed out server",
          status: "error",
          status_code: "CONNECTION_TIMEOUT",
          credential_state: "stored",
        }),
      ],
      next_cursor: null,
    });
    render(<ConnectionsPanel />);

    expect(await screen.findByText("Timed out server")).toBeInTheDocument();
    expect(screen.getByText("Timed out — check the endpoint")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.example.test/mcp")).toBeInTheDocument();
    expect(screen.getByText(/Stored securely — never shown again/)).toBeInTheDocument();
  });

  it("creates a connection through a strict form and never echoes the secret back", async () => {
    render(<ConnectionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Add connection/i }));

    fireEvent.change(await screen.findByLabelText("Connection name"), { target: { value: "Ops tools" } });
    fireEvent.change(screen.getByLabelText("Connection endpoint URL"), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid URL/i);

    fireEvent.change(screen.getByLabelText("Connection endpoint URL"), {
      target: { value: "https://mcp.example.test/mcp" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /Add entry/i })[0]);
    fireEvent.change(screen.getByLabelText(/name 1/i), { target: { value: "authorization" } });
    fireEvent.change(screen.getByLabelText(/value 1/i), { target: { value: "Bearer s3cr3t-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() =>
      expect(connectionsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Ops tools",
          kind: "mcp_http",
          config: { url: "https://mcp.example.test/mcp" },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(vi.mocked(connectionsApi.create).mock.calls[0][0].credentials).toEqual(
      expect.objectContaining({ headers: { authorization: "Bearer s3cr3t-value" } }),
    );
    // Neither the DOM nor any row ever carries the credential value.
    expect(document.body.textContent).not.toContain("s3cr3t-value");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("blocks dismissal and reports busy while a create commit is in flight", async () => {
    const onBusyChange = vi.fn();
    const pending = deferred<ConnectionDetailDto>();
    vi.spyOn(connectionsApi, "create").mockReturnValue(pending.promise);
    render(<ConnectionsPanel onBusyChange={onBusyChange} />);

    fireEvent.click(await screen.findByRole("button", { name: /Add connection/i }));
    fireEvent.change(await screen.findByLabelText("Connection name"), { target: { value: "Pending" } });
    fireEvent.change(screen.getByLabelText("Connection endpoint URL"), {
      target: { value: "https://pending.example.test/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));

    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(true));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    // The commit button stays disabled and visibly in flight.
    const saving = screen.getByRole("button", { name: /Saving/i });
    expect(saving).toBeDisabled();

    await act(async () => pending.resolve(detailRow()));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("sends only changed fields with the expected revision when editing", async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue({ items: [connectionRow()], next_cursor: null });
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit Ops tools" }));
    fireEvent.change(await screen.findByLabelText("Connection name"), { target: { value: "Ops primary" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(connectionsApi.update).toHaveBeenCalled());
    const patch = vi.mocked(connectionsApi.update).mock.calls[0][1];
    expect(patch).toEqual(expect.objectContaining({ name: "Ops primary", expected_revision: 3 }));
    // Unchanged fields are never resent: they would bump the revision and
    // reset the bounded status evidence server-side.
    expect(patch).not.toHaveProperty("config");
    expect(patch).not.toHaveProperty("credentials");
  });

  it("renders exactly one clickable sign-in link in the browser and never opens it", async () => {
    render(<ConnectionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    const links = await screen.findAllByText("https://idp.example.test/authorize?session=one");
    expect(links.length).toBe(1);
    const anchor = document.querySelector('a[href="https://idp.example.test/authorize?session=one"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
    // No auto-open machinery runs without a click.
    expect(openDesktopSignInLink).not.toHaveBeenCalled();
  });

  it("opens the sign-in link only through main with the one-time token on desktop", async () => {
    vi.mocked(hasDesktopSignInLinkBridge).mockReturnValue(true);
    vi.mocked(openDesktopSignInLink).mockClear();
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    const button = await screen.findByRole("button", { name: /Open in system browser/i });
    // Presenting the link is not opening it: main is only invoked on the click.
    expect(openDesktopSignInLink).not.toHaveBeenCalled();
    expect(document.querySelector("a[href*='idp.example.test']")).toBeNull();

    fireEvent.click(button);
    await waitFor(() =>
      expect(openDesktopSignInLink).toHaveBeenCalledWith(
        "open-intent-token",
        "https://idp.example.test/authorize?session=one",
      ),
    );
  });

  it("keeps the delete confirmation busy and clears it when the delete completes", async () => {
    const pending = deferred<{ ok: true }>();
    vi.spyOn(connectionsApi, "remove").mockReturnValue(pending.promise);
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Ops tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(connectionsApi.remove).toHaveBeenCalledWith("conn-1", expect.any(AbortSignal)));
    // The dialog cannot be dismissed while the commit is in flight.
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeDisabled();

    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(screen.queryByText("Ops tools")).not.toBeInTheDocument());
  });

  it("surfaces a delete failure after the dialog closes", async () => {
    vi.spyOn(connectionsApi, "remove").mockRejectedValue(new Error("nope"));
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Ops tools" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be deleted/i);
    expect(screen.getByText("Ops tools")).toBeInTheDocument();
  });

  it("gates tools and sign-in on enablement and toggles the row with its revision", async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue({
      items: [connectionRow({ id: "conn-off", name: "Sleepy", enabled: false })],
      next_cursor: null,
    });
    render(<ConnectionsPanel />);

    expect(await screen.findByRole("button", { name: "Test" })).toBeDisabled();
    // Sign-in is offered only for enabled HTTP connections.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Enable Sleepy" }));
    await waitFor(() =>
      expect(connectionsApi.update).toHaveBeenCalledWith(
        "conn-off",
        { enabled: true, expected_revision: 3 },
        expect.any(AbortSignal),
      ),
    );
  });

  it("revokes stored credentials with a targeted call", async () => {
    vi.mocked(connectionsApi.list).mockResolvedValue({
      items: [connectionRow({ credential_state: "stored" })],
      next_cursor: null,
    });
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(connectionsApi.revoke).toHaveBeenCalledWith("conn-1", expect.any(AbortSignal)));
  });

  it("shows the sign-in expiry and never renders a second link", async () => {
    render(<ConnectionsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    await screen.findByText(/never opens it for you/i);
    const anchors = document.querySelectorAll('a[href*="idp.example.test"]');
    expect(anchors.length).toBe(1);
    expect(anchors[0]).toHaveAttribute("href", "https://idp.example.test/authorize?session=one");
  });
});
