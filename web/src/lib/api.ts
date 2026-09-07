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
  const raw = error instanceof ApiError ? error.message.trim() : "";
  const generic =
    /^(internal server error|bad gateway|service unavailable|gateway timeout|request failed \(\d{3}\))$/i.test(raw);
  const message = raw && !generic ? raw.slice(0, 500) : fallback;
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

/** Download an authenticated resource (e.g. a document publication export). */
export async function downloadBlob(path: string, filename: string): Promise<void> {
  const blob = await apiBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
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
    if (!location.pathname.startsWith("/login") || location.hash) {
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
  agent: { id: string; name: string; icon?: string; color?: string } | null;
  created_at: string;
  updated_at: string;
}

export interface CatalogPage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface CatalogPageOptions {
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export interface CatalogStatus<T> {
  items: T[];
  missing_ids: string[];
}

const RESOURCE_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseCatalogStatus<T>(
  payload: unknown,
  requestedIds: readonly string[],
  parseItems: (value: unknown) => T[],
  itemId: (item: T) => string,
): CatalogStatus<T> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid catalog status response");
  }
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value.items) || !Array.isArray(value.missing_ids)) {
    throw new Error("invalid catalog status response");
  }
  const items = parseItems(value.items);
  const missingIds = value.missing_ids;
  if (
    items.length !== value.items.length ||
    missingIds.some((id) => typeof id !== "string" || !RESOURCE_ID_PATTERN.test(id))
  ) {
    throw new Error("invalid catalog status response");
  }
  const requested = new Set(requestedIds);
  const seen = new Set<string>();
  for (const id of [...items.map(itemId), ...(missingIds as string[])]) {
    if (!requested.has(id) || seen.has(id)) throw new Error("invalid catalog status response");
    seen.add(id);
  }
  if (seen.size !== requested.size) throw new Error("invalid catalog status response");
  return { items, missing_ids: missingIds as string[] };
}

function catalogPath(base: string, options: CatalogPageOptions = {}): string {
  const params = new URLSearchParams();
  // Preserve an explicitly supplied invalid cursor so the server can reject it.
  // Silently omitting it would widen the request back to page one.
  if (options.cursor !== undefined && options.cursor !== null) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  return params.size ? `${base}?${params.toString()}` : base;
}

function parseCatalogEnvelope<T>(payload: unknown, parseItems: (value: unknown) => T[]): CatalogPage<T> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid catalog response");
  const value = payload as Record<string, unknown>;
  if (
    !Array.isArray(value.items) ||
    (value.next_cursor !== null &&
      (typeof value.next_cursor !== "string" ||
        value.next_cursor.length < 1 ||
        value.next_cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(value.next_cursor)))
  ) {
    throw new Error("invalid catalog response");
  }
  return { items: parseItems(value.items), next_cursor: value.next_cursor as string | null };
}

function parseTypedCatalogEnvelope<T>(payload: unknown): CatalogPage<T> {
  return parseCatalogEnvelope(payload, (items) => items as T[]);
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
  /**
   * Opaque id of the persisted full-query capture backing this receipt.
   * Present only on receipts whose complete SQL was verifiably captured;
   * legacy receipts omit it and are never promotable from the sliced text.
   */
  capture_id?: string;
  can_save_analysis?: true;
}

