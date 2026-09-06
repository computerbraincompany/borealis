import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRuntimeSettings: vi.fn(),
  getRemoteEgressAcknowledgment: vi.fn(),
  createEmbeddingExecutor: vi.fn(),
  recordEgressEvent: vi.fn(async () => undefined),
}));

vi.mock("../runtimeSettings.js", () => ({ getRuntimeSettings: mocks.getRuntimeSettings }));
vi.mock("../storageRuntime.js", () => ({
  storageRuntime: () => ({ chats: { getRemoteEgressAcknowledgment: mocks.getRemoteEgressAcknowledgment } }),
}));
vi.mock("../llm.js", () => ({ createEmbeddingExecutor: mocks.createEmbeddingExecutor }));
vi.mock("../egressAudit.js", () => ({ recordEgressEvent: mocks.recordEgressEvent }));

import { RemoteEgressConsentRequiredError } from "../egressPolicy.js";
import { createAuthorizedIngestionEmbeddingSession } from "../ingestionEmbedding.js";
import type { EffectiveLlmSettings } from "../settingsStore.js";

const LOCAL: EffectiveLlmSettings = {
  llmBaseUrl: "http://127.0.0.1:1234",
  chatModel: "chat",
  embedModel: "embed-a",
  embeddingDimension: 3,
};
const REMOTE: EffectiveLlmSettings = { ...LOCAL, llmBaseUrl: "https://provider.example.test" };

function snapshot(settings: EffectiveLlmSettings, revision: number) {
  return Object.freeze({ settings: Object.freeze(settings), revision, environmentOverrides: [], fileStatus: "loaded" });
}

describe("durable ingestion embedding authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(LOCAL, 1));
    mocks.getRemoteEgressAcknowledgment.mockResolvedValue({ acknowledgedAt: null, origin: null });
    mocks.createEmbeddingExecutor.mockImplementation((settings: EffectiveLlmSettings) => {
      const baseUrl = settings.llmBaseUrl;
      return vi.fn(async (texts: string[]) => texts.map(() => (baseUrl === LOCAL.llmBaseUrl ? [1, 0, 0] : [0, 1, 0])));
    });
  });

  it("performs no transport work when a queued local job resumes under an unacknowledged remote provider", async () => {
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(REMOTE, 2));

    await expect(createAuthorizedIngestionEmbeddingSession("account-a")).rejects.toBeInstanceOf(
      RemoteEgressConsentRequiredError
    );
    expect(mocks.getRemoteEgressAcknowledgment).toHaveBeenCalledWith("account-a");
    expect(mocks.createEmbeddingExecutor).not.toHaveBeenCalled();
    expect(mocks.recordEgressEvent).not.toHaveBeenCalled();
  });

  it("binds all batches to the exact acknowledged provider snapshot", async () => {
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(REMOTE, 2));
    mocks.getRemoteEgressAcknowledgment.mockResolvedValue({
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      origin: "https://provider.example.test",
    });
    const session = await createAuthorizedIngestionEmbeddingSession("account-a");
    mocks.getRuntimeSettings.mockResolvedValue(snapshot({ ...REMOTE, llmBaseUrl: "https://other.example.test" }, 3));

    await expect(session(["one", "two"])).resolves.toEqual([
      [0, 1, 0],
      [0, 1, 0],
    ]);
    expect(mocks.createEmbeddingExecutor).toHaveBeenCalledWith(REMOTE, REMOTE.embedModel);
    expect(mocks.getRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(mocks.recordEgressEvent).toHaveBeenCalledWith("remote_ingest", "account-a", "provider.example.test");
  });

  it("denies an A timestamp paired with a B origin before any executor or transport work", async () => {
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(REMOTE, 2));
    // The stored pair acknowledges a different provider origin than the job's
    // captured snapshot targets.
    mocks.getRemoteEgressAcknowledgment.mockResolvedValue({
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      origin: "https://other.example.test",
    });

    await expect(createAuthorizedIngestionEmbeddingSession("account-a")).rejects.toBeInstanceOf(
      RemoteEgressConsentRequiredError
    );
    expect(mocks.createEmbeddingExecutor).not.toHaveBeenCalled();
    expect(mocks.recordEgressEvent).not.toHaveBeenCalled();
    expect(mocks.getRuntimeSettings).toHaveBeenCalledTimes(1);
  });

  it("denies a legacy timestamp-only pair with a null origin", async () => {
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(REMOTE, 2));
    mocks.getRemoteEgressAcknowledgment.mockResolvedValue({
      acknowledgedAt: "2026-09-01T00:00:00.000Z",
      origin: null,
    });

    await expect(createAuthorizedIngestionEmbeddingSession("account-a")).rejects.toBeInstanceOf(
      RemoteEgressConsentRequiredError
    );
    expect(mocks.createEmbeddingExecutor).not.toHaveBeenCalled();
    expect(mocks.recordEgressEvent).not.toHaveBeenCalled();
  });

  it("authorizes independently for each owning account", async () => {
    mocks.getRuntimeSettings.mockResolvedValue(snapshot(REMOTE, 2));
    mocks.getRemoteEgressAcknowledgment.mockImplementation(async (accountId: string) =>
      accountId === "acknowledged"
        ? { acknowledgedAt: "2026-09-01T00:00:00.000Z", origin: "https://provider.example.test" }
        : { acknowledgedAt: null, origin: null }
    );

    await expect(createAuthorizedIngestionEmbeddingSession("unacknowledged")).rejects.toBeInstanceOf(
      RemoteEgressConsentRequiredError
    );
    await expect(createAuthorizedIngestionEmbeddingSession("acknowledged")).resolves.toEqual(expect.any(Function));
    expect(mocks.createEmbeddingExecutor).toHaveBeenCalledTimes(1);
  });
});
