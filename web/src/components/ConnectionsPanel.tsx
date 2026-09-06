import { useEffect, useRef, useState } from "react";
import { KeyRound, Link2, LoaderCircle, Plug, Plus, RefreshCw, ShieldCheck, Trash2, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useConnections, type ConnectionRow } from "@/hooks/useConnections";
import {
  MAX_CONNECTION_NAME_CHARS,
  MAX_STDIO_ARGS,
  type ConnectionCreateInput,
  type ConnectionKind,
  type ConnectionPatchInput,
  type ConnectionSecretsInput,
} from "@/lib/api";
import { hasDesktopSignInLinkBridge, openDesktopSignInLink } from "@/lib/desktopBootstrap";
import { connectionCredentialCopy, connectionStatusCopy, connectionToneClass } from "@/lib/connectionStatus";
import { cn } from "@/lib/utils";
import { MAX_CONNECTIONS_PER_ACCOUNT } from "@/lib/api";

/**
 * Settings → Connections: the account's MCP connections (Connected agents
 * stage 5). Credentials are write-only — no response ever carries them, the
 * edit form never pre-fills them, and replacing them is an explicit whole-
 * set write (or an explicit removal). Sign-in links are shown, validated, and
 * only opened by an explicit user click (the system browser through main on
 * desktop; a plain new tab in the browser shell). The UI must never describe
 * stdio tools as sandboxed: they run with the privileges of the operator's
 * configured process.
 */

const KIND_LABEL: Record<ConnectionKind, string> = { mcp_http: "Streamable HTTP", mcp_stdio: "stdio process" };

interface SecretPair {
  name: string;
  value: string;
}

interface FormDraft {
  name: string;
  kind: ConnectionKind;
  url: string;
  command: string;
  args: string;
  cwd: string;
  enabled: boolean;
  headers: SecretPair[];
  env: SecretPair[];
  removeStoredCredentials: boolean;
}

function emptyDraft(): FormDraft {
  return {
    name: "",
    kind: "mcp_http",
    url: "",
    command: "",
    args: "",
    cwd: "",
    enabled: true,
    headers: [],
    env: [],
    removeStoredCredentials: false,
  };
}

function draftFromConnection(row: ConnectionRow): FormDraft {
  return {
    ...emptyDraft(),
    name: row.name,
    kind: row.kind,
    url: row.config.url ?? "",
    command: row.config.command ?? "",
    args: (row.config.args ?? []).join("\n"),
    cwd: row.config.cwd ?? "",
    enabled: row.enabled,
  };
}

function parseArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function validateDraft(draft: FormDraft): string | null {
  if (!draft.name.trim() || draft.name.trim().length > MAX_CONNECTION_NAME_CHARS) {
    return "Name must be 1–80 characters.";
  }
  if (draft.kind === "mcp_http") {
    const raw = draft.url.trim();
    if (!raw) return "The MCP endpoint URL is required.";
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return "The endpoint must be a valid URL.";
    }
    const plainHttpHost =
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) ||
      parsed.hostname === "::1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname.endsWith(".localhost") ||
      parsed.hostname.endsWith(".local");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && plainHttpHost)) {
      return "HTTPS is required, except explicit loopback or .local development endpoints.";
    }
    if (parsed.username || parsed.password) return "The endpoint URL must not contain credentials.";
    if (parsed.search || parsed.hash) return "The endpoint URL must not contain a query or fragment.";
  } else {
    const command = draft.command.trim();
    if (!command.startsWith("/")) return "The stdio command must be an absolute executable path.";
    if (/[\0\r\n]/.test(command)) return "The stdio command contains invalid characters.";
    const args = parseArgs(draft.args);
    if (args.length > MAX_STDIO_ARGS) return `At most ${MAX_STDIO_ARGS} arguments are allowed.`;
    if (args.some((arg) => arg.length > 200 || /[\0\r\n]/.test(arg))) {
      return "Each argument must be at most 200 characters without newlines.";
    }
    const cwd = draft.cwd.trim();
    if (cwd && (!cwd.startsWith("/") || /[\0\r\n]/.test(cwd))) return "The working directory must be an absolute path.";
  }
  const pairs = [...draft.headers, ...draft.env];
  if (pairs.some((pair) => (pair.name.trim() || pair.value.trim()) && !(pair.name.trim() && pair.value.trim()))) {
    return "Each credential entry needs both a name and a value.";
  }
  if (draft.headers.length > 8) return "At most 8 custom headers are allowed.";
  if (draft.env.length > 16) return "At most 16 environment entries are allowed.";
  if (draft.headers.some((pair) => /[\r\n\0]/.test(pair.value))) return "Header values must not contain newlines.";
  if (draft.env.some((pair) => pair.value.includes("\0"))) return "Environment values must not contain NUL.";
  return null;
}

