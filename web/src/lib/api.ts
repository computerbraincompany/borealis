import { consumeSseJson } from "@/lib/sse";

const TOKEN_KEY = "borealis_token";
const USER_KEY = "borealis_user";

export interface AuthUser {
  id: string;
  email: string;
}

function desktopToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function getToken(): string | null {
  return desktopToken() ?? window.localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  try {
    const storage = desktopToken() ? window.sessionStorage : window.localStorage;
    return JSON.parse(storage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser) {
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(USER_KEY);
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** Keep Electron's one-launch bootstrap out of persistent Chromium storage. */
export function setDesktopSession(token: string, user: AuthUser) {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  window.sessionStorage.setItem(TOKEN_KEY, token);
  window.sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  data?: unknown;
  requestId?: string;
  constructor(status: number, message: string, data?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.requestId = requestId;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function safeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let data: unknown;
  let message = res.statusText || `Request failed (${res.status})`;
  try {
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      data = await res.json();
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const error = (data as Record<string, unknown>).error;
        if (typeof error === "string" && error.trim()) message = error.trim().slice(0, 500);
      }
    } else {
      // Do not reflect arbitrary upstream HTML/text into the UI.
      await res.body?.cancel().catch(() => undefined);
    }
  } catch {
    // Keep the bounded HTTP fallback when the error payload is malformed.
  }

  const bodyRequestId =
    data && typeof data === "object" && !Array.isArray(data)
      ? safeRequestId((data as Record<string, unknown>).request_id)
      : undefined;
  const requestId = safeRequestId(res.headers.get("x-request-id")) ?? bodyRequestId;
  return new ApiError(res.status, message, data, requestId);
}

/** Convert an unknown failure to bounded user-facing text, including only a validated request reference. */
export function formatApiError(error: unknown, fallback: string): string {
  // Only the HTTP boundary's normalized message is safe to reflect. Runtime,
  // provider, and parser exceptions may contain URLs, SQL, paths, or secrets.
  const message = error instanceof ApiError && error.message.trim() ? error.message.trim().slice(0, 500) : fallback;
  const requestId = error instanceof ApiError ? safeRequestId(error.requestId) : undefined;
  return requestId ? `${message} (reference: ${requestId})` : message || fallback;
}

/** Authenticated fetch returning raw text (e.g. report HTML). */
export async function apiText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` }, signal });
  if (res.status === 401) {
    clearSession();
    location.href = "/login";
    throw await errorFromResponse(res);
  }
  if (!res.ok) throw await errorFromResponse(res);
  return res.text();
}

/** Authenticated fetch returning a Blob (e.g. report PDF). */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 401) {
    clearSession();
    location.href = "/login";
    throw await errorFromResponse(res);
  }
  if (!res.ok) throw await errorFromResponse(res);
  return res.blob();
}

/** Open a server-auth-protected resource (HTML in a tab, PDF as a download) via Blob. */
export async function openProtected(kind: "html" | "pdf", path: string, filename: string) {
  if (kind === "pdf") {
    const blob = await apiBlob(path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }

  // Open synchronously while the click still owns browser popup permission.
  // The shell is trusted app code; report HTML is mounted only in an opaque
  // sandbox so its inline chart script can never inherit the app origin or
  // read the JWT stored in localStorage.
  // Spell out the only URL Electron's main-process popup policy permits.
  // Chromium treats an empty URL as a blank page, but Electron reports that
  // request differently to setWindowOpenHandler and correctly denies it.
  const previewWindow = window.open("about:blank", "_blank");
  if (!previewWindow) throw new Error("report preview window was blocked");
  previewWindow.opener = null;
  previewWindow.document.title = filename;
  previewWindow.document.body.textContent = "Loading report…";

  try {
    const html = await apiText(path);
    if (previewWindow.closed) throw new Error("report preview window was closed");

    const frame = previewWindow.document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", filename);
    frame.style.border = "0";
    frame.style.height = "100vh";
    frame.style.width = "100%";
    frame.srcdoc = html;

    previewWindow.document.documentElement.style.height = "100%";
    previewWindow.document.body.style.margin = "0";
    previewWindow.document.body.replaceChildren(frame);
  } catch (error) {
    previewWindow.close();
    throw error;
  }
}

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string>),
  };
  // Fastify rejects an empty JSON body with content-type set; only declare JSON for real bodies.
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    clearSession();
    if (!location.pathname.startsWith("/login")) {
      location.href = "/login";
    }
    throw await errorFromResponse(res);
  }
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export interface Chat {
  id: string;
  title: string;
  model: string;
  source_mode: SourceMode;
  agent: { id: string; name: string } | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: {
    charts?: string[];
    report?: string | null;
    model?: string;
    source_mode?: SourceMode;
    source_ids?: string[];
    evidence?: RetrievedEvidence[];
    citations?: CitationRef[];
    query_results?: QueryResultArtifact[];
  } | null;
  created_at: string;
}

export interface RetrievedEvidence {
  source_id: string;
  chunk_id: string;
  source: string;
  excerpt: string;
  score: number;
}

/** Marker n → the evidence passage it resolves to; n is a 1-based evidence index. */
export interface CitationRef {
  n: number;
  source_id: string;
  chunk_id: string;
  source: string;
}

export type QueryResultCell = string | number | boolean | null;

export interface QueryResultArtifact {
  id: string;
  sql: string;
  columns: string[];
  rows: QueryResultCell[][];
  row_count: number;
  truncated: boolean;
}

const MAX_QUERY_RESULTS = 3;
const MAX_QUERY_SQL_LENGTH = 2000;
const MAX_QUERY_COLUMNS = 50;
const MAX_QUERY_COLUMN_LENGTH = 200;
const MAX_QUERY_ROWS = 100;
const MAX_QUERY_CELL_LENGTH = 500;

/**
 * Treat message metadata as untrusted JSON. Older or manually-edited rows may
 * predate the bounded query-result contract, so malformed artifacts are
 * omitted instead of being allowed to break or inflate the chat UI.
 */
export function parseQueryResultArtifacts(value: unknown): QueryResultArtifact[] {
  if (!Array.isArray(value)) return [];

  const artifacts: QueryResultArtifact[] = [];
  for (const candidate of value) {
    if (artifacts.length >= MAX_QUERY_RESULTS) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;

    const artifact = candidate as Record<string, unknown>;
    if (
      typeof artifact.id !== "string" ||
      artifact.id.trim().length === 0 ||
      artifact.id.length > 100 ||
      typeof artifact.sql !== "string" ||
      artifact.sql.trim().length === 0 ||
      artifact.sql.length > MAX_QUERY_SQL_LENGTH ||
      !Array.isArray(artifact.columns) ||
      artifact.columns.length === 0 ||
      artifact.columns.length > MAX_QUERY_COLUMNS ||
      !Array.isArray(artifact.rows) ||
      artifact.rows.length > MAX_QUERY_ROWS ||
      !Number.isSafeInteger(artifact.row_count) ||
      (artifact.row_count as number) < artifact.rows.length ||
      typeof artifact.truncated !== "boolean"
    ) {
      continue;
    }

    const columns: string[] = [];
    let valid = true;
    for (let index = 0; index < artifact.columns.length; index += 1) {
      const column = artifact.columns[index];
      if (typeof column !== "string" || column.length > MAX_QUERY_COLUMN_LENGTH) {
        valid = false;
        break;
      }
      columns.push(column);
    }
    if (!valid) continue;

    const rows: QueryResultCell[][] = [];
    for (let rowIndex = 0; rowIndex < artifact.rows.length; rowIndex += 1) {
      const candidateRow = artifact.rows[rowIndex];
      if (!Array.isArray(candidateRow) || candidateRow.length !== columns.length) {
        valid = false;
        break;
      }

      const row: QueryResultCell[] = [];
      for (let cellIndex = 0; cellIndex < candidateRow.length; cellIndex += 1) {
        const cell = candidateRow[cellIndex];
        if (
          cell !== null &&
          typeof cell !== "boolean" &&
          !(typeof cell === "number" && Number.isFinite(cell)) &&
          !(typeof cell === "string" && cell.length <= MAX_QUERY_CELL_LENGTH)
        ) {
          valid = false;
          break;
        }
        row.push(cell as QueryResultCell);
      }
      if (!valid) break;
      rows.push(row);
    }
    if (!valid) continue;

    artifacts.push({
      id: artifact.id,
      sql: artifact.sql,
      columns,
      rows,
      row_count: artifact.row_count as number,
      truncated: artifact.truncated,
    });
  }

  return artifacts;
}

const MAX_CITATIONS = 8;

/**
 * Treat message metadata as untrusted JSON. Older or manually-edited rows may
 * predate the citation contract, so malformed citation entries are omitted
 * instead of being allowed to break the chat UI.
 */
export function parseCitationRefs(value: unknown): CitationRef[] {
  if (!Array.isArray(value)) return [];

  const citations: CitationRef[] = [];
  for (const candidate of value) {
    if (citations.length >= MAX_CITATIONS) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;

    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.n !== "number" ||
      !Number.isSafeInteger(entry.n) ||
      entry.n < 1 ||
      entry.n > 99 ||
      typeof entry.source_id !== "string" ||
      entry.source_id.length === 0 ||
      entry.source_id.length > 200 ||
      typeof entry.chunk_id !== "string" ||
      entry.chunk_id.length === 0 ||
      entry.chunk_id.length > 200 ||
      typeof entry.source !== "string" ||
      entry.source.length === 0 ||
      entry.source.length > 300
    ) {
      continue;
    }

    citations.push({ n: entry.n, source_id: entry.source_id, chunk_id: entry.chunk_id, source: entry.source });
  }

  return citations;
}

export interface ChatDetail extends Chat {
  messages: Message[];
  sources: AttachedSource[];
  active_run: ChatActiveRun | null;
  messages_page?: {
    has_more: boolean;
    next_before_message_id: string | null;
  };
}

export interface ChatActiveRun {
  id: string;
  status: "running" | "cancelling";
}

export type ChatRunTerminalStatus = "cancelled" | "completed" | "failed";

export interface RunEndedEvent {
  type: "run-ended";
  run_id: string;
  status: ChatRunTerminalStatus;
}

export type SourceMode = "all" | "selected";

export interface AttachedSource {
  id: string;
  name: string;
  display_name: string;
  kind: string;
  status: string;
}

export type SourceScopeInput = { source_mode: "all" } | { source_mode: "selected"; source_ids: string[] };

export interface ChatModelOption {
  id: string;
  owned_by?: string;
}

export interface ModelsResponse {
  models: ChatModelOption[];
  default_model: string;
  /** The signed-in account's own default chat model; null until set in Settings. */
  account_default_model: string | null;
  discovery: "live" | "unavailable";
}

export interface AccountPreferences {
  default_chat_model: string | null;
}

export type ProviderSettingName =
  | "llm_base_url"
  | "llm_api_key"
  | "lm_studio_base_url"
  | "default_chat_model"
  | "default_embed_model";

export interface ProviderSettingsResponse {
  llm_base_url: string;
  /** The stored secret is deliberately never returned to the browser. */
  llm_api_key_configured: boolean;
  lm_studio_base_url: string | null;
  default_chat_model: string;
  default_embed_model: string;
  managed_by_env: Record<ProviderSettingName, boolean>;
}

export interface ProviderSettingsPatch {
  llm_base_url?: string;
  /** Omit to preserve the stored key; null explicitly clears it. */
  llm_api_key?: string | null;
  lm_studio_base_url?: string | null;
  default_chat_model?: string;
  default_embed_model?: string;
}

export interface ProviderConnectionTestResponse {
  ok: true;
  latency_ms: number;
}

export type ServiceHealthId = "api" | "database" | "data_service" | "model_gateway" | "model_runtime";

export interface ServiceHealth {
  id: ServiceHealthId;
  name: string;
  description: string;
  status: "operational" | "unavailable";
  latency_ms: number;
}

export interface SystemHealthResponse {
  status: "operational" | "degraded";
  checked_at: string;
  services: ServiceHealth[];
}

export type ProviderLocality = "local" | "private" | "remote";

export type ContainedEngineState = "off" | "starting" | "healthy" | "crashed" | "stopped";

export interface ContainedStatus {
  state: ContainedEngineState;
  model: string | null;
  endpoint_host: string | null;
  endpoint_managed_by_env: boolean;
}

export interface WorkspaceStatusResponse {
  locality: ProviderLocality;
  endpoint_reachable: boolean;
  lm_studio_reachable: boolean | null;
  chat_model: string;
  embed_model: string;
  contained: ContainedStatus | null;
  checked_at: string;
  latency_ms: number;
}

export interface Source {
  id: string;
  name: string;
  kind: "document" | "tabular";
  display_name: string;
  mime: string;
  status: string;
  meta?: {
    error?: string;
    error_code?: string;
    error_detail?: string;
    error_stage?: string;
  } | null;
  ingestion?: { attempts: number; updated_at: string };
  created_at: string;
  tabular?: { rows: number; table: string; original_name: string };
}

type SourceListPayload = Source[] | { sources?: unknown; items?: unknown };

/** Accept the compact source DTO as well as the legacy array without trusting either shape. */
export function parseSourceListPayload(payload: unknown): Source[] {
  const container = payload as SourceListPayload;
  const candidates = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? Array.isArray(container.sources)
        ? container.sources
        : Array.isArray(container.items)
          ? container.items
          : []
      : [];

  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      typeof value.display_name !== "string" ||
      (value.kind !== "document" && value.kind !== "tabular") ||
      typeof value.status !== "string"
    ) {
      return [];
    }

    const meta =
      value.meta && typeof value.meta === "object" && !Array.isArray(value.meta)
        ? {
            error:
              typeof (value.meta as Record<string, unknown>).error === "string"
                ? String((value.meta as Record<string, unknown>).error).slice(0, 300)
                : undefined,
            error_code:
              typeof (value.meta as Record<string, unknown>).error_code === "string"
                ? String((value.meta as Record<string, unknown>).error_code).slice(0, 80)
                : undefined,
            error_detail:
              typeof (value.meta as Record<string, unknown>).error_detail === "string"
                ? String((value.meta as Record<string, unknown>).error_detail).slice(0, 500)
                : undefined,
            error_stage:
              typeof (value.meta as Record<string, unknown>).error_stage === "string"
                ? String((value.meta as Record<string, unknown>).error_stage).slice(0, 40)
                : undefined,
          }
        : null;
    const rawIngestion = value.ingestion;
    const ingestion =
      rawIngestion &&
      typeof rawIngestion === "object" &&
      !Array.isArray(rawIngestion) &&
      typeof (rawIngestion as Record<string, unknown>).attempts === "number" &&
      typeof (rawIngestion as Record<string, unknown>).updated_at === "string"
        ? {
            attempts: Math.max(
              0,
              Math.min(100, Math.trunc(Number((rawIngestion as Record<string, unknown>).attempts))),
            ),
            updated_at: String((rawIngestion as Record<string, unknown>).updated_at),
          }
        : undefined;
    const rawTabular = value.tabular;
    const tabular =
      rawTabular &&
      typeof rawTabular === "object" &&
      !Array.isArray(rawTabular) &&
      typeof (rawTabular as Record<string, unknown>).rows === "number" &&
      typeof (rawTabular as Record<string, unknown>).table === "string"
        ? {
            rows: Number((rawTabular as Record<string, unknown>).rows),
            table: String((rawTabular as Record<string, unknown>).table),
            original_name:
              typeof (rawTabular as Record<string, unknown>).original_name === "string"
                ? String((rawTabular as Record<string, unknown>).original_name)
                : value.display_name,
          }
        : undefined;

    return [
      {
        id: value.id,
        name: value.name,
        display_name: value.display_name,
        kind: value.kind,
        status: value.status,
        mime: typeof value.mime === "string" ? value.mime : "application/octet-stream",
        created_at: typeof value.created_at === "string" ? value.created_at : "",
        meta,
        ingestion,
        tabular,
      } satisfies Source,
    ];
  });
}

export interface Connector {
  id: string;
  name: string;
  type: "url_csv" | "url_json";
  config: Record<string, unknown>;
  target_table: string;
  sync_status: ConnectorSyncStatus;
  sync_error?: string | null;
  last_sync: string | null;
  created_at: string;
  /** Derived convenience surface over the connector's `connector_sync` automation; null when unscheduled. */
  schedule: ConnectorSchedule | null;
}

export type ConnectorSyncStatus = "syncing" | "indexing" | "idle" | "error";

export type ConnectorScheduleState = "active" | "paused";

export interface ConnectorSchedule {
  automation_id: string;
  schedule_minutes: number;
  state: ConnectorScheduleState;
  next_run_at: string | null;
  last_run_at: string | null;
}

const CONNECTOR_SYNC_STATUSES = new Set<ConnectorSyncStatus>(["syncing", "indexing", "idle", "error"]);
const CONNECTOR_SCHEDULE_STATES = new Set<ConnectorScheduleState>(["active", "paused"]);

/**
 * Treat the derived schedule surface as untrusted JSON. A malformed or
 * outdated payload must degrade to "unscheduled" instead of breaking the
 * connector card.
 */
export function parseConnectorSchedule(value: unknown): ConnectorSchedule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.automation_id !== "string" ||
    entry.automation_id.length === 0 ||
    entry.automation_id.length > 200 ||
    typeof entry.schedule_minutes !== "number" ||
    !Number.isSafeInteger(entry.schedule_minutes) ||
    entry.schedule_minutes <= 0 ||
    !CONNECTOR_SCHEDULE_STATES.has(entry.state as ConnectorScheduleState)
  ) {
    return null;
  }
  return {
    automation_id: entry.automation_id,
    schedule_minutes: entry.schedule_minutes,
    state: entry.state as ConnectorScheduleState,
    next_run_at: typeof entry.next_run_at === "string" ? entry.next_run_at : null,
    last_run_at: typeof entry.last_run_at === "string" ? entry.last_run_at : null,
  };
}

/** Normalize one persisted connector row; returns null outside the UI contract. */
function parseConnectorRow(candidate: unknown): Connector | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.type !== "url_csv" && value.type !== "url_json") ||
    typeof value.target_table !== "string" ||
    !CONNECTOR_SYNC_STATUSES.has(value.sync_status as ConnectorSyncStatus) ||
    typeof value.created_at !== "string"
  ) {
    return null;
  }

  let config: unknown = value.config;
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      config = {};
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) config = {};

  return {
    id: value.id,
    name: value.name,
    type: value.type,
    config: config as Record<string, unknown>,
    target_table: value.target_table,
    sync_status: value.sync_status as ConnectorSyncStatus,
    sync_error: typeof value.sync_error === "string" ? value.sync_error : null,
    last_sync: typeof value.last_sync === "string" ? value.last_sync : null,
    created_at: value.created_at,
    schedule: parseConnectorSchedule(value.schedule),
  } satisfies Connector;
}

/** Treat mutation responses with the same untrusted-JSON rules as the list. */
export function parseConnectorPayload(payload: unknown): Connector | null {
  return parseConnectorRow(payload);
}

/** Normalize persisted JSON and reject connector rows outside the UI status contract. */
export function parseConnectorListPayload(payload: unknown): Connector[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((candidate) => {
    const parsed = parseConnectorRow(candidate);
    return parsed ? [parsed] : [];
  });
}

export type ConnectorSyncTrigger = "create" | "manual" | "scheduled";

export type ConnectorSyncOutcome = "succeeded" | "failed" | "skipped";

export interface ConnectorSyncRecord {
  id: number;
  trigger: ConnectorSyncTrigger;
  outcome: ConnectorSyncOutcome;
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

const CONNECTOR_SYNC_TRIGGERS = new Set<ConnectorSyncTrigger>(["create", "manual", "scheduled"]);
const CONNECTOR_SYNC_OUTCOMES = new Set<ConnectorSyncOutcome>(["succeeded", "failed", "skipped"]);
const MAX_CONNECTOR_SYNC_DETAIL_LENGTH = 200;

type ConnectorSyncListPayload = ConnectorSyncRecord[] | { syncs?: unknown };

/**
 * Sync history rows are content-free and bounded. Treat the payload as
 * untrusted JSON and drop rows outside the recorded trigger/outcome contract
 * instead of letting one malformed entry break the dialog.
 */
export function parseConnectorSyncListPayload(payload: unknown): ConnectorSyncRecord[] {
  const container = payload as ConnectorSyncListPayload;
  const candidates = Array.isArray(container)
    ? container
    : container && typeof container === "object"
      ? Array.isArray(container.syncs)
        ? container.syncs
        : []
      : [];
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      !CONNECTOR_SYNC_TRIGGERS.has(value.trigger as ConnectorSyncTrigger) ||
      !CONNECTOR_SYNC_OUTCOMES.has(value.outcome as ConnectorSyncOutcome) ||
      typeof value.started_at !== "string"
    ) {
      return [];
    }
    return [
      {
        id: value.id,
        trigger: value.trigger as ConnectorSyncTrigger,
        outcome: value.outcome as ConnectorSyncOutcome,
        detail: typeof value.detail === "string" ? value.detail.slice(0, MAX_CONNECTOR_SYNC_DETAIL_LENGTH) : null,
        started_at: value.started_at,
        finished_at: typeof value.finished_at === "string" ? value.finished_at : null,
      } satisfies ConnectorSyncRecord,
    ];
  });
}

export interface Report {
  id: string;
  title: string;
  subtitle: string | null;
  created_at: string;
  updated_at: string;
  chat_title: string | null;
  chat_id: string | null;
  version: number;
  supersedes: string | null;
}

export interface ChartArtifactSummary {
  id: string;
  run_id: string | null;
  chat_id: string | null;
  title: string;
  kind: string;
  created_at: string;
}

export interface RemoteEgressState {
  required: boolean;
  acknowledged_at: string | null;
  endpoint_host: string | null;
}

export const REMOTE_EGRESS_CONSENT_CODE = "REMOTE_EGRESS_CONSENT_REQUIRED";

/** True when the failure is the fail-closed remote-egress consent gate (403). */
export function isRemoteEgressConsentError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    (error.data as { code?: unknown } | undefined)?.code === REMOTE_EGRESS_CONSENT_CODE
  );
}

export interface ChartPayload {
  id: string;
  spec?: any;
  echarts?: any;
  png_base64?: string;
}

// ------------------------------------------------------------------ auth
export const authApi = {
  login: (email: string, password: string) =>
    api<{ token: string; user: AuthUser }>("/api/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  register: (email: string, password: string) =>
    api<{ token: string; user: AuthUser }>("/api/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => api<AuthUser>("/api/me"),
};

// ------------------------------------------------------------------ chats
export const chatsApi = {
  list: () => api<Chat[]>("/api/chats"),
  create: (title?: string, scope: SourceScopeInput = { source_mode: "selected", source_ids: [] }, agentId?: string) =>
    api<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify({ title, ...scope, ...(agentId ? { agent_id: agentId } : {}) }),
    }),
  get: (id: string, page?: { beforeMessageId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (page?.beforeMessageId) params.set("before_message_id", page.beforeMessageId);
    if (page?.limit) params.set("limit", String(page.limit));
    const query = params.size ? `?${params.toString()}` : "";
    return api<ChatDetail>(`/api/chats/${id}${query}`);
  },
  updateModel: (id: string, model: string) =>
    api<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ model }) }),
  updateTitle: (id: string, title: string) =>
    api<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  updateSources: (id: string, scope: SourceScopeInput) =>
    api<{ source_mode: SourceMode; sources: AttachedSource[] }>(`/api/chats/${id}/sources`, {
      method: "PUT",
      body: JSON.stringify(scope),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/chats/${id}`, { method: "DELETE" }),
  cancelRun: (chatId: string, runId: string) =>
    api<{ ok: true; run_id: string; status: "cancelling" | ChatRunTerminalStatus }>(
      `/api/chats/${chatId}/runs/${runId}`,
      {
        method: "DELETE",
      },
    ),
};

