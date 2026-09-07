import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  rename: vi.fn(),
  setMembers: vi.fn(),
  remove: vi.fn(),
  sourcesList: vi.fn(),
  chatsCreate: vi.fn(),
  search: vi.fn(),
  passage: vi.fn(),
  knowledgeList: vi.fn(),
  knowledgeCreate: vi.fn(),
  knowledgeUpdate: vi.fn(),
  knowledgeRemove: vi.fn(),
  createPreview: vi.fn(),
  getPreview: vi.fn(),
  applyPreview: vi.fn(),
  startRefresh: vi.fn(),
  listRefreshes: vi.fn(),
  getRefresh: vi.fn(),
  cancelRefresh: vi.fn(),
  chooseFolder: vi.fn(),
}));

const bridgeFlags = vi.hoisted(() => ({ desktop: false }));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  isRemoteEgressConsentError: (error: unknown) =>
    Boolean(error && typeof error === "object" && (error as { __consent?: boolean }).__consent),
  librariesApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    get: apiMocks.get,
    rename: apiMocks.rename,
    setMembers: apiMocks.setMembers,
    remove: apiMocks.remove,
    search: apiMocks.search,
  },
  sourcesApi: { list: apiMocks.sourcesList, passage: apiMocks.passage },
  chatsApi: { create: apiMocks.chatsCreate },
  knowledgeApi: {
    list: apiMocks.knowledgeList,
    create: apiMocks.knowledgeCreate,
    update: apiMocks.knowledgeUpdate,
    remove: apiMocks.knowledgeRemove,
    createPreview: apiMocks.createPreview,
    getPreview: apiMocks.getPreview,
    applyPreview: apiMocks.applyPreview,
    startRefresh: apiMocks.startRefresh,
    listRefreshes: apiMocks.listRefreshes,
    getRefresh: apiMocks.getRefresh,
    cancelRefresh: apiMocks.cancelRefresh,
  },
  MAX_LIBRARY_MEMBERS: 100,
}));

