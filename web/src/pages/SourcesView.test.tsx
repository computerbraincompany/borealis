import { fireEvent, render, screen } from "@testing-library/react";
import type { Source } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  addPending: vi.fn(),
  upload: vi.fn(),
  reingest: vi.fn(),
  remove: vi.fn(),
  sources: [] as Source[],
}));

vi.mock("@/hooks/useSourceCatalog", () => ({
  useSourceCatalog: () => ({
    sources: mocks.sources,
    loading: false,
    error: null,
    refresh: mocks.refresh,
    addPending: mocks.addPending,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...original,
    sourcesApi: {
      ...original.sourcesApi,
      upload: mocks.upload,
      reingest: mocks.reingest,
      remove: mocks.remove,
    },
  };
});

import { SourcesView } from "@/pages/SourcesView";

describe("SourcesView", () => {
  beforeEach(() => {
    mocks.refresh.mockReset();
    mocks.refresh.mockResolvedValue(undefined);
    mocks.addPending.mockReset();
    mocks.upload.mockReset();
    mocks.reingest.mockReset();
    mocks.remove.mockReset();
    mocks.sources = [];
  });

  it("wraps long source identity and exposes safe ingestion details on demand", () => {
    const displayName = "22-08-2026_Umsatzliste_Girokonto_DE33120300001054151210.csv";
    const technicalName = "d_22_08_2026_umsatzliste_girokonto_de33120300001054151210";
    mocks.sources = [
      {
        id: "source-1",
        name: technicalName,
        kind: "tabular",
        display_name: displayName,
        mime: "text/csv",
        status: "error",
        created_at: "2026-08-25T21:34:12.000Z",
        meta: {
          error: "The embedding service was unavailable.",
          error_code: "EMBEDDING_UNAVAILABLE",
          error_detail:
            "Borealis read the file but could not reach the configured embedding model. Start the model service, then retry.",
          error_stage: "embedding",
        },
        ingestion: { attempts: 3, updated_at: "2026-08-25T21:34:47.000Z" },
      },
    ];

    render(<SourcesView />);

    expect(screen.getByText(displayName)).toHaveClass("break-all");
    expect(screen.getByText(displayName)).not.toHaveClass("truncate");
    expect(screen.getByText(technicalName)).toHaveClass("break-all");
    expect(screen.getByTitle("Delete source")).toHaveClass("absolute");
    expect(screen.getByTitle("Delete source").parentElement).not.toHaveClass("border-t");
    const summary = screen.getByText("View error details");
    const details = summary.closest("details");
    expect(details).not.toHaveAttribute("open");

    fireEvent.click(summary);

    expect(details).toHaveAttribute("open");
    expect(screen.getByText("EMBEDDING_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("embedding", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("3", { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Borealis read the file but could not reach the configured embedding model. Start the model service, then retry.",
      ),
    ).toBeInTheDocument();
  });
});
