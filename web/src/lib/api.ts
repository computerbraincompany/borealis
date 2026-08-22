const TOKEN_KEY = "borealis_token";
const USER_KEY = "borealis_user";

export interface AuthUser {
  id: string;
  email: string;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): AuthUser | null {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Authenticated fetch returning raw text (e.g. report HTML). */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 401) {
    clearSession();
    location.href = "/login";
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
  return res.text();
}

/** Authenticated fetch returning a Blob (e.g. report PDF). */
export async function apiBlob(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (res.status === 401) {
    clearSession();
    location.href = "/login";
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) throw new ApiError(res.status, res.statusText);
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
  const html = await apiText(path);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 30000);
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
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const data = await res.json();
      if (data?.error) msg = data.error;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export interface Chat {
  id: string;
  title: string;
  created_at: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: { charts?: string[]; report?: string | null } | null;
  created_at: string;
}

export interface ChatDetail extends Chat {
  messages: Message[];
}

export interface Source {
  id: string;
  name: string;
  kind: "document" | "tabular";
  display_name: string;
  mime: string;
  status: string;
  created_at: string;
  tabular?: { rows: number; table: string; original_name: string };
}

export interface Connector {
  id: string;
  name: string;
  type: "url_csv" | "url_json";
  config: string;
  target_table: string;
  status: string;
  last_sync: string | null;
  created_at: string;
}

export interface Report {
  id: string;
  title: string;
  subtitle: string | null;
  created_at: string;
  updated_at: string;
  chat_title: string | null;
  chat_id: string | null;
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
    api<{ token: string; user: AuthUser }>("/api/register", { method: "POST", body: JSON.stringify({ email, password }) }),
  me: () => api<AuthUser>("/api/me"),
};

// ------------------------------------------------------------------ chats
export const chatsApi = {
  list: () => api<Chat[]>("/api/chats"),
  create: (title?: string) => api<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ title }) }),
  get: (id: string) => api<ChatDetail>(`/api/chats/${id}`),
  remove: (id: string) => api<{ ok: true }>(`/api/chats/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ sources
export const sourcesApi = {
  list: () => api<Source[]>("/api/sources"),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return api<Source & { processing: boolean }>("/api/sources/upload", { method: "POST", body: fd });
  },
  remove: (id: string) => api<{ ok: true }>(`/api/sources/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ connectors
export const connectorsApi = {
  list: () => api<Connector[]>("/api/connectors"),
  create: (body: { name?: string; type: string; config: Record<string, unknown> }) =>
    api<Connector>("/api/connectors", { method: "POST", body: JSON.stringify(body) }),
  sync: (id: string) => api<{ synced: true }>(`/api/connectors/${id}/sync`, { method: "POST" }),
  remove: (id: string) => api<{ ok: true }>(`/api/connectors/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ reports
export const reportsApi = {
  list: () => api<Report[]>("/api/reports"),
  get: (id: string) =>
    api<{ id: string; title: string; subtitle: string | null; created_at: string; updated_at: string; has_html: boolean; has_pdf: boolean }>(
      `/api/reports/${id}`
    ),
  remove: (id: string) => api<{ ok: true }>(`/api/reports/${id}`, { method: "DELETE" }),
};

// ------------------------------------------------------------------ charts
export const chartsApi = {
  get: (id: string) => api<ChartPayload>(`/api/charts/${id}`),
};

/** Fetch the SSE agent stream, invoking onEvent for each parsed event. Returns when the stream ends. */
export async function streamAgentChat(
  chatId: string,
  content: string,
  onEvent: (ev: any) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {}
      }
    }
  }
}
