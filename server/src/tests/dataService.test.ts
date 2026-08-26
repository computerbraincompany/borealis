import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/datasets.js", () => ({
  activatePreparedDataset: vi.fn(),
  beginDatasetPreparation: vi.fn(),
  beginInactiveLocationCleanup: vi.fn(),
  catalogDatasets: vi.fn(),
  currentDatasetLocation: vi.fn(),
  datasetHealth: vi.fn(),
  deactivateDatasetIfLocation: vi.fn(),
  describeDataset: vi.fn(),
  endDatasetPreparation: vi.fn(),
  endInactiveLocationCleanup: vi.fn(),
  extractDataset: vi.fn(),
  extractDatasetCandidate: vi.fn(),
  inspectDataset: vi.fn(),
  listDatasets: vi.fn(),
  queryDataset: vi.fn(),
  registerDataset: vi.fn(),
}));

vi.mock("../data/connectorFetch.js", () => {
  class ConnectorFetchError extends Error {
    constructor(
      readonly status: number,
      message = "connector operation failed"
    ) {
      super(message);
      this.name = "ConnectorFetchError";
    }
  }
  return {
    ConnectorFetchError,
    claimConnectorVersion: vi.fn(),
    cleanupConnectorVersion: vi.fn(),
    connectorVersionPath: vi.fn(),
    downloadConnectorVersion: vi.fn(),
    resolveConnectorCacheFile: vi.fn(),
  };
});

vi.mock("../storageArtifacts.js", () => ({
  isMissingOwnedSourceArtifact: vi.fn(),
  resolveSourceArtifact: vi.fn(),
}));

vi.mock("../data/playwrightRender.js", () => ({
  renderChartPng: vi.fn(),
  renderReportPdf: vi.fn(),
}));

import {
  claimConnectorVersion,
  cleanupConnectorVersion,
  ConnectorFetchError,
  connectorVersionPath,
  downloadConnectorVersion,
  resolveConnectorCacheFile,
} from "../data/connectorFetch.js";
import {
  activatePreparedDataset,
  beginDatasetPreparation,
  beginInactiveLocationCleanup,
  catalogDatasets,
  currentDatasetLocation,
  datasetHealth,
  deactivateDatasetIfLocation,
  describeDataset,
  endDatasetPreparation,
  endInactiveLocationCleanup,
  extractDataset,
  extractDatasetCandidate,
  inspectDataset,
  listDatasets,
  queryDataset,
  registerDataset,
} from "../data/datasets.js";
import { DataServiceError as WorkerDataServiceError } from "../data/errors.js";
import { renderChartPng, renderReportPdf } from "../data/playwrightRender.js";
import { boundedRequestSignal, dataService, DataServiceError } from "../dataService.js";
import { isMissingOwnedSourceArtifact, resolveSourceArtifact } from "../storageArtifacts.js";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const VERSION = "33333333-3333-4333-8333-333333333333";
const CANDIDATE = "/uploads/url_cache/account/ledger/33333333333343338333333333333333.csv";
const PREVIOUS = "/uploads/url_cache/account/ledger/44444444444444448444444444444444.csv";
const metadata = {
  name: "ledger",
  location: CANDIDATE,
  safe_location: CANDIDATE,
  original_name: "Ledger.csv",
  rows: 2,
  columns: [{ name: "amount", type: "BIGINT" }],
  preview: [[10], [20]],
  preview_truncated: false,
  size_bytes: 20,
  file_signature: "20:123",
} as const;