// ------------------------------------------------------------------ models
export const modelsApi = {
  list: (refresh = false) => api<ModelsResponse>(`/api/models${refresh ? "?refresh=1" : ""}`),
};

// ------------------------------------------------------------------ settings
export const settingsApi = {
  get: (signal?: AbortSignal) => api<ProviderSettingsResponse>("/api/settings", { signal }),
  update: (body: ProviderSettingsPatch) =>
    api<ProviderSettingsResponse>("/api/settings", { method: "PATCH", body: JSON.stringify(body) }),
  testConnection: (body: ProviderSettingsPatch) =>
    api<ProviderConnectionTestResponse>("/api/settings/test", { method: "POST", body: JSON.stringify(body) }),
};

// ------------------------------------------------------------------ preferences
export const preferencesApi = {
  get: () => api<AccountPreferences>("/api/preferences"),
  set: (defaultChatModel: string | null) =>
    api<AccountPreferences>("/api/preferences", {
      method: "PATCH",
      body: JSON.stringify({ default_chat_model: defaultChatModel }),
    }),
};

// ------------------------------------------------------------------ audit
export interface EgressEvent {
  id: number;
  kind: "consent_acknowledged" | "remote_turn" | "remote_ingest";
  endpoint_host: string | null;
  created_at: string;
}

