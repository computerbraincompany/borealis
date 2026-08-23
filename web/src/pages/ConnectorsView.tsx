import { useEffect, useState } from "react";
import { Plus, Trash2, Globe, Database, RefreshCw, Loader2, Plug, Link as LinkIcon } from "lucide-react";
import { ApiError, connectorsApi, formatApiError, type Connector } from "@/lib/api";
import { validateConnectorDraft } from "@/lib/connectorDraft";
import { isConnectorTransitioning, useConnectorCatalog } from "@/hooks/useConnectorCatalog";
import { cn, formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ConnectorsView() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [type, setType] = useState<"url_csv" | "url_json">("url_csv");
  const [targetTable, setTargetTable] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operationErrors, setOperationErrors] = useState<Record<string, string>>({});
  const { connectors, loading, error: catalogError, refresh } = useConnectorCatalog();

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const create = async () => {
    setError(null);
    const validation = validateConnectorDraft({ displayName: name, targetTable, type, url });
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setCreating(true);
    try {
      const created = await connectorsApi.create(validation.value);
      setOpen(false);
      setName("");
      setUrl("");
      setTargetTable("");
      await refresh();
      if (created.sync_status === "error" && created.sync_error) {
        const syncError = created.sync_error;
        setOperationErrors((current) => ({ ...current, [created.id]: safeConnectorError(syncError) }));
      }
    } catch (failure: unknown) {
      if (failure instanceof ApiError && failure.status === 422 && failure.data && typeof failure.data === "object") {
        const failed = failure.data as Partial<Connector>;
        if (typeof failed.id === "string") {
          setOpen(false);
          setName("");
          setUrl("");
          setTargetTable("");
          await refresh();
          setOperationErrors((current) => ({
            ...current,
            [failed.id as string]:
              typeof failed.sync_error === "string"
                ? safeConnectorError(failed.sync_error)
                : formatApiError(failure, "Connector sync failed"),
          }));
          return;
        }
      }
      setError(formatApiError(failure, "Could not create the connector"));
    } finally {
      setCreating(false);
    }
  };

  const sync = async (c: Connector) => {
    if (isConnectorTransitioning(c) || syncing === c.id || deleting === c.id) return;
    setSyncing(c.id);
    setOperationErrors((current) => {
      const next = { ...current };
      delete next[c.id];
      return next;
    });
    try {
      const updated = await connectorsApi.sync(c.id);
      await refresh();
      if ("sync_status" in updated && updated.sync_status === "error" && updated.sync_error) {
        const syncError = updated.sync_error;
        setOperationErrors((current) => ({ ...current, [c.id]: safeConnectorError(syncError) }));
      }
    } catch (failure: unknown) {
      setOperationErrors((current) => ({
        ...current,
        [c.id]: formatApiError(failure, "Could not start connector sync"),
      }));
      await refresh();
    } finally {
      setSyncing(null);
    }
  };

  const remove = async (c: Connector) => {
    if (isConnectorTransitioning(c) || syncing === c.id || deleting === c.id) return;
    setDeleting(c.id);
    try {
      await connectorsApi.remove(c.id);
      setOperationErrors((current) => {
        const next = { ...current };
        delete next[c.id];
        return next;
      });
      await refresh();
    } catch (failure: unknown) {
      setOperationErrors((current) => ({
        ...current,
        [c.id]: formatApiError(failure, "Could not delete the connector"),
      }));
      await refresh();
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Connectors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pull CSV / JSON datasets straight from a URL — no file download needed.
          </p>
        </div>
        <Button
          variant="aurora"
          size="sm"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <Plus className="h-4 w-4" /> Add connector
        </Button>
      </div>

      {catalogError && (
        <div
          className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {catalogError}
        </div>
      )}

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        {connectors.map((c) => {
          const cfg = parseConfig(c.config);
          return (
            <Card key={c.id} className="flex flex-col gap-3 p-5 transition-colors hover:border-foreground/20">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-aurora-violet/15 text-aurora-violet">
                  {c.type === "url_csv" ? <Database className="h-5 w-5" /> : <Globe className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">{c.name}</span>
                    <Badge variant="aurora">{c.type === "url_csv" ? "URL · CSV" : "URL · JSON"}</Badge>
                    <ConnectorStatus status={c.sync_status} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    table <span className="font-mono text-aurora-teal">{c.target_table}</span>
                  </div>
                </div>
              </div>
              {cfg.url && (
                <div className="flex items-center gap-2 truncate rounded-lg bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                  <LinkIcon className="h-3.5 w-3.5 shrink-0 text-aurora-blue" />
                  <span className="truncate font-mono">{cfg.url}</span>
                </div>
              )}
              {(operationErrors[c.id] || (c.sync_status === "error" && c.sync_error)) && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {operationErrors[c.id] || safeConnectorError(c.sync_error || "Connector sync failed.")}
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Last sync: {c.last_sync ? formatDate(c.last_sync) : "never"}</span>
                <span className="flex items-center gap-0.5">
                  <Plug className="h-3 w-3" /> created {formatDate(c.created_at)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="flex-1"
                  onClick={() => sync(c)}
                  disabled={syncing === c.id || deleting === c.id || isConnectorTransitioning(c)}
                >
                  {syncing === c.id || isConnectorTransitioning(c) ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {isConnectorTransitioning(c) ? "Syncing…" : "Sync now"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(c)}
                  disabled={deleting === c.id || syncing === c.id || isConnectorTransitioning(c)}
                  aria-label={`Delete ${c.name}`}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          );
        })}
        {connectors.length === 0 && !loading && (
          <Card className="flex flex-col items-center gap-3 py-16 text-center md:col-span-2">
            <Plug className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No connectors yet. Point one at a public CSV to start querying remote data.
            </p>
          </Card>
        )}
        {connectors.length === 0 && loading && (
          <Card className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground md:col-span-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading connectors…
          </Card>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add URL connector</DialogTitle>
            <DialogDescription>
              Register a remote dataset. Borealis downloads it, registers it as a DuckDB table and makes it searchable.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="connType">Dataset type</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["url_csv", "url_json"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setType(t)}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      type === t
                        ? "border-aurora-teal/50 bg-aurora-teal/10 text-aurora-teal"
                        : "border-input text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                    )}
                  >
                    {t === "url_csv" ? <Database className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
                    {t === "url_csv" ? "CSV" : "JSON"}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="url">Dataset URL</Label>
              <Input
                id="url"
                placeholder="https://example.com/data.csv"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                className="h-10 bg-background/60 font-mono text-[13px]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="name">Display name</Label>
                <Input
                  id="name"
                  placeholder="My dataset"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  className="h-10 bg-background/60"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="table">DuckDB table</Label>
                <Input
                  id="table"
                  placeholder="transactions_2026"
                  value={targetTable}
                  onChange={(e) => {
                    setTargetTable(e.target.value);
                    setError(null);
                  }}
                  aria-describedby="table-help"
                  className="h-10 bg-background/60 font-mono text-[13px]"
                />
                <p id="table-help" className="text-[11px] text-muted-foreground">
                  Starts with a letter; letters, digits and underscores only. Saved lowercase.
                </p>
              </div>
            </div>
            {error && (
              <div
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="aurora"
              onClick={create}
              disabled={creating || !url.trim() || !name.trim() || !targetTable.trim()}
            >
              {creating && <Loader2 className="animate-spin" />} Connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectorStatus({ status }: { status: Connector["sync_status"] }) {
  if (status === "idle") return <Badge variant="success">idle</Badge>;
  if (status === "error") return <Badge variant="destructive">error</Badge>;
  return <Badge variant="pending">{status}</Badge>;
}

function safeConnectorError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : "Connector sync failed.";
}

function parseConfig(config: Connector["config"] | string): { url?: string } {
  try {
    const parsed: unknown = typeof config === "string" ? JSON.parse(config) : config;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const url = (parsed as Record<string, unknown>).url;
    return typeof url === "string" ? { url } : {};
  } catch {
    return {};
  }
}