const CAPTURE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

    // The capture affordance is trusted only as a lowercase capture UUID
    // paired with the explicit server flag; anything else is dropped so the
    // UI's promotion path keys off `capture_id`/`can_save_analysis` alone.
    const captureId =
      typeof artifact.capture_id === "string" && CAPTURE_ID_PATTERN.test(artifact.capture_id)
        ? artifact.capture_id
        : undefined;
    const canSave = artifact.can_save_analysis === true && captureId !== undefined;

    artifacts.push({
      id: artifact.id,
      sql: artifact.sql,
      columns,
      rows,
      row_count: artifact.row_count as number,
      truncated: artifact.truncated,
      ...(canSave ? { capture_id: captureId, can_save_analysis: true as const } : {}),
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
  display_name?: string;
  owned_by?: string;
}

export interface ModelsResponse {
  available_models?: ChatModelOption[];
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
  | "default_embed_model"
  | "embedding_dimension";

export interface ProviderSettingsResponse {
  llm_base_url: string;
  /** The stored secret is deliberately never returned to the browser. */
  llm_api_key_configured: boolean;
  lm_studio_base_url: string | null;
  default_chat_model: string;
  default_embed_model: string;
  embedding_dimension: number;
  managed_by_env: Record<ProviderSettingName, boolean>;
}

export interface ProviderSettingsPatch {
  llm_base_url?: string;
  /** Omit to preserve the stored key; null explicitly clears it. */
  llm_api_key?: string | null;
  lm_studio_base_url?: string | null;
  default_chat_model?: string;
  default_embed_model?: string;
  embedding_dimension?: number;
}

export interface ProviderConnectionTestResponse {
  ok: true;
  latency_ms: number;
}

export type ChatQualificationReason =
  | "qualified"
  | "unreachable"
  | "timeout"
  | "response-truncated"
  | "tool-call-missing"
  | "tool-call-invalid";
export type EmbeddingQualificationReason =
  | "qualified"
  | "unreachable"
  | "timeout"
  | "embedding-invalid"
  | "dimension-mismatch";

export interface ModelPairQualificationResult {
  chat: {
    qualified: boolean;
    reason_code: ChatQualificationReason;
    latency_ms: number;
  };
  embedding: {
    qualified: boolean;
    reason_code: EmbeddingQualificationReason;
    dimension: number | null;
    latency_ms: number;
  };
}

export type ModelPairQualificationRequest = Omit<ProviderSettingsPatch, "lm_studio_base_url"> & {
  expected_dimension?: number;
  remote_egress_ack_origin?: string;
};

export type EmbeddingMigrationPhase =
  | "idle"
  | "snapshotting"
  | "building"
  | "ready_to_apply"
  | "apply_pending"
  | "failed";

export interface EmbeddingMigrationStatus {
  phase: EmbeddingMigrationPhase;
  target_model: string | null;
  target_dimension: number | null;
  source_count: number;
  chunk_count: number;
  indexed_count: number;
  error_code: string | null;
  restart_required: boolean;
  can_cancel: boolean;
  can_retry: boolean;
  can_apply: boolean;
}

export interface EmbeddingMigrationStartRequest {
  target_embed_model: string;
  target_dimension: number;
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

/** Normalize compact source DTO rows without trusting their shape. */
export function parseSourceListPayload(payload: unknown): Source[] {
  const candidates = Array.isArray(payload) ? payload : [];

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
      Number.isFinite((rawIngestion as Record<string, unknown>).attempts) &&
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
      Number.isFinite((rawTabular as Record<string, unknown>).rows) &&
      typeof (rawTabular as Record<string, unknown>).table === "string"
        ? {
            // JSON.stringify can emit a literal NaN through untrusted
            // providers; never let a non-finite row count reach rendering.
            rows: Math.max(0, Math.trunc(Number((rawTabular as Record<string, unknown>).rows))),
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
  /** Artifact presence from the list/detail endpoints; rename responses omit them. */
  has_html?: boolean;
  has_pdf?: boolean;
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
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<Chat>(await api<unknown>(catalogPath("/api/chats", options), { signal: options.signal })),
  create: (
    title?: string,
    scope: SourceScopeInput = { source_mode: "selected", source_ids: [] },
    agentId?: string,
    signal?: AbortSignal,
    model?: string,
  ) =>
    api<Chat>("/api/chats", {
      method: "POST",
      body: JSON.stringify({ title, ...(model ? { model } : {}), ...scope, ...(agentId ? { agent_id: agentId } : {}) }),
      signal,
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
  qualify: (body: ModelPairQualificationRequest, signal?: AbortSignal) =>
    api<ModelPairQualificationResult>("/api/models/qualify", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  embeddingMigrationStatus: (signal?: AbortSignal) =>
    api<EmbeddingMigrationStatus>("/api/models/embedding-migration", { signal }),
  startEmbeddingMigration: (body: EmbeddingMigrationStartRequest) =>
    api<EmbeddingMigrationStatus>("/api/models/embedding-migration/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  retryEmbeddingMigration: () =>
    api<EmbeddingMigrationStatus>("/api/models/embedding-migration/retry", { method: "POST" }),
  cancelEmbeddingMigration: () =>
    api<EmbeddingMigrationStatus>("/api/models/embedding-migration/cancel", { method: "POST" }),
  applyEmbeddingMigration: () =>
    api<EmbeddingMigrationStatus>("/api/models/embedding-migration/apply", { method: "POST" }),
};

// ------------------------------------------------------------------ settings
export const settingsApi = {
  get: (signal?: AbortSignal) => api<ProviderSettingsResponse>("/api/settings", { signal }),
  update: (body: ProviderSettingsPatch, signal?: AbortSignal) =>
    api<ProviderSettingsResponse>("/api/settings", { method: "PATCH", body: JSON.stringify(body), signal }),
  testConnection: (body: ProviderSettingsPatch, signal?: AbortSignal) =>
    api<ProviderConnectionTestResponse>("/api/settings/test", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
};

// ------------------------------------------------------------------ preferences
export const preferencesApi = {
  get: (signal?: AbortSignal) => api<AccountPreferences>("/api/preferences", { signal }),
  set: (defaultChatModel: string | null, signal?: AbortSignal) =>
    api<AccountPreferences>("/api/preferences", {
      method: "PATCH",
      body: JSON.stringify({ default_chat_model: defaultChatModel }),
      signal,
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
  egress: (limit = 50, signal?: AbortSignal) => api<EgressEvent[]>(`/api/audit/egress?limit=${limit}`, { signal }),
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
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<Automation>(
      await api<unknown>(catalogPath("/api/automations", options), { signal: options.signal }),
    ),
  create: (
    body: {
      name: string;
      kind: AutomationKind;
      target_id: string;
      prompt?: string;
      schedule_minutes: number;
    },
    signal?: AbortSignal,
  ) => api<Automation>("/api/automations", { method: "POST", body: JSON.stringify(body), signal }),
  update: (
    id: string,
    patch: { name?: string; state?: "active" | "paused"; schedule_minutes?: number },
    signal?: AbortSignal,
  ) => api<Automation>(`/api/automations/${id}`, { method: "PATCH", body: JSON.stringify(patch), signal }),
  remove: (id: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/automations/${id}`, { method: "DELETE", signal }),
  runs: (id: string, limit = 20, signal?: AbortSignal) =>
    api<AutomationRun[]>(`/api/automations/${id}/runs?limit=${limit}`, { signal }),
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

// ------------------------------------------------------------------ contained
/**
 * Redacted server projection of the stored contained configuration. Durable
 * absolute paths, the binary digest, and the raw argument array never leave
 * the server: `binary` and `model` are basenames only, the digest appears as a
 * presence flag, and extra arguments as a count. A disabled or unsaved
 * configuration carries no names, flag false, and count zero.
 */
export interface ContainedConfig {
  enabled: boolean;
  binary: string | null;
  model: string | null;
  binary_digest_configured: boolean;
  extra_arg_count: number;
}

/**
 * Write-side payload. Unlike the read projection it still carries full
 * absolute paths; the request schema accepts them even though no response
 * ever echoes them. An enabled write additionally needs `binary_sha256`
 * because the server verifies the binary against it on every spawn.
 */
export interface ContainedConfigInput {
  enabled: boolean;
  binary_path?: string;
  model_path?: string;
  /** Operator-declared SHA-256 of the engine binary; required to enable. Never returned. */
  binary_sha256?: string;
  extra_args?: string[];
}

export interface ContainedDownloadState {
  filename: string;
  url_host: string;
  state: "downloading" | "verifying" | "complete" | "failed" | "canceled";
  bytes_received: number;
  total_bytes: number | null;
  error?: string;
}

export interface ContainedDownloadInput {
  url: string;
  filename: string;
  sha256: string;
}

/** Full engine status from the contained management surface. */
export interface ContainedEngineStatus {
  state: ContainedEngineState;
  model: string | null;
  endpoint_host: string | null;
  endpoint_managed_by_env: boolean;
  pid: number | null;
  started_at: string | null;
  error: string | null;
}

export interface ContainedResponse {
  config: ContainedConfig | null;
  engine: ContainedEngineStatus;
  downloads: ContainedDownloadState[];
}

export const containedApi = {
  get: (signal?: AbortSignal) => api<ContainedResponse>("/api/contained", { signal }),
  saveConfig: (config: ContainedConfigInput, signal?: AbortSignal) =>
    api<ContainedConfig>("/api/contained/config", { method: "PUT", body: JSON.stringify(config), signal }),
  startDownload: (body: ContainedDownloadInput, signal?: AbortSignal) =>
    api<ContainedDownloadState>("/api/contained/downloads", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  cancelDownload: (filename: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/contained/downloads/${encodeURIComponent(filename)}`, { method: "DELETE", signal }),
  startEngine: (signal?: AbortSignal) =>
    api<ContainedEngineStatus>("/api/contained/engine/start", { method: "POST", signal }),
  stopEngine: (signal?: AbortSignal) =>
    api<ContainedEngineStatus>("/api/contained/engine/stop", { method: "POST", signal }),
};

// ------------------------------------------------------------------ libraries
/** One connected-tool selection in an agent configuration (Connected agents). */
export interface AgentMcpBindingSelection {
  connection_id: string;
  tool_id: string;
  discovery_revision: number;
  /** Explicit operator allowance for a server-flagged write-oriented tool. */
  allow_write?: boolean;
}

export type AgentOutputTemplate =
  | { kind: "instruction"; instruction: string }
  | { kind: "template_id"; template_id: string };

/** Versioned job setup with instructions or a document-template reference. */
export interface AgentJobSetup {
  starter_prompts: string[];
  output_template: AgentOutputTemplate | null;
  library_ids: string[];
}

export const MAX_MCP_BINDINGS = 16;
export const MAX_JOB_STARTER_PROMPTS = 5;
export const MAX_JOB_STARTER_PROMPT_CHARS = 2_000;
export const MAX_JOB_LIBRARIES = 10;
export const MAX_JOB_TEMPLATE_CHARS = 8_000;

export interface AgentConfiguration {
  description?: string;
  icon?: string;
  color?: string;
  /** Built-in tools only; connected tools live in `mcp_tools`. */
  tools?: string[];
  skill_ids?: string[];
  mcp_tools?: AgentMcpBindingSelection[];
  job_setup?: AgentJobSetup;
}

export function emptyJobSetup(): AgentJobSetup {
  return { starter_prompts: [], output_template: null, library_ids: [] };
}

function parseJobSetup(candidate: unknown): AgentJobSetup | undefined {
  if (candidate === undefined || candidate === null) return undefined;
  if (typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  const prompts = Array.isArray(value.starter_prompts)
    ? value.starter_prompts.filter((p): p is string => typeof p === "string").slice(0, MAX_JOB_STARTER_PROMPTS)
    : [];
  const templateValue = value.output_template;
  let template: AgentOutputTemplate | null = null;
  if (
    templateValue &&
    typeof templateValue === "object" &&
    !Array.isArray(templateValue) &&
    (templateValue as Record<string, unknown>).kind === "instruction" &&
    typeof (templateValue as Record<string, unknown>).instruction === "string"
  ) {
    template = {
      kind: "instruction",
      instruction: ((templateValue as Record<string, unknown>).instruction as string).slice(0, MAX_JOB_TEMPLATE_CHARS),
    };
  } else if (
    templateValue &&
    typeof templateValue === "object" &&
    !Array.isArray(templateValue) &&
    (templateValue as Record<string, unknown>).kind === "template_id" &&
    typeof (templateValue as Record<string, unknown>).template_id === "string"
  ) {
    template = { kind: "template_id", template_id: (templateValue as { template_id: string }).template_id };
  }
  const libraries = Array.isArray(value.library_ids)
    ? value.library_ids.filter((id): id is string => typeof id === "string").slice(0, MAX_JOB_LIBRARIES)
    : [];
  return { starter_prompts: prompts, output_template: template, library_ids: libraries };
}

function parseMcpBindingSelections(candidate: unknown): AgentMcpBindingSelection[] {
  if (!Array.isArray(candidate)) return [];
  return candidate
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .filter(
      (entry) =>
        typeof entry.connection_id === "string" &&
        typeof entry.tool_id === "string" &&
        typeof entry.discovery_revision === "number" &&
        Number.isSafeInteger(entry.discovery_revision),
    )
    .slice(0, MAX_MCP_BINDINGS)
    .map((entry) => ({
      connection_id: entry.connection_id as string,
      tool_id: entry.tool_id as string,
      discovery_revision: entry.discovery_revision as number,
      ...(typeof entry.allow_write === "boolean" ? { allow_write: entry.allow_write } : {}),
    }));
}
/** Defensive view of an agent's job setup (server rows are untrusted JSON). */
export function agentJobSetupOf(agent: { job_setup?: unknown }): AgentJobSetup {
  return parseJobSetup(agent.job_setup) ?? emptyJobSetup();
}

/** Defensive view of an agent's connected-tool selections. */
export function agentMcpBindingsOf(agent: { mcp_tools?: unknown }): AgentMcpBindingSelection[] {
  return parseMcpBindingSelections(agent.mcp_tools);
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  version: number;
}
export const agentSkillsApi = {
  list: (signal?: AbortSignal) => api<{ items: AgentSkill[] }>("/api/agent-skills", { signal }),
  save: (skill: { name: string; description: string; content: string }, id?: string) =>
    api<AgentSkill>(id ? `/api/agent-skills/${id}` : "/api/agent-skills", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({ name: skill.name, description: skill.description, content: skill.content }),
    }),
  remove: (id: string) => api<{ ok: true }>(`/api/agent-skills/${id}`, { method: "DELETE" }),
};
export interface AgentSummary extends AgentConfiguration {
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
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<AgentSummary>(
      await api<unknown>(catalogPath("/api/agents", options), { signal: options.signal }),
    ),
  create: (name: string, instructions: string, configuration: AgentConfiguration = {}) =>
    api<AgentSummary>("/api/agents", {
      method: "POST",
      body: JSON.stringify({ name, instructions, ...configuration }),
    }),
  get: (id: string) => api<AgentDetail>(`/api/agents/${id}`),
  update: (id: string, patch: { name?: string; instructions?: string } & AgentConfiguration) =>
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
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<LibrarySummary>(
      await api<unknown>(catalogPath("/api/libraries", options), { signal: options.signal }),
    ),
  create: (name: string, signal?: AbortSignal) =>
    api<LibrarySummary>("/api/libraries", { method: "POST", body: JSON.stringify({ name }), signal }),
  get: (id: string, signal?: AbortSignal) => api<LibraryDetail>(`/api/libraries/${id}`, { signal }),
  rename: (id: string, name: string, signal?: AbortSignal) =>
    api<LibrarySummary>(`/api/libraries/${id}`, { method: "PATCH", body: JSON.stringify({ name }), signal }),
  setMembers: (id: string, sourceIds: string[], signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/libraries/${id}/sources`, {
      method: "PUT",
      body: JSON.stringify({ source_ids: sourceIds }),
      signal,
    }),
  remove: (id: string, signal?: AbortSignal) => api<{ ok: true }>(`/api/libraries/${id}`, { method: "DELETE", signal }),
  /** Library-scoped inspectable search (M14): keyword (default, no model
   * request) or semantic (explicit; subject to the remote-egress consent
   * gate). Filters never widen beyond library membership. */
  search: (
    id: string,
    body: { query: string; mode?: "keyword" | "semantic"; source_ids?: string[]; kind?: "document" | "tabular" },
    signal?: AbortSignal,
  ) => api<LibrarySearchResult>(`/api/libraries/${id}/search`, { method: "POST", body: JSON.stringify(body), signal }),
};

// ------------------------------------------------- library search & passages
export type SourceLocator =
  | { kind: "pdf_page"; page: number; ocr: boolean; char_start: number; char_len: number }
  | { kind: "text_span"; char_start: number; char_len: number; heading?: string | null }
  | { kind: "tabular_rows"; table: string; row_start: number; row_end: number };

export interface LibrarySearchHit {
  source_id: string;
  generation: number;
  chunk_id: string;
  label: string;
  excerpt: string;
  score: number;
  rank: number;
  locators?: SourceLocator[];
}

export interface LibrarySearchCapturedScopeEntry {
  source_id: string;
  generation: number;
  status: "ready" | "source_changed" | "unavailable";
}

export interface LibrarySearchResult {
  mode: "keyword" | "semantic";
  query_truncated: boolean;
  captured_scope: LibrarySearchCapturedScopeEntry[];
  ignored_source_ids: string[];
  hits: LibrarySearchHit[];
  returned_char_count: number;
  truncated: boolean;
}

export interface PassageNeighbour {
  chunk_id: string;
  seq: number;
  content: string;
}

export interface SourcePassage {
  source: { id: string; label: string; status: string; ready_generation: number | null };
  chunk: {
    chunk_id: string;
    source_id: string;
    generation: number;
    seq: number;
    content: string;
    locators?: SourceLocator[];
  };
  neighbors: { before: PassageNeighbour | null; after: PassageNeighbour | null };
}

// ------------------------------------------------------------------ sources
export const sourcesApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseCatalogEnvelope(
      await api<unknown>(catalogPath("/api/sources", options), { signal: options.signal }),
      parseSourceListPayload,
    ),
  status: async (ids: string[], signal?: AbortSignal) =>
    parseCatalogStatus(
      await api<unknown>("/api/sources/status", { method: "POST", body: JSON.stringify({ ids }), signal }),
      ids,
      parseSourceListPayload,
      (source) => source.id,
    ),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api<Source & { processing: boolean }>("/api/sources/upload", { method: "POST", body: fd });
  },
  reingest: (id: string) => api<Source & { processing: boolean }>(`/api/sources/${id}/reingest`, { method: "POST" }),
  remove: (id: string) => api<{ ok: true }>(`/api/sources/${id}`, { method: "DELETE" }),
  /** Owned current-chunk passage with typed locators and bounded neighboring
   * text. 410 PASSAGE_UNAVAILABLE means the chunk was pruned or superseded. */
  passage: (id: string, chunkId: string, signal?: AbortSignal) =>
    api<SourcePassage>(`/api/sources/${id}/passages/${chunkId}`, { signal }),
};

// ------------------------------------------------- living knowledge (M14)
export type KnowledgeConnectionKind = "desktop_folder" | "webdav";
export type KnowledgeConnectionStatus = "untested" | "ready" | "disconnected" | "error";
export type KnowledgePreviewStatus = "pending" | "complete" | "failed" | "applied" | "expired";
export type KnowledgePreviewClassification = "new" | "changed" | "unchanged" | "duplicate" | "missing" | "unsupported";
export type KnowledgeRefreshStatus = "active" | "completed" | "partial" | "failed" | "cancelled";

export interface KnowledgeConnection {
  id: string;
  name: string;
  kind: KnowledgeConnectionKind;
  library_id: string | null;
  revision: number;
  watch_enabled: boolean;
  credential_configured: boolean;
  status: KnowledgeConnectionStatus;
  status_code: string | null;
  /** Display-only label: the folder picker's label or the WebDAV host. */
  label: string;
  /** Non-secret WebDAV endpoint shape; never present for folder connections. */
  webdav?: { url: string; username: string } | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgePreview {
  id: string;
  connection_id: string;
  revision: number;
  status: KnowledgePreviewStatus;
  error_code: string | null;
  visited_entries: number;
  directories: number;
  aggregate_bytes: number;
  new_count: number;
  changed_count: number;
  unchanged_count: number;
  duplicate_count: number;
  missing_count: number;
  unsupported_count: number;
  skipped_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  applied_at: string | null;
}

export interface KnowledgePreviewEntry {
  entry_id: string;
  ordinal: number;
  relative_path: string;
  classification: KnowledgePreviewClassification;
  content_hash: string | null;
  size_bytes: number | null;
  existing_source_id: string | null;
  mtime_hint: string | null;
  etag_hint: string | null;
  /** Exact-revision binding echoed back on apply; never a path or secret. */
  selection_token: string;
}

export interface KnowledgeRefresh {
  id: string;
  connection_id: string;
  requested_by: "manual" | "apply" | "scheduled";
  expected_connection_revision: number;
  status: KnowledgeRefreshStatus;
  cancel_requested: boolean;
  error_code: string | null;
  created_at: string;
  started_at: string;
  finished_at: string | null;
}

export interface KnowledgeRefreshItem {
  item_id: string;
  source_id: string;
  relative_path: string;
  status: "pending" | "staged" | "committed" | "ready" | "unchanged" | "missing" | "failed" | "blocked" | "cancelled";
  error_code: string | null;
  current_ready_generation: number | null;
  expected_generation: number | null;
  promoted_generation: number | null;
}

export interface KnowledgeRefreshDetail {
  refresh: KnowledgeRefresh;
  counts: Record<string, number>;
  items: KnowledgeRefreshItem[];
}

export interface KnowledgeCreateInput {
  name: string;
  kind: KnowledgeConnectionKind;
  library_id: string;
  watch_enabled?: boolean;
  /** Desktop folder: the opaque one-time id from the native picker. */
  grant_id?: string;
  /** WebDAV only; the password is write-only and lands in shared custody. */
  config?: { url: string; username: string; password: string };
}

export const knowledgeApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<KnowledgeConnection>(
      await api<unknown>(catalogPath("/api/knowledge-connections", options), { signal: options.signal }),
    ),
  create: (body: KnowledgeCreateInput, signal?: AbortSignal) =>
    api<KnowledgeConnection>("/api/knowledge-connections", { method: "POST", body: JSON.stringify(body), signal }),
  update: (
    id: string,
    body: {
      expected_revision: number;
      name?: string;
      watch_enabled?: boolean;
      credentials?: { password: string } | null;
    },
    signal?: AbortSignal,
  ) =>
    api<KnowledgeConnection>(`/api/knowledge-connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal,
    }),
  remove: (id: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/knowledge-connections/${id}`, { method: "DELETE", signal }),
  /** Starts the durable bounded scan; the pending preview + run id return now. */
  createPreview: (id: string, signal?: AbortSignal) =>
    api<{ preview: KnowledgePreview; run_id: string }>(`/api/knowledge-connections/${id}/previews`, {
      method: "POST",
      signal,
    }),
  getPreview: (previewId: string, signal?: AbortSignal) =>
    api<{ preview: KnowledgePreview; entries: KnowledgePreviewEntry[] }>(`/api/knowledge-previews/${previewId}`, {
      signal,
    }),
  applyPreview: (
    previewId: string,
    body: { expected_revision: number; selections: { entry_id: string; selection_token: string }[] },
    signal?: AbortSignal,
  ) =>
    api<{
      preview: KnowledgePreview;
      items: { entry_id: string; item_id: string; source_id: string; relative_path: string; action: string }[];
      refresh_id: string | null;
    }>(`/api/knowledge-previews/${previewId}/apply`, { method: "POST", body: JSON.stringify(body), signal }),
  startRefresh: (
    id: string,
    body: { expected_connection_revision?: number; item_ids?: string[] } = {},
    signal?: AbortSignal,
  ) =>
    api<{ refresh: KnowledgeRefresh }>(`/api/knowledge-connections/${id}/refreshes`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  listRefreshes: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<KnowledgeRefresh>(
      await api<unknown>(catalogPath(`/api/knowledge-connections/${id}/refreshes`, options), {
        signal: options.signal,
      }),
    ),
  getRefresh: (refreshId: string, signal?: AbortSignal) =>
    api<KnowledgeRefreshDetail>(`/api/knowledge-refreshes/${refreshId}`, { signal }),
  cancelRefresh: (refreshId: string, signal?: AbortSignal) =>
    api<{ ok: true; cancel_requested: boolean; status: KnowledgeRefreshStatus }>(
      `/api/knowledge-refreshes/${refreshId}`,
      { method: "DELETE", signal },
    ),
};

// ------------------------------------------------------------------ connectors
const MAX_CONNECTOR_SYNC_HISTORY_LIMIT = 50;

export const connectorsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseCatalogEnvelope(
      await api<unknown>(catalogPath("/api/connectors", options), { signal: options.signal }),
      parseConnectorListPayload,
    ),
  status: async (ids: string[], signal?: AbortSignal) =>
    parseCatalogStatus(
      await api<unknown>("/api/connectors/status", { method: "POST", body: JSON.stringify({ ids }), signal }),
      ids,
      parseConnectorListPayload,
      (connector) => connector.id,
    ),
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

// ------------------------------------------------------------------ connections
export type ConnectionKind = "mcp_http" | "mcp_stdio";
export type ConnectionStatus = "untested" | "ready" | "disconnected" | "error";
export type ConnectionCredentialState = "none" | "stored" | "unavailable";

export interface ConnectionConfigDto {
  kind: ConnectionKind;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
}

export interface ConnectionToolDto {
  tool_id: string;
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Redacted connection DTO: never any credential material, only its state. */
export interface ConnectionDto {
  id: string;
  name: string;
  kind: ConnectionKind;
  revision: number;
  discovery_revision: number;
  enabled: boolean;
  status: ConnectionStatus;
  status_code: string | null;
  config: ConnectionConfigDto;
  credential_state: ConnectionCredentialState;
  created_at: string;
  updated_at: string;
}

export interface ConnectionDetailDto extends ConnectionDto {
  tools: ConnectionToolDto[];
}

export interface ConnectionAuthorizationDto {
  authorize_url: string;
  expires_at: string;
  /** Packaged-desktop only: one-time system-browser open intent for this URL. */
  desktop_open_token?: string;
  desktop_open_expires_at?: string;
}

export interface ConnectionSecretsInput {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ConnectionCreateInput {
  name: string;
  kind: ConnectionKind;
  config: Record<string, unknown>;
  enabled?: boolean;
  credentials?: ConnectionSecretsInput;
}

export interface ConnectionPatchInput {
  expected_revision: number;
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  /** An object fully replaces stored credentials; `null` removes them. */
  credentials?: ConnectionSecretsInput | null;
}

const CONNECTION_STATUSES: ReadonlySet<string> = new Set(["untested", "ready", "disconnected", "error"]);
const CONNECTION_KINDS: ReadonlySet<string> = new Set(["mcp_http", "mcp_stdio"]);
const CONNECTION_CREDENTIAL_STATES: ReadonlySet<string> = new Set(["none", "stored", "unavailable"]);

function parseConnectionConfig(candidate: unknown): ConnectionConfigDto | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (value.kind === "mcp_http" && typeof value.url === "string") return value as unknown as ConnectionConfigDto;
  if (
    value.kind === "mcp_stdio" &&
    typeof value.command === "string" &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    (value.cwd === null || value.cwd === undefined || typeof value.cwd === "string")
  ) {
    return { kind: "mcp_stdio", command: value.command, args: value.args as string[], cwd: value.cwd ?? null };
  }
  return null;
}

function parseConnectionRow(candidate: unknown): ConnectionDto | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !CONNECTION_KINDS.has(value.kind as string) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    typeof value.discovery_revision !== "number" ||
    !Number.isSafeInteger(value.discovery_revision) ||
    typeof value.enabled !== "boolean" ||
    !CONNECTION_STATUSES.has(value.status as string) ||
    (value.status_code !== null && typeof value.status_code !== "string") ||
    !CONNECTION_CREDENTIAL_STATES.has(value.credential_state as string) ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }
  const config = parseConnectionConfig(value.config);
  if (!config) return null;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind as ConnectionKind,
    revision: value.revision,
    discovery_revision: value.discovery_revision,
    enabled: value.enabled,
    status: value.status as ConnectionStatus,
    status_code: (value.status_code as string | null) ?? null,
    config,
    credential_state: value.credential_state as ConnectionCredentialState,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function parseConnectionTool(candidate: unknown): ConnectionToolDto | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.tool_id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !value.input_schema ||
    typeof value.input_schema !== "object" ||
    Array.isArray(value.input_schema)
  ) {
    return null;
  }
  return {
    tool_id: value.tool_id,
    name: value.name,
    description: value.description,
    input_schema: value.input_schema as Record<string, unknown>,
  };
}

/** Treat every connection response as untrusted JSON. */
export function parseConnectionPayload(payload: unknown): ConnectionDto | null {
  return parseConnectionRow(payload);
}

export function parseConnectionDetailPayload(payload: unknown): ConnectionDetailDto | null {
  const base = parseConnectionRow(payload);
  if (!base) return null;
  const tools =
    payload && typeof payload === "object" && Array.isArray((payload as { tools?: unknown }).tools)
      ? ((payload as { tools: unknown[] }).tools ?? []).flatMap((tool) => {
          const parsed = parseConnectionTool(tool);
          return parsed ? [parsed] : [];
        })
      : [];
  return { ...base, tools };
}

/**
 * The list endpoint serves redacted DTOs WITHOUT the tool catalog; tool
 * counts are only known once a connection's detail was loaded.
 */
export function parseConnectionListPayload(payload: unknown): ConnectionDto[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((candidate) => {
    const parsed = parseConnectionRow(candidate);
    return parsed ? [parsed] : [];
  });
}

function parseConnectionAuthorization(payload: unknown): ConnectionAuthorizationDto | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.authorize_url !== "string" || !/^https?:\/\//i.test(value.authorize_url)) return null;
  if (typeof value.expires_at !== "string") return null;
  return {
    authorize_url: value.authorize_url,
    expires_at: value.expires_at,
    ...(typeof value.desktop_open_token === "string" ? { desktop_open_token: value.desktop_open_token } : {}),
    ...(typeof value.desktop_open_expires_at === "string"
      ? { desktop_open_expires_at: value.desktop_open_expires_at }
      : {}),
  };
}

export const MAX_CONNECTIONS_PER_ACCOUNT = 20;
export const MAX_CONNECTION_NAME_CHARS = 80;
export const MAX_STDIO_ARGS = 32;

/** Require a well-formed DTO from a mutation; a malformed body is a failure. */
function requireDetail(payload: unknown): ConnectionDetailDto {
  const detail = parseConnectionDetailPayload(payload);
  if (!detail) throw new Error("invalid connection response");
  return detail;
}

function requireConnection(payload: unknown): ConnectionDto {
  const connection = parseConnectionPayload(payload);
  if (!connection) throw new Error("invalid connection response");
  return connection;
}

export const connectionsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseCatalogEnvelope(
      await api<unknown>(catalogPath("/api/connections", options), { signal: options.signal }),
      parseConnectionListPayload,
    ),
  create: async (body: ConnectionCreateInput, signal?: AbortSignal) =>
    requireDetail(await api<unknown>("/api/connections", { method: "POST", body: JSON.stringify(body), signal })),
  get: async (id: string, signal?: AbortSignal) =>
    requireDetail(await api<unknown>(`/api/connections/${encodeURIComponent(id)}`, { signal })),
  update: async (id: string, patch: ConnectionPatchInput, signal?: AbortSignal) =>
    requireDetail(
      await api<unknown>(`/api/connections/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
        signal,
      }),
    ),
  remove: (id: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE", signal }),
  test: async (id: string, signal?: AbortSignal) =>
    requireConnection(
      await api<unknown>(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST", signal }),
    ),
  discover: async (id: string, signal?: AbortSignal) =>
    requireDetail(
      await api<unknown>(`/api/connections/${encodeURIComponent(id)}/discover`, { method: "POST", signal }),
    ),
  authorize: async (id: string, signal?: AbortSignal) => {
    const authorization = parseConnectionAuthorization(
      await api<unknown>(`/api/connections/${encodeURIComponent(id)}/authorize`, { method: "POST", signal }),
    );
    if (!authorization) throw new Error("invalid sign-in response");
    return authorization;
  },
  revoke: async (id: string, signal?: AbortSignal) =>
    requireConnection(
      await api<unknown>(`/api/connections/${encodeURIComponent(id)}/authorization`, { method: "DELETE", signal }),
    ),
};

// ------------------------------------------------------------------ starter jobs
export interface StarterJobDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  instructions: string;
  tools: string[];
  job_setup: AgentJobSetup;
}

function parseStarterJob(candidate: unknown): StarterJobDefinition | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.icon !== "string" ||
    typeof value.color !== "string" ||
    typeof value.instructions !== "string" ||
    !Array.isArray(value.tools) ||
    !value.tools.every((tool) => typeof tool === "string")
  ) {
    return null;
  }
  const jobSetup = parseJobSetup(value.job_setup ?? { starter_prompts: [], output_template: null, library_ids: [] });
  if (!jobSetup) return null;
  return {
    id: value.id,
    name: value.name,
    description: value.description,
    icon: value.icon,
    color: value.color,
    instructions: value.instructions,
    tools: value.tools as string[],
    job_setup: jobSetup,
  };
}

export const jobsApi = {
  list: async (signal?: AbortSignal): Promise<StarterJobDefinition[]> => {
    const payload = await api<unknown>("/api/jobs", { signal });
    const jobs = payload && typeof payload === "object" ? (payload as { jobs?: unknown }).jobs : undefined;
    if (!Array.isArray(jobs)) return [];
    return jobs.flatMap((job) => {
      const parsed = parseStarterJob(job);
      return parsed ? [parsed] : [];
    });
  },
};

// ------------------------------------------------------------------ chat creation from a job
export interface ChatJobProjection {
  starter_prompts: string[];
  output_template: AgentOutputTemplate | null;
  suggested_library_ids: string[];
  suggested_source_ids: string[];
}

export interface ChatWithJob extends Chat {
  job?: ChatJobProjection;
}

function parseChatJobProjection(candidate: unknown): ChatJobProjection | undefined {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const value = candidate as Record<string, unknown>;
  const setup = parseJobSetup({
    starter_prompts: value.starter_prompts,
    output_template: value.output_template,
    library_ids: value.suggested_library_ids,
  });
  if (!setup) return undefined;
  const sourceIds = Array.isArray(value.suggested_source_ids)
    ? value.suggested_source_ids.filter((id): id is string => typeof id === "string").slice(0, 100)
    : [];
  return {
    starter_prompts: setup.starter_prompts,
    output_template: setup.output_template,
    suggested_library_ids: setup.library_ids,
    suggested_source_ids: sourceIds,
  };
}

/**
 * Normalize `POST /api/chats` job creation: the created chat is always
 * selected-empty until the user confirms the expanded suggestion; a payload
 * without a usable suggestion block yields an explicit empty projection so
 * the confirmation surface can say "suggests no sources" rather than guess.
 */
export function parseChatFromJobPayload(payload: unknown): ChatWithJob | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.title !== "string" || typeof value.model !== "string") return null;
  const job = parseChatJobProjection(value.job);
  const chat: Record<string, unknown> = { ...value };
  delete chat.job;
  return { ...(chat as unknown as Chat), ...(job ? { job } : {}) };
}

export const chatsFromJobApi = {
  /**
   * Create a chat from the bound agent's job setup. The request always names
   * an explicit selected-empty scope — never an omitted scope (legacy `all`)
   * and never a widened list — and the server confirms it back as such.
   */
  create: async (input: {
    agentId: string;
    suggestedLibraryIds: string[];
    model?: string;
    signal?: AbortSignal;
  }): Promise<ChatWithJob> => {
    const payload = await api<unknown>("/api/chats", {
      method: "POST",
      body: JSON.stringify({
        ...(input.model ? { model: input.model } : {}),
        source_mode: "selected",
        source_ids: [],
        agent_id: input.agentId,
        job: { suggested_library_ids: input.suggestedLibraryIds },
      }),
      signal: input.signal,
    });
    const created = parseChatFromJobPayload(payload);
    if (!created) throw new Error("invalid chat response");
    if (created.source_mode !== "selected") throw new Error("invalid chat scope");
    return created;
  },
};

// ------------------------------------------------------------------ reports
export const reportsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<Report>(
      await api<unknown>(catalogPath("/api/reports", options), { signal: options.signal }),
    ),
  listShared: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<SharedReport>(
      await api<unknown>(catalogPath("/api/reports/shared", options), { signal: options.signal }),
    ),
  listShares: (id: string, signal?: AbortSignal) => api<ReportShare[]>(`/api/reports/${id}/shares`, { signal }),
  share: (id: string, recipientAccountId: string, signal?: AbortSignal) =>
    api<ReportShare>(`/api/reports/${id}/shares`, {
      method: "POST",
      body: JSON.stringify({ recipient_account_id: recipientAccountId }),
      signal,
    }),
  revoke: (id: string, recipientAccountId: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/reports/${id}/shares/${recipientAccountId}`, { method: "DELETE", signal }),
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
  rename: (id: string, title: string, signal?: AbortSignal) =>
    api<Report>(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify({ title }), signal }),
  remove: (id: string, signal?: AbortSignal) => api<{ ok: true }>(`/api/reports/${id}`, { method: "DELETE", signal }),
};

// ------------------------------------------------------------------ documents
export type DocumentAuthorKind = "user" | "model" | "automation";

export interface DocumentOrigin {
  report_id: string | null;
  chat_id: string | null;
  run_id: string | null;
  analysis_result_id: string | null;
}

export interface DocumentSummary {
  id: string;
  title: string;
  current_revision: number;
  current_revision_id: string;
  head_author_kind: DocumentAuthorKind;
  origin: DocumentOrigin;
  latest_publication_version: number | null;
  revision_count: number;
  created_at: string;
  updated_at: string;
}

/** Detail-only render status of the latest publication attempt. */
export interface DocumentDetail extends DocumentSummary {
  publication_status?: DocumentPublicationStatus | null;
}

export interface DocumentSectionPayload {
  id: string;
  heading: string;
  markdown: string;
}

/** Versioned document evidence entry; `unknown` provenance is never upgraded. */
export interface DocumentEvidencePayload {
  id: string;
  source_id: string;
  source_name: string;
  generation: number | "unknown";
  content_identity: string | "unknown";
  locator: string | null;
  excerpt: string;
}

export interface DocumentTreePayload {
  title: string;
  subtitle: string;
  verified: boolean;
  sections: DocumentSectionPayload[];
  charts: unknown[];
  tables: unknown[];
  evidence: DocumentEvidencePayload[];
}

export interface DocumentRevisionPayload {
  id: string;
  document_id: string;
  revision: number;
  title: string;
  author_kind: DocumentAuthorKind;
  base_revision_id: string | null;
  payload: DocumentTreePayload;
  payload_chars: number;
  created_at: string;
}

export interface DocumentRevisionSummary {
  id: string;
  revision: number;
  title: string;
  author_kind: DocumentAuthorKind;
  base_revision_id: string | null;
  payload_chars: number;
  published_version: number | null;
  created_at: string;
}

export interface DocumentPublicationSummary {
  id: string;
  document_id: string;
  revision_id: string;
  revision: number;
  version: number;
  title: string;
  supersedes: string | null;
  created_at: string;
}

/** Render-status of the latest publication attempt (never artifact paths). */
export interface DocumentPublicationStatus {
  operation_id: string;
  revision_id: string;
  revision: number;
  status: "rendering" | "ready" | "completed" | "failed";
  error_code: string | null;
  updated_at: string;
}

export type DocumentExportFormat = "html" | "pdf" | "markdown" | "docx";

export interface DocumentDiffOp {
  kind: "equal" | "insert" | "delete";
  old_line: number | null;
  new_line: number | null;
  text: string;
}

export interface DocumentSectionTextDiff {
  section_id: string;
  heading: string;
  ops: DocumentDiffOp[];
  truncated: boolean;
}

export interface DocumentRevisionDiff {
  base: { revision_id: string; revision: number; title: string };
  target: { revision_id: string; revision: number; title: string };
  fields: { title_changed: boolean; subtitle_changed: boolean; verified_changed: boolean };
  sections: {
    added: Array<{ id: string; heading: string; index: number }>;
    removed: Array<{ id: string; heading: string; index: number }>;
    moved: Array<{ id: string; heading: string; base_index: number; target_index: number }>;
    modified: Array<{ id: string; heading: string; index: number }>;
  };
  text_diffs: DocumentSectionTextDiff[];
  charts: { added: string[]; removed: string[]; changed: string[] };
  tables: {
    added: Array<{ index: number; columns: string[] }>;
    removed: Array<{ index: number; columns: string[] }>;
    changed: number[];
  };
  evidence: {
    added: Array<{ id: string; source_name: string }>;
    removed: Array<{ id: string; source_name: string }>;
    changed: string[];
  };
  truncated: boolean;
}

/** Tree input accepted by the create/save routes; the server normalizes it. */
export interface DocumentTreeInput {
  title: string;
  subtitle?: string;
  verified?: boolean;
  sections?: Array<{ id?: string; heading?: string; markdown?: string }>;
  charts?: Array<{ id: string; spec: unknown }>;
  tables?: Array<{ columns: string[]; rows: unknown[][]; analysis?: unknown | null }>;
  evidence?: unknown[];
}

export const DOCUMENT_REVISION_CONFLICT_CODE = "DOCUMENT_REVISION_CONFLICT";
export const DOCUMENT_UNAVAILABLE_CODE = "DOCUMENT_UNAVAILABLE";
export const DOCUMENT_HEAD_MOVED_CODE = "DOCUMENT_HEAD_MOVED";
export const DOCUMENT_REVISION_SELECTION_CODE = "DOCUMENT_REVISION_SELECTION";
export const DOCUMENT_PUBLICATION_ACTIVE_CODE = "DOCUMENT_PUBLICATION_ACTIVE";

/** Outcome of a publish request: the frozen publication or an in-flight status. */
export type PublishDocumentResult =
  | { status: "published"; replayed: boolean; publication: DocumentPublicationSummary }
  | { status: "rendering"; publication_status: DocumentPublicationStatus };

/** True for a stable publication 409 code (active/head-moved/selection). */
export function isDocumentPublicationErrorCode(error: unknown, code: string): boolean {
  return conflictData(error, code) !== null;
}

/** Head metadata carried on a lost base-revision compare-and-swap (409). */
export interface DocumentConflictHead {
  revision_id: string;
  revision: number;
  title: string;
  author_kind: DocumentAuthorKind;
  updated_at: string;
}

function conflictData(error: unknown, code: string): Record<string, unknown> | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const data = error.data as { code?: unknown } | undefined;
  return data?.code === code ? (data as Record<string, unknown>) : null;
}

/** Extracts the authoritative head metadata from a save-conflict failure. */
export function parseDocumentRevisionConflict(error: unknown): DocumentConflictHead | null {
  return parseConflictHead(conflictData(error, DOCUMENT_REVISION_CONFLICT_CODE));
}

/** True when a copy request hit the typed payload-less legacy-report state. */
export function isDocumentUnavailableCopyError(error: unknown): boolean {
  return conflictData(error, DOCUMENT_UNAVAILABLE_CODE) !== null;
}

// ------------------------------------------------------------- rewrites

export type DocumentRewriteStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
export const DOCUMENT_REWRITE_ACTIVE_STATUSES: readonly DocumentRewriteStatus[] = ["queued", "running"];
export const DOCUMENT_REWRITE_STALE_CODE = "DOCUMENT_REWRITE_STALE";
export const DOCUMENT_REWRITE_ACTIVE_CODE = "DOCUMENT_REWRITE_ACTIVE";
export const DOCUMENT_REWRITE_QUOTA_CODE = "DOCUMENT_REWRITE_QUOTA_REACHED";

/** One durable rewrite operation/proposal; `replacement` exists once completed. */
export interface DocumentRewrite {
  id: string;
  document_id: string;
  base_revision_id: string;
  section_id: string;
  range_start: number | null;
  range_end: number | null;
  selection_sha256: string;
  selection_chars: number;
  instruction: string;
  status: DocumentRewriteStatus;
  replacement: string | null;
  evidence_refs: string[];
  model: string | null;
  error_code: string | null;
  error_reason: string | null;
  cancel_requested: boolean;
  applied_revision_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface DocumentRewriteRequest {
  base_revision_id: string;
  section_id: string;
  range_start?: number;
  range_end?: number;
  selection_sha256: string;
  instruction: string;
}

function parseConflictHead(data: Record<string, unknown> | null): DocumentConflictHead | null {
  const value = data?.current_head as Record<string, unknown> | undefined;
  if (
    !value ||
    typeof value.revision_id !== "string" ||
    typeof value.revision !== "number" ||
    typeof value.title !== "string"
  ) {
    return null;
  }
  return {
    revision_id: value.revision_id,
    revision: value.revision,
    title: value.title,
    author_kind: (value.author_kind === "model" || value.author_kind === "automation"
      ? value.author_kind
      : "user") as DocumentAuthorKind,
    updated_at: typeof value.updated_at === "string" ? value.updated_at : "",
  };
}

/** Head metadata carried on a stale-acceptance rejection (409). */
export function parseDocumentRewriteStale(error: unknown): DocumentConflictHead | null {
  return parseConflictHead(conflictData(error, DOCUMENT_REWRITE_STALE_CODE));
}

/** True for a stable rewrite 409 code (active/quota/stale/state). */
export function isDocumentRewriteErrorCode(error: unknown, code: string): boolean {
  return conflictData(error, code) !== null;
}

export const documentsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<DocumentSummary>(
      await api<unknown>(catalogPath("/api/documents", options), { signal: options.signal }),
    ),
  create: (
    body: { title?: string; tree?: DocumentTreeInput; template_id?: string; copy_from_report_id?: string },
    signal?: AbortSignal,
  ) =>
    api<{ document: DocumentSummary; revision: DocumentRevisionPayload }>("/api/documents", {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  get: (id: string, signal?: AbortSignal) => api<DocumentDetail>(`/api/documents/${id}`, { signal }),
  remove: (id: string, signal?: AbortSignal) => api<{ ok: true }>(`/api/documents/${id}`, { method: "DELETE", signal }),
  revisions: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<DocumentRevisionSummary>(
      await api<unknown>(catalogPath(`/api/documents/${id}/revisions`, options), { signal: options.signal }),
    ),
  saveRevision: (id: string, body: { base_revision_id: string; tree: DocumentTreeInput }, signal?: AbortSignal) =>
    api<{ document: DocumentSummary; revision: DocumentRevisionPayload }>(`/api/documents/${id}/revisions`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  revision: (id: string, revisionId: string, signal?: AbortSignal) =>
    api<DocumentRevisionPayload>(`/api/documents/${id}/revisions/${revisionId}`, { signal }),
  diff: (id: string, base: string, target: string, signal?: AbortSignal) =>
    api<DocumentRevisionDiff>(`/api/documents/${id}/diff?base=${base}&target=${target}`, { signal }),
  publications: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<DocumentPublicationSummary>(
      await api<unknown>(catalogPath(`/api/documents/${id}/publications`, options), { signal: options.signal }),
    ),
  /** Idempotent publication: the caller owns the operation UUID per attempt. */
  publish: (
    id: string,
    revisionId: string,
    body: { operation_id: string; expected_revision_id?: string; allow_non_head_revision?: boolean },
    signal?: AbortSignal,
  ) =>
    api<PublishDocumentResult>(`/api/documents/${id}/revisions/${revisionId}/publish`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  publicationExportPath: (id: string, publicationId: string, format: DocumentExportFormat) =>
    `/api/documents/${id}/publications/${publicationId}/export?format=${format}`,
  rewrites: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<DocumentRewrite>(
      await api<unknown>(catalogPath(`/api/documents/${id}/rewrites`, options), { signal: options.signal }),
    ),
  rewrite: (id: string, rewriteId: string, signal?: AbortSignal) =>
    api<DocumentRewrite>(`/api/documents/${id}/rewrites/${rewriteId}`, { signal }),
  createRewrite: (id: string, body: DocumentRewriteRequest, signal?: AbortSignal) =>
    api<DocumentRewrite>(`/api/documents/${id}/rewrites`, { method: "POST", body: JSON.stringify(body), signal }),
  deleteRewrite: (id: string, rewriteId: string, signal?: AbortSignal) =>
    api<{ ok: true; action: "deleted" | "cancelled" | "cancelling"; rewrite?: DocumentRewrite }>(
      `/api/documents/${id}/rewrites/${rewriteId}`,
      { method: "DELETE", signal },
    ),
  acceptRewrite: (id: string, rewriteId: string, signal?: AbortSignal) =>
    api<{ document: DocumentSummary; revision: DocumentRevisionPayload; rewrite: DocumentRewrite }>(
      `/api/documents/${id}/rewrites/${rewriteId}/accept`,
      { method: "POST", body: "{}", signal },
    ),
};

// ------------------------------------------------------------------ document templates
export interface DocumentTemplateSnapshot {
  title: string;
  subtitle: string;
  sections: Array<{ heading: string; markdown: string }>;
}

export interface DocumentTemplateSummary {
  id: string;
  built_in: boolean;
  name: string;
  description: string;
  snapshot: DocumentTemplateSnapshot;
  revision?: number;
  created_at?: string;
  updated_at?: string;
}

export const documentTemplatesApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<DocumentTemplateSummary>(
      await api<unknown>(catalogPath("/api/document-templates", options), { signal: options.signal }),
    ),
  get: (id: string, signal?: AbortSignal) => api<DocumentTemplateSummary>(`/api/document-templates/${id}`, { signal }),
  create: (body: { name: string; description?: string; document_id: string }, signal?: AbortSignal) =>
    api<DocumentTemplateSummary>("/api/document-templates", { method: "POST", body: JSON.stringify(body), signal }),
  update: (
    id: string,
    body: { name?: string; description?: string; expected_revision: number },
    signal?: AbortSignal,
  ) =>
    api<DocumentTemplateSummary>(`/api/document-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal,
    }),
  remove: (id: string, expectedRevision: number, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/document-templates/${id}`, {
      method: "DELETE",
      body: JSON.stringify({ expected_revision: expectedRevision }),
      signal,
    }),
};

// ------------------------------------------------------------------ charts
export const chartsApi = {
  list: () => api<ChartArtifactSummary[]>("/api/charts"),
  get: (id: string) => api<ChartPayload>(`/api/charts/${id}`),
};

// ------------------------------------------------------------------ analyses
export type AnalysisParameterType = "string" | "number" | "integer" | "boolean" | "date";
export type AnalysisParameterValue = string | number | boolean | null;

export interface AnalysisParameterDeclaration {
  name: string;
  type: AnalysisParameterType;
  required: boolean;
  nullable: boolean;
  default?: AnalysisParameterValue;
  label?: string;
  description?: string;
}

export interface AnalysisParameterBinding {
  name: string;
  type: AnalysisParameterType;
  value: AnalysisParameterValue;
}

export interface AnalysisSourceBinding {
  source_id: string;
  ready_generation: number | null;
  content_identity: string | null;
  unavailable_at: string | null;
  bound_at: string;
}

export interface Analysis {
  id: string;
  current_revision: number;
  title: string;
  description: string;
  sql: string;
  parameters: AnalysisParameterDeclaration[];
  source_ids: string[];
  comparison_key: string[] | null;
  origin: { chat_id: string | null; run_id: string | null; capture_id: string | null };
  revision_created_at: string;
  sources: AnalysisSourceBinding[];
  created_at: string;
  updated_at: string;
}

export interface AnalysisSummaryItem {
  id: string;
  title: string;
  description: string;
  current_revision: number;
  source_count: number;
  unavailable_source_count: number;
  created_at: string;
  updated_at: string;
}

export type AnalysisRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale-inputs";

export const TERMINAL_ANALYSIS_RUN_STATUSES: readonly AnalysisRunStatus[] = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "stale-inputs",
]);

export interface AnalysisRunSource {
  source_id: string;
  ready_generation: number;
  content_identity: string;
}

export interface AnalysisRunSummary {
  id: string;
  analysis_id: string;
  revision: number;
  status: AnalysisRunStatus;
  cancel_requested: boolean;
  operation_id: string | null;
  schema_fingerprint: string | null;
  error_code: string | null;
  error_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AnalysisRun extends AnalysisRunSummary {
  parameter_values: AnalysisParameterBinding[];
  sources: AnalysisRunSource[];
}

export interface AnalysisAcceptedRun {
  outcome: "queued" | "replayed" | "stale-inputs";
  run: AnalysisRun;
}

export interface AnalysisResultSummary {
  id: string;
  run_id: string;
  revision: number;
  returned_rows: number;
  source_row_total: number | null;
  row_count_exact: boolean;
  complete: boolean;
  completeness_reasons: string[];
  schema_fingerprint: string | null;
  created_at: string;
}

export interface AnalysisResultColumn {
  name: string;
  type: "empty" | "number" | "string" | "boolean" | "mixed";
}

export interface AnalysisResultDetail {
  id: string;
  analysis_id: string;
  run_id: string;
  revision: number;
  columns: AnalysisResultColumn[];
  rows: QueryResultCell[][];
  returned_rows: number;
  source_row_total: number | null;
  row_count_exact: boolean;
  completeness: { complete: boolean; reasons: string[] };
  parameter_values: AnalysisParameterBinding[];
  source_provenance: AnalysisRunSource[];
  schema_fingerprint: string | null;
  created_at: string;
}

export interface AnalysisComparisonTable {
  columns: string[];
  rows: QueryResultCell[][];
  returned_rows: number;
  complete: boolean;
  completeness_reasons: string[];
  preview_truncated: boolean;
}

export interface AnalysisComparison {
  left_result_id: string;
  right_result_id: string;
  mode: "keyed" | "side-by-side";
  key_columns: string[];
  reason_code: string | null;
  reason_detail: string | null;
  exhaustive: boolean;
  parameters: {
    same: boolean;
    changed: Array<{ name: string; left: AnalysisParameterValue; right: AnalysisParameterValue }>;
  };
  sources: Array<{
    source_id: string;
    status: "same" | "added" | "removed" | "version-changed";
    left: { ready_generation: number; content_identity: string } | null;
    right: { ready_generation: number; content_identity: string } | null;
  }>;
  schema: {
    same: boolean;
    left_only: string[];
    right_only: string[];
    changed_types: Array<{ name: string; from: string; to: string }>;
    order_changed: boolean;
  };
  added?: QueryResultCell[][];
  removed?: QueryResultCell[][];
  changed?: Array<{
    key: QueryResultCell[];
    changes: Array<{ column: string; before: QueryResultCell; after: QueryResultCell; delta: number | null }>;
  }>;
  added_total?: number | null;
  removed_total?: number | null;
  changed_total?: number | null;
  truncated?: boolean;
  left_table: AnalysisComparisonTable;
  right_table: AnalysisComparisonTable;
}

export type AnalysisExportFormat = "csv" | "json" | "manifest";

export interface AnalysisCreateBody {
  title: string;
  description?: string;
  sql: string;
  parameters?: AnalysisParameterDeclaration[];
  source_ids?: string[];
  comparison_key?: string[] | null;
}

export interface AnalysisEditBody extends Partial<AnalysisCreateBody> {
  expected_revision: number;
}

function analysisExportPath(analysisId: string, resultId: string, format: AnalysisExportFormat): string {
  return `/api/analyses/${analysisId}/results/${resultId}/export?format=${format}`;
}

export const analysesApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<AnalysisSummaryItem>(
      await api<unknown>(catalogPath("/api/analyses", options), { signal: options.signal }),
    ),
  create: (body: AnalysisCreateBody, signal?: AbortSignal) =>
    api<Analysis>("/api/analyses", { method: "POST", body: JSON.stringify(body), signal }),
  get: (id: string, signal?: AbortSignal) => api<Analysis>(`/api/analyses/${id}`, { signal }),
  update: (id: string, body: AnalysisEditBody, signal?: AbortSignal) =>
    api<Analysis>(`/api/analyses/${id}`, { method: "PATCH", body: JSON.stringify(body), signal }),
  remove: (id: string, signal?: AbortSignal) => api<{ ok: true }>(`/api/analyses/${id}`, { method: "DELETE", signal }),
  /** Promote a VERIFIED full-query capture only; legacy receipts 404 on the server. */
  fromQuery: (captureId: string, title: string, signal?: AbortSignal) =>
    api<Analysis>("/api/analyses/from-query", {
      method: "POST",
      body: JSON.stringify({ capture_id: captureId, title }),
      signal,
    }),
  listRuns: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<AnalysisRunSummary>(
      await api<unknown>(catalogPath(`/api/analyses/${id}/runs`, options), { signal: options.signal }),
    ),
  run: (
    id: string,
    body: { values?: Record<string, AnalysisParameterValue>; operation_id?: string; expected_revision?: number },
    signal?: AbortSignal,
  ) => api<AnalysisAcceptedRun>(`/api/analyses/${id}/runs`, { method: "POST", body: JSON.stringify(body), signal }),
  getRun: (id: string, runId: string, signal?: AbortSignal) =>
    api<AnalysisRun>(`/api/analyses/${id}/runs/${runId}`, { signal }),
  cancelRun: (id: string, runId: string, signal?: AbortSignal) =>
    api<{ ok: true; status: AnalysisRunStatus }>(`/api/analyses/${id}/runs/${runId}`, { method: "DELETE", signal }),
  listResults: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<AnalysisResultSummary>(
      await api<unknown>(catalogPath(`/api/analyses/${id}/results`, options), { signal: options.signal }),
    ),
  getResult: (id: string, resultId: string, signal?: AbortSignal) =>
    api<AnalysisResultDetail>(`/api/analyses/${id}/results/${resultId}`, { signal }),
  removeResult: (id: string, resultId: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/analyses/${id}/results/${resultId}`, { method: "DELETE", signal }),
  compare: (id: string, left: string, right: string, signal?: AbortSignal) =>
    api<AnalysisComparison>(`/api/analyses/${id}/compare?left=${left}&right=${right}`, { signal }),
  /** Canonical chart-spec copy bound to a stored result id (server-side copy). */
  resultChart: (id: string, resultId: string, signal?: AbortSignal) =>
    api<{ result_id: string; spec: Record<string, unknown> }>(`/api/analyses/${id}/results/${resultId}/chart`, {
      signal,
    }),
  /** Download the stored snapshot only — never re-runs a query. */
  downloadExport: async (id: string, resultId: string, format: AnalysisExportFormat) => {
    const blob = await apiBlob(analysisExportPath(id, resultId, format));
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `analysis-${resultId.slice(0, 8)}.${format === "manifest" ? "json" : format}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

export function isTerminalAnalysisRunStatus(status: AnalysisRunStatus): boolean {
  return TERMINAL_ANALYSIS_RUN_STATUSES.includes(status);
}

// ------------------------------------------------------------------ research (M15)

/** Client mirrors of `server/src/researchSchemas.ts` bounds for input gating. */
export const RESEARCH_TITLE_MAX_CHARS = 120;
export const RESEARCH_QUESTION_MAX_CHARS = 4_000;
export const RESEARCH_SOURCES_MAX = 100;
export const RESEARCH_LIBRARY_PROVENANCE_MAX = 20;
export const RESEARCH_PLAN_STEPS_MAX = 8;
export const RESEARCH_QUESTIONS_PER_STEP_MAX = 8;
export const RESEARCH_STEP_OBJECTIVE_MAX_CHARS = 500;
export const RESEARCH_STEP_QUESTION_MAX_CHARS = 1_000;
export const RESEARCH_COLUMNS_MAX = 20;
export const RESEARCH_COLUMN_LABEL_MAX_CHARS = 80;
export const RESEARCH_COLUMN_QUESTION_MAX_CHARS = 500;
export const RESEARCH_COLUMN_UNIT_MAX_CHARS = 40;
export const RESEARCH_ENUM_CHOICES_MAX = 20;
export const RESEARCH_ENUM_CHOICE_MAX_CHARS = 80;
export const RESEARCH_NOTE_MAX_CHARS = 2_000;
export const RESEARCH_CLAIM_TEXT_MAX_CHARS = 2_000;
export const RESEARCH_CELL_EXPLANATION_MAX_CHARS = 1_000;
export const RESEARCH_REVIEW_OPS_MAX = 100;
/** Evidence keyset page: 25 default, 50 max. */
export const RESEARCH_EVIDENCE_PAGE_DEFAULT = 25;
export const RESEARCH_EVIDENCE_PAGE_MAX = 50;

export const RESEARCH_ACTIVE_RUN_CODE = "RESEARCH_ACTIVE_RUN";
export const RESEARCH_REVISION_CONFLICT_CODE = "RESEARCH_REVISION_CONFLICT";
export const RESEARCH_MODEL_UNAVAILABLE_CODE = "RESEARCH_MODEL_UNAVAILABLE";
export const RESEARCH_SCOPE_EMPTY_CODE = "RESEARCH_SCOPE_EMPTY";
export const RESEARCH_INPUTS_NOT_READY_CODE = "RESEARCH_INPUTS_NOT_READY";
export const RESEARCH_QUEUE_FULL_CODE = "RESEARCH_QUEUE_FULL";

export type ResearchOutputKind = "memo" | "comparison";
export type ResearchColumnType = "text" | "number" | "date" | "boolean" | "enum";
export type ResearchClaimClassification = "supported" | "conflicting" | "unsupported";
export type ResearchCellStatus = "supported" | "conflicting" | "not_found" | "invalid";
export type ResearchRunStatus =
  | "queued"
  | "running"
  | "cancelling"
  | "needs_review"
  | "completed"
  | "failed"
  | "cancelled";
export type ResearchStepStatus = "pending" | "running" | "done" | "source_changed" | "failed" | "skipped";
export type ResearchClaimKind = "claim" | "gap";
export type ResearchClaimReviewState = "pending" | "accepted" | "rejected";
export type ResearchTypedValue = string | number | boolean | null;

/** Durable runs keep producing output until these absorbing states. */
export const TERMINAL_RESEARCH_RUN_STATUSES: readonly ResearchRunStatus[] = Object.freeze([
  "needs_review",
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalResearchRunStatus(status: ResearchRunStatus): boolean {
  return TERMINAL_RESEARCH_RUN_STATUSES.includes(status);
}

export interface ResearchColumnDeclaration {
  id: string;
  label: string;
  question: string;
  type: ResearchColumnType;
  unit: string | null;
  choices: string[] | null;
}

export interface ResearchPlanStep {
  id: string;
  objective: string;
  questions: string[];
}

export interface ResearchPlan {
  steps: ResearchPlanStep[];
}

export interface ResearchSourceAvailability {
  source_id: string;
  availability: "ready" | "unready" | "missing";
  ready_generation: number | null;
}

export interface ResearchActiveRunRef {
  id: string;
  status: ResearchRunStatus;
}

export interface ResearchDefinitionSummaryItem {
  id: string;
  title: string;
  output_kind: ResearchOutputKind;
  current_revision: number;
  source_count: number;
  created_at: string;
  updated_at: string;
}

export interface ResearchDefinition {
  id: string;
  title: string;
  question: string;
  output_kind: ResearchOutputKind;
  current_revision: number;
  source_ids: string[];
  library_ids: string[];
  chat_model: string;
  columns: ResearchColumnDeclaration[];
  plan: ResearchPlan;
  sources: ResearchSourceAvailability[];
  active_run: ResearchActiveRunRef | null;
  revision_created_at: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchDefinitionCreateBody {
  title: string;
  question: string;
  output_kind: ResearchOutputKind;
  source_ids: string[];
  library_ids?: string[];
  chat_model: string;
  columns?: ResearchColumnDeclaration[];
  plan?: ResearchPlan;
}

export interface ResearchDefinitionPatchBody extends Partial<ResearchDefinitionCreateBody> {
  expected_revision: number;
}

export interface ResearchPlanProposal {
  definition_id: string;
  base_revision: number;
  model: string;
  model_used: boolean;
  fallback: boolean;
  error_code: string | null;
  plan: ResearchPlan;
}

export interface ResearchRunSummary {
  id: string;
  definition_id: string;
  definition_revision: number;
  status: ResearchRunStatus;
  cancel_requested: boolean;
  chat_model: string;
  provider_locality: ProviderLocality;
  rerun_of: string | null;
  review_revision: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ResearchRerunSelection {
  row_source_ids: string[] | null;
  column_ids: string[] | null;
}

export interface ResearchRun extends ResearchRunSummary {
  error_reason: string | null;
  sources: Array<{ source_id: string; generation: number }>;
  budgets: {
    steps: number;
    searches: number;
    model_requests: number;
    evidence: number;
    evidence_chars: number;
    wall_ms: number;
  };
  usage: { searches: number; model_requests: number };
  rerun_selection: ResearchRerunSelection | null;
}

export interface ResearchStep {
  ordinal: number;
  objective: string;
  questions: string[];
  status: ResearchStepStatus;
  outcome: string | null;
  attempts: number;
  started_at: string | null;
  finished_at: string | null;
}

export interface ResearchClaim {
  id: string;
  run_id: string;
  kind: ResearchClaimKind;
  text: string;
  corrected_text: string | null;
  classification: ResearchClaimClassification;
  evidence_refs: string[];
  user_note: string | null;
  review_state: ResearchClaimReviewState;
  created_at: string;
  updated_at: string;
}

export interface ResearchRunCounts {
  evidence_count: number;
  evidence_char_count: number;
  claim_count: number;
  gap_count: number;
  machine_cell_count: number;
  correction_cell_count: number;
  table_serialized_bytes: number;
}

export interface ResearchRunDetail extends ResearchRun {
  steps: ResearchStep[];
  claims: ResearchClaim[];
  counts: ResearchRunCounts;
  run_notes: string[];
}

export interface ResearchEvidence {
  id: string;
  run_id: string;
  source_id: string;
  generation: number;
  chunk_id: string;
  label: string;
  locators: SourceLocator[];
  excerpt: string;
  content_hash: string;
  retrieved_at: string;
  step_ordinal: number;
  query: string;
  irrelevant: boolean;
}

export interface ResearchCell {
  column_id: string;
  row_source_id: string;
  row_generation: number;
  origin: "machine" | "correction";
  value: ResearchTypedValue;
  status: ResearchCellStatus;
  evidence_refs: string[];
  explanation: string | null;
  corrected_at: string | null;
  corrected_from_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchTableRow {
  row_source_id: string;
  row_generation: number;
  cells: ResearchCell[];
}

export interface ResearchTableLimitState {
  serialized_bytes: number;
  limit_bytes: number;
  at_limit: boolean;
}

export interface ResearchTableViewState {
  sort_applied: boolean;
  filter_applied: boolean;
  basis: "row_source_id_keyset";
  sort_column_id: string | null;
  sort_dir: "asc" | "desc";
  sort_view: "effective" | "machine" | "correction";
}

export interface ResearchCellChangeSnapshot {
  value: ResearchTypedValue;
  status: ResearchCellStatus;
}

export interface ResearchCellChangeSlot {
  machine: ResearchCellChangeSnapshot | null;
  correction: ResearchCellChangeSnapshot | null;
  effective: ResearchCellChangeSnapshot | null;
}

export interface ResearchCellChange {
  row_source_id: string;
  column_id: string;
  before: ResearchCellChangeSlot;
  after: ResearchCellChangeSlot;
  machine_changed: boolean;
  correction_changed: boolean;
}

export interface ResearchRunTableDiff {
  from_run_id: string;
  to_run_id: string;
  rows_added: string[];
  rows_removed: string[];
  changed_cells: ResearchCellChange[];
  changed_total: number;
  truncated: boolean;
  carried_overrides: Array<{ column_id: string; row_source_id: string; corrected_from_run_id: string }>;
}

export interface ResearchTableViewOptions {
  cursor?: string | null;
  limit?: number;
  sortColumn?: string | null;
  sortDir?: "asc" | "desc";
  sortView?: "effective" | "machine" | "correction";
  filterColumn?: string | null;
  filterStatus?: ResearchCellStatus | null;
  filterText?: string | null;
  against?: string | null;
  signal?: AbortSignal;
}

export interface ResearchTableView {
  run_id: string;
  columns: ResearchColumnDeclaration[];
  items: ResearchTableRow[];
  next_cursor: string | null;
  limit_state: ResearchTableLimitState;
  view_state: ResearchTableViewState;
  comparison?: ResearchRunTableDiff;
}

export type ResearchReviewOp =
  | { op: "accept_claim"; claim_id: string }
  | { op: "reject_claim"; claim_id: string }
  | { op: "add_note"; target_kind: "claim" | "evidence" | "run"; target_id?: string; note: string }
  | { op: "correct_claim"; claim_id: string; text: string }
  | {
      op: "correct_cell";
      column_id: string;
      row_source_id: string;
      value?: ResearchTypedValue;
      status?: ResearchCellStatus;
      explanation?: string;
    }
  | { op: "flag_evidence"; evidence_id: string; irrelevant: boolean };

export interface ResearchReviewResult {
  review_revision: number;
  ops_applied: number;
  run: ResearchRun;
}

export interface ResearchProjectionCounts {
  evidence: number;
  rows: number;
  columns: number;
  cells: number;
  claims: number;
  gaps: number;
}

export interface ResearchProjectionSummary {
  output_kind: ResearchOutputKind;
  run_status: ResearchRunStatus;
  cell_chars_max: number;
  excerpt_chars_max: number;
  payload_chars: number;
  projected: ResearchProjectionCounts;
  omitted: {
    rows: string[];
    columns: Array<{ id: string; label: string }>;
    claims: number;
    gaps: number;
    evidence: number;
  };
  labels: string[];
  disclosures: {
    needs_review: boolean;
    conflicting_cells: number;
    invalid_cells: number;
    not_found_cells: number;
    correction_cells: number;
    excerpts_shortened: number;
    cells_truncated: number;
    table_at_limit: boolean;
  };
}

export interface ResearchArtifactResult {
  run_id: string;
  document_id: string;
  document_revision_id: string;
  document_revision: number;
  projection: ResearchProjectionSummary;
}

/** True when the failure carries this stable research error code. */
export function isResearchErrorCode(error: unknown, code: string): boolean {
  return error instanceof ApiError && (error.data as { code?: unknown } | undefined)?.code === code;
}

/** The already-active run identity carried on a 409 RESEARCH_ACTIVE_RUN. */
export function researchActiveRunId(error: unknown): string | null {
  if (!isResearchErrorCode(error, RESEARCH_ACTIVE_RUN_CODE)) return null;
  const id = (error as ApiError).data as { existing_run_id?: unknown } | undefined;
  return typeof id?.existing_run_id === "string" ? id.existing_run_id : null;
}

/** The precise conflicting source ids carried on a readiness rejection. */
export function researchUnreadySourceIds(error: unknown): string[] {
  if (!isResearchErrorCode(error, RESEARCH_INPUTS_NOT_READY_CODE)) return [];
  const ids = (error as ApiError).data as { unready_source_ids?: unknown } | undefined;
  return Array.isArray(ids?.unready_source_ids)
    ? ids.unready_source_ids.filter((id): id is string => typeof id === "string")
    : [];
}

function researchTablePath(runId: string, options: ResearchTableViewOptions = {}): string {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.sortColumn) params.set("sort_column", options.sortColumn);
  if (options.sortDir) params.set("sort_dir", options.sortDir);
  if (options.sortView) params.set("sort_view", options.sortView);
  if (options.filterColumn) params.set("filter_column", options.filterColumn);
  if (options.filterStatus) params.set("filter_status", options.filterStatus);
  if (options.filterText) params.set("filter_text", options.filterText);
  if (options.against) params.set("against", options.against);
  const query = params.size ? `?${params.toString()}` : "";
  return `/api/research-runs/${encodeURIComponent(runId)}/table${query}`;
}

export const researchApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<ResearchDefinitionSummaryItem>(
      await api<unknown>(catalogPath("/api/research", options), { signal: options.signal }),
    ),
  create: (body: ResearchDefinitionCreateBody, signal?: AbortSignal) =>
    api<ResearchDefinition>("/api/research", { method: "POST", body: JSON.stringify(body), signal }),
  get: (id: string, signal?: AbortSignal) =>
    api<ResearchDefinition>(`/api/research/${encodeURIComponent(id)}`, { signal }),
  /** Revision-CAS definition edit; one stale `expected_revision` is a conflict, never a silent overwrite. */
  update: (id: string, body: ResearchDefinitionPatchBody, signal?: AbortSignal) =>
    api<ResearchDefinition>(`/api/research/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal,
    }),
  /** Deletion first requests durable cancellation of the definition's own active run. */
  remove: (id: string, signal?: AbortSignal) =>
    api<{ ok: true }>(`/api/research/${encodeURIComponent(id)}`, { method: "DELETE", signal }),
  /** Bounded editable proposal for review only; never starts execution. */
  proposePlan: (id: string, expectedRevision: number, signal?: AbortSignal) =>
    api<ResearchPlanProposal>(`/api/research/${encodeURIComponent(id)}/plan`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: expectedRevision }),
      signal,
    }),
  listRuns: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<ResearchRunSummary>(
      await api<unknown>(catalogPath(`/api/research/${encodeURIComponent(id)}/runs`, options), {
        signal: options.signal,
      }),
    ),
  start: (
    id: string,
    body: {
      expected_revision?: number;
      definition_revision?: number;
      rerun_of?: string;
      rerun_selection?: { row_source_ids?: string[]; column_ids?: string[] };
    },
    signal?: AbortSignal,
  ) =>
    api<ResearchRun>(`/api/research/${encodeURIComponent(id)}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  getRun: (runId: string, signal?: AbortSignal) =>
    api<ResearchRunDetail>(`/api/research-runs/${encodeURIComponent(runId)}`, { signal }),
  listEvidence: async (runId: string, options: CatalogPageOptions & { limit?: number } = {}) =>
    parseTypedCatalogEnvelope<ResearchEvidence>(
      await api<unknown>(catalogPath(`/api/research-runs/${encodeURIComponent(runId)}/evidence`, options), {
        signal: options.signal,
      }),
    ),
  getTable: async (runId: string, options: ResearchTableViewOptions = {}) =>
    api<ResearchTableView>(researchTablePath(runId, options), { signal: options.signal }),
  /** Idempotent durable cancellation request. */
  cancelRun: (runId: string, signal?: AbortSignal) =>
    api<{ ok: true; status: ResearchRunStatus }>(`/api/research-runs/${encodeURIComponent(runId)}`, {
      method: "DELETE",
      signal,
    }),
  /** Revision-CAS review batch (≤100 ops); stale revisions conflict. */
  review: (runId: string, body: { expected_revision: number; ops: ResearchReviewOp[] }, signal?: AbortSignal) =>
    api<ResearchReviewResult>(`/api/research-runs/${encodeURIComponent(runId)}/review`, {
      method: "PATCH",
      body: JSON.stringify(body),
      signal,
    }),
  /** M13 reviewed draft from a finished run only; failed/cancelled runs are refused. */
  createArtifact: (runId: string, signal?: AbortSignal) =>
    api<ResearchArtifactResult>(`/api/research-runs/${encodeURIComponent(runId)}/artifacts`, {
      method: "POST",
      body: "{}",
      signal,
    }),
  exportPath: (runId: string, format: "csv" | "manifest") =>
    `/api/research-runs/${encodeURIComponent(runId)}/export?format=${format}`,
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
    if (!location.pathname.startsWith("/login") || location.hash) location.href = "/login";
    throw await errorFromResponse(res);
  }
  if (!res.ok || !res.body) {
    throw await errorFromResponse(res);
  }
  await consumeSseJson(res.body, onEvent);
}

// ------------------------------------------------------- reviewed briefs (M16)
// Typed clients for the reviewed-brief recipes, run pipeline, review inbox, and
// local notifications. All pages are endpoint-bound keyset (default 20, max 50);
// the server owns calendar math, so the only schedule preview is the `GET
// /api/briefs/:id` detail's `next_occurrences` — never recompute client-side.

export type BriefScheduleKind = "daily" | "weekly" | "monthly";
export type BriefRunStage =
  | "queued"
  | "refreshing"
  | "waiting_ready"
  | "analyzing"
  | "drafting"
  | "awaiting_review"
  | "publishing"
  | "failed"
  | "cancelled"
  | "skipped"
  | "approved"
  | "rejected";

/** The 7 progress stages in execution order (terminal stages badge separately). */
export const BRIEF_PIPELINE_STAGES: readonly BriefRunStage[] = Object.freeze([
  "queued",
  "refreshing",
  "waiting_ready",
  "analyzing",
  "drafting",
  "awaiting_review",
]);

export interface BriefCalendarSchedule {
  kind: BriefScheduleKind;
  weekday: number | null;
  day_of_month: number | null;
  hour: number;
  minute: number;
  time_zone: string;
}

/** Server-resolved civil occurrence: the recipe-zone wall time and its UTC instant. */
export interface BriefOccurrencePreview {
  occurrence_key: string;
  civil: string;
  utc_at: string;
}

export interface BriefRefreshBinding {
  source_id: string;
  kind: "connector" | "knowledge";
  connector_id: string | null;
  connection_id: string | null;
}

export interface BriefRecipe {
  id: string;
  kind: "reviewed_brief";
  name: string;
  revision: number;
  state: "active" | "paused";
  paused_reason: string | null;
  notifications_enabled: boolean;
  consecutive_failures: number;
  analysis_id: string;
  analysis_revision: number;
  parameter_values: AnalysisParameterBinding[];
  report_title: string;
  report_instruction: string;
  source_ids: string[];
  refresh_bindings: BriefRefreshBinding[];
  schedule: BriefCalendarSchedule;
  next_occurrence_key: string;
  next_run_at: string;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** Detail reads only: the server's next three resolved civil + UTC instants. */
  next_occurrences?: BriefOccurrencePreview[];
}

export interface BriefRecipeCreateBody {
  name: string;
  analysis_id: string;
  parameter_values?: Record<string, AnalysisParameterValue>;
  report_title: string;
  report_instruction: string;
  source_ids: string[];
  refresh_bindings?: BriefRefreshBinding[];
  schedule: BriefCalendarSchedule;
}

export interface BriefRecipeEditBody extends Partial<Omit<BriefRecipeCreateBody, "analysis_id">> {
  expected_revision: number;
  analysis_id?: string;
}

export interface BriefRunSummary {
  id: string;
  recipe_id: string;
  trigger: "scheduled" | "manual";
  operation_id: string | null;
  occurrence_key: string;
  recipe_revision: number;
  stage: BriefRunStage;
  stage_attempts: number;
  cancel_requested: boolean;
  deadline_at: string;
  refresh_deadline_at: string | null;
  coalesced_count: number;
  missed_through_key: string | null;
  analysis_run_id: string | null;
  baseline_run_id: string | null;
  analysis_succeeded: boolean;
  document_id: string | null;
  document_revision_id: string | null;
  reviewed_revision_id: string | null;
  publication_operation_id: string | null;
  publication_error_code: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  created_at: string;
  started_at: string | null;
  stage_updated_at: string;
  finished_at: string | null;
}

/** Server-committed refresh receipt; `label` is the durable freshness text. */
export interface BriefRefreshReceipt {
  source_id: string;
  kind: "connector" | "knowledge" | "static";
  outcome: "promoted" | "unchanged" | "no-change";
  generation: number;
  label: string;
}

export interface BriefSourceSnapshotEntry {
  source_id: string;
  ready_generation: number;
  content_identity: string;
}

export interface BriefComparisonSummary {
  kind: "compared";
  baseline_run_id: string;
  baseline_result_id: string;
  current_result_id: string;
  mode: "keyed" | "side-by-side";
  key_columns: string[];
  reason_code: string | null;
  reason_detail: string | null;
  exhaustive: boolean;
  added_total: number | null;
  removed_total: number | null;
  changed_total: number | null;
  truncated: boolean;
  changed_sample: Array<{
    key: Array<string | number | boolean | null>;
    changes: Array<{ column: string; delta: number | null }>;
  }>;
}

export interface BriefComparisonUnavailable {
  kind: "unavailable";
  reason: "baseline-missing" | "baseline-result-deleted" | "current-result-deleted";
}

/** Persisted ≤32 KiB comparison; `null` before the analyzing stage commits one. */
export type BriefComparisonPayload = BriefComparisonSummary | BriefComparisonUnavailable | null;

export interface BriefRunDetail extends BriefRunSummary {
  refresh_receipts: BriefRefreshReceipt[];
  source_snapshot: BriefSourceSnapshotEntry[] | null;
  comparison_summary: BriefComparisonPayload;
}

export interface BriefDecisionResult {
  status: "publishing" | "approved" | "rejected";
  replayed: boolean;
  status_path: string;
  run: BriefRunSummary;
}

export interface BriefReviewRow {
  id: string;
  recipe_id: string;
  recipe_name: string;
  recipe_revision: number;
  /** Null once the live recipe is deleted; the run snapshot stays readable. */
  recipe_state: string | null;
  recipe_paused_reason: string | null;
  trigger: "scheduled" | "manual";
  occurrence_key: string;
  coalesced_count: number;
  missed_through_key: string | null;
  stage: BriefRunStage;
  created_at: string;
  stage_updated_at: string;
  finished_at: string | null;
  analysis_run_id: string | null;
  baseline_run_id: string | null;
  comparison_summary: BriefComparisonPayload;
  refresh_receipts: BriefRefreshReceipt[];
  document_id: string | null;
  document_revision_id: string | null;
  document_head_revision_id: string | null;
  head_moved: boolean;
  reviewed_revision_id: string | null;
  publication_operation_id: string | null;
  publication_error_code: string | null;
  publication_failure: { code: string; message: string } | null;
  review: {
    decision: "approve" | "reject";
    note: string | null;
    document_revision_id: string;
    created_at: string;
  } | null;
}

export type BriefNotificationKind = "first_draft" | "meaningful_change" | "attention" | "paused";
export type BriefNotificationState = "unread" | "read" | "dismissed";

export interface BriefNotification {
  id: string;
  kind: BriefNotificationKind;
  state: BriefNotificationState;
  detail: string;
  recipe_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  read_at: string | null;
}

export const BRIEFS_PAGE_LIMIT = 20;

/** A durable run still occupying the recipe's pipeline (review stages excluded). */
export function isBriefActiveRunStage(stage: BriefRunStage): boolean {
  return (
    stage === "queued" ||
    stage === "refreshing" ||
    stage === "waiting_ready" ||
    stage === "analyzing" ||
    stage === "drafting" ||
    stage === "publishing"
  );
}

export function briefScheduleLabel(schedule: BriefCalendarSchedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  if (schedule.kind === "weekly" && schedule.weekday !== null)
    return `Weekly ${weekdayNames[schedule.weekday] ?? "?"} ${time} (${schedule.time_zone})`;
  if (schedule.kind === "monthly" && schedule.day_of_month !== null)
    return `Monthly day ${schedule.day_of_month} ${time} (${schedule.time_zone})`;
  return `Daily ${time} (${schedule.time_zone})`;
}

export const briefsApi = {
  previewSchedule: (
    schedule: Omit<BriefCalendarSchedule, "weekday" | "day_of_month"> & { weekday?: number; day_of_month?: number },
    signal?: AbortSignal,
  ) =>
    api<{ next_occurrences: BriefOccurrencePreview[] }>("/api/briefs/schedule-preview", {
      method: "POST",
      body: JSON.stringify({ schedule }),
      signal,
    }),
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<BriefRecipe>(
      await api<unknown>(catalogPath("/api/briefs", options), { signal: options.signal }),
    ),
  /** Detail carries the server's `next_occurrences` three-run preview. */
  get: (id: string, signal?: AbortSignal) => api<BriefRecipe>(`/api/briefs/${id}`, { signal }),
  create: (body: BriefRecipeCreateBody, signal?: AbortSignal) =>
    api<BriefRecipe>("/api/briefs", { method: "POST", body: JSON.stringify(body), signal }),
  update: (id: string, body: BriefRecipeEditBody, signal?: AbortSignal) =>
    api<BriefRecipe>(`/api/briefs/${id}`, { method: "PATCH", body: JSON.stringify(body), signal }),
  pause: (id: string, signal?: AbortSignal) => api<BriefRecipe>(`/api/briefs/${id}/pause`, { method: "POST", signal }),
  resume: (id: string, signal?: AbortSignal) =>
    api<BriefRecipe>(`/api/briefs/${id}/resume`, { method: "POST", signal }),
  setNotifications: (id: string, enabled: boolean, signal?: AbortSignal) =>
    api<BriefRecipe>(`/api/briefs/${id}/notifications`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
      signal,
    }),
  remove: (id: string, signal?: AbortSignal) => api<{ ok: true }>(`/api/briefs/${id}`, { method: "DELETE", signal }),
  /** Run now: caller-generated UUID idempotency key; a retried key replays the run. */
  run: (id: string, body: { operation_id: string }, signal?: AbortSignal) =>
    api<{ run: BriefRunSummary; replayed: boolean }>(`/api/briefs/${id}/runs`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
  listRuns: async (id: string, options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<BriefRunSummary>(
      await api<unknown>(catalogPath(`/api/briefs/${id}/runs`, options), { signal: options.signal }),
    ),
  getRun: (id: string, runId: string, signal?: AbortSignal) =>
    api<BriefRunDetail>(`/api/briefs/${id}/runs/${runId}`, { signal }),
  cancelRun: (id: string, runId: string, signal?: AbortSignal) =>
    api<BriefRunDetail & { cancel_requested: boolean }>(`/api/briefs/${id}/runs/${runId}`, {
      method: "DELETE",
      signal,
    }),
};

export const briefReviewsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<BriefReviewRow>(
      await api<unknown>(catalogPath("/api/brief-reviews", options), { signal: options.signal }),
    ),
  /** Exact-revision decision; approve answers 202 `publishing` until the publication commits. */
  decide: (
    id: string,
    body: { decision: "approve" | "reject"; document_revision_id: string; note?: string },
    signal?: AbortSignal,
  ) =>
    api<BriefDecisionResult>(`/api/brief-reviews/${id}/decision`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
};

export const notificationsApi = {
  list: async (options: CatalogPageOptions = {}) =>
    parseTypedCatalogEnvelope<BriefNotification>(
      await api<unknown>(catalogPath("/api/notifications", options), { signal: options.signal }),
    ),
  /** Durable visibility transition only; the event content cannot be modified. */
  setState: (id: string, state: "read" | "dismissed", signal?: AbortSignal) =>
    api<BriefNotification>(`/api/notifications/${id}`, { method: "PATCH", body: JSON.stringify({ state }), signal }),
};
