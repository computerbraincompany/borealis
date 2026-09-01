import { useEffect, useState } from "react";
import { Cpu, Download, LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useContained } from "@/hooks/useContained";
import type { ContainedConfigInput, ContainedDownloadState, ContainedEngineState } from "@/lib/api";
import { cn } from "@/lib/utils";

const CONTAINED_FILENAME_PATTERN = /^[A-Za-z0-9._-]{1,180}$/;
const CONTAINED_SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

const ENGINE_STATE_CHIP: Record<ContainedEngineState, string> = {
  off: "border-border bg-secondary text-muted-foreground",
  starting: "border-primary/30 bg-primary/10 text-primary",
  healthy: "border-success/30 bg-success/10 text-success",
  crashed: "border-destructive/30 bg-destructive/10 text-destructive",
  stopped: "border-border bg-secondary text-muted-foreground",
};

const DOWNLOAD_STATE_CHIP: Record<ContainedDownloadState["state"], string> = {
  downloading: "border-primary/30 bg-primary/10 text-primary",
  verifying: "border-primary/30 bg-primary/10 text-primary",
  complete: "border-success/30 bg-success/10 text-success",
  failed: "border-destructive/30 bg-destructive/10 text-destructive",
  canceled: "border-border bg-secondary text-muted-foreground",
};

interface ContainedConfigDraft {
  enabled: boolean;
  binary_path: string;
  model_path: string;
}

interface ContainedDownloadDraft {
  url: string;
  filename: string;
  sha256: string;
}

function absolutePathError(label: string, value: string): string | null {
  if (value.includes("~")) return `${label} must not contain ~.`;
  if (!value.startsWith("/")) return `${label} must be an absolute path.`;
  return null;
}

function validateConfigForm(form: ContainedConfigDraft): string | null {
  const binaryPath = form.binary_path.trim();
  const modelPath = form.model_path.trim();
  if (binaryPath) {
    const error = absolutePathError("Binary path", binaryPath);
    if (error) return error;
  }
  if (modelPath) {
    const error = absolutePathError("Model path", modelPath);
    if (error) return error;
  }
  if (form.enabled && (!binaryPath || !modelPath)) {
    return "An enabled engine needs absolute binary and model paths.";
  }
  return null;
}

function validateDownloadForm(form: ContainedDownloadDraft): string | null {
  const url = form.url.trim();
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Download URL must be an HTTP or HTTPS URL.";
    }
  } catch {
    return "Download URL must be an HTTP or HTTPS URL.";
  }
  const filename = form.filename.trim();
  if (!CONTAINED_FILENAME_PATTERN.test(filename) || filename.includes("..")) {
    return "Filename must be 1-180 characters of [A-Za-z0-9._-] without separators.";
  }
  if (!CONTAINED_SHA256_PATTERN.test(form.sha256.trim())) {
    return "SHA-256 must be a 64-character hex digest.";
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  for (const unit of ["KB", "MB", "GB", "TB"]) {
    value /= 1024;
    if (value < 1024) {
      return `${value >= 100 ? String(Math.round(value)) : value.toFixed(1)} ${unit}`;
    }
  }
  return `${value.toFixed(1)} PB`;
}

/**
 * Bounded contained-model management under Settings → Models. It is mounted
 * only while that section is open, so the live two-second poll inside
 * `useContained` stops on unmount.
 */
