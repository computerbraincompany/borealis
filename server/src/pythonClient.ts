import { config } from "./config.js";
import { currentRequestId } from "./requestContext.js";

const DEFAULT_TIMEOUT_MS = 65_000;

export class PythonServiceError extends Error {
  readonly code = "PYTHON_SERVICE_ERROR";

  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super("The data service could not complete the operation");
    this.name = "PythonServiceError";
  }
}

function serviceHeaders(contentType = true): Record<string, string> {
  return {
    ...(contentType ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${config.pythonServiceToken}`,
    "X-Request-ID": currentRequestId(),
  };
}

async function request(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${config.pythonServiceUrl}${path}`, {
      ...init,
      headers: { ...serviceHeaders(init.body !== undefined), ...(init.headers || {}) },
      signal: boundedRequestSignal(init.signal, timeoutMs),
    });
  } catch {
    if (init.signal?.aborted) {
      const cancelled = new Error("operation cancelled");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    throw new PythonServiceError(503, path);
  }
  if (!res.ok) {
    // Never copy Python response bodies or tracebacks into Node errors: they
    // can contain local paths, SQL, signed URLs, or source content.
    throw new PythonServiceError(res.status, path);
  }
  return res;
}

export function boundedRequestSignal(caller: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

async function post<T = any>(path: string, body: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  const res = await request(path, { method: "POST", body: JSON.stringify(body), signal }, timeoutMs);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const py = {
  async health(): Promise<boolean> {
    try {
      // /health is intentionally the sole public Python route.
      const res = await fetch(`${config.pythonServiceUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
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
  ) {
    return post<any>("/datasets/register", {
      account_id: accountId,
      name,
      location: registration.location,
      kind: registration.kind ?? "path",
      url: registration.url,
      original_name: registration.originalName,
      expected_format: registration.expectedFormat,
      source_id: registration.sourceId,
    });
  },
  prepareDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    url: string,
    originalName: string,
    expectedFormat: "csv" | "json",
    signal?: AbortSignal
  ) {
    return post<{
      version: string;
      location: string;
      previous_location: string | null;
      rows: number;
      size_bytes: number;
    }>(
      "/datasets/refresh/prepare",
      {
        account_id: accountId,
        name,
        version,
        url,
        original_name: originalName,
        expected_format: expectedFormat,
      },
      120_000,
      signal
    );
  },
  extractPreparedDataset(
    accountId: string,
    name: string,
    version: string,
    expectedFormat: "csv" | "json",
    maxRows = 40,
    signal?: AbortSignal
  ) {
    return post<{
      columns: string[];
      rows: unknown[][];
      row_count: number;
      total_row_count: number;
      returned_row_count: number;
      columns_truncated: boolean;
      truncated: boolean;
    }>(
      "/datasets/refresh/extract",
      {
        account_id: accountId,
        name,
        version,
        expected_format: expectedFormat,
        max_rows: Math.max(1, Math.min(Math.trunc(maxRows), 100)),
      },
      undefined,
      signal
    );
  },
  activateDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    url: string,
    originalName: string,
    expectedFormat: "csv" | "json",
    previousLocation: string | null,
    signal?: AbortSignal
  ) {
    return post<any>(
      "/datasets/refresh/activate",
      {
        account_id: accountId,
        name,
        version,
        url,
        original_name: originalName,
        expected_format: expectedFormat,
        previous_location: previousLocation,
      },
      undefined,
      signal
    );
  },
  abortDatasetRefresh(
    accountId: string,
    name: string,
    version: string,
    expectedFormat: "csv" | "json",
    signal?: AbortSignal
  ) {
    return post<{ status: "deleted" | "missing" }>(
      "/datasets/refresh/abort",
      { account_id: accountId, name, version, expected_format: expectedFormat },
      undefined,
      signal
    );
  },
  extractDataset(accountId: string, name: string, maxRows = 40) {
    return post<{
      columns: string[];
      rows: unknown[][];
      total_row_count: number;
      returned_row_count: number;
      truncated: boolean;
    }>("/datasets/extract", {
      account_id: accountId,
      table: name,
      allowed_tables: [name],
      max_rows: Math.max(1, Math.min(Math.trunc(maxRows), 100)),
    });
  },
  async listDatasets(accountId: string, signal?: AbortSignal): Promise<any[]> {
    const res = await request(`/datasets?account_id=${encodeURIComponent(accountId)}`, { signal });
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },
  async listDatasetSummaries(
    accountId: string,
    signal?: AbortSignal
  ): Promise<Array<{ table: string; original_name: string; rows: number; exists: boolean }>> {
    const res = await request(`/datasets?account_id=${encodeURIComponent(accountId)}&view=summary`, { signal });
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },
  listDatasetCatalog(accountId: string, allowedTables: readonly string[], signal?: AbortSignal) {
    return post<{
      datasets: Array<{ table: string; original_name: string; rows: number; columns: unknown[] }>;
      total: number;
      returned: number;
      omitted: number;
      truncated: boolean;
    }>("/datasets/catalog", { account_id: accountId, allowed_tables: [...allowedTables] }, undefined, signal);
  },
  deactivateDatasetLocation(accountId: string, name: string, location: string) {
    return post<{ status: "dropped" | "unchanged" }>("/datasets/deactivate", {
      account_id: accountId,
      name,
      location,
    });
  },
  cleanupDatasetCache(accountId: string, name: string, location: string) {
    return post<{ status: "deleted" | "missing" }>("/datasets/cache/cleanup", {
      account_id: accountId,
      name,
      location,
    });
  },
  query(accountId: string, sql: string, allowedTables: readonly string[], signal?: AbortSignal) {
    return post<{
      columns: string[];
      rows: any[][];
      row_count: number;
      returned_row_count?: number;
      columns_truncated?: boolean;
      truncated?: boolean;
    }>("/query", { account_id: accountId, sql, allowed_tables: [...allowedTables] }, undefined, signal);
  },
  describe(accountId: string, table: string, allowedTables: readonly string[], signal?: AbortSignal) {
    return post("/describe", { account_id: accountId, table, allowed_tables: [...allowedTables] }, undefined, signal);
  },
  chart(accountId: string, spec: any, signal?: AbortSignal) {
    return post<{ png_base64: string; echarts: any; spec: any }>(
      "/chart",
      { account_id: accountId, spec },
      undefined,
      signal
    );
  },
  buildReport(payload: any, signal?: AbortSignal) {
    return post<{ title: string; html: string }>("/reports/build", payload, undefined, signal);
  },
  async pdf(payload: any, signal?: AbortSignal): Promise<Buffer> {
    const res = await request("/reports/pdf", { method: "POST", body: JSON.stringify(payload), signal }, 120_000);
    return Buffer.from(await res.arrayBuffer());
  },
};
