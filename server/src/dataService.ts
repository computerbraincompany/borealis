import path from "node:path";

import {
  claimConnectorVersion,
  cleanupConnectorVersion,
  ConnectorFetchError,
  connectorVersionPath,
  downloadConnectorVersion,
  resolveConnectorCacheFile,
} from "./data/connectorFetch.js";
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
  extractDataset as extractRegisteredDataset,
  extractDatasetCandidate,
  inspectDataset,
  listDatasets as listRegisteredDatasets,
  queryDataset,
  registerDataset as registerWorkerDataset,
  type DatasetFormat,
  type DatasetMetadata,
} from "./data/datasets.js";
import { ChartSpecError, echartsOption, normalize as normalizeChart } from "./data/charts.js";
import { DataServiceError as WorkerDataServiceError } from "./data/errors.js";
import { renderChartPng, renderReportPdf } from "./data/playwrightRender.js";
import { buildHtml, normalizeReport } from "./data/reports.js";
import { isMissingOwnedSourceArtifact, resolveSourceArtifact } from "./storageArtifacts.js";

const DEFAULT_TIMEOUT_MS = 65_000;
const PREPARE_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 2_000;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class DataServiceError extends Error {
  readonly code = "DATA_SERVICE_ERROR";

  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super("The data service could not complete the operation");
    this.name = "DataServiceError";
  }
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

