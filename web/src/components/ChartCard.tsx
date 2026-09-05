import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import { GridComponent, TooltipComponent, LegendComponent, TitleComponent, DatasetComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { chartsApi, formatApiError, type ChartPayload } from "@/lib/api";
import { readChartThemeTokens, themeChartOption } from "@/lib/chartTheme";
import { optionFromCanonicalSpec, chatChartLayout } from "@/lib/chartOption";
import { useTheme } from "@/components/ThemeProvider";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
  CanvasRenderer,
]);

function ChartCanvas({ data, expanded = false }: { data: ChartPayload; expanded?: boolean }) {
  const { resolvedTheme } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    if (!data || !ref.current) return;
    const baseOption = data.echarts ?? (data.spec ? optionFromCanonicalSpec(data.spec) : null);
    if (!baseOption) return;
    const container = ref.current;
    if (!chartRef.current) chartRef.current = echarts.init(container);
    const render = () => {
      const { option, height } = chatChartLayout(baseOption, container.clientWidth);
      container.style.height = `${expanded ? Math.max(480, height) : height}px`;
      chartRef.current?.resize();
      chartRef.current?.setOption(themeChartOption(option, readChartThemeTokens()), { notMerge: true });
    };
    render();
    const observer = new ResizeObserver(render);
    observer.observe(container);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [data, resolvedTheme, expanded]);

  return <div ref={ref} style={{ height: expanded ? 480 : 280 }} className="w-full min-w-0" />;
}

export function ChartCard({ chartId, className }: { chartId: string; className?: string }) {
  const [data, setData] = useState<ChartPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    chartsApi
      .get(chartId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((error: unknown) => !cancelled && setError(formatApiError(error, "Failed to load chart")));
    return () => {
      cancelled = true;
    };
  }, [chartId]);

  if (error) {
    return (
      <div className="embedded-chart py-4 text-center text-sm text-destructive" role="alert">
        Couldn't load chart: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="embedded-chart space-y-2 py-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }
  // A row without any renderable option (corrupt or legacy payload) must not
  // leave an empty 280px box; say so, matching the gallery card's wording.
  if (!(data.echarts ?? (data.spec ? optionFromCanonicalSpec(data.spec) : null))) {
    return (
      <div className="embedded-chart py-4 text-center text-sm text-muted-foreground" role="status">
        Chart preview unavailable
      </div>
    );
  }

  const title = data.spec?.title || "Chart";
  return (
    <div className={className}>
      <div className="embedded-chart">
        <div className="space-y-1 px-2 pb-2 pt-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 break-words text-[13px] font-semibold text-foreground">{title}</div>
            <Dialog>
              <DialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 px-2"
                  aria-label={`Expand chart: ${title}`}
                >
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" /> Expand
                </Button>
              </DialogTrigger>
              <DialogContent className="flex max-h-[92dvh] w-[calc(100%-2rem)] max-w-6xl flex-col overflow-hidden p-4 sm:p-6">
                <div className="shrink-0 space-y-2 pr-8">
                  <DialogTitle className="break-words leading-snug">{title}</DialogTitle>
                  <DialogDescription>
                    {data.spec?.subtitle ||
                      "Explore the chart. Hover over a value for details; select legend items to show or hide them."}
                  </DialogDescription>
                </div>
                <div className="min-h-0 overflow-y-auto">
                  <ChartCanvas data={data} expanded />
                  {data.spec?.items?.length > 0 && (
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">Chart values</caption>
                      <thead>
                        <tr className="border-b">
                          <th className="p-2">Category</th>
                          <th className="p-2 text-right">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.spec.items.map((item: { name: string; value: number }, index: number) => (
                          <tr key={index} className="border-b">
                            <td className="break-words p-2">{item.name}</td>
                            <td className="p-2 text-right tabular-nums">{item.value.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                {data.png_base64 && (
                  <a
                    className="shrink-0 self-end text-sm text-primary underline"
                    href={`data:image/png;base64,${data.png_base64}`}
                    download={`${title.replace(/\s+/g, "_")}.png`}
                  >
                    Download PNG
                  </a>
                )}
              </DialogContent>
            </Dialog>
          </div>
          {data.spec?.subtitle && <p className="break-words text-xs text-muted-foreground">{data.spec.subtitle}</p>}
          {(data.spec?.x_label || data.spec?.y_label) && (
            <p className="break-words text-xs text-muted-foreground">
              {[data.spec.x_label, data.spec.y_label].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
        <ChartCanvas data={data} />
        {data.png_base64 && (
          <div className="flex items-center justify-end gap-3 px-2 pb-1">
            <a
              className="rounded-sm text-[11px] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Download PNG export"
              href={`data:image/png;base64,${data.png_base64}`}
              download={`${title.replace(/\s+/g, "_")}.png`}
            >
              Download PNG
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
