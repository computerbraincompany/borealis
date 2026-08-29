import { useWorkspaceStatus } from "@/hooks/useWorkspaceStatus";
import type { ProviderLocality } from "@/lib/api";
import { cn } from "@/lib/utils";

const LOCALITY_LABEL: Record<ProviderLocality, string> = {
  local: "On this Mac",
  private: "Private network",
  remote: "Remote provider",
};

const LOCALITY_DOT: Record<ProviderLocality, string> = {
  local: "bg-success",
  private: "bg-primary",
  remote: "bg-warning",
};

function localityHint(locality: ProviderLocality, containedManaged: boolean): string {
  if (locality === "remote") {
    return "A remote provider is configured. Ingestion text, prompts, retrieval queries, and selected tool context leave this machine under that provider's policy.";
  }
  if (containedManaged) {
    return "The provider endpoint is managed by an environment override, so the contained engine cannot switch it.";
  }
  if (locality === "private") {
    return "Model calls go to a private-network endpoint you own.";
  }
  return "Model calls stay on this machine.";
}

export function WorkspaceStatus() {
  const { status, checking } = useWorkspaceStatus();

  const reachability = !status
    ? { label: checking ? "Checking endpoint…" : "Endpoint status unavailable", dot: "bg-muted-foreground/40" }
    : status.endpoint_reachable
      ? { label: `Endpoint reachable · ${status.latency_ms} ms`, dot: "bg-success" }
      : { label: "Endpoint unreachable", dot: "bg-destructive" };

  return (
    <section aria-label="Model locality and health" className="space-y-2 px-4 py-3 text-xs">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            status ? LOCALITY_DOT[status.locality] : "animate-status-pulse bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <span
          className="font-semibold tracking-tight text-foreground"
          title={status ? localityHint(status.locality, status.contained?.endpoint_managed_by_env ?? false) : undefined}
        >
          {status
            ? status.contained?.state === "healthy"
              ? "On this Mac · contained"
              : LOCALITY_LABEL[status.locality]
            : "Checking locality…"}
          {status?.contained && status.contained.state !== "healthy" && status.contained.state !== "off"
            ? ` · engine ${status.contained.state}`
            : ""}
        </span>
      </div>
      {status?.contained?.state === "healthy" && status.contained.model && (
        <div
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={`Contained model ${status.contained.model}`}
        >
          {status.contained.model}
        </div>
      )}
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className={cn("size-1.5 shrink-0 rounded-full", reachability.dot)} aria-hidden />
        <span>{reachability.label}</span>
      </div>
      {status && (
        <div
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={`Chat ${status.chat_model} · Embed ${status.embed_model}`}
        >
          {status.chat_model}
        </div>
      )}
      {status?.locality === "remote" && (
        <p className="text-warning" title={localityHint("remote", status.contained?.endpoint_managed_by_env ?? false)}>
          Some data leaves this Mac.{" "}
          <a href="#/settings" className="underline underline-offset-2 hover:text-foreground">
            See Settings
          </a>
        </p>
      )}
    </section>
  );
}
