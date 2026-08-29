import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  listShared: vi.fn(),
  listShares: vi.fn(),
  share: vi.fn(),
  revoke: vi.fn(),
  chartsList: vi.fn(),
  chartsGet: vi.fn(),
  apiText: vi.fn(),
  openProtected: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  reportsApi: {
    list: apiMocks.list,
    remove: apiMocks.remove,
    rename: apiMocks.rename,
    listShared: apiMocks.listShared,
    listShares: apiMocks.listShares,
    share: apiMocks.share,
    revoke: apiMocks.revoke,
  },
  chartsApi: { list: apiMocks.chartsList, get: apiMocks.chartsGet },
  apiText: apiMocks.apiText,
  formatApiError: (_error: unknown, fallback: string) => fallback,
  openProtected: apiMocks.openProtected,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { ReportsView } from "@/pages/ReportsView";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const reports = [
  {
    id: "r1",
    title: "First",
    subtitle: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    chat_title: null,
    chat_id: null,
    version: 1,
    supersedes: null,
  },
  {
    id: "r2",
    title: "Second",
    subtitle: null,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    chat_title: null,
    chat_id: null,
    version: 2,
    supersedes: "r1",
  },
];

const charts = [
  {
    id: "c1",
    run_id: "run1",
    chat_id: "chat1",
    title: "Monthly spend",
    kind: "bar",
    created_at: "2026-01-02T00:00:00Z",
  },
];

describe("ReportsView preview", () => {
  beforeEach(() => {
    apiMocks.list.mockResolvedValue(reports);
    apiMocks.chartsList.mockResolvedValue(charts);
    apiMocks.chartsGet.mockResolvedValue({ id: "c1", png_base64: "cG5nLWJ5dGVz" });
    apiMocks.listShared.mockResolvedValue([
      {
        id: "shared-1",
        title: "Diligence snapshot",
        subtitle: null,
        version: 2,
        owner_account_id: "owner-2",
        owner_email: "peer@example.test",
        shared_at: "2026-01-03T00:00:00Z",
        created_at: "2026-01-03T00:00:00Z",
      },
    ]);
  });

  it("aborts and ignores a stale request while using a script-only opaque sandbox", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    apiMocks.apiText.mockImplementation((path: string) => (path.includes("r1") ? first.promise : second.promise));

    const { unmount } = render(<ReportsView />);
    await screen.findByText("First");
    const previewButtons = screen.getAllByRole("button", { name: /Preview/i });

    fireEvent.click(previewButtons[0]);
    await waitFor(() => expect(apiMocks.apiText).toHaveBeenCalledTimes(1));
    const firstSignal = apiMocks.apiText.mock.calls[0][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    fireEvent.click(previewButtons[1]);
    await waitFor(() => expect(apiMocks.apiText).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    await act(async () => second.resolve("<h1>Second report</h1>"));
    const frame = await screen.findByTitle("Report preview");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame).toHaveAttribute("srcdoc", "<h1>Second report</h1>");

    await act(async () => first.resolve("<h1>Stale first report</h1>"));
    expect(frame).toHaveAttribute("srcdoc", "<h1>Second report</h1>");

    const secondSignal = apiMocks.apiText.mock.calls[1][1] as AbortSignal;
    unmount();
    expect(secondSignal.aborted).toBe(true);
  });

  it("shows version badges with a working supersedes link", async () => {
    apiMocks.apiText.mockResolvedValue("<h1>First report</h1>");
    render(<ReportsView />);

    await screen.findByText("First");
    expect(screen.getAllByText("v1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "supersedes v1" }));
    await waitFor(() => expect(apiMocks.apiText).toHaveBeenCalledWith("/api/reports/r1/html", expect.anything()));
    expect(await screen.findByTitle("Report preview")).toBeInTheDocument();
  });

  it("renames a report through the dialog and applies the saved title", async () => {
    const user = userEvent.setup();
    apiMocks.rename.mockResolvedValue({ ...reports[1], title: "Quarterly review" });
    render(<ReportsView />);

    await screen.findByText("Second");
    fireEvent.click(screen.getAllByTitle("Rename report")[1]);
    const input = screen.getByLabelText("Report title");
    expect(input).toHaveValue("Second");
    await user.clear(input);
    await user.type(input, "Quarterly review");
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(apiMocks.rename).toHaveBeenCalledWith("r2", "Quarterly review"));
    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
  });

  it("renders the chart gallery from the registry with embedded thumbnails", async () => {
    render(<ReportsView />);

    expect(await screen.findByRole("heading", { name: "Charts" })).toBeInTheDocument();
    expect(screen.getByText("Monthly spend")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
    const chatLink = screen.getByRole("link", { name: /source chat/i });
    expect(chatLink).toHaveAttribute("href", "#/chat/chat1");
    await waitFor(() =>
      expect(screen.getByAltText("Chart Monthly spend")).toHaveAttribute("src", "data:image/png;base64,cG5nLWJ5dGVz"),
    );
  });

  it("renders read-only snapshots shared by another workspace account", async () => {
    render(<ReportsView />);

    expect(await screen.findByRole("heading", { name: "Shared with me" })).toBeInTheDocument();
    expect(screen.getByText("Diligence snapshot")).toBeInTheDocument();
    expect(screen.getByText(/peer@example.test/)).toBeInTheDocument();
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0);
  });

  it("keeps reports usable when only the chart registry fails", async () => {
    apiMocks.chartsList.mockRejectedValue(new Error("registry unavailable"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ReportsView />);

    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByText("Could not load the chart gallery")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Charts" })).not.toBeInTheDocument();
    warn.mockRestore();
  });
});
