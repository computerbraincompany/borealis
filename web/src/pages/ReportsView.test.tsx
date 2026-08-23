import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  apiText: vi.fn(),
  openProtected: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  reportsApi: { list: apiMocks.list, remove: apiMocks.remove },
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
  },
  {
    id: "r2",
    title: "Second",
    subtitle: null,
    created_at: "2026-01-02T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    chat_title: null,
    chat_id: null,
  },
];

describe("ReportsView preview", () => {
  it("aborts and ignores a stale request while using a script-only opaque sandbox", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    apiMocks.list.mockResolvedValue(reports);
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
});
