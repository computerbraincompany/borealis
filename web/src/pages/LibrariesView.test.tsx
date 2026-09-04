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
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  librariesApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    get: apiMocks.get,
    rename: apiMocks.rename,
    setMembers: apiMocks.setMembers,
    remove: apiMocks.remove,
  },
  sourcesApi: { list: apiMocks.sourcesList },
  chatsApi: { create: apiMocks.chatsCreate },
  MAX_LIBRARY_MEMBERS: 100,
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
    "keeps a reopened create form owned when the older request later %ss",
    async (settlement) => {
      const older = deferred<(typeof libraries)[number]>();
      const newer = deferred<(typeof libraries)[number]>();
      apiMocks.create.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
      render(<LibrariesView />);

      fireEvent.click(await screen.findByRole("button", { name: /New library/i }));
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "First library" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(1));
      expect(apiMocks.create.mock.calls[0][0]).toBe("First library");
      const olderSignal = apiMocks.create.mock.calls[0][1] as AbortSignal;

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(olderSignal.aborted).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /New library/i }));
      fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Second library" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(2));
      expect(apiMocks.create.mock.calls[1][0]).toBe("Second library");
      expect(apiMocks.create.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

      await act(async () => {
        if (settlement === "resolve") {
          older.resolve({ ...libraries[0], id: "lib-stale", name: "Stale library" });
        } else {
          older.reject(new Error("stale create failed"));
        }
      });

      expect(screen.getByRole("heading", { name: "New library" })).toBeInTheDocument();
      expect(screen.getByLabelText("Library name")).toHaveValue("Second library");
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
      expect(screen.queryByText("Stale library")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();

      await act(async () => newer.resolve({ ...libraries[0], id: "lib2", name: "Second library" }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "New library" })).not.toBeInTheDocument());
      expect(screen.getByText("Second library")).toBeInTheDocument();
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

  it("keeps a newer rename dialog owned when an older rename resolves late", async () => {
    const firstRename = deferred<(typeof libraries)[number]>();
    const secondLibrary = { ...libraries[0], id: "lib2", name: "Diligence room" };
    apiMocks.list.mockResolvedValue({ items: [libraries[0], secondLibrary], next_cursor: null });
    apiMocks.get.mockImplementation((id: string) =>
      Promise.resolve(id === "lib1" ? detail : { ...secondLibrary, members: [] }),
    );
    apiMocks.rename.mockImplementation((id: string) =>
      id === "lib1" ? firstRename.promise : Promise.resolve({ ...secondLibrary, name: "Diligence archive" }),
    );
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Library name"), { target: { value: "Finance archive" } });
    fireEvent.submit(screen.getByLabelText("Library name").closest("form")!);
    await waitFor(() =>
      expect(apiMocks.rename).toHaveBeenCalledWith("lib1", "Finance archive", expect.any(AbortSignal)),
    );
    const firstSignal = apiMocks.rename.mock.calls[0][2] as AbortSignal;

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(firstSignal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rename library" })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Diligence room" }));
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("lib2", expect.any(AbortSignal)));
    const libraryHeading = await screen.findByRole("heading", { name: "Diligence room" });
    const memberDialog = libraryHeading.parentElement?.parentElement;
    expect(memberDialog).not.toBeNull();
    fireEvent.click(within(memberDialog!).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByLabelText("Library name")).toHaveValue("Diligence room"));

    await act(async () => firstRename.resolve({ ...libraries[0], name: "Finance archive" }));
    expect(screen.getByRole("heading", { name: "Rename library" })).toBeInTheDocument();
    expect(screen.getByLabelText("Library name")).toHaveValue("Diligence room");
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