vi.mock("@/lib/desktopBootstrap", () => ({
  hasFolderPickerBridge: () => bridgeFlags.desktop,
  chooseDesktopFolder: apiMocks.chooseFolder,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? (
      <div>
        {children}
        <button type="button" aria-label="Close dialog" onClick={() => onOpenChange?.(false)} />
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { LibrariesView } from "@/pages/LibrariesView";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const libraries = [
  {
    id: "lib1",
    name: "Finance data room",
    member_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
];

const detail = {
  ...libraries[0],
  members: [
    { id: "s1", name: "ledger", display_name: "ledger.csv", status: "ready" },
    { id: "s2", name: "memo", display_name: "memo.pdf", status: "ready" },
  ],
};

describe("LibrariesView", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    window.location.hash = "";
    bridgeFlags.desktop = false;
    apiMocks.knowledgeList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.listRefreshes.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.chooseFolder.mockResolvedValue({ cancelled: true });
    apiMocks.list.mockResolvedValue({ items: libraries, next_cursor: null });
    apiMocks.get.mockResolvedValue(detail);
    apiMocks.sourcesList.mockResolvedValue({
      items: [
        { id: "s1", name: "ledger", display_name: "ledger.csv", status: "ready" },
        { id: "s3", name: "extra", display_name: "extra.csv", status: "ready" },
      ],
      next_cursor: null,
    });
  });

  it("lists libraries with member counts and creates one", async () => {
    apiMocks.create.mockResolvedValue({ ...libraries[0], id: "lib2", name: "Diligence" });
    apiMocks.list.mockResolvedValueOnce({ items: libraries, next_cursor: null }).mockResolvedValue({
      items: [
        ...libraries,
        {
          id: "lib2",
          name: "Diligence",
          member_count: 0,
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
        },
      ],
      next_cursor: null,
    });
    render(<LibrariesView />);

    expect(await screen.findByText("Finance data room")).toBeInTheDocument();
    expect(screen.getByText("2 members")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New library/i }));
    const input = screen.getByLabelText("Library name");
    fireEvent.change(input, { target: { value: "Diligence" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith("Diligence", expect.any(AbortSignal)));
    expect(await screen.findByText("Diligence")).toBeInTheDocument();
  });

  it("reconciles the authoritative catalog after create supersedes an unresolved initial load", async () => {
    const initial = deferred<{ items: typeof libraries; next_cursor: null }>();
    const created = { ...libraries[0], id: "lib2", name: "Diligence", member_count: 0 };
    apiMocks.list
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce({ items: [created, ...libraries], next_cursor: null });
    apiMocks.create.mockResolvedValue(created);
    render(<LibrariesView />);

    fireEvent.click(screen.getByRole("button", { name: /New library/i }));
    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Diligence" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Diligence")).toBeInTheDocument();
    expect(screen.getByText("Finance data room")).toBeInTheDocument();
    await act(async () => initial.resolve({ items: libraries, next_cursor: null }));
    expect(screen.getByText("Diligence")).toBeInTheDocument();
    expect(screen.getByText("Finance data room")).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "holds the create dialog open until the in-flight request settles as %s",
    async (settlement) => {
      const pending = deferred<(typeof libraries)[number]>();
      apiMocks.create.mockReturnValue(pending.promise);
      render(<LibrariesView />);

      fireEvent.click(await screen.findByRole("button", { name: /New library/i }));
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "First library" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(1));
      expect(apiMocks.create.mock.calls[0][0]).toBe("First library");
      expect(apiMocks.create.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

      // Mid-flight the dialog cannot be dismissed: a committed library must
      // never be left invisible, so both dismiss controls stay disabled.
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("heading", { name: "New library" })).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          pending.resolve({ ...libraries[0], id: "lib2", name: "First library" });
        } else {
          pending.reject(new Error("create failed"));
        }
      });

      if (settlement === "resolve") {
        await waitFor(() => expect(screen.queryByRole("heading", { name: "New library" })).not.toBeInTheDocument());
        expect(screen.getByText("First library")).toBeInTheDocument();
      } else {
        // The failure is kept inside the still-open dialog, never silent.
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "New library" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      }
    },
  );

  it("aborts and invalidates a pending create when unmounted", async () => {
    const pending = deferred<(typeof libraries)[number]>();
    apiMocks.create.mockReturnValue(pending.promise);
    const { unmount } = render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: /New library/i }));
    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Unmounted library" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(1));
    const signal = apiMocks.create.mock.calls[0][1] as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ ...libraries[0], id: "lib-late", name: "Unmounted library" }));
  });

  it("loads libraries beyond the first bounded page", async () => {
    const older = { ...libraries[0], id: "lib-older", name: "Archive room" };
    apiMocks.list.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor === "libraries-page-2"
        ? Promise.resolve({ items: [older], next_cursor: null })
        : Promise.resolve({ items: libraries, next_cursor: "libraries-page-2" }),
    );
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older libraries" }));

    expect(await screen.findByText("Archive room")).toBeInTheDocument();
    expect(apiMocks.list).toHaveBeenCalledWith({ cursor: "libraries-page-2" });
  });

  it("keeps a refreshed continuation after the earlier library traversal completed", async () => {
    const older = { ...libraries[0], id: "lib-older", name: "Archive room" };
    const inserted = { ...libraries[0], id: "lib-inserted", name: "Inserted room" };
    let headRequests = 0;
    apiMocks.list.mockImplementation((options?: { cursor?: string }) => {
      if (options?.cursor === "old-page-2") return Promise.resolve({ items: [older], next_cursor: null });
      if (options?.cursor === "fresh-page-2") {
        return Promise.resolve({ items: [inserted, older], next_cursor: null });
      }
      headRequests += 1;
      return Promise.resolve({
        items: libraries,
        next_cursor: headRequests === 1 ? "old-page-2" : "fresh-page-2",
      });
    });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Load older libraries" }));
    expect(await screen.findByText("Archive room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older libraries" }));

    expect(await screen.findByText("Inserted room")).toBeInTheDocument();
    expect(screen.getAllByText("Archive room")).toHaveLength(1);
    expect(apiMocks.list).toHaveBeenCalledWith({ cursor: "fresh-page-2" });
  });

  it("manages members through exact-set replacement", async () => {
    apiMocks.setMembers.mockResolvedValue({ ok: true });
    apiMocks.get.mockResolvedValueOnce(detail).mockResolvedValue({
      ...detail,
      members: [...detail.members, { id: "s3", name: "extra", display_name: "extra.csv", status: "ready" }],
    });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    await screen.findByText("ledger.csv");

    const select = screen.getByLabelText("Add a source to this library");
    fireEvent.change(select, { target: { value: "s3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(apiMocks.setMembers).toHaveBeenCalledWith("lib1", ["s1", "s2", "s3"], expect.any(AbortSignal)),
    );

    fireEvent.click(await screen.findByTitle("Remove ledger.csv"));
    await waitFor(() =>
      expect(apiMocks.setMembers).toHaveBeenCalledWith("lib1", ["s2", "s3"], expect.any(AbortSignal)),
    );
  });

  it("reaches older sources in the library member picker", async () => {
    apiMocks.sourcesList.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor === "sources-page-2"
        ? Promise.resolve({
            items: [{ id: "s4", name: "archive", display_name: "archive.csv", status: "ready" }],
            next_cursor: null,
          })
        : Promise.resolve({
            items: [{ id: "s1", name: "ledger", display_name: "ledger.csv", status: "ready" }],
            next_cursor: "sources-page-2",
          }),
    );
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older sources" }));

    expect(await screen.findByRole("option", { name: "archive.csv" })).toBeInTheDocument();
    expect(apiMocks.sourcesList).toHaveBeenCalledWith({
      cursor: "sources-page-2",
      signal: expect.any(AbortSignal),
    });
  });

  it("ignores a library detail response after a newer target opens", async () => {
    const older = deferred<typeof detail>();
    const newer = deferred<typeof detail>();
    const secondLibrary = { ...libraries[0], id: "lib2", name: "Diligence room" };
    apiMocks.list.mockResolvedValue({ items: [libraries[0], secondLibrary], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) => (id === "lib1" ? older.promise : newer.promise));
    apiMocks.sourcesList.mockResolvedValue({ items: [], next_cursor: null });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("lib1", expect.any(AbortSignal)));
    const olderSignal = apiMocks.get.mock.calls[0][1] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Diligence room" }));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("lib2", expect.any(AbortSignal)));
    expect(olderSignal.aborted).toBe(true);

    await act(async () =>
      newer.resolve({
        ...detail,
        id: "lib2",
        name: "Diligence room",
        members: [{ id: "s3", name: "diligence", display_name: "diligence.csv", status: "ready" }],
      }),
    );
    expect(await screen.findByText("diligence.csv")).toBeInTheDocument();

    await act(async () => older.resolve(detail));
    expect(screen.queryByText("ledger.csv")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Diligence room" })).toBeInTheDocument();
  });

  it("aborts an older source page when a different library opens", async () => {
    const olderPage = deferred<{
      items: Array<{ id: string; name: string; display_name: string; status: string }>;
      next_cursor: null;
    }>();
    const secondLibrary = { ...libraries[0], id: "lib2", name: "Diligence room", member_count: 0 };
    apiMocks.list.mockResolvedValue({ items: [libraries[0], secondLibrary], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) =>
      Promise.resolve(id === "lib1" ? detail : { ...secondLibrary, members: [] }),
    );
    apiMocks.sourcesList
      .mockResolvedValueOnce({
        items: [{ id: "s1", name: "ledger", display_name: "ledger.csv", status: "ready" }],
        next_cursor: "sources-page-2",
      })
      .mockImplementationOnce(() => olderPage.promise)
      .mockResolvedValueOnce({
        items: [{ id: "s9", name: "diligence", display_name: "diligence.csv", status: "ready" }],
        next_cursor: null,
      });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older sources" }));
    await waitFor(() => expect(apiMocks.sourcesList).toHaveBeenCalledTimes(2));
    const olderSignal = apiMocks.sourcesList.mock.calls[1][0].signal as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Diligence room" }));
    expect(await screen.findByRole("option", { name: "diligence.csv" })).toBeInTheDocument();
    expect(olderSignal.aborted).toBe(true);

    await act(async () =>
      olderPage.resolve({
        items: [{ id: "s4", name: "archive", display_name: "archive.csv", status: "ready" }],
        next_cursor: null,
      }),
    );
    expect(screen.queryByRole("option", { name: "archive.csv" })).not.toBeInTheDocument();
  });

  it("holds the rename dialog open until the in-flight rename settles, then updates every surface it owns", async () => {
    const firstRename = deferred<(typeof libraries)[number]>();
    apiMocks.list.mockResolvedValue({ items: [libraries[0]], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) => Promise.resolve(id === "lib1" ? detail : { ...detail, id }));
    apiMocks.rename.mockReturnValue(firstRename.promise);
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Finance archive" } });
    fireEvent.submit(screen.getByLabelText("Library name").closest("form")!);
    await waitFor(() =>
      expect(apiMocks.rename).toHaveBeenCalledWith("lib1", "Finance archive", expect.any(AbortSignal)),
    );

    // Mid-flight the dialog cannot be dismissed, so the settling response
    // always lands in the surface that owns it — never silently dropped.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Rename library" })).toBeInTheDocument();

    await act(async () => firstRename.resolve({ ...libraries[0], name: "Finance archive" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rename library" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Finance archive" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Finance archive" })).toBeInTheDocument();
  });

  it("attaches ready members to a new chat by explicit expansion", async () => {
    apiMocks.chatsCreate.mockResolvedValue({ id: "chat9" });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Attach to new chat/i }));

    await waitFor(() =>
      expect(apiMocks.chatsCreate).toHaveBeenCalledWith(
        undefined,
        {
          source_mode: "selected",
          source_ids: ["s1", "s2"],
        },
        undefined,
        expect.any(AbortSignal),
      ),
    );
    expect(window.location.hash).toBe("#/chat/chat9");
  });

  it("aborts a pending attach and ignores its error when the library dialog closes", async () => {
    const pending = deferred<{ id: string }>();
    apiMocks.chatsCreate.mockReturnValue(pending.promise);
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Attach to new chat/i }));
    await waitFor(() => expect(apiMocks.chatsCreate).toHaveBeenCalledTimes(1));
    const signal = apiMocks.chatsCreate.mock.calls[0][3] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error("stale attach failed")));

    expect(screen.queryByRole("heading", { name: "Finance data room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("keeps attach navigation and busy state owned by the newest library target", async () => {
    const older = deferred<{ id: string }>();
    const newer = deferred<{ id: string }>();
    const secondLibrary = { ...libraries[0], id: "lib2", name: "Diligence room", member_count: 1 };
    apiMocks.list.mockResolvedValue({ items: [libraries[0], secondLibrary], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) =>
      Promise.resolve(
        id === "lib1"
          ? detail
          : {
              ...secondLibrary,
              members: [{ id: "s3", name: "diligence", display_name: "diligence.csv", status: "ready" }],
            },
      ),
    );
    apiMocks.chatsCreate.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Attach to new chat/i }));
    await waitFor(() => expect(apiMocks.chatsCreate).toHaveBeenCalledTimes(1));
    const olderSignal = apiMocks.chatsCreate.mock.calls[0][3] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Diligence room" }));
    expect(olderSignal.aborted).toBe(true);
    expect(await screen.findByText("diligence.csv")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Attach to new chat/i }));
    await waitFor(() => expect(apiMocks.chatsCreate).toHaveBeenCalledTimes(2));
    expect(apiMocks.chatsCreate.mock.calls[1]).toEqual([
      undefined,
      { source_mode: "selected", source_ids: ["s3"] },
      undefined,
      expect.any(AbortSignal),
    ]);

    await act(async () => older.resolve({ id: "chat-stale" }));
    expect(window.location.hash).toBe("");
    expect(screen.getByRole("heading", { name: "Diligence room" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Attach to new chat/i })).toBeDisabled();

    await act(async () => newer.resolve({ id: "chat-new" }));
    expect(window.location.hash).toBe("#/chat/chat-new");
  });

  it("suppresses repeated attach attempts while one request owns the target", async () => {
    const pending = deferred<{ id: string }>();
    apiMocks.chatsCreate.mockReturnValue(pending.promise);
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    const attachButton = await screen.findByRole("button", { name: /Attach to new chat/i });
    fireEvent.click(attachButton);
    fireEvent.click(attachButton);

    await waitFor(() => expect(apiMocks.chatsCreate).toHaveBeenCalledTimes(1));
    expect(attachButton).toBeDisabled();
    await act(async () => pending.resolve({ id: "chat-once" }));
    expect(window.location.hash).toBe("#/chat/chat-once");
  });

  it("aborts and invalidates a pending attach when unmounted", async () => {
    const pending = deferred<{ id: string }>();
    apiMocks.chatsCreate.mockReturnValue(pending.promise);
    const { unmount } = render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Attach to new chat/i }));
    await waitFor(() => expect(apiMocks.chatsCreate).toHaveBeenCalledTimes(1));
    const signal = apiMocks.chatsCreate.mock.calls[0][3] as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ id: "chat-late" }));
    expect(window.location.hash).toBe("");
  });

  it("deletes the library without deleting its sources", async () => {
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByTitle("Delete library"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("lib1", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText("Finance data room")).not.toBeInTheDocument());
  });

  it("does not let a stale catalog refresh resurrect a successfully deleted library", async () => {
    const stale = deferred<{ items: typeof libraries; next_cursor: null }>();
    apiMocks.list.mockResolvedValueOnce({ items: libraries, next_cursor: null }).mockReturnValueOnce(stale.promise);
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<LibrariesView />);

    expect(await screen.findByText("Finance data room")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTitle("Delete library"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Finance data room")).not.toBeInTheDocument());

    await act(async () => stale.resolve({ items: libraries, next_cursor: null }));
    expect(screen.queryByText("Finance data room")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not close a newer library when an older deletion resolves", async () => {
    const deletion = deferred<{ ok: true }>();
    const secondLibrary = { ...libraries[0], id: "lib2", name: "Diligence room" };
    apiMocks.list.mockResolvedValue({ items: [libraries[0], secondLibrary], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) =>
      Promise.resolve(id === "lib1" ? detail : { ...secondLibrary, members: [] }),
    );
    apiMocks.remove.mockReturnValue(deletion.promise);
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    expect(await screen.findByRole("heading", { name: "Finance data room" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByTitle("Delete library")[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("lib1", expect.any(AbortSignal)));

    fireEvent.click(screen.getByRole("button", { name: "Diligence room" }));
    expect(await screen.findByRole("heading", { name: "Diligence room" })).toBeInTheDocument();
    await act(async () => deletion.resolve({ ok: true }));

    expect(screen.getByRole("heading", { name: "Diligence room" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Finance data room" })).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------- M14 stage 4

const knowledgeConnection = {
  id: "kc-1",
  name: "Research drive",
  kind: "desktop_folder",
  library_id: "lib1",
  revision: 1,
  watch_enabled: false,
  credential_configured: false,
  status: "ready",
  status_code: null,
  label: "Research notes",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const completedPreview = {
  preview: {
    id: "pv-1",
    connection_id: "kc-1",
    revision: 2,
    status: "complete",
    error_code: null,
    visited_entries: 3,
    directories: 1,
    aggregate_bytes: 30,
    new_count: 1,
    changed_count: 1,
    unchanged_count: 1,
    duplicate_count: 0,
    missing_count: 0,
    unsupported_count: 0,
    skipped_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:01Z",
    expires_at: "2026-01-01T00:10:00Z",
    applied_at: null,
  },
  entries: [
    {
      entry_id: "e-new",
      ordinal: 0,
      relative_path: "notes/new.md",
      classification: "new",
      content_hash: "a".repeat(64),
      size_bytes: 10,
      existing_source_id: null,
      mtime_hint: null,
      etag_hint: null,
      selection_token: "t".repeat(64),
    },
    {
      entry_id: "e-changed",
      ordinal: 1,
      relative_path: "notes/old.md",
      classification: "changed",
      content_hash: "b".repeat(64),
      size_bytes: 12,
      existing_source_id: "s1",
      mtime_hint: null,
      etag_hint: null,
      selection_token: "u".repeat(64),
    },
    {
      entry_id: "e-same",
      ordinal: 2,
      relative_path: "notes/same.md",
      classification: "unchanged",
      content_hash: "c".repeat(64),
      size_bytes: 8,
      existing_source_id: "s2",
      mtime_hint: null,
      etag_hint: null,
      selection_token: "v".repeat(64),
    },
  ],
};

function consentError() {
  return Object.assign(new Error("egress"), { __consent: true });
}

function previewEntryFixture() {
  return structuredClone(completedPreview);
}

describe("LibrariesView — knowledge connections", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    bridgeFlags.desktop = false;
    apiMocks.list.mockResolvedValue({ items: libraries, next_cursor: null });
    apiMocks.get.mockResolvedValue(detail);
    apiMocks.sourcesList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.knowledgeList.mockResolvedValue({ items: [knowledgeConnection], next_cursor: null });
    apiMocks.chooseFolder.mockResolvedValue({ cancelled: true });
  });

  it("lists connections with kind, label, and status code copy without any secret", async () => {
    render(<LibrariesView />);
    expect(await screen.findByText("Research drive")).toBeInTheDocument();
    expect(screen.getByText("Research notes")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    // Folder connections and watching are labeled desktop-only in browser mode.
    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
    expect(screen.getByText(/available only in the desktop app/i)).toBeInTheDocument();
  });

  it("explains denied folder reads in the connection badge and preview without offering an import", async () => {
    apiMocks.knowledgeList.mockResolvedValue({
      items: [
        { ...knowledgeConnection, watch_enabled: true, status: "error", status_code: "KNOWLEDGE_FILE_UNREADABLE" },
      ],
      next_cursor: null,
    });
    apiMocks.createPreview.mockResolvedValue({
      preview: { ...completedPreview.preview, status: "failed", error_code: "KNOWLEDGE_FILE_UNREADABLE" },
      run_id: "pv-1",
    });
    render(<LibrariesView />);
    expect(await screen.findByText("Restore read access to the folder and its files, then retry.")).toBeInTheDocument();
    expect(screen.getByText("Watching is paused until a manual preview or refresh succeeds.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));
    expect(
      await screen.findByText("Restore read access to the folder and its files, then retry. Nothing was imported."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Import selected/i })).not.toBeInTheDocument();
    expect(apiMocks.applyPreview).not.toHaveBeenCalled();
    expect(screen.queryByText(/upload budget/i)).not.toBeInTheDocument();
  });

  it.each([true, false])(
    "reconciles the watch badge after a terminal preview (recovered=%s) without importing",
    async (recovered) => {
      const ready = { ...knowledgeConnection, watch_enabled: true, status: "ready", status_code: null };
      const denied = { ...ready, status: "error", status_code: "KNOWLEDGE_FILE_UNREADABLE" };
      apiMocks.knowledgeList
        .mockResolvedValueOnce({ items: [recovered ? denied : ready], next_cursor: null })
        .mockResolvedValue({ items: [recovered ? ready : denied], next_cursor: null });
      apiMocks.createPreview.mockResolvedValue({
        preview: {
          ...completedPreview.preview,
          status: recovered ? "complete" : "failed",
          error_code: recovered ? null : "KNOWLEDGE_FILE_UNREADABLE",
        },
        run_id: "pv-1",
      });
      render(<LibrariesView />);
      await screen.findByText("Research drive");
      expect(Boolean(screen.queryByText("Watching is paused until a manual preview or refresh succeeds."))).toBe(
        recovered,
      );
      fireEvent.click(screen.getByRole("button", { name: /Preview/i }));
      await waitFor(() => expect(apiMocks.knowledgeList).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(Boolean(screen.queryByText("Watching is paused until a manual preview or refresh succeeds."))).toBe(
          !recovered,
        ),
      );
      expect(apiMocks.applyPreview).not.toHaveBeenCalled();
    },
  );

  it("clears the permission pause for a recovered connection loaded beyond the catalog head", async () => {
    const head = { ...knowledgeConnection, id: "newer", name: "Newer folder" };
    const denied = {
      ...knowledgeConnection,
      watch_enabled: true,
      status: "error",
      status_code: "KNOWLEDGE_FILE_UNREADABLE",
    };
    apiMocks.knowledgeList
      .mockResolvedValueOnce({ items: [head], next_cursor: "older" })
      .mockResolvedValueOnce({ items: [denied], next_cursor: null })
      .mockResolvedValue({ items: [head], next_cursor: "older" });
    apiMocks.createPreview.mockResolvedValue({
      preview: { ...completedPreview.preview, status: "complete", error_code: null },
      run_id: "pv-1",
    });
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Load older connections" }));
    const name = await screen.findByText("Research drive");
    const card = name.closest(".p-4")!;
    expect(
      within(card as HTMLElement).getByText("Watching is paused until a manual preview or refresh succeeds."),
    ).toBeInTheDocument();
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: /Preview/i }));
    await waitFor(() => expect(apiMocks.knowledgeList).toHaveBeenCalledTimes(3));
    await waitFor(() =>
      expect(
        screen.queryByText("Watching is paused until a manual preview or refresh succeeds."),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Research drive")).toBeInTheDocument();
    expect(apiMocks.applyPreview).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "partial"])(
    "reconciles an older connection permission badge after a %s manual refresh",
    async (status) => {
      const recovered = status === "completed";
      const head = { ...knowledgeConnection, id: "newer", name: "Newer folder" };
      const older = {
        ...knowledgeConnection,
        watch_enabled: true,
        status: recovered ? "error" : "ready",
        status_code: recovered ? "KNOWLEDGE_FILE_UNREADABLE" : null,
      };
      apiMocks.knowledgeList
        .mockResolvedValueOnce({ items: [head], next_cursor: "older" })
        .mockResolvedValueOnce({ items: [older], next_cursor: null })
        .mockResolvedValue({ items: [head], next_cursor: "older" });
      apiMocks.startRefresh.mockResolvedValue({
        refresh: {
          id: "rf-1",
          connection_id: older.id,
          requested_by: "manual",
          expected_connection_revision: older.revision,
          status,
          cancel_requested: false,
          error_code: recovered ? null : "KNOWLEDGE_FILE_UNREADABLE",
          created_at: "2026-01-01T00:00:00Z",
          started_at: "2026-01-01T00:00:00Z",
          finished_at: "2026-01-01T00:00:01Z",
        },
      });
      render(<LibrariesView />);
      fireEvent.click(await screen.findByRole("button", { name: "Load older connections" }));
      const name = await screen.findByText("Research drive");
      const card = name.closest(".p-4") as HTMLElement;
      expect(Boolean(within(card).queryByText("Watching is paused until a manual preview or refresh succeeds."))).toBe(
        recovered,
      );
      fireEvent.click(within(card).getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(apiMocks.knowledgeList).toHaveBeenCalledTimes(3));
      await waitFor(() =>
        expect(Boolean(screen.queryByText("Watching is paused until a manual preview or refresh succeeds."))).toBe(
          !recovered,
        ),
      );
      expect(screen.getByText("Research drive")).toBeInTheDocument();
    },
  );

  it("does not reconcile connection status from a preview response that arrives after its dialog closes", async () => {
    const preview = deferred<unknown>();
    apiMocks.createPreview.mockImplementation(() => preview.promise);
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await act(async () => {
      preview.resolve({
        preview: { ...completedPreview.preview, status: "failed", error_code: "KNOWLEDGE_FILE_UNREADABLE" },
        run_id: "pv-1",
      });
    });
    expect(apiMocks.knowledgeList).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Nothing was imported/)).not.toBeInTheDocument();
  });

  it("renders restore-reconnect status codes as actionable badge copy", async () => {
    apiMocks.knowledgeList.mockResolvedValue({
      items: [
        {
          ...knowledgeConnection,
          status: "disconnected",
          status_code: "KNOWLEDGE_RESTORE_RECONNECT_REQUIRED",
        },
      ],
      next_cursor: null,
    });
    render(<LibrariesView />);
    expect(await screen.findByText(/reconnect needed after restore/i)).toBeInTheDocument();
  });

  it("creates a folder connection only with the opaque grant, and not when cancelled", async () => {
    bridgeFlags.desktop = true;
    apiMocks.knowledgeCreate.mockResolvedValue({ ...knowledgeConnection, id: "kc-2" });
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Folder" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Deep notes" } });
    apiMocks.chooseFolder.mockResolvedValue({
      cancelled: false,
      grantId: "f".repeat(64),
      label: "Notes",
      entryCount: 3,
      truncated: false,
    });
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/i }));
    await waitFor(() =>
      expect(apiMocks.knowledgeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Deep notes",
          kind: "desktop_folder",
          library_id: "lib1",
          grant_id: "f".repeat(64),
        }),
      ),
    );
    // The chosen path never travels through the client contract.
    expect(JSON.stringify(apiMocks.knowledgeCreate.mock.calls[0])).not.toContain("path");

    // Cancelled picker creates nothing.
    fireEvent.click(screen.getByRole("button", { name: "Folder" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Nope" } });
    apiMocks.chooseFolder.mockResolvedValue({ cancelled: true });
    fireEvent.click(screen.getByRole("button", { name: /Choose folder/i }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(apiMocks.knowledgeCreate).toHaveBeenCalledTimes(1);
  });

  it("creates a WebDAV connection with a write-only password field", async () => {
    apiMocks.knowledgeCreate.mockResolvedValue({ ...knowledgeConnection, kind: "webdav", label: "dav.example.test" });
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "WebDAV" }));
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Team docs" } });
    fireEvent.change(screen.getByLabelText("Collection URL"), { target: { value: "https://dav.example.test/c" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ada" } });
    const password = screen.getByLabelText("Application password") as HTMLInputElement;
    expect(password.type).toBe("password");
    fireEvent.change(password, { target: { value: "pw-42" } });
    fireEvent.click(screen.getByRole("button", { name: /Create connection/i }));
    await waitFor(() =>
      expect(apiMocks.knowledgeCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "webdav",
          config: { url: "https://dav.example.test/c", username: "ada", password: "pw-42" },
        }),
        expect.anything(),
      ),
    );
    expect(document.body.textContent).not.toContain("pw-42");
  });

  it("shows the write-only password requirement when submitting without one", async () => {
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "WebDAV" }));
    fireEvent.click(screen.getByRole("button", { name: /Create connection/i }));
    expect(await screen.findByText(/application password is required/i)).toBeInTheDocument();
    expect(apiMocks.knowledgeCreate).not.toHaveBeenCalled();
  });

  it("asks for a library before opening the connection form when none exists", async () => {
    apiMocks.list.mockResolvedValue({ items: [], next_cursor: null });
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "WebDAV" }));
    expect(await screen.findByText(/create a library first/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Create connection/i })).not.toBeInTheDocument();
  });

  it("previews with counts, applies exact revision + selection tokens, and keeps the dialog closed while applying", async () => {
    const first = deferred<unknown>();
    apiMocks.createPreview.mockResolvedValue({
      preview: { ...completedPreview.preview, status: "pending" },
      run_id: "pv-1",
    });
    apiMocks.getPreview.mockResolvedValueOnce({
      preview: { ...completedPreview.preview, status: "pending" },
      entries: [],
    });
    apiMocks.getPreview.mockResolvedValue(previewEntryFixture());
    apiMocks.applyPreview.mockImplementation(() => first.promise);
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));
    expect(
      await screen.findByText(/1 new · 1 changed · 1 unchanged · 0 duplicate · 0 missing · 0 unsupported · 2 skipped/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select notes/new.md"));
    const unchangedRow = screen.getByText("notes/same.md").closest("tr")!;
    expect(unchangedRow.querySelector("input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Import selected \(1\)/ }));
    await waitFor(() =>
      expect(apiMocks.applyPreview).toHaveBeenCalledWith("pv-1", {
        expected_revision: 2,
        selections: [{ entry_id: "e-new", selection_token: "t".repeat(64) }],
      }),
    );
    // Busy dialog cannot be dismissed mid-apply.
    fireEvent.click(screen.getByLabelText("Close dialog"));
    expect(screen.getByText("notes/new.md")).toBeInTheDocument();
    await act(async () => {
      first.resolve({ preview: { ...completedPreview.preview, status: "applied" }, items: [], refresh_id: null });
    });
    await waitFor(() => expect(screen.queryByText("notes/new.md")).not.toBeInTheDocument());
  });

  it("keeps the preview dialog open on a stale apply and explains the retry", async () => {
    apiMocks.createPreview.mockResolvedValue({
      preview: { ...completedPreview.preview, status: "pending" },
      run_id: "pv-1",
    });
    apiMocks.getPreview.mockResolvedValue(previewEntryFixture());
    apiMocks.applyPreview.mockRejectedValue({
      status: 409,
      data: { code: "KNOWLEDGE_PREVIEW_STALE" },
    });
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: /Preview/i }));
    await screen.findByText("notes/new.md");
    fireEvent.click(screen.getByLabelText("Select notes/old.md"));
    fireEvent.click(screen.getByRole("button", { name: /Import selected/i }));
    expect(await screen.findByText(/run a new preview and re-select/i)).toBeInTheDocument();
    expect(screen.getByText("notes/new.md")).toBeInTheDocument();
  });

  it("starts a refresh and requests durable cancellation", async () => {
    const refresh = {
      id: "rf-1",
      connection_id: "kc-1",
      requested_by: "manual",
      expected_connection_revision: 1,
      status: "active",
      cancel_requested: false,
      error_code: null,
      created_at: "2026-01-01T00:00:00Z",
      started_at: "2026-01-01T00:00:00Z",
      finished_at: null,
    };
    apiMocks.startRefresh.mockResolvedValue({ refresh });
    apiMocks.cancelRefresh.mockResolvedValue({ ok: true, cancel_requested: true, status: "cancelled" });
    apiMocks.getRefresh.mockResolvedValue({ ...refresh, status: "cancelled", cancel_requested: true });
    render(<LibrariesView />);
    const section = await screen.findByRole("region", { name: "Knowledge connections" });
    fireEvent.click(within(section).getByRole("button", { name: "Refresh" }));
    const cancel = await within(section).findByRole("button", { name: "Cancel" });
    fireEvent.click(cancel);
    await waitFor(() => expect(apiMocks.cancelRefresh).toHaveBeenCalledWith("rf-1"));
  });

  it("deletes with a busy confirm and never loses the local filter to a stale catalog", async () => {
    apiMocks.knowledgeList.mockResolvedValue({ items: [knowledgeConnection], next_cursor: null });
    const remove = deferred<{ ok: true }>();
    apiMocks.knowledgeRemove.mockImplementation(() => remove.promise);
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Research drive" }));
    expect(
      await screen.findByText(/sources, library membership, reports, and saved evidence are kept/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Busy: dismiss blocked while in flight.
    expect(screen.getByRole("button", { name: /Deleting/i })).toBeDisabled();
    await act(async () => {
      remove.resolve({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => expect(screen.queryByText("Research drive")).not.toBeInTheDocument());
    // The delete never reopens a catalog window that could resurrect it.
    expect(apiMocks.knowledgeList).toHaveBeenCalledTimes(1);
  });

  it("keeps the watch toggle desktop-gated", async () => {
    render(<LibrariesView />);
    const watch = (await screen.findByLabelText("Watch")) as HTMLInputElement;
    expect(watch.disabled).toBe(true);
  });

  it("toggles watch through the versioned patch in desktop mode", async () => {
    bridgeFlags.desktop = true;
    apiMocks.knowledgeUpdate.mockResolvedValue({ ...knowledgeConnection, watch_enabled: true });
    render(<LibrariesView />);
    const watch = (await screen.findByLabelText("Watch")) as HTMLInputElement;
    expect(watch.disabled).toBe(false);
    fireEvent.click(watch);
    await waitFor(() =>
      expect(apiMocks.knowledgeUpdate).toHaveBeenCalledWith("kc-1", { expected_revision: 1, watch_enabled: true }),
    );
  });
});

describe("LibrariesView — library search and passage panel", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    bridgeFlags.desktop = false;
    apiMocks.list.mockResolvedValue({ items: libraries, next_cursor: null });
    apiMocks.get.mockResolvedValue(detail);
    apiMocks.sourcesList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.knowledgeList.mockResolvedValue({ items: [], next_cursor: null });
  });

  async function openSearch() {
    render(<LibrariesView />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    fireEvent.click(await screen.findByRole("button", { name: /Search sources/i }));
    await screen.findByLabelText("Search query");
  }

  it("runs keyword search with typed locators and highlighted excerpts", async () => {
    apiMocks.search.mockResolvedValue({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [{ source_id: "s1", generation: 2, status: "ready" }],
      ignored_source_ids: [],
      hits: [
        {
          source_id: "s1",
          generation: 2,
          chunk_id: "c1",
          label: "ledger.csv",
          excerpt: "cashflow improved in Q3",
          score: 2.5,
          rank: 1,
          locators: [{ kind: "tabular_rows", table: "ledger", row_start: 4, row_end: 9 }],
        },
        {
          source_id: "s1",
          generation: 2,
          chunk_id: "c2",
          label: "memo.pdf",
          excerpt: "Cashflow forecast revised",
          score: 1.5,
          rank: 2,
          locators: [{ kind: "pdf_page", page: 3, ocr: true, char_start: 10, char_len: 20 }],
        },
      ],
      returned_char_count: 48,
      truncated: false,
    });
    await openSearch();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "cashflow" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText("2 hits")).toBeInTheDocument();
    expect(screen.getAllByText(/Cashflow/i).some((node) => node.tagName === "MARK")).toBe(true);
    expect(screen.getByText("ledger rows 4–9")).toBeInTheDocument();
    expect(screen.getByText(/PDF page 3 \(OCR\)/)).toBeInTheDocument();
    expect(apiMocks.search).toHaveBeenCalledWith("lib1", { query: "cashflow", mode: "keyword" }, expect.anything());
  });

  it("labels legacy chunks as location-unavailable", async () => {
    apiMocks.search.mockResolvedValue({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [],
      ignored_source_ids: [],
      hits: [
        {
          source_id: "s1",
          generation: 1,
          chunk_id: "c9",
          label: "old.md",
          excerpt: "cashflow",
          score: 1,
          rank: 1,
        },
      ],
      returned_char_count: 8,
      truncated: false,
    });
    await openSearch();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "cashflow" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText(/location unavailable for this chunk/i)).toBeInTheDocument();
  });

  it("discloses the payload classes for semantic mode and gates on remote consent", async () => {
    apiMocks.search.mockRejectedValueOnce(consentError());
    await openSearch();
    fireEvent.click(screen.getByRole("radio", { name: /^Semantic$/ }));
    expect(
      await screen.findByText(
        /upload and ingestion text, prompts, chat history, retrieval queries, and selected tool context/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "forecast" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    expect(await screen.findByText(/remote model-provider consent is required/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open Settings/i })).toHaveAttribute("href", "#/settings");
    expect(apiMocks.search).toHaveBeenCalledWith("lib1", { query: "forecast", mode: "semantic" }, expect.anything());
  });

  it("applies type and source filters without widening scope, and surfaces ignored filter ids", async () => {
    apiMocks.search.mockResolvedValue({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [],
      ignored_source_ids: ["ghost"],
      hits: [],
      returned_char_count: 0,
      truncated: false,
    });
    await openSearch();
    fireEvent.change(screen.getByLabelText("Filter by type"), { target: { value: "tabular" } });
    const checkbox = screen.getByLabelText("ledger.csv");
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "cashflow" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    await waitFor(() =>
      expect(apiMocks.search).toHaveBeenCalledWith(
        "lib1",
        { query: "cashflow", mode: "keyword", source_ids: ["s1"], kind: "tabular" },
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/1 filter id\(s\) outside the library were ignored/)).toBeInTheDocument();
  });

  it("ignores a stale search response when a newer query completes", async () => {
    const slow = deferred<unknown>();
    const fast = deferred<unknown>();
    apiMocks.search.mockImplementationOnce(() => slow.promise).mockImplementationOnce(() => fast.promise);
    await openSearch();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "beta" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    fast.resolve({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [],
      ignored_source_ids: [],
      hits: [{ source_id: "s1", generation: 1, chunk_id: "cb", label: "beta hit", excerpt: "beta", score: 1, rank: 1 }],
      returned_char_count: 4,
      truncated: false,
    });
    expect(await screen.findByText(/beta hit/)).toBeInTheDocument();
    await act(async () => {
      slow.resolve({
        mode: "keyword",
        query_truncated: false,
        captured_scope: [],
        ignored_source_ids: [],
        hits: [
          { source_id: "s1", generation: 1, chunk_id: "ca", label: "alpha stale", excerpt: "alpha", score: 1, rank: 1 },
        ],
        returned_char_count: 5,
        truncated: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(/alpha stale/)).not.toBeInTheDocument();
  });

  it("opens the passage panel with neighbors and honest captured-generation copy", async () => {
    apiMocks.search.mockResolvedValue({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [],
      ignored_source_ids: [],
      hits: [
        {
          source_id: "s1",
          generation: 1,
          chunk_id: "c1",
          label: "memo.pdf",
          excerpt: "cashflow grew",
          score: 1,
          rank: 1,
          locators: [{ kind: "pdf_page", page: 3, ocr: false, char_start: 0, char_len: 13 }],
        },
      ],
      returned_char_count: 13,
      truncated: false,
    });
    apiMocks.passage.mockResolvedValue({
      source: { id: "s1", label: "memo.pdf", status: "ready", ready_generation: 2 },
      chunk: {
        chunk_id: "c1",
        source_id: "s1",
        generation: 1,
        seq: 2,
        content: "cashflow grew",
        locators: [{ kind: "pdf_page", page: 3, ocr: false, char_start: 0, char_len: 13 }],
      },
      neighbors: {
        before: { chunk_id: "c0", seq: 1, content: "before text" },
        after: { chunk_id: "c2", seq: 3, content: "after text" },
      },
    });
    await openSearch();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "cashflow" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Open passage/i }));
    expect(await screen.findByText("before text")).toBeInTheDocument();
    expect(screen.getByText("after text")).toBeInTheDocument();
    expect(screen.getByText(/captured generation 1 — source now indexes generation 2/)).toBeInTheDocument();
    expect(screen.getAllByText("PDF page 3, chars 0–13")).toHaveLength(2);
  });

  it("renders the passage panel honestly when the chunk was pruned", async () => {
    apiMocks.search.mockResolvedValue({
      mode: "keyword",
      query_truncated: false,
      captured_scope: [],
      ignored_source_ids: [],
      hits: [
        {
          source_id: "s1",
          generation: 1,
          chunk_id: "c1",
          label: "memo.pdf",
          excerpt: "cashflow grew",
          score: 1,
          rank: 1,
        },
      ],
      returned_char_count: 13,
      truncated: false,
    });
    apiMocks.passage.mockRejectedValue({ status: 410, data: { code: "PASSAGE_UNAVAILABLE" } });
    await openSearch();
    fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "cashflow" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Open passage/i }));
    expect(await screen.findByText(/no longer available for the source's current generation/i)).toBeInTheDocument();
  });
});
