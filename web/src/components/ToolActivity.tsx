import { Search, Table2, Info, BarChart3, FileOutput, Globe, List, Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolStep } from "@/lib/chatStream";

export type { ToolStep } from "@/lib/chatStream";

const TOOL_META: Record<string, { icon: typeof Search; label: string }> = {
  retrieve: { icon: Search, label: "Searching documents & data" },
  list_sources: { icon: List, label: "Listing sources" },
  query_data: { icon: Table2, label: "Querying data (SQL)" },
  describe_data: { icon: Info, label: "Analyzing schema" },
  render_chart: { icon: BarChart3, label: "Rendering chart" },
  create_report: { icon: FileOutput, label: "Building report" },
  fetch_url: { icon: Globe, label: "Fetching URL" },
};

export function ToolActivity({
  steps,
  running,
  className,
}: {
  steps: ToolStep[];
  running?: boolean;
  className?: string;
}) {
  if (!steps.length) return null;
  const working = running ?? steps.some((step) => step.status === "running");
  const completed = steps.filter((step) => step.status === "done").length;
  const failed = steps.filter((step) => step.status === "error").length;
  const latest = steps.at(-1)!;
  const latestText =
    latest.status === "running" && working
      ? latest.summary
      : (latest.resultSummary ?? (working ? "Preparing the next step…" : "Activity finished."));
  return (
    <div className={cn("my-3 w-full rounded-lg border bg-surface-subtle", className)}>
      <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium">
        {working ? (
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin text-primary" />
        ) : failed ? (
          <TriangleAlert aria-hidden="true" className="h-4 w-4 text-warning" />
        ) : (
          <Check aria-hidden="true" className="h-4 w-4 text-success" />
        )}
        {working ? "Borealis is working" : "Activity finished"}
      </div>
      <p className="px-4 pb-3 pt-1 text-xs leading-relaxed text-muted-foreground">
        {working && latest.status !== "running" ? "Reviewing results and preparing the next step…" : latestText}
      </p>
      <details className="border-t">
        <summary className="cursor-pointer px-4 py-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          View activity · {completed} completed{failed > 0 ? ` · ${failed} failed` : ""}
        </summary>
        <div className="max-h-64 overflow-y-auto border-t p-2">
          {steps.map((s) => {
            const meta = TOOL_META[s.name] || { icon: Search, label: "Operation" };
            const Icon = meta.icon;
            const running = s.status === "running" && working;
            return (
              <div
                key={s.key}
                className={cn("flex items-start gap-2.5 rounded-lg px-2.5 py-2", running && "bg-accent/60")}
              >
                <div
                  className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                    running
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-muted/70 text-muted-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    {meta.label}
                    {running && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                  </div>
                  {s.status !== "error" && (
                    <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                      {running ? s.summary : (s.resultSummary ?? "Step finished.")}
                    </div>
                  )}
                  {s.status === "error" && (
                    <div className="mt-1 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                      <TriangleAlert className="h-3 w-3 shrink-0" />
                      <span>{s.resultSummary || "This step could not be completed."}</span>
                    </div>
                  )}
                </div>
                {s.status === "done" && <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-success" />}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