export function ContainedPanel() {
  const contained = useContained(true);
  const [configDraft, setConfigDraft] = useState<ContainedConfigDraft>({
    enabled: false,
    binary_path: "",
    model_path: "",
  });
  const [configDirty, setConfigDirty] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [downloadDraft, setDownloadDraft] = useState<ContainedDownloadDraft>({ url: "", filename: "", sha256: "" });
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Follow server state only while the operator has not edited the draft;
  // polling must never clobber in-progress edits.
  useEffect(() => {
    const config = contained.config;
    if (!config || configDirty) return;
    setConfigDraft({ enabled: config.enabled, binary_path: config.binary_path, model_path: config.model_path });
  }, [contained.config, configDirty]);

  const engine = contained.engine;
  const busy = contained.action !== null;

  const editConfig = (patch: Partial<ContainedConfigDraft>) => {
    setConfigDraft((current) => ({ ...current, ...patch }));
    setConfigDirty(true);
  };

  const submitConfig = async () => {
    const validationError = validateConfigForm(configDraft);
    if (validationError) {
      setConfigError(validationError);
      return;
    }
    setConfigError(null);
    const body: ContainedConfigInput = { enabled: configDraft.enabled };
    const binaryPath = configDraft.binary_path.trim();
    const modelPath = configDraft.model_path.trim();
    if (binaryPath) body.binary_path = binaryPath;
    if (modelPath) body.model_path = modelPath;
    if (await contained.saveConfig(body)) setConfigDirty(false);
  };

  const submitDownload = async () => {
    const validationError = validateDownloadForm(downloadDraft);
    if (validationError) {
      setDownloadError(validationError);
      return;
    }
    setDownloadError(null);
    if (
      await contained.startDownload({
        url: downloadDraft.url.trim(),
        filename: downloadDraft.filename.trim(),
        sha256: downloadDraft.sha256.trim(),
      })
    ) {
      setDownloadDraft({ url: "", filename: "", sha256: "" });
    }
  };

  return (
    <section aria-labelledby="contained-engine-heading" className="mt-5 border-t pt-5">
      <div className="flex min-w-0 items-start gap-3">
        <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <h3 id="contained-engine-heading" className="text-sm font-semibold text-foreground">
            Contained engine
          </h3>
          <p className="mt-1 max-w-prose text-xs leading-5 text-muted-foreground">
            Download a checksum-verified model file and run a local llama-server engine on this Mac. The engine binds
            loopback only; saving a configuration never starts or stops a running engine.
          </p>
        </div>
      </div>

      {contained.loadError && !engine ? (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4" role="alert">
          <p className="text-sm text-destructive">{contained.loadError}</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void contained.refresh()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : !engine ? (
        <div className="mt-3 space-y-3 rounded-lg border bg-card p-4" aria-label="Loading contained engine">
          <div className="h-9 animate-pulse rounded-md bg-secondary" />
          <div className="h-9 animate-pulse rounded-md bg-secondary" />
          <div className="h-9 animate-pulse rounded-md bg-secondary" />
        </div>
      ) : (
        <>
          <form
            className="mt-3 overflow-hidden rounded-lg border bg-card"
            aria-label="Contained configuration"
            onSubmit={(event) => {
              event.preventDefault();
              void submitConfig();
            }}
          >
            <div className="grid gap-x-4 gap-y-4 p-4">
              <label className="flex items-start gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={configDraft.enabled}
                  onChange={(event) => editConfig({ enabled: event.target.checked })}
                  disabled={busy}
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">Enable contained engine</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    Lets Borealis start the configured local engine as the model provider while it runs.
                  </span>
                </span>
              </label>

              <div className="sm:col-span-2">
                <Label htmlFor="settings-contained-binary-path">Binary path</Label>
                <Input
                  id="settings-contained-binary-path"
                  type="text"
                  spellCheck={false}
                  maxLength={4096}
                  className="mt-2 font-mono"
                  placeholder="/usr/local/bin/llama-server"
                  value={configDraft.binary_path}
                  onChange={(event) => editConfig({ binary_path: event.target.value })}
                  disabled={busy}
                  aria-describedby="settings-contained-paths-help"
                />
              </div>

              <div className="sm:col-span-2">
                <Label htmlFor="settings-contained-model-path">Model path</Label>
                <Input
                  id="settings-contained-model-path"
                  type="text"
                  spellCheck={false}
                  maxLength={4096}
                  className="mt-2 font-mono"
                  placeholder="/Users/you/Models/model.gguf"
                  value={configDraft.model_path}
                  onChange={(event) => editConfig({ model_path: event.target.value })}
                  disabled={busy}
                  aria-describedby="settings-contained-paths-help"
                />
              </div>

              <p id="settings-contained-paths-help" className="text-xs leading-5 text-muted-foreground sm:col-span-2">
                Both paths must be absolute on this Mac and may not contain ~.
              </p>

              {configError && (
                <p className="text-xs text-destructive sm:col-span-2" role="alert">
                  {configError}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end border-t bg-secondary/20 px-4 py-3">
              <Button type="submit" disabled={busy}>
                {contained.action === "saving-config" && <LoaderCircle className="animate-spin" />}
                {contained.action === "saving-config" ? "Saving…" : "Save configuration"}
              </Button>
            </div>
          </form>

          <div className="mt-4 rounded-lg border bg-card p-4" aria-label="Contained engine state">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span
                className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", ENGINE_STATE_CHIP[engine.state])}
              >
                {engine.state}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {engine.endpoint_managed_by_env && (
                  <span className="rounded border bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    endpoint managed by environment
                  </span>
                )}
                {engine.model && (
                  <code className="max-w-full truncate font-mono" title={`Contained model ${engine.model}`}>
                    {engine.model}
                  </code>
                )}
                {engine.endpoint_host && <code className="font-mono">{engine.endpoint_host}</code>}
              </div>
            </div>

            {engine.error && (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {engine.error}
              </p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void contained.startEngine()}
                disabled={busy || engine.state === "starting" || engine.state === "healthy"}
              >
                {contained.action === "starting-engine" && <LoaderCircle className="animate-spin" />}
                {contained.action === "starting-engine" ? "Starting…" : "Start engine"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void contained.stopEngine()}
                disabled={busy || engine.state === "off" || engine.state === "stopped" || engine.state === "crashed"}
              >
                {contained.action === "stopping-engine" && <LoaderCircle className="animate-spin" />}
                {contained.action === "stopping-engine" ? "Stopping…" : "Stop engine"}
              </Button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-lg border bg-card" aria-label="Contained model downloads">
            <form
              className="grid gap-x-4 gap-y-4 p-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitDownload();
              }}
            >
              <div className="sm:col-span-2">
                <Label htmlFor="settings-contained-download-url">Download URL</Label>
                <Input
                  id="settings-contained-download-url"
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  maxLength={2048}
                  className="mt-2 font-mono"
                  placeholder="https://model.example.test/model.gguf"
                  value={downloadDraft.url}
                  onChange={(event) => setDownloadDraft((current) => ({ ...current, url: event.target.value }))}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="settings-contained-download-filename">Model filename</Label>
                <Input
                  id="settings-contained-download-filename"
                  type="text"
                  spellCheck={false}
                  maxLength={180}
                  className="mt-2 font-mono"
                  placeholder="model.gguf"
                  value={downloadDraft.filename}
                  onChange={(event) => setDownloadDraft((current) => ({ ...current, filename: event.target.value }))}
                  disabled={busy}
                />
              </div>
              <div>
                <Label htmlFor="settings-contained-download-sha256">SHA-256 checksum</Label>
                <Input
                  id="settings-contained-download-sha256"
                  type="text"
                  spellCheck={false}
                  maxLength={64}
                  className="mt-2 font-mono"
                  placeholder="64-character hex digest"
                  value={downloadDraft.sha256}
                  onChange={(event) => setDownloadDraft((current) => ({ ...current, sha256: event.target.value }))}
                  disabled={busy}
                />
              </div>

              {downloadError && (
                <p className="text-xs text-destructive sm:col-span-2" role="alert">
                  {downloadError}
                </p>
              )}

              <div className="sm:col-span-2">
                <Button type="submit" disabled={busy}>
                  {contained.action === "starting-download" ? <LoaderCircle className="animate-spin" /> : <Download />}
                  {contained.action === "starting-download" ? "Starting…" : "Start download"}
                </Button>
              </div>
            </form>

            <div className="border-t">
              {contained.downloads.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  No downloads yet. Completed files land in the workspace models directory.
                </p>
              ) : (
                <ul className="divide-y" aria-label="Contained download progress">
                  {contained.downloads.map((download) => (
                    <li key={download.filename} className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span
                          className="min-w-0 truncate font-mono font-medium text-foreground"
                          title={download.filename}
                        >
                          {download.filename}
                        </span>
                        <span className="font-mono text-muted-foreground">{download.url_host}</span>
                        <span
                          className={cn(
                            "rounded-md border px-2 py-0.5 text-xs font-medium",
                            DOWNLOAD_STATE_CHIP[download.state],
                          )}
                        >
                          {download.state}
                        </span>
                        <span className="text-muted-foreground">
                          {formatBytes(download.bytes_received)}
                          {download.total_bytes === null ? "" : ` of ${formatBytes(download.total_bytes)}`}
                        </span>
                        {(download.state === "downloading" || download.state === "verifying") && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 py-0 text-xs"
                            onClick={() => void contained.cancelDownload(download.filename)}
                            disabled={busy}
                          >
                            {contained.action === "cancelling-download" ? "Cancelling…" : "Cancel"}
                          </Button>
                        )}
                      </div>
                      {download.error && (
                        <p className="mt-1 text-xs text-destructive" role="alert">
                          {download.error}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-4 min-h-5 text-xs" aria-live="polite">
        {contained.loadError && engine ? (
          <p role="alert" className="text-destructive">
            {contained.loadError}
          </p>
        ) : contained.feedback ? (
          <p
            role={contained.feedback.kind === "error" ? "alert" : "status"}
            className={contained.feedback.kind === "error" ? "text-destructive" : "text-success"}
          >
            {contained.feedback.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}
