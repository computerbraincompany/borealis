import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  runs: vi.fn(),
  connectorsList: vi.fn(),
  chatsList: vi.fn(),
  briefsList: vi.fn(),
  briefsGet: vi.fn(),
  briefsCreate: vi.fn(),
  briefsUpdate: vi.fn(),
  briefsPause: vi.fn(),
  briefsResume: vi.fn(),
  briefsSetNotifications: vi.fn(),
  briefsRemove: vi.fn(),
  briefsRun: vi.fn(),
  briefsListRuns: vi.fn(),
  briefsGetRun: vi.fn(),
  briefsCancelRun: vi.fn(),
  analysesList: vi.fn(),
  analysesGet: vi.fn(),
  sourcesList: vi.fn(),
  knowledgeList: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  formatApiError: (error: unknown, fallback: string) =>
    error instanceof Error && error.name === "ApiError" ? error.message : fallback,
  isRemoteEgressConsentError: () => false,
  consentApi: { get: vi.fn(), acknowledge: vi.fn() },
  automationsApi: {
    list: apiMocks.list,
    create: apiMocks.create,
    update: apiMocks.update,
    remove: apiMocks.remove,
    runs: apiMocks.runs,
  },
  connectorsApi: { list: apiMocks.connectorsList },
  chatsApi: { list: apiMocks.chatsList },
  briefScheduleLabel: (schedule: { kind: string }) => `schedule ${schedule.kind}`,
  isBriefActiveRunStage: (stage: string) =>
    ["queued", "refreshing", "waiting_ready", "analyzing", "drafting", "publishing"].includes(stage),
  BRIEF_PIPELINE_STAGES: ["queued", "refreshing", "waiting_ready", "analyzing", "drafting", "awaiting_review"],
  briefsApi: {
    list: apiMocks.briefsList,
    get: apiMocks.briefsGet,
    create: apiMocks.briefsCreate,
    update: apiMocks.briefsUpdate,
    pause: apiMocks.briefsPause,
    resume: apiMocks.briefsResume,
    setNotifications: apiMocks.briefsSetNotifications,
    remove: apiMocks.briefsRemove,
    run: apiMocks.briefsRun,
    listRuns: apiMocks.briefsListRuns,
    getRun: apiMocks.briefsGetRun,
    cancelRun: apiMocks.briefsCancelRun,
  },
  analysesApi: { list: apiMocks.analysesList, get: apiMocks.analysesGet },
  sourcesApi: { list: apiMocks.sourcesList },
  knowledgeApi: { list: apiMocks.knowledgeList },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import { AutomationsView } from "@/pages/AutomationsView";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const automation = {
  id: "auto-1",
  name: "Nightly ledger",
  kind: "connector_sync" as const,
  target_id: "conn-1",
  prompt: null,
  schedule_minutes: 60,
  state: "active" as const,
  consecutive_failures: 0,
  last_run_at: null,
  next_run_at: "2026-01-02T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("AutomationsView", () => {
  beforeEach(() => {
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.list.mockResolvedValue({ items: [automation], next_cursor: null });
    apiMocks.connectorsList.mockResolvedValue({ items: [{ id: "conn-1", name: "Ledger feed" }], next_cursor: null });
    apiMocks.chatsList.mockResolvedValue({ items: [{ id: "chat-1", title: "Digest chat" }], next_cursor: null });
    apiMocks.briefsList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.briefsListRuns.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.analysesList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.sourcesList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.knowledgeList.mockResolvedValue({ items: [], next_cursor: null });
    apiMocks.runs.mockResolvedValue([
      {
        id: 1,
        outcome: "failed",
        detail: "the automation could not complete this run",
        started_at: "2026-01-02T00:00:00Z",
        finished_at: null,
      },
    ]);
  });

  it("lists automations with kind and schedule", async () => {
    render(<AutomationsView />);

    expect(await screen.findByText("Nightly ledger")).toBeInTheDocument();
    expect(screen.getByText("connector refresh")).toBeInTheDocument();
    expect(screen.getByText("every 60 min")).toBeInTheDocument();
  });

  it("creates a connector-refresh automation", async () => {
    apiMocks.create.mockResolvedValue({ ...automation, id: "auto-2", name: "Weekly sync" });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Weekly sync" } });
    fireEvent.change(screen.getByLabelText("Automation kind"), { target: { value: "connector_sync" } });
    fireEvent.change(screen.getByLabelText("Automation target"), { target: { value: "conn-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(apiMocks.create).toHaveBeenCalledWith(
        {
          name: "Weekly sync",
          kind: "connector_sync",
          target_id: "conn-1",
          schedule_minutes: 60,
        },
        expect.any(AbortSignal),
      ),
    );
  });

  it("reconciles the authoritative catalog after create supersedes an unresolved refresh", async () => {
    const stale = deferred<{ items: Array<typeof automation>; next_cursor: null }>();
    const created = { ...automation, id: "auto-2", name: "Weekly sync" };
    apiMocks.list
      .mockResolvedValueOnce({ items: [automation], next_cursor: null })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ items: [created, automation], next_cursor: null });
    apiMocks.create.mockResolvedValue(created);
    render(<AutomationsView />);

    expect(await screen.findByText("Nightly ledger")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /New automation/i }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Weekly sync" } });
    fireEvent.change(screen.getByLabelText("Automation target"), { target: { value: "conn-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("Weekly sync")).toBeInTheDocument();
    expect(screen.getByText("Nightly ledger")).toBeInTheDocument();
    await act(async () => stale.resolve({ items: [automation], next_cursor: null }));
    expect(screen.getByText("Weekly sync")).toBeInTheDocument();
    expect(screen.getByText("Nightly ledger")).toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "holds the create dialog open until the in-flight request settles as %s",
    async (settlement) => {
      const pending = deferred<typeof automation>();
      apiMocks.create.mockReturnValue(pending.promise);
      render(<AutomationsView />);

      fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
      fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "First automation" } });
      fireEvent.change(screen.getByLabelText("Automation target"), { target: { value: "conn-1" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(1));
      expect(apiMocks.create.mock.calls[0][0]).toEqual({
        name: "First automation",
        kind: "connector_sync",
        target_id: "conn-1",
        schedule_minutes: 60,
      });
      expect(apiMocks.create.mock.calls[0][1]).toBeInstanceOf(AbortSignal);

      // Mid-flight the dialog cannot be dismissed: a committed automation must
      // never be left invisible, so both dismiss controls stay disabled.
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("heading", { name: "New automation" })).toBeInTheDocument();

      await act(async () => {
        if (settlement === "resolve") {
          pending.resolve({ ...automation, id: "auto-2", name: "First automation" });
        } else {
          pending.reject(new Error("create failed"));
        }
      });

      if (settlement === "resolve") {
        await waitFor(() => expect(screen.queryByRole("heading", { name: "New automation" })).not.toBeInTheDocument());
        expect(screen.getByText("First automation")).toBeInTheDocument();
      } else {
        // The failure is kept inside the still-open dialog, never silent.
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "New automation" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      }
    },
  );

  it("aborts and invalidates a pending create when unmounted", async () => {
    const pending = deferred<typeof automation>();
    apiMocks.create.mockReturnValue(pending.promise);
    const { unmount } = render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Unmounted automation" } });
    fireEvent.change(screen.getByLabelText("Automation target"), { target: { value: "conn-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(apiMocks.create).toHaveBeenCalledTimes(1));
    const signal = apiMocks.create.mock.calls[0][1] as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ ...automation, id: "auto-late", name: "Unmounted automation" }));
  });

  it("reaches automation targets across repeated bounded pages", async () => {
    apiMocks.connectorsList.mockImplementation((options?: { cursor?: string }) => {
      if (options?.cursor === "connectors-page-2") {
        return Promise.resolve({ items: [{ id: "conn-2", name: "Older feed" }], next_cursor: "connectors-page-3" });
      }
      if (options?.cursor === "connectors-page-3") {
        return Promise.resolve({ items: [{ id: "conn-3", name: "Oldest feed" }], next_cursor: null });
      }
      return Promise.resolve({ items: [{ id: "conn-1", name: "Ledger feed" }], next_cursor: "connectors-page-2" });
    });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.click(screen.getByRole("button", { name: "Load older connectors" }));
    await screen.findByRole("option", { name: "Older feed" });
    fireEvent.click(screen.getByRole("button", { name: "Load older connectors" }));

    expect(await screen.findByRole("option", { name: "Oldest feed" })).toBeInTheDocument();
    expect(apiMocks.connectorsList).toHaveBeenCalledWith({
      cursor: "connectors-page-2",
      signal: expect.any(AbortSignal),
    });
    expect(apiMocks.connectorsList).toHaveBeenCalledWith({
      cursor: "connectors-page-3",
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts obsolete target pagination on kind change and lets the new kind load immediately", async () => {
    const obsolete = deferred<{ items: Array<{ id: string; name: string }>; next_cursor: null }>();
    apiMocks.connectorsList.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor
        ? obsolete.promise
        : Promise.resolve({ items: [{ id: "conn-1", name: "Ledger feed" }], next_cursor: "connector-page-2" }),
    );
    apiMocks.chatsList.mockImplementation((options?: { cursor?: string }) =>
      Promise.resolve(
        options?.cursor
          ? { items: [{ id: "chat-2", title: "Older digest" }], next_cursor: null }
          : { items: [{ id: "chat-1", title: "Digest chat" }], next_cursor: "chat-page-2" },
      ),
    );
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.click(screen.getByRole("button", { name: "Load older connectors" }));
    await waitFor(() => expect(apiMocks.connectorsList).toHaveBeenCalledTimes(2));
    const obsoleteSignal = apiMocks.connectorsList.mock.calls[1][0].signal as AbortSignal;
    fireEvent.change(screen.getByLabelText("Automation kind"), { target: { value: "agent_turn" } });
    expect(obsoleteSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load older chats" }));

    expect(await screen.findByRole("option", { name: "Older digest" })).toBeInTheDocument();
    await act(async () => obsolete.reject(new Error("obsolete connector page failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("aborts target pagination when the create dialog closes", async () => {
    const pending = deferred<{ items: Array<{ id: string; name: string }>; next_cursor: null }>();
    apiMocks.connectorsList.mockImplementation((options?: { cursor?: string }) =>
      options?.cursor
        ? pending.promise
        : Promise.resolve({ items: [{ id: "conn-1", name: "Ledger feed" }], next_cursor: "connector-page-2" }),
    );
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: /New automation/i }));
    fireEvent.click(screen.getByRole("button", { name: "Load older connectors" }));
    await waitFor(() => expect(apiMocks.connectorsList).toHaveBeenCalledTimes(2));
    const signal = apiMocks.connectorsList.mock.calls[1][0].signal as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error("closed target page failed")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows durable run history with generic failure details", async () => {
    render(<AutomationsView />);

    fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
    expect(await screen.findByText("failed")).toBeInTheDocument();
    expect(screen.getByText(/the automation could not complete this run/)).toBeInTheDocument();
  });

  it("keeps run history owned by the newest dialog target", async () => {
    const older = deferred<Awaited<ReturnType<typeof apiMocks.runs>>>();
    const newer = deferred<Awaited<ReturnType<typeof apiMocks.runs>>>();
    const secondAutomation = { ...automation, id: "auto-2", name: "Weekly digest" };
    apiMocks.list.mockResolvedValue({ items: [automation, secondAutomation], next_cursor: null });
    apiMocks.runs.mockImplementation((id: string) => (id === automation.id ? older.promise : newer.promise));
    render(<AutomationsView />);

    const buttons = await screen.findAllByRole("button", { name: "Runs" });
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(apiMocks.runs).toHaveBeenCalledWith("auto-1", 20, expect.any(AbortSignal)));
    const olderSignal = apiMocks.runs.mock.calls[0][2] as AbortSignal;

    fireEvent.click(buttons[1]);
    await waitFor(() => expect(apiMocks.runs).toHaveBeenCalledWith("auto-2", 20, expect.any(AbortSignal)));
    expect(olderSignal.aborted).toBe(true);

    await act(async () =>
      newer.resolve([
        {
          id: 2,
          outcome: "succeeded",
          detail: "new target result",
          started_at: "2026-01-03T00:00:00Z",
          finished_at: "2026-01-03T00:01:00Z",
        },
      ]),
    );
    expect(await screen.findByText("new target result")).toBeInTheDocument();

    await act(async () =>
      older.resolve([
        {
          id: 1,
          outcome: "failed",
          detail: "stale target result",
          started_at: "2026-01-02T00:00:00Z",
          finished_at: null,
        },
      ]),
    );
    expect(screen.queryByText("stale target result")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weekly digest runs" })).toBeInTheDocument();
  });

  it("pauses and resumes an automation", async () => {
    apiMocks.update.mockResolvedValue({ ...automation, state: "paused" });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByTitle("Pause automation"));
    await waitFor(() =>
      expect(apiMocks.update).toHaveBeenCalledWith("auto-1", { state: "paused" }, expect.any(AbortSignal)),
    );
    expect(await screen.findByTitle("Resume automation")).toBeInTheDocument();
  });

  it("deletes an automation", async () => {
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<AutomationsView />);

    fireEvent.click(await screen.findByTitle("Delete automation"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledWith("auto-1", expect.any(AbortSignal)));
    await waitFor(() => expect(screen.queryByText("Nightly ledger")).not.toBeInTheDocument());
  });

  it("does not let a stale catalog refresh resurrect a successfully deleted automation", async () => {
    const stale = deferred<{ items: Array<typeof automation>; next_cursor: null }>();
    apiMocks.list.mockResolvedValueOnce({ items: [automation], next_cursor: null }).mockReturnValueOnce(stale.promise);
    apiMocks.remove.mockResolvedValue({ ok: true });
    render(<AutomationsView />);

    expect(await screen.findByText("Nightly ledger")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(apiMocks.list).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByTitle("Delete automation"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Nightly ledger")).not.toBeInTheDocument());

    await act(async () => stale.resolve({ items: [automation], next_cursor: null }));
    expect(screen.queryByText("Nightly ledger")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a newer same-row deletion owned when the older toggle later %ss",
    async (settlement) => {
      const older = deferred<Awaited<ReturnType<typeof apiMocks.update>>>();
      const newer = deferred<{ ok: true }>();
      apiMocks.update.mockReturnValue(older.promise);
      apiMocks.remove.mockReturnValue(newer.promise);
      render(<AutomationsView />);

      fireEvent.click(await screen.findByTitle("Pause automation"));
      await waitFor(() => expect(apiMocks.update).toHaveBeenCalledTimes(1));
      const olderSignal = apiMocks.update.mock.calls[0][2] as AbortSignal;
      fireEvent.click(screen.getByTitle("Delete automation"));
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledTimes(1));
      expect(olderSignal.aborted).toBe(true);

      await act(async () => {
        if (settlement === "resolve") older.resolve({ ...automation, state: "paused" });
        else older.reject(new Error("stale toggle failed"));
      });

      expect(screen.getByText("Nightly ledger")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => newer.resolve({ ok: true }));
      expect(screen.queryByText("Nightly ledger")).not.toBeInTheDocument();
    },
  );

  describe("reviewed briefs section", () => {
    const briefRecipe = {
      id: "brief-1",
      kind: "reviewed_brief" as const,
      name: "Weekly finance",
      revision: 3,
      state: "active" as const,
      paused_reason: null,
      notifications_enabled: true,
      consecutive_failures: 0,
      analysis_id: "analysis-1",
      analysis_revision: 2,
      parameter_values: [],
      report_title: "Weekly finance brief",
      report_instruction: "Summarize weekly.",
      source_ids: ["src-a"],
      refresh_bindings: [],
      schedule: {
        kind: "weekly" as const,
        weekday: 1,
        day_of_month: null,
        hour: 9,
        minute: 0,
        time_zone: "Europe/Berlin",
      },
      next_occurrence_key: "2026-09-07T09:00",
      next_run_at: "2026-09-07T07:00:00Z",
      last_run_at: null,
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    };
    const briefRecipeDetail = {
      ...briefRecipe,
      revision: 4,
      next_occurrences: [
        { occurrence_key: "2026-09-07T09:00", civil: "2026-09-07T09:00", utc_at: "2026-09-07T07:00:00.000Z" },
        { occurrence_key: "2026-09-14T09:00", civil: "2026-09-14T09:00", utc_at: "2026-09-14T07:00:00.000Z" },
        { occurrence_key: "2026-09-21T09:00", civil: "2026-09-21T09:00", utc_at: "2026-09-21T07:00:00.000Z" },
      ],
    };
    const analysisFixture = {
      id: "analysis-1",
      current_revision: 2,
      title: "Monthly spend",
      description: "",
      sql: "SELECT 1",
      parameters: [],
      source_ids: ["src-a"],
      comparison_key: null,
      origin: { chat_id: null, run_id: null, capture_id: null },
      revision_created_at: "2026-09-01T00:00:00Z",
      sources: [],
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    };
    const briefRun = {
      id: "run-new",
      recipe_id: "brief-1",
      trigger: "manual",
      operation_id: "op-1",
      occurrence_key: "manual-op-1",
      recipe_revision: 4,
      stage: "queued",
      stage_attempts: 1,
      cancel_requested: false,
      deadline_at: "2026-09-07T07:30:00Z",
      refresh_deadline_at: null,
      coalesced_count: 0,
      missed_through_key: null,
      analysis_run_id: null,
      baseline_run_id: null,
      analysis_succeeded: false,
      document_id: null,
      document_revision_id: null,
      reviewed_revision_id: null,
      publication_operation_id: null,
      publication_error_code: null,
      failure_code: null,
      failure_reason: null,
      created_at: "2026-09-06T07:00:00Z",
      started_at: null,
      stage_updated_at: "2026-09-06T07:00:00Z",
      finished_at: null,
    };

    function briefApiError(message: string, code: string, status = 400) {
      const error = new Error(message) as Error & { name: string; status: number; data: unknown };
      error.name = "ApiError";
      error.status = status;
      error.data = { code };
      return error;
    }

    beforeEach(() => {
      apiMocks.briefsList.mockResolvedValue({ items: [briefRecipe], next_cursor: null });
      apiMocks.briefsGet.mockResolvedValue(briefRecipeDetail);
      apiMocks.briefsListRuns.mockResolvedValue({ items: [], next_cursor: null });
      apiMocks.analysesList.mockResolvedValue({
        items: [
          {
            id: "analysis-1",
            title: "Monthly spend",
            description: "",
            current_revision: 2,
            source_count: 1,
            unavailable_source_count: 0,
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-01T00:00:00Z",
          },
        ],
        next_cursor: null,
      });
      apiMocks.analysesGet.mockResolvedValue(analysisFixture);
      apiMocks.sourcesList.mockResolvedValue({
        items: [
          {
            id: "src-a",
            name: "ledger.csv",
            display_name: "ledger.csv",
            kind: "tabular",
            mime: "text/csv",
            status: "ready",
            created_at: "2026-09-01T00:00:00Z",
            meta: null,
          },
        ],
        next_cursor: null,
      });
      apiMocks.knowledgeList.mockResolvedValue({ items: [], next_cursor: null });
    });

    it("lists reviewed briefs as a distinct section beside the interval automations", async () => {
      render(<AutomationsView />);

      expect(await screen.findByText("Nightly ledger")).toBeInTheDocument();
      expect(await screen.findByText("Weekly finance")).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Reviewed briefs" })).toBeInTheDocument();
      expect(screen.getByText("reviewed brief")).toBeInTheDocument();
      expect(screen.getByText("schedule weekly")).toBeInTheDocument();
    });

    it("edits with the loaded recipe revision as the CAS guard and surfaces conflicts inside the wizard", async () => {
      apiMocks.briefsUpdate.mockRejectedValueOnce(
        briefApiError("brief recipe revision conflict", "BRIEF_REVISION_CONFLICT", 409),
      );
      render(<AutomationsView />);

      fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
      fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));

      // The edit wizard is seeded from the server detail (revision 4).
      expect(await screen.findByRole("heading", { name: "Edit “Weekly finance”" })).toBeInTheDocument();
      await screen.findByRole("checkbox", { name: "Source ledger.csv" });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() =>
        expect(apiMocks.briefsUpdate).toHaveBeenCalledWith(
          "brief-1",
          expect.objectContaining({ expected_revision: 4, source_ids: ["src-a"] }),
          expect.any(AbortSignal),
        ),
      );
      expect(await screen.findByText(/This recipe changed since you opened it/)).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Edit “Weekly finance”" })).toBeInTheDocument();

      apiMocks.briefsUpdate.mockResolvedValue({ ...briefRecipeDetail, revision: 5 });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(apiMocks.briefsUpdate).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "Edit “Weekly finance”" })).not.toBeInTheDocument(),
      );
    });

    it("shows the server's next three resolved run times and the running-app caveat in the schedule editor", async () => {
      render(<AutomationsView />);

      fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
      fireEvent.click(await screen.findByRole("button", { name: /Edit/ }));
      await screen.findByText("ledger.csv");

      expect(screen.getByText("2026-09-07 09:00")).toBeInTheDocument();
      expect(screen.getByText("2026-09-14 09:00")).toBeInTheDocument();
      expect(screen.getByText("2026-09-21 09:00")).toBeInTheDocument();
      expect(screen.getByText("2026-09-07 07:00:00Z")).toBeInTheDocument();
      expect(
        screen.getByText("The app/server must be running for schedules to fire — there is no OS scheduler."),
      ).toBeInTheDocument();
    });

    it("mirrors the server's membership-equality error and never sends a widened source set", async () => {
      apiMocks.briefsCreate.mockRejectedValueOnce(
        briefApiError(
          "recipe source membership must equal the bound analysis revision's selected source set",
          "BRIEF_RECIPE_VALIDATION",
        ),
      );
      render(<AutomationsView />);

      fireEvent.click(await screen.findByRole("button", { name: "New brief" }));
      fireEvent.change(screen.getByLabelText("Brief name"), { target: { value: "Monday brief" } });
      await screen.findByRole("option", { name: "Monthly spend (rev 2)" });
      fireEvent.change(screen.getByLabelText("Saved analysis"), { target: { value: "analysis-1" } });
      fireEvent.change(screen.getByLabelText("Report title"), { target: { value: "Monday brief" } });
      fireEvent.change(screen.getByLabelText("Draft instruction"), { target: { value: "Sum it up." } });

      // Membership is locked to the bound revision's selected set.
      const membershipCheckbox = await screen.findByRole("checkbox", { name: "Source ledger.csv" });
      expect(membershipCheckbox).toBeChecked();
      expect(membershipCheckbox).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
      await waitFor(() =>
        expect(apiMocks.briefsCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            name: "Monday brief",
            analysis_id: "analysis-1",
            source_ids: ["src-a"],
            report_title: expect.any(String),
            report_instruction: expect.any(String),
            schedule: expect.objectContaining({ kind: "weekly", weekday: 1 }),
          }),
          expect.any(AbortSignal),
        ),
      );
      // The wizard mirrors the exact server contract violation.
      expect(
        await screen.findByText(
          "recipe source membership must equal the bound analysis revision's selected source set",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "New reviewed brief" })).toBeInTheDocument();

      apiMocks.briefsCreate.mockResolvedValue({ ...briefRecipe, id: "brief-2", name: "Monday brief" });
      fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
      await waitFor(() => expect(apiMocks.briefsCreate).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("Monday brief")).toBeInTheDocument();
    });

    it("reuses the same client-generated idempotency key when Run now is retried after a lost response", async () => {
      const pending = deferred<{ items: Array<typeof briefRun>; next_cursor: null }>();
      apiMocks.briefsListRuns.mockReturnValue(pending.promise);
      apiMocks.briefsRun.mockRejectedValueOnce(new Error("network down"));
      render(<AutomationsView />);

      fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
      fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
      await waitFor(() => expect(apiMocks.briefsRun).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/Retry replays the same request/)).toBeInTheDocument();
      await act(async () => pending.resolve({ items: [], next_cursor: null }));

      apiMocks.briefsRun.mockResolvedValueOnce({ run: briefRun, replayed: false });
      fireEvent.click(screen.getByRole("button", { name: "Run now" }));
      await waitFor(() => expect(apiMocks.briefsRun).toHaveBeenCalledTimes(2));

      // Same durable intent → same UUID key: a retry can never double-run.
      const firstKey = apiMocks.briefsRun.mock.calls[0][1].operation_id;
      const secondKey = apiMocks.briefsRun.mock.calls[1][1].operation_id;
      expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
      expect(secondKey).toBe(firstKey);
      expect(await screen.findByText("queued")).toBeInTheDocument();
    });

    it("states the pending-review preservation default in the delete dialog and stops the brief", async () => {
      const stale = deferred<{ items: Array<typeof briefRecipe>; next_cursor: null }>();
      apiMocks.briefsList
        .mockResolvedValueOnce({ items: [briefRecipe], next_cursor: null })
        .mockReturnValueOnce(stale.promise);
      apiMocks.briefsRemove.mockResolvedValue({ ok: true });
      render(<AutomationsView />);

      expect(await screen.findByText("Weekly finance")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Refresh briefs" }));
      await waitFor(() => expect(apiMocks.briefsList).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByTitle("Delete brief"));
      expect(await screen.findByText(/Pending and rejected drafts are preserved \(default\)/)).toBeInTheDocument();
      fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
      await waitFor(() => expect(apiMocks.briefsRemove).toHaveBeenCalledWith("brief-1", expect.any(AbortSignal)));
      await waitFor(() => expect(screen.queryByText("Weekly finance")).not.toBeInTheDocument());

      // A stale brief catalog response cannot resurrect the deleted recipe.
      await act(async () => stale.resolve({ items: [briefRecipe], next_cursor: null }));
      expect(screen.queryByText("Weekly finance")).not.toBeInTheDocument();
    });

    it("pauses a brief through the durable pause route", async () => {
      let pausedNow = false;
      apiMocks.briefsList.mockImplementation(async () => ({
        items: [pausedNow ? { ...briefRecipe, state: "paused", paused_reason: "paused manually" } : briefRecipe],
        next_cursor: null,
      }));
      apiMocks.briefsPause.mockImplementation(async () => {
        pausedNow = true;
        return { ...briefRecipe, state: "paused", paused_reason: "paused manually" };
      });
      render(<AutomationsView />);

      fireEvent.click(await screen.findByTitle("Pause brief"));
      await waitFor(() => expect(apiMocks.briefsPause).toHaveBeenCalledWith("brief-1", expect.any(AbortSignal)));
      expect(await screen.findByText(/paused: paused manually/)).toBeInTheDocument();
    });
  });

  it("keeps different-row mutations concurrent and aborts all of them on unmount", async () => {
    const toggle = deferred<Awaited<ReturnType<typeof apiMocks.update>>>();
    const deletion = deferred<{ ok: true }>();
    const secondAutomation = { ...automation, id: "auto-2", name: "Weekly digest" };
    apiMocks.list.mockResolvedValue({ items: [automation, secondAutomation], next_cursor: null });
    apiMocks.update.mockReturnValue(toggle.promise);
    apiMocks.remove.mockReturnValue(deletion.promise);
    const { unmount } = render(<AutomationsView />);

    const pauseButtons = await screen.findAllByTitle("Pause automation");
    const deleteButtons = screen.getAllByTitle("Delete automation");
    fireEvent.click(pauseButtons[0]);
    fireEvent.click(deleteButtons[1]);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiMocks.update).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiMocks.remove).toHaveBeenCalledTimes(1));
    const toggleSignal = apiMocks.update.mock.calls[0][2] as AbortSignal;
    const deleteSignal = apiMocks.remove.mock.calls[0][1] as AbortSignal;
    expect(toggleSignal.aborted).toBe(false);
    expect(deleteSignal.aborted).toBe(false);

    unmount();
    expect(toggleSignal.aborted).toBe(true);
    expect(deleteSignal.aborted).toBe(true);
    await act(async () => {
      toggle.resolve({ ...automation, state: "paused" });
      deletion.reject(new Error("late deletion failed"));
    });
  });
});