function secretsFromDraft(draft: FormDraft): { credentials?: ConnectionSecretsInput; removeStored: boolean } {
  const headers = Object.fromEntries(
    draft.headers.filter((p) => p.name.trim() && p.value).map((p) => [p.name.trim(), p.value]),
  );
  const env = Object.fromEntries(
    draft.env.filter((p) => p.name.trim() && p.value).map((p) => [p.name.trim(), p.value]),
  );
  const hasEntries = Object.keys(headers).length > 0 || Object.keys(env).length > 0;
  if (draft.removeStoredCredentials && !hasEntries) return { removeStored: true };
  if (!hasEntries) return { removeStored: false };
  // Submitting any entry is a whole-set replacement (server semantics).
  return { credentials: { headers, env }, removeStored: false };
}

function configFromDraft(draft: FormDraft): Record<string, unknown> {
  if (draft.kind === "mcp_http") return { url: draft.url.trim() };
  return {
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    cwd: draft.cwd.trim() || null,
  };
}

function endpointSummary(row: ConnectionRow): string {
  if (row.kind === "mcp_http") return row.config.url ?? "";
  const args = (row.config.args ?? []).length > 0 ? ` ${row.config.args?.length} arg(s)` : "";
  return `${row.config.command ?? ""}${args}`;
}

function isValidSignInUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function SecretPairsEditor({
  legend,
  namePlaceholder,
  pairs,
  disabled,
  stored,
  onChange,
}: {
  legend: string;
  namePlaceholder: string;
  pairs: SecretPair[];
  disabled: boolean;
  stored: boolean;
  onChange: (next: SecretPair[]) => void;
}) {
  return (
    <fieldset className="rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
        {stored
          ? "Stored securely and never shown again. Add an entry to replace the whole set, or remove the stored credentials below."
          : "Stored encrypted at rest and never returned by the server."}
      </p>
      <div className="space-y-2">
        {pairs.map((pair, index) => (
          <div key={index} className="flex gap-2">
            <Input
              aria-label={`${legend} name ${index + 1}`}
              className="min-w-0 flex-1"
              placeholder={namePlaceholder}
              value={pair.name}
              maxLength={128}
              disabled={disabled}
              onChange={(e) => onChange(pairs.map((p, i) => (i === index ? { ...p, name: e.target.value } : p)))}
            />
            <Input
              aria-label={`${legend} value ${index + 1}`}
              className="min-w-0 flex-1"
              type="password"
              autoComplete="off"
              placeholder={stored ? "Stored — enter to replace" : "Secret value"}
              value={pair.value}
              disabled={disabled}
              onChange={(e) => onChange(pairs.map((p, i) => (i === index ? { ...p, value: e.target.value } : p)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${legend} entry ${index + 1}`}
              disabled={disabled}
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={disabled}
        onClick={() => onChange([...pairs, { name: "", value: "" }])}
      >
        <Plus className="h-4 w-4" /> Add entry
      </Button>
    </fieldset>
  );
}

function ConnectionFormDialog({
  row,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  row: ConnectionRow | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (draft: FormDraft, secrets: ReturnType<typeof secretsFromDraft>) => void;
}) {
  const [draft, setDraft] = useState<FormDraft>(() => (row ? draftFromConnection(row) : emptyDraft()));
  const storedCredentials = row?.credential_state === "stored";
  const change = <K extends keyof FormDraft>(key: K, value: FormDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const submit = () => {
    if (busy) return;
    const validation = validateDraft(draft);
    if (validation) {
      onSubmit(draft, { removeStored: false });
      return;
    }
    onSubmit(draft, secretsFromDraft(draft));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[88dvh] max-w-2xl overflow-y-auto" aria-busy={busy}>
        <DialogTitle>{row ? `Edit “${row.name}”` : "New connection"}</DialogTitle>
        <DialogDescription>
          Configuration is stored redacted; credentials cross only into encrypted custody and are never shown again.
        </DialogDescription>
        <div className="space-y-4 py-2">
          <label className="block space-y-1.5 text-sm font-medium">
            Name
            <Input
              aria-label="Connection name"
              value={draft.name}
              maxLength={MAX_CONNECTION_NAME_CHARS}
              disabled={busy}
              onChange={(e) => change("name", e.target.value)}
              placeholder="Ops tools"
            />
          </label>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Transport</legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(KIND_LABEL) as ConnectionKind[]).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={draft.kind === kind ? "default" : "outline"}
                  disabled={busy || row !== null}
                  aria-pressed={draft.kind === kind}
                  onClick={() => change("kind", kind)}
                >
                  {KIND_LABEL[kind]}
                </Button>
              ))}
            </div>
            {row && (
              <p className="mt-2 text-xs text-muted-foreground">
                The transport kind is fixed for an existing connection.
              </p>
            )}
          </fieldset>
          {draft.kind === "mcp_http" ? (
            <label className="block space-y-1.5 text-sm font-medium">
              MCP endpoint URL
              <Input
                aria-label="Connection endpoint URL"
                value={draft.url}
                disabled={busy}
                onChange={(e) => change("url", e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                type="url"
              />
              <span className="block text-xs font-normal text-muted-foreground">
                HTTPS required; plain HTTP only for loopback or .local development endpoints.
              </span>
            </label>
          ) : (
            <>
              <label className="block space-y-1.5 text-sm font-medium">
                Executable (absolute path)
                <Input
                  aria-label="Stdio executable path"
                  value={draft.command}
                  disabled={busy}
                  onChange={(e) => change("command", e.target.value)}
                  placeholder="/usr/local/bin/my-mcp-server"
                />
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Arguments (one per line, at most {MAX_STDIO_ARGS})
                <textarea
                  aria-label="Stdio arguments"
                  rows={3}
                  className="w-full rounded-lg border bg-background p-3 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={draft.args}
                  disabled={busy}
                  onChange={(e) => change("args", e.target.value)}
                  placeholder={"--stdio\n--workspace"}
                />
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                Working directory <span className="font-normal text-muted-foreground">(optional, absolute)</span>
                <Input
                  aria-label="Stdio working directory"
                  value={draft.cwd}
                  disabled={busy}
                  onChange={(e) => change("cwd", e.target.value)}
                  placeholder="/srv/mcp"
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                stdio tools run with the privileges of the process you configure. Borealis spawns the executable
                directly (never a shell) and will not install or download it — they are not sandboxed.
              </p>
            </>
          )}
          <SecretPairsEditor
            legend="Custom HTTP headers (secrets)"
            namePlaceholder="Authorization"
            pairs={draft.headers}
            stored={storedCredentials}
            disabled={busy || draft.removeStoredCredentials}
            onChange={(headers) => change("headers", headers)}
          />
          <SecretPairsEditor
            legend="Environment secrets"
            namePlaceholder="API_KEY"
            pairs={draft.env}
            stored={storedCredentials}
            disabled={busy || draft.removeStoredCredentials}
            onChange={(env) => change("env", env)}
          />
          {storedCredentials && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-primary"
                aria-label="Remove stored credentials"
                checked={draft.removeStoredCredentials}
                disabled={busy}
                onChange={(e) => change("removeStoredCredentials", e.target.checked)}
              />
              <span>
                Remove stored credentials
                <span className="block text-xs text-muted-foreground">
                  Deletes the encrypted credential record; agent bindings on this connection become unavailable.
                </span>
              </span>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-primary"
              aria-label="Connection enabled"
              checked={draft.enabled}
              disabled={busy}
              onChange={(e) => change("enabled", e.target.checked)}
            />
            <span>Enabled — disabled connections cannot be tested, discovered, or used by agents.</span>
          </label>
        </div>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={busy || !draft.name.trim()}>
            {busy && <LoaderCircle className="h-4 w-4 animate-spin" />}
            {busy ? "Saving…" : row ? "Save changes" : "Create connection"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectionsPanel({
  standalone = false,
  onBusyChange,
}: {
  standalone?: boolean;
  /**
   * Reports a durable-mutation dialog in flight so the host (the Settings
   * modal) can block section switching/ dismissal while a create/edit/delete
   * commit could otherwise go invisible (the busy-dialog rule).
   */
  onBusyChange?: (busy: boolean) => void;
}) {
  const state = useConnections(true);
  const [form, setForm] = useState<{ row: ConnectionRow | null; validation: string | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRow | null>(null);
  const [desktopBusy, setDesktopBusy] = useState(false);
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const busy = state.action !== null;
  const formBusy =
    busy && (state.action?.kind === "create" || (state.action?.kind === "update" && state.action.connectionId != null));
  const formError = form
    ? (form.validation ?? (formBusy ? null : state.feedback?.kind === "error" ? state.feedback.message : null))
    : null;

  const submitForm = (draft: FormDraft, secrets: ReturnType<typeof secretsFromDraft>) => {
    const validation = validateDraft(draft);
    if (validation) {
      setForm((current) => (current ? { ...current, validation } : current));
      return;
    }
    if (secrets.credentials && secrets.removeStored) return;
    if (form?.row) {
      const row = form.row;
      const nextConfig = configFromDraft(draft);
      const configChanged =
        JSON.stringify(
          row.config.kind === "mcp_http"
            ? { url: row.config.url }
            : { command: row.config.command, args: row.config.args ?? [], cwd: row.config.cwd ?? null },
        ) !== JSON.stringify(nextConfig);
      const nameChanged = row.name !== draft.name.trim();
      // Only changed fields are sent: an unchanged name/config edit would
      // bump the server revision and reset the bounded status evidence.
      const edit: Omit<ConnectionPatchInput, "expected_revision"> = {
        enabled: draft.enabled,
        ...(nameChanged ? { name: draft.name.trim() } : {}),
        ...(configChanged ? { config: nextConfig } : {}),
        ...(secrets.credentials
          ? { credentials: secrets.credentials }
          : secrets.removeStored
            ? { credentials: null }
            : {}),
      };
      void state.save(row.id, edit, row.revision).then((ok) => {
        if (ok) setForm(null);
      });
      return;
    }
    const input: ConnectionCreateInput = {
      name: draft.name.trim(),
      kind: draft.kind,
      config: configFromDraft(draft),
      enabled: draft.enabled,
      ...(secrets.credentials ? { credentials: secrets.credentials } : {}),
    };
    void state.create(input).then((ok) => {
      if (ok) setForm(null);
    });
  };

  const openDesktopLink = async () => {
    if (!state.authSession?.desktopOpenToken || desktopBusy) return;
    setDesktopBusy(true);
    setDesktopError(null);
    const opened = await openDesktopSignInLink(
      state.authSession.desktopOpenToken,
      state.authSession.authorizeUrl,
    ).catch(() => false);
    setDesktopBusy(false);
    if (!opened) setDesktopError("The sign-in link could not be opened. Try again.");
  };

  const deleteBusy = busy && state.action?.kind === "delete" && state.action.connectionId === deleteTarget?.id;
  const commitBusy = Boolean(form && formBusy) || deleteBusy;
  const onBusyChangeRef = useRef(onBusyChange);
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange;
  }, [onBusyChange]);
  useEffect(() => {
    onBusyChangeRef.current?.(commitBusy);
    return () => onBusyChangeRef.current?.(false);
  }, [commitBusy]);

  return (
    <section aria-labelledby="connections-heading" className={cn(standalone ? "space-y-5" : "mt-5 border-t pt-5")}>
      <div
        className={cn("flex min-w-0 flex-wrap items-start justify-between gap-3", standalone && "border-b pb-5 pr-8")}
      >
        <div className="min-w-0">
          <h2
            id="connections-heading"
            className={cn("flex items-center gap-2 font-semibold", standalone ? "text-lg" : "text-sm")}
          >
            <Plug className="h-4 w-4 text-primary" aria-hidden="true" /> Connections
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Connect external MCP servers over Streamable HTTP or stdio, sign in when required, and publish their tools
            for agents. Credentials stay in encrypted local custody and are never displayed.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            type="button"
            size="sm"
            disabled={busy || state.connections.length >= MAX_CONNECTIONS_PER_ACCOUNT}
            onClick={() => {
              state.clearFeedback();
              setForm({ row: null, validation: null });
            }}
          >
            <Plus className="h-4 w-4" /> Add connection
          </Button>
          {state.connections.length >= MAX_CONNECTIONS_PER_ACCOUNT && (
            <p className="text-xs text-muted-foreground">
              The {MAX_CONNECTIONS_PER_ACCOUNT}-connection account limit is reached.
            </p>
          )}
        </div>
      </div>

      {state.loadError && (
        <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <p role="alert" className="text-sm text-destructive">
            {state.loadError}
          </p>
          <Button type="button" variant="ghost" size="sm" onClick={() => void state.refresh()} disabled={busy}>
            <RefreshCw className="h-4 w-4" /> Retry
          </Button>
        </div>
      )}

      {state.feedback && !form && (
        <p
          role={state.feedback.kind === "error" ? "alert" : "status"}
          className={cn(
            "rounded-md p-3 text-sm",
            state.feedback.kind === "error" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
          )}
        >
          {state.feedback.message}
        </p>
      )}

      {state.loading && <p className="text-sm text-muted-foreground">Loading connections…</p>}

      {!state.loading && state.connections.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No connections yet. Add one, then Test it and publish its tools with Discover.
        </p>
      )}

      <div className="divide-y rounded-lg border">
        {state.connections.map((row) => {
          const copy = connectionStatusCopy(row.status, row.status_code);
          const auth = state.authSession?.connectionId === row.id ? state.authSession : null;
          return (
            <div key={row.id} className="p-4">
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{row.name}</span>
                    <span
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-xs font-medium",
                        connectionToneClass(copy.tone),
                      )}
                    >
                      {copy.label}
                    </span>
                    <span className="rounded-md border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                      {KIND_LABEL[row.kind]}
                    </span>
                    {!row.enabled && (
                      <span className="rounded-md border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
                        Disabled
                      </span>
                    )}
                  </div>
                  <p
                    className="mt-1 max-w-full truncate font-mono text-xs text-muted-foreground"
                    title={endpointSummary(row)}
                  >
                    {endpointSummary(row)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <KeyRound className="mr-1 inline h-3 w-3" aria-hidden="true" />
                    {connectionCredentialCopy(row.credential_state)}
                    {row.discovery_revision > 0 && (
                      <>
                        {" · "}
                        <Wrench className="mr-1 inline h-3 w-3" aria-hidden="true" />
                        discovery r{row.discovery_revision}
                        {row.tools ? ` · ${row.tools.length} published tools` : ""}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !row.enabled}
                    title={row.enabled ? "Bounded initialize/list-tools check" : "Enable the connection first"}
                    onClick={() => {
                      state.clearFeedback();
                      void state.test(row.id);
                    }}
                  >
                    {state.action?.kind === "test" && state.action.connectionId === row.id && (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    )}
                    Test
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !row.enabled}
                    title="Publish the validated tool catalog"
                    onClick={() => {
                      state.clearFeedback();
                      void state.discover(row.id);
                    }}
                  >
                    {state.action?.kind === "discover" && state.action.connectionId === row.id && (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    )}
                    Discover
                  </Button>
                  {row.kind === "mcp_http" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !row.enabled || auth !== null}
                      onClick={() => {
                        state.clearFeedback();
                        void state.authorize(row.id);
                      }}
                    >
                      <ShieldCheck className="h-4 w-4" /> Sign in
                    </Button>
                  )}
                  {row.credential_state === "stored" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        state.clearFeedback();
                        void state.revoke(row.id);
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Edit ${row.name}`}
                    onClick={() => {
                      state.clearFeedback();
                      setForm({ row, validation: null });
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`}
                    onClick={() => {
                      state.clearFeedback();
                      void state.toggle(row.id, !row.enabled, row.revision);
                    }}
                  >
                    {state.action?.kind === "toggle" && state.action.connectionId === row.id && (
                      <LoaderCircle className="h-4 w-4 animate-spin" />
                    )}
                    {row.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    aria-label={`Delete ${row.name}`}
                    onClick={() => {
                      state.clearFeedback();
                      setDeleteTarget(row);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {auth && (
                <div className="mt-3 rounded-lg border bg-muted/30 p-3" aria-label="Sign-in link">
                  <p className="text-sm">
                    Open this one-time sign-in link in your browser. It expires at{" "}
                    {new Date(auth.expiresAt).toLocaleTimeString()}. Borealis never opens it for you.
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{auth.authorizeUrl}</p>
                  {hasDesktopSignInLinkBridge() ? (
                    auth.desktopOpenToken ? (
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2"
                        disabled={desktopBusy}
                        onClick={() => void openDesktopLink()}
                      >
                        {desktopBusy ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <Link2 className="h-4 w-4" />
                        )}
                        Open in system browser
                      </Button>
                    ) : (
                      // A packaged desktop never renders a plain link: the
                      // system browser is only reachable through the one-time
                      // backend-issued open intent.
                      <p className="mt-1 text-xs text-muted-foreground">
                        Start sign-in again to enable opening this link in your system browser.
                      </p>
                    )
                  ) : (
                    isValidSignInUrl(auth.authorizeUrl) && (
                      <a
                        href={auth.authorizeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2"
                      >
                        <Link2 className="h-4 w-4" /> Open sign-in link
                      </a>
                    )
                  )}
                  {desktopError && (
                    <p role="alert" className="mt-1 text-sm text-destructive">
                      {desktopError}
                    </p>
                  )}
                  <p role="status" className="mt-2 text-xs text-muted-foreground">
                    Waiting for sign-in to finish — this panel updates automatically.{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2"
                      onClick={() => {
                        setDesktopError(null);
                        state.dismissAuthSession();
                      }}
                    >
                      Cancel sign-in
                    </button>
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Disabling, revoking, or deleting a connection takes effect before the next use; already running turns keep their
        frozen tool configuration.
      </p>

      {form && (
        <ConnectionFormDialog
          key={form.row?.id ?? "create"}
          row={form.row}
          busy={formBusy}
          error={formError}
          onClose={() => {
            if (formBusy) return;
            setForm(null);
          }}
          onSubmit={submitForm}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete “${deleteTarget.name}”?`}
          description="The connection, its credential record, and its published tool catalog are removed. Agents using its tools will show them as unavailable."
          busy={deleteBusy}
          onCancel={() => {
            if (!deleteBusy) setDeleteTarget(null);
          }}
          onConfirm={() => {
            if (deleteBusy) return;
            const target = deleteTarget;
            // Close on completion whatever the outcome: with the dialog gone,
            // the panel's own feedback slot carries the success or the error
            // (a failure left inside this dialog would be invisible).
            void state.remove(target.id).then(() => {
              if (deleteTarget === target) setDeleteTarget(null);
            });
          }}
        />
      )}
    </section>
  );
}
