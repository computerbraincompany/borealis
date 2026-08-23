import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ q: vi.fn(), pool: { connect: vi.fn() } }));
vi.mock("../pythonClient.js", () => ({
  py: { registerDataset: vi.fn() },
}));

import { q } from "../db.js";
import { restoreDatasets } from "../ingest.js";
import { py } from "../pythonClient.js";

const qMock = vi.mocked(q);
const registerMock = vi.mocked(py.registerDataset);

afterEach(() => {
  qMock.mockReset();
  registerMock.mockReset();
  vi.restoreAllMocks();
});

describe("dataset restoration", () => {
  it("restores uploads as paths and connectors with URL provenance", async () => {
    qMock.mockResolvedValueOnce([
      {
        account_id: "acct-upload",
        name: "ledger",
        file_path: "/safe/uploads/ledger.json",
        display_name: "Ledger.json",
        url: null,
        connector: null,
      },
      {
        account_id: "acct-connector",
        name: "balances",
        file_path: "/safe/cache/balances.csv",
        display_name: "Balances feed",
        url: "https://example.invalid/balances.csv?signature=secret",
        connector: "connector-id",
      },
    ]);
    registerMock.mockResolvedValue([] as any);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await restoreDatasets();

    expect(registerMock).toHaveBeenNthCalledWith(1, "acct-upload", "ledger", {
      location: "/safe/uploads/ledger.json",
      kind: "path",
      originalName: "Ledger.json",
    });
    expect(registerMock).toHaveBeenNthCalledWith(2, "acct-connector", "balances", {
      location: "/safe/cache/balances.csv",
      kind: "url",
      url: "https://example.invalid/balances.csv?signature=secret",
      originalName: "Balances feed",
    });
  });
});
