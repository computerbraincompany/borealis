import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttachedSource, LibrarySummary, Source, SourceScopeInput } from "@/lib/api";
import { ChatSourcePicker } from "@/components/ChatSourcePicker";

const apiMocks = vi.hoisted(() => ({
  librariesGet: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  librariesApi: { get: apiMocks.librariesGet },
  MAX_LIBRARY_MEMBERS: 100,
}));

const baseSource: Source = {
  id: "source-1",
  name: "source-1.csv",
  display_name: "Quarterly revenue.csv",
  kind: "tabular",
  mime: "text/csv",
  status: "ready",
  created_at: "2026-08-26T00:00:00.000Z",
};

const financeLibrary: LibrarySummary = {
  id: "lib-1",
  name: "Finance data room",
  member_count: 2,
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:00:00.000Z",
};

function member(id: string, status = "ready"): Source {
  return { ...baseSource, id, name: `${id}.csv`, display_name: `${id}.csv`, status };
}

function attached(source: Source = baseSource): AttachedSource {
  return {
    id: source.id,
    name: source.name,
    display_name: source.display_name,
    kind: source.kind,
    status: source.status,
  };
}

function source(index: number): Source {
  return {
    ...baseSource,
    id: `source-${index}`,
    name: `source-${index}.csv`,
    display_name: index === 6 ? "Operating plan.csv" : `Dataset ${index}.csv`,
  };
}

function renderPicker(overrides: Partial<React.ComponentProps<typeof ChatSourcePicker>> = {}) {
  const onApply = vi.fn<(scope: SourceScopeInput) => Promise<void>>().mockResolvedValue(undefined);
  const onUpload = vi.fn<(file: File) => Promise<Source>>().mockResolvedValue({
    ...baseSource,
    id: "uploaded-source",
    name: "new-source.csv",
    display_name: "new-source.csv",
    status: "index",
  });
  const onRetrySources = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  render(
    <ChatSourcePicker
      sourceMode="selected"
      attachedSources={[]}
      sources={[baseSource]}
      sourcesLoading={false}
      sourcesError={null}
      disabled={false}
      saving={false}
      hasMessages={false}
      onApply={onApply}
      onUpload={onUpload}
      onRetrySources={onRetrySources}
      {...overrides}
    />,
  );

  return { onApply, onUpload, onRetrySources };
}

