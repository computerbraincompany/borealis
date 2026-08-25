import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttachedSource, Source, SourceScopeInput } from "@/lib/api";
import { ChatSourcePicker } from "@/components/ChatSourcePicker";

const baseSource: Source = {
  id: "source-1",
  name: "source-1.csv",
  display_name: "Quarterly revenue.csv",
  kind: "tabular",
  mime: "text/csv",
  status: "ready",
  created_at: "2026-08-26T00:00:00.000Z",
};

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
});
