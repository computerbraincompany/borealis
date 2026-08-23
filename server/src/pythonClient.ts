import { config } from "./config.js";

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${config.pythonServiceUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON (e.g. PDF bytes handled separately) */
  }
  if (!res.ok) {
    const detail = typeof data === "object" && data !== null ? JSON.stringify(data.detail ?? data) : text;
    throw new Error(`${path}: ${res.status} ${detail}`);
  }
  return data as T;
}

export const py = {
  registerDataset(
    accountId: string,
    name: string,
    registration: {
      location?: string;
      kind?: "path" | "url";
      url?: string;
      originalName?: string;
    } = {}
  ) {
    return post<any>("/datasets/register", {
      account_id: accountId,
      name,
      location: registration.location,
      kind: registration.kind ?? "path",
      url: registration.url,
      original_name: registration.originalName,
    });
  },
  resync(accountId: string, name: string, url?: string, originalName?: string) {
    return post<any>("/datasets/resync", {
      account_id: accountId,
      name,
      url,
      original_name: originalName,
    });
  },
  async listDatasets(accountId: string): Promise<any[]> {
    const res = await fetch(`${config.pythonServiceUrl}/datasets?account_id=${accountId}`);
    if (!res.ok) throw new Error(`/datasets ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  },
  deleteDataset(accountId: string, name: string) {
    return fetch(`${config.pythonServiceUrl}/datasets/${name}?account_id=${accountId}`, { method: "DELETE" }).then((r) => r.json());
  },
  query(accountId: string, sql: string, allowedTables: readonly string[]) {
    return post<{ columns: string[]; rows: any[][]; row_count: number }>("/query", {
      account_id: accountId,
      sql,
      allowed_tables: [...allowedTables],
    });
  },
  describe(accountId: string, table: string, allowedTables: readonly string[]) {
    return post("/describe", { account_id: accountId, table, allowed_tables: [...allowedTables] });
  },
  chart(accountId: string, spec: any) {
    return post<{ png_base64: string; echarts: any; spec: any }>("/chart", { account_id: accountId, spec });
  },
  buildReport(payload: any) {
    return post<{ title: string; html: string }>("/reports/build", payload);
  },
  async pdf(payload: any): Promise<Buffer> {
    const res = await fetch(`${config.pythonServiceUrl}/reports/pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`/reports/pdf ${res.status}: ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  },
};