const healthMock = vi.mocked(datasetHealth);
const registerMock = vi.mocked(registerDataset);
const inspectMock = vi.mocked(inspectDataset);
const currentLocationMock = vi.mocked(currentDatasetLocation);
const beginPreparationMock = vi.mocked(beginDatasetPreparation);
const endPreparationMock = vi.mocked(endDatasetPreparation);
const activateMock = vi.mocked(activatePreparedDataset);
const beginCleanupMock = vi.mocked(beginInactiveLocationCleanup);
const endCleanupMock = vi.mocked(endInactiveLocationCleanup);
const queryMock = vi.mocked(queryDataset);
const describeMock = vi.mocked(describeDataset);
const extractMock = vi.mocked(extractDataset);
const extractCandidateMock = vi.mocked(extractDatasetCandidate);
const listMock = vi.mocked(listDatasets);
const catalogMock = vi.mocked(catalogDatasets);
const deactivateMock = vi.mocked(deactivateDatasetIfLocation);
const connectorPathMock = vi.mocked(connectorVersionPath);
const downloadMock = vi.mocked(downloadConnectorVersion);
const claimMock = vi.mocked(claimConnectorVersion);
const resolveCacheMock = vi.mocked(resolveConnectorCacheFile);
const cleanupCacheMock = vi.mocked(cleanupConnectorVersion);
const resolveArtifactMock = vi.mocked(resolveSourceArtifact);
const missingArtifactMock = vi.mocked(isMissingOwnedSourceArtifact);
const renderChartMock = vi.mocked(renderChartPng);
const renderPdfMock = vi.mocked(renderReportPdf);