export function boundedRequestSignal(caller: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

async function inProcess<T>(
  operation: string,
  caller: AbortSignal | undefined,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = boundedRequestSignal(caller, timeoutMs);
  try {
    return await run(signal);
  } catch (error) {
    if (error instanceof DataServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      if (caller?.aborted) throw abortError();
      throw new DataServiceError(503, operation);
    }
    if (error instanceof WorkerDataServiceError || error instanceof ConnectorFetchError) {
      throw new DataServiceError(error.status, operation);
    }
    throw new DataServiceError(500, operation);
  }
}

function connectorOriginalName(name: string, url: string, expectedFormat: DatasetFormat, supplied?: string): string {
  if (supplied) return supplied;
  try {
    return path.basename(new URL(url).pathname) || `${name}.${expectedFormat}`;
  } catch {
    return `${name}.${expectedFormat}`;
  }
}

function boundedRows(maxRows: number): number {
  return Math.max(1, Math.min(Math.trunc(maxRows), 100));
}

async function proveConnectorCacheLocation(
  accountId: string,
  name: string,
  location: string,
  requireFile = false
): Promise<string> {
  const match = /^([0-9a-f]{32})\.(csv|json)$/.exec(path.basename(location));
  if (!match) throw new ConnectorFetchError(400);
  const hex = match[1];
  const version = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const candidate = await connectorVersionPath(
    { accountId, name, version, expectedFormat: match[2] as DatasetFormat },
    { createDirectory: false, requireFile }
  );
  if (path.resolve(location) !== candidate) throw new ConnectorFetchError(400);
  return candidate;
}

export const dataService = {
  async health(): Promise<boolean> {
    return inProcess("/health", undefined, HEALTH_TIMEOUT_MS, (signal) => datasetHealth(signal)).catch(() => false);
  },

  registerDataset(
    accountId: string,
    name: string,
    registration: {
      location?: string;
      kind?: "path" | "url";
      url?: string;
      originalName?: string;
      expectedFormat?: "csv" | "json";
      sourceId?: string;
    } = {}
  ): Promise<any> {
    return inProcess("/datasets/register", undefined, DEFAULT_TIMEOUT_MS, async (signal) => {
      const kind = registration.kind ?? "path";
      if (!registration.location) throw new DataServiceError(400, "/datasets/register");

      if (kind === "url") {
        if (!registration.url || !registration.expectedFormat) {
          throw new DataServiceError(400, "/datasets/register");
        }
        // Reconciliation may only re-open an immutable cache version that was
        // already prepared by the connector pipeline. It must never fetch.
        const location = await resolveConnectorCacheFile({
          accountId,
          name,
          location: registration.location,
        });
        return registerWorkerDataset(
          {
            accountId,
            name,
            location,
            kind,
            originalName: connectorOriginalName(
              name,
              registration.url,
              registration.expectedFormat,
              registration.originalName
            ),
            url: registration.url,
            expectedFormat: registration.expectedFormat,
          },
          signal
        );
      }

      if (!registration.sourceId) throw new DataServiceError(400, "/datasets/register");
      const location = await resolveSourceArtifact({
        accountId,
        sourceId: registration.sourceId,
        name,
        filePath: registration.location,
      });
      if (!location) {
        const missing = await isMissingOwnedSourceArtifact({
          accountId,
          sourceId: registration.sourceId,
          filePath: registration.location,
        });
        throw new DataServiceError(missing ? 404 : 400, "/datasets/register");
      }
      return registerWorkerDataset(
        {
          accountId,
          name,
          location,
          kind,
          originalName: registration.originalName || path.basename(location),
          expectedFormat: registration.expectedFormat,
        },
        signal
      );
    });
  },

  prepareDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    url: string,
    originalName: string,
    expectedFormat: "csv" | "json",
    caller?: AbortSignal
  ): Promise<{
    version: string;
    location: string;
    previous_location: string | null;
    rows: number;
    size_bytes: number;
    columns?: unknown[];
    preview?: unknown[][];
    preview_truncated?: boolean;
  }> {
    return inProcess("/datasets/refresh/prepare", caller, PREPARE_TIMEOUT_MS, async (signal) => {
      const identity = { accountId, name, version, expectedFormat };
      const candidate = await connectorVersionPath(identity);
      let preparationStarted = false;
      let inspected: DatasetMetadata | undefined;
      try {
        await beginDatasetPreparation(accountId, name, candidate, signal);
        preparationStarted = true;
        const resolvedOriginalName = connectorOriginalName(name, url, expectedFormat, originalName);
        const location = await downloadConnectorVersion({
          ...identity,
          url,
          signal,
          inspect: async (candidateLocation) => {
            inspected = await inspectDataset(
              { name, location: candidateLocation, originalName: resolvedOriginalName, expectedFormat },
              signal
            );
          },
        });
        const metadata =
          inspected?.safe_location === location
            ? inspected
            : await inspectDataset({ name, location, originalName: resolvedOriginalName, expectedFormat }, signal);
        const previousLocation = await currentDatasetLocation(accountId, name, signal);
        return {
          version,
          location,
          previous_location: previousLocation,
          rows: metadata.rows,
          columns: metadata.columns,
          preview: metadata.preview,
          preview_truncated: metadata.preview_truncated,
          size_bytes: metadata.size_bytes,
        };
      } finally {
        if (preparationStarted) await endDatasetPreparation(accountId, name, candidate);
      }
    });
  },

  extractPreparedDataset(
    accountId: string,
    name: string,
    version: string,
    expectedFormat: "csv" | "json",
    maxRows = 40,
    caller?: AbortSignal
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    row_count: number;
    total_row_count: number;
    returned_row_count: number;
    columns_truncated: boolean;
    truncated: boolean;
  }> {
    return inProcess("/datasets/refresh/extract", caller, DEFAULT_TIMEOUT_MS, async (signal) => {
      const location = await connectorVersionPath(
        { accountId, name, version, expectedFormat },
        { createDirectory: false, requireFile: true }
      );
      return extractDatasetCandidate(name, location, expectedFormat, boundedRows(maxRows), signal);
    });
  },

  activateDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    url: string,
    originalName: string,
    expectedFormat: "csv" | "json",
    previousLocation: string | null,
    caller?: AbortSignal
  ): Promise<any> {
    return inProcess("/datasets/refresh/activate", caller, DEFAULT_TIMEOUT_MS, async (signal) => {
      const identity = { accountId, name, version, expectedFormat };
      const location = await claimConnectorVersion({ ...identity, url });
      await resolveConnectorCacheFile({ accountId, name, location });
      const expectedPreviousLocation = previousLocation
        ? await proveConnectorCacheLocation(accountId, name, previousLocation)
        : null;
      const activated = await activatePreparedDataset(
        {
          accountId,
          name,
          location,
          originalName: connectorOriginalName(name, url, expectedFormat, originalName),
          url,
          expectedFormat,
          expectedPreviousLocation,
        },
        signal
      );
      return { ...activated, version };
    });
  },

  abortDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    expectedFormat: "csv" | "json",
    caller?: AbortSignal
  ): Promise<{ status: "deleted" | "missing" }> {
    return inProcess("/datasets/refresh/abort", caller, DEFAULT_TIMEOUT_MS, async (signal) => {
      const location = await connectorVersionPath({ accountId, name, version, expectedFormat });
      let reserved = false;
      try {
        await beginInactiveLocationCleanup(accountId, name, location, signal);
        reserved = true;
        const deleted = await cleanupConnectorVersion({ accountId, name, location });
        return { status: deleted ? ("deleted" as const) : ("missing" as const) };
      } finally {
        if (reserved) await endInactiveLocationCleanup(accountId, name, location);
      }
    });
  },

  extractDataset(
    accountId: string,
    name: string,
    maxRows = 40
  ): Promise<{
    columns: string[];
    rows: unknown[][];
    total_row_count: number;
    returned_row_count: number;
    truncated: boolean;
  }> {
    return inProcess("/datasets/extract", undefined, DEFAULT_TIMEOUT_MS, (signal) =>
      extractRegisteredDataset(accountId, name, [name], boundedRows(maxRows), signal)
    );
  },

  listDatasets(accountId: string, caller?: AbortSignal): Promise<any[]> {
    return inProcess("/datasets", caller, DEFAULT_TIMEOUT_MS, (signal) =>
      listRegisteredDatasets(accountId, false, signal)
    );
  },

  listDatasetSummaries(
    accountId: string,
    caller?: AbortSignal
  ): Promise<Array<{ table: string; original_name: string; rows: number; exists: boolean }>> {
    return inProcess("/datasets?view=summary", caller, DEFAULT_TIMEOUT_MS, (signal) =>
      listRegisteredDatasets(accountId, true, signal)
    );
  },

  listDatasetCatalog(
    accountId: string,
    allowedTables: readonly string[],
    caller?: AbortSignal
  ): Promise<{
    datasets: Array<{ table: string; original_name: string; rows: number; columns: unknown[] }>;
    total: number;
    returned: number;
    omitted: number;
    truncated: boolean;
  }> {
    return inProcess("/datasets/catalog", caller, DEFAULT_TIMEOUT_MS, (signal) =>
      catalogDatasets(accountId, allowedTables, signal)
    );
  },

  deactivateDatasetLocation(
    accountId: string,
    name: string,
    location: string
  ): Promise<{ status: "dropped" | "unchanged" }> {
    // Deactivation never touches the filesystem. The worker canonicalizes the
    // supplied path and performs an exact safe_location CAS, which supports
    // both uploaded files and connector cache versions without widening to a
    // table-name-only drop.
    return inProcess("/datasets/deactivate", undefined, DEFAULT_TIMEOUT_MS, async (signal) => ({
      status: (await deactivateDatasetIfLocation(accountId, name, location, signal))
        ? ("dropped" as const)
        : ("unchanged" as const),
    }));
  },

  cleanupDatasetCache(accountId: string, name: string, location: string): Promise<{ status: "deleted" | "missing" }> {
    return inProcess("/datasets/cache/cleanup", undefined, DEFAULT_TIMEOUT_MS, async (signal) => {
      let reserved = false;
      try {
        await beginInactiveLocationCleanup(accountId, name, location, signal);
        reserved = true;
        const deleted = await cleanupConnectorVersion({ accountId, name, location });
        return { status: deleted ? ("deleted" as const) : ("missing" as const) };
      } finally {
        if (reserved) await endInactiveLocationCleanup(accountId, name, location);
      }
    });
  },

  query(
    accountId: string,
    sql: string,
    allowedTables: readonly string[],
    caller?: AbortSignal
  ): Promise<{
    columns: string[];
    rows: any[][];
    row_count: number;
    returned_row_count?: number;
    columns_truncated?: boolean;
    truncated?: boolean;
  }> {
    return inProcess("/query", caller, DEFAULT_TIMEOUT_MS, (signal) =>
      queryDataset(accountId, sql, allowedTables, signal)
    );
  },

  describe(accountId: string, table: string, allowedTables: readonly string[], caller?: AbortSignal): Promise<any> {
    return inProcess("/describe", caller, DEFAULT_TIMEOUT_MS, (signal) =>
      describeDataset(accountId, table, allowedTables, signal)
    );
  },

  chart(accountId: string, spec: any, caller?: AbortSignal): Promise<{ png_base64: string; echarts: any; spec: any }> {
    return inProcess("/chart", caller, DEFAULT_TIMEOUT_MS, async (signal) => {
      if (!ACCOUNT_RE.test(accountId)) throw new DataServiceError(422, "/chart");
      let normalized;
      try {
        normalized = normalizeChart(spec);
      } catch (error) {
        if (error instanceof ChartSpecError) throw new DataServiceError(400, "/chart");
        throw error;
      }
      const png = await renderChartPng(normalized, signal);
      return { png_base64: png.toString("base64"), echarts: echartsOption(normalized), spec: normalized };
    });
  },
  buildReport(payload: any, caller?: AbortSignal): Promise<{ title: string; html: string }> {
    return inProcess("/reports/build", caller, DEFAULT_TIMEOUT_MS, async (signal) => {
      try {
        if (signal.aborted) throw abortError();
        const report = normalizeReport(payload, true);
        const html = buildHtml(report);
        if (signal.aborted) throw abortError();
        return { title: report.title, html };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new DataServiceError(422, "/reports/build");
      }
    });
  },
  pdf(payload: any, caller?: AbortSignal): Promise<Buffer> {
    return inProcess("/reports/pdf", caller, PREPARE_TIMEOUT_MS, async (signal) => {
      try {
        return await renderReportPdf(payload, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new DataServiceError(422, "/reports/pdf");
      }
    });
  },
};
