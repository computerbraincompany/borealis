import { Search, Table2, Info, BarChart3, FileOutput, Globe, List, Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ToolStep {
  key: number;
  name: string;
  args: Record<string, any>;
  status: "running" | "done" | "error";
  resultPreview?: string;
}

const TOOL_META: Record<string, { icon: typeof Search; label: string }> = {
  retrieve: { icon: Search, label: "Searching documents & data" },
  list_sources: { icon: List, label: "Listing sources" },
  query_data: { icon: Table2, label: "Querying data (SQL)" },
  describe_data: { icon: Info, label: "Analyzing schema" },
  render_chart: { icon: BarChart3, label: "Rendering chart" },
  create_report: { icon: FileOutput, label: "Building report" },
  fetch_url: { icon: Globe, label: "Fetching URL" },
};

export function ToolActivity({ steps, className }: { steps: ToolStep[]; className?: string }) {
  if (!steps.length) return null;
  return (
    <div className={cn("my-3 space-y-1.5 rounded-xl border bg-surface-subtle/90 p-3", className)}>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {steps.some((s) => s.status === "running") ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-aurora-teal" />
            Borealis is working
          </>
        ) : (
          <Check className="h-3.5 w-3.5 text-aurora-teal" />
        )}
        <span className="ml-auto flex items-center gap-1">
          {steps.filter((s) => s.status === "done").length}/{steps.length} steps
        </span>
      </div>
      {steps.map((s) => {
        const meta = TOOL_META[s.name] || { icon: Search, label: s.name };
        const Icon = meta.icon;
        const running = s.status === "running";
        return (
          <div key={s.key} className={cn("flex items-start gap-2.5 rounded-lg px-2.5 py-2", running && "bg-accent/60")}>
            <div
              className={cn(
                "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border",
                running ? "border-aurora-teal/30 bg-aurora-teal/10 text-aurora-teal" : "border-border bg-muted/70 text-muted-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                {meta.label}
                {running && <Loader2 className="h-3 w-3 animate-spin text-aurora-teal" />}
              </div>
              {s.args && !isEmptyArgs(s.args) && (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(s.args)}>
                  {JSON.stringify(s.args).slice(0, 140)}
                </div>
              )}
              {s.status === "error" && (
                <div className="mt-1 flex items-center gap-1.5 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
                  <TriangleAlert className="h-3 w-3 shrink-0" />
                  <span className="truncate">{s.resultPreview || "tool failed"}</span>
                </div>
              )}
            </div>
            {s.status === "done" && <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-success" />}
          </div>
        );
      })}
    </div>
  );
}

function isEmptyArgs(args: Record<string, any>): boolean {
  return Object.keys(args || {}).length === 0;
}
