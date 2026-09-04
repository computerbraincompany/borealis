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
  accounts: vi.fn(),
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
  api: apiMocks.accounts,
  apiText: apiMocks.apiText,
  formatApiError: (_error: unknown, fallback: string) => fallback,
  openProtected: apiMocks.openProtected,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { ReportsView } from "@/pages/ReportsView";
import { failOnReactActWarning } from "@/test/console";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.list.mockResolvedValue({ items: reports, next_cursor: null });
    apiMocks.chartsList.mockResolvedValue(charts);
    apiMocks.chartsGet.mockResolvedValue({ id: "c1", png_base64: "cG5nLWJ5dGVz" });
    apiMocks.listShared.mockResolvedValue({
      items: [
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
      ],
      next_cursor: null,
    });
    apiMocks.accounts.mockResolvedValue([{ id: "account-2", email: "peer@example.test" }]);
    apiMocks.listShares.mockResolvedValue([]);
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

    await waitFor(() =>
      expect(apiMocks.rename).toHaveBeenCalledWith("r2", "Quarterly review", expect.any(AbortSignal)),
    );
    expect(await screen.findByText("Quarterly review")).toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
  });

  it("keeps a newer rename dialog owned when an older mutation resolves late", async () => {
    const firstRename = deferred<(typeof reports)[number]>();
    apiMocks.rename.mockImplementation((id: string) =>
      id === "r1" ? firstRename.promise : Promise.resolve({ ...reports[1], title: "Second updated" }),
    );
    render(<ReportsView />);

    await screen.findByText("First");
    fireEvent.click(screen.getAllByTitle("Rename report")[0]);
    fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "First updated" } });
    fireEvent.submit(screen.getByLabelText("Report title").closest("form")!);
    await waitFor(() => expect(apiMocks.rename).toHaveBeenCalledWith("r1", "First updated", expect.any(AbortSignal)));
    const firstSignal = apiMocks.rename.mock.calls[0][2] as AbortSignal;

    fireEvent.click(screen.getAllByTitle("Rename report")[1]);
    expect(firstSignal.aborted).toBe(true);
    expect(screen.getByLabelText("Report title")).toHaveValue("Second");

    await act(async () => firstRename.resolve({ ...reports[0], title: "First updated" }));
    expect(screen.getByRole("heading", { name: "Rename report" })).toBeInTheDocument();
    expect(screen.getByLabelText("Report title")).toHaveValue("Second");
    expect(screen.queryByText("First updated")).not.toBeInTheDocument();
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

  it("loads owned and shared reports beyond their first bounded pages", async () => {
    const olderReport = { ...reports[0], id: "r-older", title: "Older owned report" };
    const olderShared = {
      id: "shared-older",
      title: "Older shared report",
      subtitle: null,
      version: 1,
      owner_account_id: "owner-3",
      owner_email: "older@example.test",
      shared_at: "2025-01-03T00:00:00Z",
      created_at: "2025-01-03T00:00:00Z",
    };
    apiMocks.list.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor === "reports-page-2"
        ? Promise.resolve({ items: [olderReport], next_cursor: null })
        : Promise.resolve({ items: reports, next_cursor: "reports-page-2" }),
    );
    apiMocks.listShared.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor === "shared-page-2"
        ? Promise.resolve({ items: [olderShared], next_cursor: null })
        : Promise.resolve({
            items: [
              {
                id: "shared-newer",
                title: "Newer shared report",
                subtitle: null,
                version: 2,
                owner_account_id: "owner-2",
                owner_email: "newer@example.test",
                shared_at: "2026-01-03T00:00:00Z",
                created_at: "2026-01-03T00:00:00Z",
              },
            ],
            next_cursor: "shared-page-2",
          }),
    );
    render(<ReportsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older reports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older shared reports" }));

    expect(await screen.findByText("Older owned report")).toBeInTheDocument();
    expect(await screen.findByText("Older shared report")).toBeInTheDocument();
    expect(apiMocks.list).toHaveBeenCalledWith({ cursor: "reports-page-2" });
    expect(apiMocks.listShared).toHaveBeenCalledWith({ cursor: "shared-page-2" });
  });

  it("restarts completed owned and shared traversals from a refreshed head", async () => {
    const olderReport = { ...reports[0], id: "r-older", title: "Older owned report" };
    const insertedReport = { ...reports[0], id: "r-inserted", title: "Inserted owned report" };
    const sharedBase = {
      id: "shared-head",
      title: "Shared head",
      subtitle: null,
      version: 2,
      owner_account_id: "owner-2",
      owner_email: "newer@example.test",
      shared_at: "2026-01-03T00:00:00Z",
      created_at: "2026-01-03T00:00:00Z",
    };
    const olderShared = { ...sharedBase, id: "shared-older", title: "Older shared report" };
    const insertedShared = { ...sharedBase, id: "shared-inserted", title: "Inserted shared report" };
    let ownedHeadRequests = 0;
    let sharedHeadRequests = 0;
    apiMocks.list.mockImplementation((options?: { cursor?: string }) => {
      if (options?.cursor === "owned-old-page-2") return Promise.resolve({ items: [olderReport], next_cursor: null });
      if (options?.cursor === "owned-fresh-page-2") {
        return Promise.resolve({ items: [insertedReport, olderReport], next_cursor: null });
      }
      ownedHeadRequests += 1;
      return Promise.resolve({
        items: reports,
        next_cursor: ownedHeadRequests === 1 ? "owned-old-page-2" : "owned-fresh-page-2",
      });
    });
    apiMocks.listShared.mockImplementation((options?: { cursor?: string }) => {
      if (options?.cursor === "shared-old-page-2") return Promise.resolve({ items: [olderShared], next_cursor: null });
      if (options?.cursor === "shared-fresh-page-2") {
        return Promise.resolve({ items: [insertedShared, olderShared], next_cursor: null });
      }
      sharedHeadRequests += 1;
      return Promise.resolve({
        items: [sharedBase],
        next_cursor: sharedHeadRequests === 1 ? "shared-old-page-2" : "shared-fresh-page-2",
      });
    });
    render(<ReportsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older reports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older shared reports" }));
    await screen.findByText("Older owned report");
    await screen.findByText("Older shared report");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older reports" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older shared reports" }));

    expect(await screen.findByText("Inserted owned report")).toBeInTheDocument();
    expect(await screen.findByText("Inserted shared report")).toBeInTheDocument();
    expect(screen.getAllByText("Older owned report")).toHaveLength(1);
    expect(screen.getAllByText("Older shared report")).toHaveLength(1);
    expect(apiMocks.list).toHaveBeenCalledWith({ cursor: "owned-fresh-page-2" });
    expect(apiMocks.listShared).toHaveBeenCalledWith({ cursor: "shared-fresh-page-2" });
  });

  it("keeps reports usable when only the chart registry fails", async () => {
    apiMocks.chartsList.mockRejectedValue(new Error("registry unavailable"));
    const warn = vi.spyOn(console, "error").mockImplementation((...args) => failOnReactActWarning(args));
    render(<ReportsView />);

    expect(await screen.findByText("First")).toBeInTheDocument();
    expect(screen.getByText("Could not load the chart gallery")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Charts" })).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it.each(["resolve", "reject"] as const)(
    "blocks a second same-report deletion while the first is pending and settles the %s cleanly",
    async (settlement) => {
      const older = deferred<{ ok: true }>();
      apiMocks.remove.mockReturnValueOnce(older.promise);
      render(<ReportsView />);

      const deleteButton = (await screen.findAllByTitle("Delete report"))[0];
      fireEvent.click(deleteButton);
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledTimes(1));
      // The pending deletion keeps the dialog busy and the row guard closed:
      // a second trigger must not start another request for the same report.
      fireEvent.click(deleteButton);
      expect(apiMocks.remove).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (settlement === "resolve") older.resolve({ ok: true });
        else older.reject(new Error("stale deletion failed"));
      });

      if (settlement === "resolve") {
        await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());
      } else {
        expect(screen.getByText("First")).toBeInTheDocument();
      }
    },
  );

  it("keeps different-report deletions concurrent and aborts all of them on unmount", async () => {
    const first = deferred<{ ok: true }>();
    const second = deferred<{ ok: true }>();
    apiMocks.remove.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { unmount } = render(<ReportsView />);

    const deleteButtons = await screen.findAllByTitle("Delete report");
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(deleteButtons[1]);
    await screen.findByText("Delete “Second”?");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledTimes(2));
    const firstSignal = apiMocks.remove.mock.calls[0][1] as AbortSignal;
    const secondSignal = apiMocks.remove.mock.calls[1][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);
    expect(secondSignal.aborted).toBe(false);

    unmount();
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    await act(async () => {
      first.resolve({ ok: true });
      second.reject(new Error("late deletion failed"));
    });
  });

  it("does not let a stale catalog refresh resurrect a successfully deleted report", async () => {
    render(<ReportsView />);
    await screen.findByText("First");
    const stale = deferred<{ items: typeof reports; next_cursor: null }>();
    apiMocks.list.mockReturnValueOnce(stale.promise);
    apiMocks.remove.mockResolvedValue({ ok: true });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getAllByTitle("Delete report")[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("First")).not.toBeInTheDocument());

    await act(async () => stale.resolve({ items: reports, next_cursor: null }));
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });

  it("keeps sharing state and actions owned by the newest report", async () => {
    const firstShares = deferred<Array<{ recipient_account_id: string; recipient_email: string; shared_at: string }>>();
    const secondShares =
      deferred<Array<{ recipient_account_id: string; recipient_email: string; shared_at: string }>>();
    apiMocks.listShares.mockImplementation((id: string) => (id === "r1" ? firstShares.promise : secondShares.promise));
    render(<ReportsView />);

    const buttons = await screen.findAllByRole("button", { name: "Share" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(apiMocks.listShares).toHaveBeenCalledWith("r1", expect.any(AbortSignal)));
    const firstSignal = apiMocks.listShares.mock.calls[0][1] as AbortSignal;

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(apiMocks.listShares).toHaveBeenCalledWith("r2", expect.any(AbortSignal)));
    expect(firstSignal.aborted).toBe(true);

    await act(async () =>
      secondShares.resolve([
        {
          recipient_account_id: "account-2",
          recipient_email: "peer@example.test",
          shared_at: "2026-01-04T00:00:00Z",
        },
      ]),
    );
    expect(await screen.findByRole("heading", { name: 'Share "Second"' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();

    await act(async () => firstShares.resolve([]));
    expect(screen.getByRole("heading", { name: 'Share "Second"' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });
});