beforeEach(() => {
  vi.clearAllMocks();
  healthMock.mockResolvedValue(true);
  beginPreparationMock.mockResolvedValue();
  endPreparationMock.mockResolvedValue();
  beginCleanupMock.mockResolvedValue();
  endCleanupMock.mockResolvedValue();
  connectorPathMock.mockImplementation(async ({ version }) => (version.startsWith("44444444") ? PREVIOUS : CANDIDATE));
  resolveCacheMock.mockImplementation(async ({ location }) => location);
  cleanupCacheMock.mockResolvedValue(true);
  inspectMock.mockResolvedValue(metadata as any);
  currentLocationMock.mockResolvedValue(PREVIOUS);
  registerMock.mockResolvedValue(metadata as any);
  missingArtifactMock.mockResolvedValue(false);
  renderChartMock.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  renderPdfMock.mockResolvedValue(Buffer.from("%PDF-facade"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected HTTP request")))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("in-process data facade", () => {
  it("proves uploaded path ownership before registering it with the worker", async () => {
    const requested = "/uploads/requested/ledger.csv";
    const owned = "/uploads/canonical/ledger.csv";
    resolveArtifactMock.mockResolvedValueOnce(owned);

    await expect(
      dataService.registerDataset(ACCOUNT, "ledger", {
        location: requested,
        kind: "path",
        originalName: "Ledger.csv",
        sourceId: SOURCE,
      })
    ).resolves.toMatchObject({ safe_location: CANDIDATE });

    expect(resolveArtifactMock).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      sourceId: SOURCE,
      name: "ledger",
      filePath: requested,
    });
    expect(registerMock).toHaveBeenCalledWith(
      {
        accountId: ACCOUNT,
        name: "ledger",
        location: owned,
        kind: "path",
        originalName: "Ledger.csv",
        expectedFormat: undefined,
      },
      expect.any(AbortSignal)
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps missing owned uploads distinct from unsafe locations", async () => {
    resolveArtifactMock.mockResolvedValue(undefined);
    missingArtifactMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const missing = await dataService
      .registerDataset(ACCOUNT, "ledger", { location: "/owned/missing.csv", sourceId: SOURCE })
      .catch((error) => error);
    const unsafe = await dataService
      .registerDataset(ACCOUNT, "ledger", { location: "/outside/data.csv", sourceId: SOURCE })
      .catch((error) => error);

    expect(missing).toMatchObject({ status: 404, code: "DATA_SERVICE_ERROR" });
    expect(unsafe).toMatchObject({ status: 400, code: "DATA_SERVICE_ERROR" });
    expect(missing).toBeInstanceOf(DataServiceError);
    expect(unsafe).toBeInstanceOf(DataServiceError);
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("re-registers URL datasets only from an existing proven cache file", async () => {
    resolveCacheMock.mockResolvedValueOnce(CANDIDATE);

    await dataService.registerDataset(ACCOUNT, "ledger", {
      location: "/untrusted/cache.csv",
      kind: "url",
      url: "https://example.invalid/ledger.csv",
      originalName: "Ledger.csv",
      expectedFormat: "csv",
    });

    expect(resolveCacheMock).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      name: "ledger",
      location: "/untrusted/cache.csv",
    });
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        name: "ledger",
        location: CANDIDATE,
        kind: "url",
        url: "https://example.invalid/ledger.csv",
        expectedFormat: "csv",
      }),
      expect.any(AbortSignal)
    );
    expect(downloadMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prepares, inspects, and releases an immutable connector candidate", async () => {
    downloadMock.mockImplementationOnce(async (input) => {
      await input.inspect(CANDIDATE);
      return CANDIDATE;
    });

    await expect(
      dataService.prepareDatasetRefresh(
        ACCOUNT,
        "ledger",
        VERSION,
        "https://example.invalid/ledger.csv",
        "Ledger.csv",
        "csv"
      )
    ).resolves.toEqual({
      version: VERSION,
      location: CANDIDATE,
      previous_location: PREVIOUS,
      rows: 2,
      columns: [{ name: "amount", type: "BIGINT" }],
      preview: [[10], [20]],
      preview_truncated: false,
      size_bytes: 20,
    });

    expect(beginPreparationMock).toHaveBeenCalledWith(ACCOUNT, "ledger", CANDIDATE, expect.any(AbortSignal));
    expect(inspectMock).toHaveBeenCalledWith(
      {
        name: "ledger",
        location: CANDIDATE,
        originalName: "Ledger.csv",
        expectedFormat: "csv",
      },
      expect.any(AbortSignal)
    );
    expect(currentLocationMock).toHaveBeenCalledWith(ACCOUNT, "ledger", expect.any(AbortSignal));
    expect(endPreparationMock).toHaveBeenCalledWith(ACCOUNT, "ledger", CANDIDATE);
  });

  it("always releases a preparation reservation after a failed download", async () => {
    downloadMock.mockRejectedValueOnce(new ConnectorFetchError(422, "private response detail"));

    const error = await dataService
      .prepareDatasetRefresh(ACCOUNT, "ledger", VERSION, "https://example.invalid/ledger.csv", "Ledger.csv", "csv")
      .catch((value) => value);

    expect(error).toBeInstanceOf(DataServiceError);
    expect(error).toMatchObject({ status: 422, operation: "/datasets/refresh/prepare" });
    expect(String(error)).not.toContain("private response detail");
    expect(endPreparationMock).toHaveBeenCalledWith(ACCOUNT, "ledger", CANDIDATE);
  });

  it("activates with exact cache proofs and adds the stable version field", async () => {
    claimMock.mockResolvedValueOnce(CANDIDATE);
    activateMock.mockResolvedValueOnce({ ...metadata, previous_location: PREVIOUS } as any);

    const result = await dataService.activateDatasetRefresh(
      ACCOUNT,
      "ledger",
      VERSION,
      "https://example.invalid/ledger.csv",
      "Ledger.csv",
      "csv",
      PREVIOUS
    );

    expect(resolveCacheMock).toHaveBeenCalledWith({ accountId: ACCOUNT, name: "ledger", location: CANDIDATE });
    expect(activateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT,
        name: "ledger",
        location: CANDIDATE,
        expectedPreviousLocation: PREVIOUS,
      }),
      expect.any(AbortSignal)
    );
    expect(result).toMatchObject({ version: VERSION, location: CANDIDATE });
  });

  it("reserves and finalizes exact-location abort and cleanup operations", async () => {
    await expect(dataService.abortDatasetRefresh(ACCOUNT, "ledger", VERSION, "csv")).resolves.toEqual({
      status: "deleted",
    });
    cleanupCacheMock.mockResolvedValueOnce(false);
    await expect(dataService.cleanupDatasetCache(ACCOUNT, "ledger", PREVIOUS)).resolves.toEqual({ status: "missing" });

    expect(beginCleanupMock).toHaveBeenNthCalledWith(1, ACCOUNT, "ledger", CANDIDATE, expect.any(AbortSignal));
    expect(endCleanupMock).toHaveBeenNthCalledWith(1, ACCOUNT, "ledger", CANDIDATE);
    expect(beginCleanupMock).toHaveBeenNthCalledWith(2, ACCOUNT, "ledger", PREVIOUS, expect.any(AbortSignal));
    expect(endCleanupMock).toHaveBeenNthCalledWith(2, ACCOUNT, "ledger", PREVIOUS);
    expect(cleanupCacheMock).toHaveBeenNthCalledWith(1, { accountId: ACCOUNT, name: "ledger", location: CANDIDATE });
    expect(cleanupCacheMock).toHaveBeenNthCalledWith(2, { accountId: ACCOUNT, name: "ledger", location: PREVIOUS });
  });

  it("deactivates uploaded paths only through the worker's exact-location CAS", async () => {
    const uploaded = "/uploads/account/source/ledger.csv";
    deactivateMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(dataService.deactivateDatasetLocation(ACCOUNT, "ledger", uploaded)).resolves.toEqual({
      status: "dropped",
    });
    await expect(
      dataService.deactivateDatasetLocation(ACCOUNT, "ledger", "/uploads/account/source/stale.csv")
    ).resolves.toEqual({ status: "unchanged" });

    expect(deactivateMock).toHaveBeenNthCalledWith(1, ACCOUNT, "ledger", uploaded, expect.any(AbortSignal));
    expect(deactivateMock).toHaveBeenNthCalledWith(
      2,
      ACCOUNT,
      "ledger",
      "/uploads/account/source/stale.csv",
      expect.any(AbortSignal)
    );
  });

  it("keeps list, catalog, query, describe, extract, and deactivate scoped in-process", async () => {
    listMock.mockResolvedValue([]);
    catalogMock.mockResolvedValue({ datasets: [], total: 0, returned: 0, omitted: 0, truncated: false });
    queryMock.mockResolvedValue({ columns: [], rows: [], row_count: 0 } as any);
    describeMock.mockResolvedValue({ table: "ledger" } as any);
    extractMock.mockResolvedValue({ columns: [], rows: [], total_row_count: 0, returned_row_count: 0 } as any);
    extractCandidateMock.mockResolvedValue({
      columns: [],
      rows: [],
      row_count: 0,
      total_row_count: 0,
      returned_row_count: 0,
      columns_truncated: false,
      truncated: false,
    });
    deactivateMock.mockResolvedValue(true);

    await dataService.listDatasets(ACCOUNT);
    await dataService.listDatasetSummaries(ACCOUNT);
    await dataService.listDatasetCatalog(ACCOUNT, ["ledger"]);
    await dataService.query(ACCOUNT, "SELECT * FROM ledger", ["ledger"]);
    await dataService.describe(ACCOUNT, "ledger", ["ledger"]);
    await dataService.extractDataset(ACCOUNT, "ledger", 999);
    await dataService.extractPreparedDataset(ACCOUNT, "ledger", VERSION, "csv", 999);
    await expect(dataService.deactivateDatasetLocation(ACCOUNT, "ledger", CANDIDATE)).resolves.toEqual({
      status: "dropped",
    });

    expect(listMock).toHaveBeenNthCalledWith(1, ACCOUNT, false, expect.any(AbortSignal));
    expect(listMock).toHaveBeenNthCalledWith(2, ACCOUNT, true, expect.any(AbortSignal));
    expect(catalogMock).toHaveBeenCalledWith(ACCOUNT, ["ledger"], expect.any(AbortSignal));
    expect(queryMock).toHaveBeenCalledWith(ACCOUNT, "SELECT * FROM ledger", ["ledger"], expect.any(AbortSignal));
    expect(describeMock).toHaveBeenCalledWith(ACCOUNT, "ledger", ["ledger"], expect.any(AbortSignal));
    expect(extractMock).toHaveBeenCalledWith(ACCOUNT, "ledger", ["ledger"], 100, expect.any(AbortSignal));
    expect(extractCandidateMock).toHaveBeenCalledWith("ledger", CANDIDATE, "csv", 100, expect.any(AbortSignal));
    expect(deactivateMock).toHaveBeenCalledWith(ACCOUNT, "ledger", CANDIDATE, expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the worker smoke test for health and preserves opaque worker statuses", async () => {
    await expect(dataService.health()).resolves.toBe(true);
    expect(healthMock).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();

    queryMock.mockRejectedValueOnce(new WorkerDataServiceError(504, "secret SQL and /private/path"));
    const error = await dataService.query(ACCOUNT, "SELECT secret FROM ledger", ["ledger"]).catch((value) => value);
    expect(error).toBeInstanceOf(DataServiceError);
    expect(error).toMatchObject({
      status: 504,
      operation: "/query",
      code: "DATA_SERVICE_ERROR",
    });
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("/private/path");
  });

  it("renders normalized charts and reports in-process without HTTP", async () => {
    const chartSpec = {
      type: "bar",
      title: "Spending",
      categories: ["Jan"],
      series: [{ name: "Total", data: [42] }],
    };
    const chart = await dataService.chart(ACCOUNT, chartSpec);
    expect(chart.spec).toMatchObject({ type: "bar", subtitle: "", x_label: "", y_label: "" });
    expect(chart.echarts).toMatchObject({ xAxis: { type: "category", data: ["Jan"] } });
    expect(chart.png_base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
    expect(renderChartMock).toHaveBeenCalledWith(chart.spec, expect.any(AbortSignal));

    const payload = {
      account_id: ACCOUNT,
      title: "Report",
      sections: [{ heading: "Summary", markdown: "**Safe**" }],
      charts: [],
      tables: [],
    };
    const report = await dataService.buildReport(payload);
    expect(report.title).toBe("Report");
    expect(report.html).toContain("<strong>Safe</strong>");
    await expect(dataService.pdf(payload)).resolves.toEqual(Buffer.from("%PDF-facade"));
    expect(renderPdfMock).toHaveBeenCalledWith(payload, expect.any(AbortSignal));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps chart validation at 400 and report failures opaque at 422", async () => {
    const chartError = await dataService.chart(ACCOUNT, { type: "nope" }).catch((error) => error);
    expect(chartError).toBeInstanceOf(DataServiceError);
    expect(chartError).toMatchObject({ status: 400, operation: "/chart" });

    const privatePayload = { account_id: ACCOUNT, title: "private", unresolved_chart_ids: ["secret"] };
    const reportError = await dataService.buildReport(privatePayload).catch((error) => error);
    expect(reportError).toBeInstanceOf(DataServiceError);
    expect(reportError).toMatchObject({ status: 422, operation: "/reports/build" });
    expect(String(reportError)).not.toContain("private");
    expect(String(reportError)).not.toContain("secret");

    renderPdfMock.mockRejectedValueOnce(new Error("private browser trace /Users/me"));
    const pdfError = await dataService
      .pdf({ account_id: ACCOUNT, title: "Report", sections: [], charts: [], tables: [] })
      .catch((error) => error);
    expect(pdfError).toBeInstanceOf(DataServiceError);
    expect(pdfError).toMatchObject({ status: 422, operation: "/reports/pdf" });
    expect(String(pdfError)).not.toContain("/Users/me");
  });

  it("preserves caller cancellation as AbortError across the worker boundary", async () => {
    queryMock.mockImplementationOnce(
      (_accountId, _sql, _allowedTables, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("worker cancelled");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const pending = dataService.query(ACCOUNT, "SELECT 1", [], controller.signal);
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps the 65s dataset, 120s prepare, and 2s health timeout budgets", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    queryMock.mockResolvedValueOnce({ columns: [], rows: [], row_count: 0 } as any);
    downloadMock.mockImplementationOnce(async (input) => {
      await input.inspect(CANDIDATE);
      return CANDIDATE;
    });

    await dataService.query(ACCOUNT, "SELECT 1", []);
    await dataService.prepareDatasetRefresh(
      ACCOUNT,
      "ledger",
      VERSION,
      "https://example.invalid/ledger.csv",
      "Ledger.csv",
      "csv"
    );
    await dataService.health();

    expect(timeoutSpy).toHaveBeenCalledWith(65_000);
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    expect(timeoutSpy).toHaveBeenCalledWith(2_000);
  });

  it("composes a caller signal with the total timeout", () => {
    const caller = new AbortController();
    const bounded = boundedRequestSignal(caller.signal, 10_000);
    caller.abort();
    expect(bounded.aborted).toBe(true);
  });
});