export const auditApi = {
  egress: (limit = 50) => api<EgressEvent[]>(`/api/audit/egress?limit=${limit}`),
};

// ------------------------------------------------------------------ shares
export interface ReportShare {
  recipient_account_id: string;
  recipient_email: string;
  shared_at: string;
}

export interface SharedReport {
  id: string;
  title: string;
  subtitle: string | null;
  version: number;
  owner_account_id: string;
  owner_email: string;
  shared_at: string;
  created_at: string;
}

// ------------------------------------------------------------------ automations
export type AutomationKind = "connector_sync" | "agent_turn";

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  target_id: string;
  prompt: string | null;
  schedule_minutes: number;
  state: "active" | "paused";
  consecutive_failures: number;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationRun {
  id: number;
  outcome: "succeeded" | "failed" | "skipped";
  detail: string | null;
  started_at: string;
  finished_at: string | null;
}

export const automationsApi = {
  list: () => api<Automation[]>("/api/automations"),
  create: (body: {
    name: string;
    kind: AutomationKind;
    target_id: string;
    prompt?: string;
    schedule_minutes: number;
  }) => api<Automation>("/api/automations", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, patch: { name?: string; state?: "active" | "paused"; schedule_minutes?: number }) =>
    api<Automation>(`/api/automations/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: true }>(`/api/automations/${id}`, { method: "DELETE" }),
  runs: (id: string, limit = 20) => api<AutomationRun[]>(`/api/automations/${id}/runs?limit=${limit}`),
};

// ------------------------------------------------------------------ system
export const systemApi = {
  health: (signal?: AbortSignal) => api<SystemHealthResponse>("/api/health", { signal }),
  workspaceStatus: (signal?: AbortSignal) => api<WorkspaceStatusResponse>("/api/status", { signal }),
};

// ------------------------------------------------------------------ consent
export const consentApi = {
  get: (signal?: AbortSignal) => api<RemoteEgressState>("/api/consent/remote-egress", { signal }),
  acknowledge: () => api<RemoteEgressState>("/api/consent/remote-egress", { method: "POST" }),
};

// ------------------------------------------------------------------ libraries
export interface AgentSummary {
  id: string;
  name: string;
  current_version: number;
  instructions: string;
  instructions_chars: number;
  created_at: string;
  updated_at: string;
}

export interface AgentRevision {
  version: number;
  instructions: string;
  created_at: string;
}

export interface AgentDetail extends AgentSummary {
  revisions: AgentRevision[];
}

export const MAX_AGENT_INSTRUCTION_CHARS = 8_000;

export const agentsApi = {
  list: () => api<AgentSummary[]>("/api/agents"),
  create: (name: string, instructions: string) =>
    api<AgentSummary>("/api/agents", { method: "POST", body: JSON.stringify({ name, instructions }) }),
  get: (id: string) => api<AgentDetail>(`/api/agents/${id}`),
  update: (id: string, patch: { name?: string; instructions?: string }) =>
    api<AgentSummary>(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => api<{ ok: true }>(`/api/agents/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ libraries
export interface LibrarySummary {
  id: string;
  name: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface LibraryDetail extends LibrarySummary {
  members: Source[];
}

export const MAX_LIBRARY_MEMBERS = 100;

export const librariesApi = {
  list: () => api<LibrarySummary[]>("/api/libraries"),
  create: (name: string) => api<LibrarySummary>("/api/libraries", { method: "POST", body: JSON.stringify({ name }) }),
  get: (id: string) => api<LibraryDetail>(`/api/libraries/${id}`),
  rename: (id: string, name: string) =>
    api<LibrarySummary>(`/api/libraries/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  setMembers: (id: string, sourceIds: string[]) =>
    api<{ ok: true }>(`/api/libraries/${id}/sources`, {
      method: "PUT",
      body: JSON.stringify({ source_ids: sourceIds }),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/libraries/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ sources
export const sourcesApi = {
  list: async () => parseSourceListPayload(await api<unknown>("/api/sources")),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api<Source & { processing: boolean }>("/api/sources/upload", { method: "POST", body: fd });
  },
  reingest: (id: string) => api<Source & { processing: boolean }>(`/api/sources/${id}/reingest`, { method: "POST" }),
  remove: (id: string) => api<{ ok: true }>(`/api/sources/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ connectors
const MAX_CONNECTOR_SYNC_HISTORY_LIMIT = 50;

export const connectorsApi = {
  list: async () => parseConnectorListPayload(await api<unknown>("/api/connectors")),
  create: (body: {
    display_name: string;
    target_table: string;
    type: "url_csv" | "url_json";
    config: { url: string };
  }) => api<Connector>("/api/connectors", { method: "POST", body: JSON.stringify(body) }),
  sync: (id: string) =>
    api<Connector | { synced: true; processing: true }>(`/api/connectors/${id}/sync`, { method: "POST" }),
  remove: (id: string) => api<{ ok: true }>(`/api/connectors/${id}`, { method: "DELETE" }),
  /** `null` removes the schedule (deletes the linked connector_sync automation). */
  updateConnectorSchedule: async (id: string, scheduleMinutes: number | null) =>
    parseConnectorPayload(
      await api<unknown>(`/api/connectors/${id}/schedule`, {
        method: "PUT",
        body: JSON.stringify({ schedule_minutes: scheduleMinutes }),
      }),
    ),
  listConnectorSyncs: async (id: string, limit = MAX_CONNECTOR_SYNC_HISTORY_LIMIT) => {
    const bounded = Math.max(1, Math.min(MAX_CONNECTOR_SYNC_HISTORY_LIMIT, Math.trunc(limit) || 1));
    return parseConnectorSyncListPayload(await api<unknown>(`/api/connectors/${id}/syncs?limit=${bounded}`));
  },
};

// ------------------------------------------------------------------ reports
export const reportsApi = {
  list: () => api<Report[]>("/api/reports"),
  listShared: () => api<SharedReport[]>("/api/reports/shared"),
  listShares: (id: string) => api<ReportShare[]>(`/api/reports/${id}/shares`),
  share: (id: string, recipientAccountId: string) =>
    api<ReportShare>(`/api/reports/${id}/shares`, {
      method: "POST",
      body: JSON.stringify({ recipient_account_id: recipientAccountId }),
    }),
  revoke: (id: string, recipientAccountId: string) =>
    api<{ ok: true }>(`/api/reports/${id}/shares/${recipientAccountId}`, { method: "DELETE" }),
  get: (id: string) =>
    api<{
      id: string;
      title: string;
      subtitle: string | null;
      created_at: string;
      updated_at: string;
      has_html: boolean;
      has_pdf: boolean;
      version: number;
      supersedes: string | null;
      payload?: unknown;
    }>(`/api/reports/${id}`),
  rename: (id: string, title: string) =>
    api<Report>(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  remove: (id: string) => api<{ ok: true }>(`/api/reports/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ charts
export const chartsApi = {
  list: () => api<ChartArtifactSummary[]>("/api/charts"),
  get: (id: string) => api<ChartPayload>(`/api/charts/${id}`),
};

/** Fetch the SSE agent stream, invoking onEvent for each parsed event. Returns when the stream ends. */
export async function streamAgentChat(
  chatId: string,
  content: string,
  onEvent: (ev: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ content }),
    signal,
  });
  if (res.status === 401) {
    clearSession();
    if (!location.pathname.startsWith("/login")) location.href = "/login";
    throw await errorFromResponse(res);
  }
  if (!res.ok || !res.body) {
    throw await errorFromResponse(res);
  }
  await consumeSseJson(res.body, onEvent);
}
