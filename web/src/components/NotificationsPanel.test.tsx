import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const notifyMocks = vi.hoisted(() => ({
  list: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (_error: unknown, fallback: string) => fallback,
  notificationsApi: { list: notifyMocks.list, setState: notifyMocks.setState },
}));

import { NotificationsPanel } from "@/components/NotificationsPanel";

function notification(overrides: Record<string, unknown> = {}) {
  return {
    id: "note-1",
    kind: "first_draft",
    state: "unread",
    detail: "Weekly finance draft is ready for review",
    recipe_id: "brief-1",
    run_id: "run-1",
    created_at: "2026-09-07T07:05:00Z",
    updated_at: "2026-09-07T07:05:00Z",
    read_at: null,
    ...overrides,
  };
}

describe("NotificationsPanel", () => {
  beforeEach(() => {
    notifyMocks.list.mockReset();
    notifyMocks.setState.mockReset();
    notifyMocks.list.mockResolvedValue({ items: [notification()], next_cursor: null });
    notifyMocks.setState.mockImplementation(async (_id: string, state: "read" | "dismissed") =>
      notification({ state, read_at: state === "read" ? "2026-09-07T08:00:00Z" : null }),
    );
  });

  it("loads the bounded page and shows the unread badge from the loaded total", async () => {
    notifyMocks.list.mockResolvedValue({
      items: [
        notification(),
        notification({ id: "note-2", kind: "meaningful_change" }),
        notification({ id: "note-3", state: "read" }),
      ],
      next_cursor: null,
    });
    render(<NotificationsPanel />);

    await waitFor(() => expect(notifyMocks.list).toHaveBeenCalledWith({ limit: 20 }));
    const bell = await screen.findByRole("button", { name: /Notifications/ });
    expect(bell).toHaveAccessibleName(/2 unread notifications/);
  });

  it("marks the badge as unbounded when older pages exist", async () => {
    notifyMocks.list.mockResolvedValue({ items: [notification()], next_cursor: "older-page" });
    render(<NotificationsPanel />);

    const bell = await screen.findByRole("button", { name: /Notifications/ });
    expect(bell).toHaveAccessibleName(/1 unread notifications \(more in older pages\)/);
    expect(await screen.findByText("1+")).toBeInTheDocument();
  });

  it("reveals the tray with deduplicated events and never marks anything automatically", async () => {
    notifyMocks.list.mockResolvedValue({
      items: [
        notification({ id: "note-a" }),
        notification({ id: "note-b", kind: "attention", detail: "a brief run needs attention" }),
        notification({ id: "note-c", state: "read", kind: "paused", detail: "paused after five consecutive failures" }),
      ],
      next_cursor: null,
    });
    render(<NotificationsPanel />);

    await screen.findByText("2");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    expect(await screen.findByText("New draft ready")).toBeInTheDocument();
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getByText("Brief auto-paused")).toBeInTheDocument();
    // One row per server event — the server deduplicated per (run, kind).
    expect(screen.getAllByText("Weekly finance draft is ready for review")).toHaveLength(1);
    // Read rows never offer "Mark read" again.
    expect(screen.getAllByRole("button", { name: /Mark read/ })).toHaveLength(2);
    // Nothing automatic: no transition has been requested at all.
    expect(notifyMocks.setState).not.toHaveBeenCalled();
  });

  it("marks read durably through the durable transition route", async () => {
    render(<NotificationsPanel />);

    await screen.findByText("1");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    fireEvent.click(await screen.findByRole("button", { name: /Mark read/ }));
    await waitFor(() => expect(notifyMocks.setState).toHaveBeenCalledWith("note-1", "read"));
    // The server-returned durable state replaces the row: the event stays in
    // the tray as read (only dismiss removes it from view), and the unread
    // badge drops to zero.
    expect(screen.getByText("Weekly finance draft is ready for review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark read/ })).not.toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("removes dismissed events from the tray without deleting them", async () => {
    render(<NotificationsPanel />);

    await screen.findByText("1");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));

    fireEvent.click(await screen.findByRole("button", { name: /Dismiss/ }));
    await waitFor(() => expect(notifyMocks.setState).toHaveBeenCalledWith("note-1", "dismissed"));
    expect(screen.queryByText("Weekly finance draft is ready for review")).not.toBeInTheDocument();
    expect(await screen.findByText(/Dismissed events stay durable/)).toBeInTheDocument();
  });

  it("keeps an older page reachable and never sends anything outbound", async () => {
    notifyMocks.list
      .mockResolvedValueOnce({ items: [notification()], next_cursor: "older" })
      .mockResolvedValueOnce({ items: [notification({ id: "note-old", detail: "older event" })], next_cursor: null });
    render(<NotificationsPanel />);

    await screen.findByText("1+");
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Load older notifications" }));

    await waitFor(() => expect(notifyMocks.list).toHaveBeenLastCalledWith({ cursor: "older", limit: 20 }));
    expect(await screen.findByText("older event")).toBeInTheDocument();
    expect(screen.getByText(/never sent anywhere/i)).toBeInTheDocument();
  });
});
