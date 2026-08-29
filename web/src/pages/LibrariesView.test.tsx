import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { LibrariesView } from "@/pages/LibrariesView";

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
    apiMocks.list.mockResolvedValue(libraries);
    apiMocks.get.mockResolvedValue(detail);
    apiMocks.sourcesList.mockResolvedValue([
      { id: "s1", name: "ledger", display_name: "ledger.csv", status: "ready" },
      { id: "s3", name: "extra", display_name: "extra.csv", status: "ready" },
    ]);
  });

  it("lists libraries with member counts and creates one", async () => {
    apiMocks.create.mockResolvedValue({ ...libraries[0], id: "lib2", name: "Diligence" });
    apiMocks.list.mockResolvedValueOnce(libraries).mockResolvedValue([
      ...libraries,
      {
        id: "lib2",
        name: "Diligence",
        member_count: 0,
        created_at: "2026-01-02T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
      },
    ]);
    render(<LibrariesView />);

    expect(await screen.findByText("Finance data room")).toBeInTheDocument();
    expect(screen.getByText("2 members")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New library/i }));
    const input = screen.getByLabelText("Library name");
    fireEvent.change(input, { target: { value: "Diligence" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(apiMocks.create).toHaveBeenCalledWith("Diligence"));
    expect(await screen.findByText("Diligence")).toBeInTheDocument();
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

    await waitFor(() => expect(apiMocks.setMembers).toHaveBeenCalledWith("lib1", ["s1", "s2", "s3"]));

    fireEvent.click(await screen.findByTitle("Remove ledger.csv"));
    await waitFor(() => expect(apiMocks.setMembers).toHaveBeenCalledWith("lib1", ["s2", "s3"]));
  });

  it("attaches ready members to a new chat by explicit expansion", async () => {
    apiMocks.chatsCreate.mockResolvedValue({ id: "chat9" });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByRole("button", { name: "Finance data room" }));
    fireEvent.click(await screen.findByRole("button", { name: /Attach to new chat/i }));

    await waitFor(() =>
      expect(apiMocks.chatsCreate).toHaveBeenCalledWith(undefined, {
        source_mode: "selected",
        source_ids: ["s1", "s2"],
      }),
    );
    expect(window.location.hash).toBe("#/chat/chat9");
  });

  it("deletes the library without deleting its sources", async () => {
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<LibrariesView />);

    fireEvent.click(await screen.findByTitle("Delete library"));

    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("lib1"));
    await waitFor(() => expect(screen.queryByText("Finance data room")).not.toBeInTheDocument());
  });
});
