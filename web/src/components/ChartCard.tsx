import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart, PieChart, ScatterChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DatasetComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { chartsApi, type ChartPayload } from "@/lib/api";
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

const AURORA_PALETTE = ["#2dd4bf", "#60a5fa", "#a78bfa", "#4ade80", "#fbbf24", "#fb7185", "#7dd3fc", "#f472b6"];

/** Build a valid ECharts option from the canonical chart spec (normally the backend provides this too). */
function optionFromSpec(spec: any): any {
  const color = AURORA_PALETTE;
  const isPie = spec.type === "pie" || spec.type === "donut";
  const series: any[] = isPie
    ? [
        {
          type: "pie",
          radius: spec.type === "donut" ? ["45%", "70%"] : "70%",
          data: (spec.items || []).map((it: any) => ({ name: it.name, value: it.value })),
        },
      ]
    : (spec.series || []).map((s: any) => ({
        name: s.name,
        type: spec.type === "area" ? "line" : spec.type,
        data: s.data,
        smooth: spec.type === "line" || spec.type === "area",
        areaStyle: spec.type === "area" ? { opacity: 0.25 } : undefined,
        symbolSize: spec.type === "scatter" ? 10 : 6,
      }));
  return {
    color,
    title: { text: spec.title, subtext: spec.subtitle, left: "center", textStyle: { color: "#e2e8f0" }, subtextStyle: { color: "#94a3b8" } },
    tooltip: { trigger: isPie ? "item" : "axis" },
    legend: isPie ? { bottom: 0, textStyle: { color: "#94a3b8" } } : { top: "bottom", textStyle: { color: "#94a3b8" } },
    grid: isPie ? {} : { left: 48, right: 24, top: 56, bottom: 56, containLabel: true },
    xAxis: isPie ? undefined : { type: "category", data: spec.categories || [], name: spec.x_label, axisLabel: { color: "#94a3b8" }, axisLine: { lineStyle: { color: "#2a3247" } }, nameTextStyle: { color: "#94a3b8" } },
    yAxis: isPie ? undefined : { type: "value", name: spec.y_label, axisLabel: { color: "#94a3b8" }, splitLine: { lineStyle: { color: "#1c2334" } }, nameTextStyle: { color: "#94a3b8" } },
    series,
  };
}

export function ChartCard({ chartId, className }: { chartId: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<ChartPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    let cancelled = false;
    chartsApi
      .get(chartId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
      })
      .catch((e) => !cancelled && setError(e.message || "Failed to load chart"));
    return () => {
      cancelled = true;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [chartId]);

  useEffect(() => {
    if (!data || !ref.current) return;
    const option = data.echarts ?? (data.spec ? optionFromSpec(data.spec) : null);
    if (!option) return;
    if (!chartRef.current) chartRef.current = echarts.init(ref.current);
    chartRef.current.setOption(option);
    const onResize = () => chartRef.current?.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [data]);

  if (error) {
    return (
      <div className="embedded-chart py-4 text-center text-sm text-muted-foreground">
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

  const title = data.spec?.title || "Chart";
  return (
    <div className={className}>
      <div className="embedded-chart">
        <div className="mb-1 px-2 pt-1 text-[13px] font-semibold text-foreground">{title}</div>
        <div ref={ref} style={{ height: 280 }} className="w-full" />
        {data.png_base64 && (
          <div className="flex items-center justify-end gap-3 px-2 pb-1">
            <a
              className="text-[11px] text-muted-foreground hover:text-aurora-teal"
              title="PNG export (from Python service)"
              href={`data:image/png;base64,${data.png_base64}`}
              download={`${title.replace(/\s+/g, "_")}.png`}
            >
              PNG ↓
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
