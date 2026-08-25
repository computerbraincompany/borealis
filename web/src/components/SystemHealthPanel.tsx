import {
  Activity,
  Check,
  CircleAlert,
  Cpu,
  Database,
  Network,
  RefreshCw,
  Server,
  TableProperties,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ServiceHealthId, SystemHealthResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

const SERVICE_ICONS: Record<ServiceHealthId, typeof Server> = {
  api: Server,
  database: Database,
  data_service: TableProperties,
  model_gateway: Network,
  model_runtime: Cpu,
};

interface SystemHealthPanelProps {
  health: SystemHealthResponse | null;
  checking: boolean;
  error: string | null;
  onRefresh: () => void;
  embedded?: boolean;
}

function checkedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last check time unavailable";
  return `Last checked ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export function SystemHealthPanel({ health, checking, error, onRefresh, embedded = false }: SystemHealthPanelProps) {
  const degraded = health?.status === "degraded";
  const unavailableCount = health?.services.filter((service) => service.status === "unavailable").length ?? 0;

  return (
    <Card className={cn("overflow-hidden rounded-lg shadow-none", embedded && "rounded-none border-0 bg-transparent")}>
      <section aria-labelledby="system-health-heading">
        <div className={cn("border-b px-5 py-5", health && (degraded ? "bg-warning/[0.06]" : "bg-success/[0.055]"))}>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-md border",
                  !health
                    ? "bg-secondary text-muted-foreground"
                    : degraded
                      ? "border-warning/30 bg-warning/10 text-warning"
                      : "border-success/30 bg-success/10 text-success",
                )}
              >
                {!health ? (
                  <Activity className={cn("size-5", checking && "animate-status-pulse")} />
                ) : degraded ? (
                  <CircleAlert className="size-5" />
                ) : (
                  <Check className="size-5" strokeWidth={2.5} />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Readiness</p>
                <h2 id="system-health-heading" className="mt-1 text-lg font-semibold tracking-tight text-foreground">
                  {!health
                    ? "Checking system readiness"
                    : degraded
                      ? "Service attention required"
                      : "All systems ready"}
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {!health
                    ? "Testing the services Borealis needs for chat, data analysis, and reports."
                    : degraded
                      ? `${unavailableCount} ${unavailableCount === 1 ? "dependency is" : "dependencies are"} unavailable. Follow the affected service below to restore full operation.`
                      : "Chat, ingestion, data analysis, and report generation are ready to use."}
                </p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={checking}>
              <RefreshCw className={cn(checking && "animate-spin")} />
              {checking ? "Checking…" : "Check now"}
            </Button>
          </div>
        </div>

        {error && (
          <div
            className="border-b border-destructive/25 bg-destructive/[0.06] px-5 py-3 text-sm text-destructive"
            role="alert"
          >
            {health && <span className="font-medium">Showing the last completed check. </span>}
            {error}
          </div>
        )}

        <div className="p-5">
          {!health ? (
            <div className="space-y-3" aria-label="Checking service dependencies">
              {[0, 1, 2, 3, 4].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <div className="size-9 animate-pulse rounded-md bg-secondary" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3 w-32 animate-pulse rounded bg-secondary" />
                    <div className="h-3 max-w-md animate-pulse rounded bg-secondary" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <ol className="relative" aria-label="Service dependency status">
              {health.services.map((service, index) => {
                const Icon = SERVICE_ICONS[service.id];
                const operational = service.status === "operational";
                return (
                  <li key={service.id} className="relative flex gap-3 pb-3 last:pb-0">
                    {index < health.services.length - 1 && (
                      <span className="absolute left-[17px] top-9 h-[calc(100%-2.25rem)] border-l" aria-hidden="true" />
                    )}
                    <div
                      className={cn(
                        "relative z-10 flex size-9 shrink-0 items-center justify-center rounded-md border bg-card",
                        operational ? "border-success/30 text-success" : "border-destructive/35 text-destructive",
                      )}
                    >
                      <Icon className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 py-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                        <h3 className="text-sm font-semibold text-foreground">{service.name}</h3>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {service.latency_ms} ms
                          </span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                              operational
                                ? "border-success/30 bg-success/10 text-success"
                                : "border-destructive/30 bg-destructive/10 text-destructive",
                            )}
                          >
                            {operational ? <Check className="size-3" /> : <X className="size-3" />}
                            {operational ? "Ready" : "Unavailable"}
                          </span>
                        </div>
                      </div>
                      {!operational && <p className="mt-1 text-sm leading-5 text-destructive">{service.description}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-secondary/25 px-5 py-3 text-xs text-muted-foreground">
          <span>Updates every 30 seconds while Settings is open.</span>
          {health && <time dateTime={health.checked_at}>{checkedLabel(health.checked_at)}</time>}
        </div>
      </section>
    </Card>
  );
}