describe("ChatSourcePicker", () => {
  it("uses a compact anchored menu instead of a modal dialog", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

    expect(screen.getByRole("menu")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Stored data is off")).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Select source: Quarterly revenue.csv" })).toBeVisible();
  });

  it("applies individual and automatic scopes immediately without closing the menu", async () => {
    const user = userEvent.setup();
    const { onApply } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

    await user.click(screen.getByRole("menuitemcheckbox", { name: "Select source: Quarterly revenue.csv" }));
    await waitFor(() =>
      expect(onApply).toHaveBeenLastCalledWith({ source_mode: "selected", source_ids: [baseSource.id] }),
    );
    expect(screen.getByRole("menu")).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: /All sources/ }));
    await waitFor(() => expect(onApply).toHaveBeenLastCalledWith({ source_mode: "all" }));
    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("removes the last selected source with one click", async () => {
    const user = userEvent.setup();
    const { onApply } = renderPicker({ attachedSources: [attached()] });
    await user.click(screen.getByRole("button", { name: "Chat sources: 1 source" }));

    const selectedSource = screen.getByRole("menuitemcheckbox", { name: "Remove source: Quarterly revenue.csv" });
    expect(selectedSource).toHaveClass("bg-accent", "font-medium");
    expect(selectedSource).not.toHaveClass("border-l-2", "border-l-primary");
    await user.click(selectedSource);

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ source_mode: "selected", source_ids: [] }));
  });

  it("searches larger source catalogs inside the menu", async () => {
    const user = userEvent.setup();
    renderPicker({ sources: [1, 2, 3, 4, 5, 6].map(source) });
    await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

    await user.type(screen.getByPlaceholderText("Search sources"), "operating");

    expect(screen.getByRole("menuitemcheckbox", { name: "Select source: Operating plan.csv" })).toBeVisible();
    expect(screen.queryByRole("menuitemcheckbox", { name: "Select source: Dataset 1.csv" })).not.toBeInTheDocument();
  });

  it("uploads a file and immediately adds it to a specific-source chat", async () => {
    const user = userEvent.setup();
    const { onApply, onUpload } = renderPicker();
    const file = new File(["month,amount\nJan,12"], "new-source.csv", { type: "text/csv" });

    await user.upload(screen.getByLabelText("Upload a source file"), file);

    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file));
    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith({ source_mode: "selected", source_ids: ["uploaded-source"] }),
    );
  });

  it("keeps the menu open and explains a failed immediate update", async () => {
    const user = userEvent.setup();
    const { onApply } = renderPicker();
    onApply.mockRejectedValueOnce(new Error("save rejected"));
    await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

    await user.click(screen.getByRole("menuitem", { name: /All sources/ }));

    expect(await screen.findByText(/Source selection unchanged:/)).toHaveTextContent(
      "Could not update this chat's sources",
    );
    expect(screen.getByRole("menu")).toBeVisible();
  });

  describe("libraries", () => {
    beforeEach(() => {
      apiMocks.librariesGet.mockReset();
    });

    it("lists libraries with names and member counts inside the picker menu", async () => {
      const user = userEvent.setup();
      renderPicker({
        libraries: [financeLibrary, { ...financeLibrary, id: "lib-2", name: "Diligence room", member_count: 1 }],
      });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      expect(screen.getByText("Attach a library")).toBeVisible();
      expect(screen.getByRole("menuitem", { name: /Finance data room/ })).toBeVisible();
      expect(screen.getByText("2 members")).toBeVisible();
      expect(screen.getByRole("menuitem", { name: /Diligence room/ })).toBeVisible();
      expect(screen.getByText("1 member")).toBeVisible();
    });

    it("hides the library section when the catalog is empty", async () => {
      const user = userEvent.setup();
      renderPicker({ libraries: [] });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      expect(screen.queryByText("Attach a library")).not.toBeInTheDocument();
      expect(screen.getByRole("menuitemcheckbox", { name: "Select source: Quarterly revenue.csv" })).toBeVisible();
    });

    it("shows a loading line while the library catalog loads", async () => {
      const user = userEvent.setup();
      renderPicker({ libraries: [financeLibrary], librariesLoading: true });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      expect(screen.getByText("Loading libraries…")).toBeVisible();
    });

    it("attaches a library's ready members as the explicit selected scope", async () => {
      const user = userEvent.setup();
      apiMocks.librariesGet.mockResolvedValue({
        ...financeLibrary,
        members: [member("ready-1"), member("processing-1", "index"), member("ready-2")],
      });
      const { onApply } = renderPicker({ libraries: [financeLibrary] });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      await user.click(screen.getByRole("menuitem", { name: /Finance data room/ }));

      await waitFor(() =>
        expect(onApply).toHaveBeenCalledWith({ source_mode: "selected", source_ids: ["ready-1", "ready-2"] }),
      );
      expect(apiMocks.librariesGet).toHaveBeenCalledWith("lib-1");
      expect(screen.getByRole("menu")).toBeVisible();
    });

    it("explains a library that has no ready members without applying a scope", async () => {
      const user = userEvent.setup();
      apiMocks.librariesGet.mockResolvedValue({
        ...financeLibrary,
        members: [member("processing-1", "index")],
      });
      const { onApply } = renderPicker({ libraries: [financeLibrary] });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      await user.click(screen.getByRole("menuitem", { name: /Finance data room/ }));

      expect(await screen.findByText(/Source selection unchanged:/)).toHaveTextContent("has no ready members yet");
      expect(onApply).not.toHaveBeenCalled();
      expect(screen.getByRole("menu")).toBeVisible();
    });

    it("fails an over-cap library attach instead of truncating the scope", async () => {
      const user = userEvent.setup();
      apiMocks.librariesGet.mockResolvedValue({
        ...financeLibrary,
        members: Array.from({ length: 101 }, (_, index) => member(`ready-${index}`)),
      });
      const { onApply } = renderPicker({ libraries: [financeLibrary] });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      await user.click(screen.getByRole("menuitem", { name: /Finance data room/ }));

      expect(await screen.findByText(/Source selection unchanged:/)).toHaveTextContent(
        "more than 100 ready sources; a chat can use at most 100 selected sources",
      );
      expect(onApply).not.toHaveBeenCalled();
    });

    it("surfaces library catalog errors as a bounded banner with retry", async () => {
      const user = userEvent.setup();
      const onRetryLibraries = vi.fn<() => void>();
      renderPicker({ libraries: null, librariesError: "Could not load libraries", onRetryLibraries });
      await user.click(screen.getByRole("button", { name: "Chat sources: No sources" }));

      expect(screen.getByRole("alert")).toHaveTextContent("Could not load libraries");

      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetryLibraries).toHaveBeenCalledTimes(1);
    });
  });
});
