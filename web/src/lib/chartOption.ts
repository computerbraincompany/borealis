import { CANONICAL_CHART_PALETTE } from "@/lib/chartTheme";

type ChartSpecRecord = Record<string, any>;

/** Mirror python/app/charts.py::echarts_option for legacy chart rows without a stored option. */
export function optionFromCanonicalSpec(spec: ChartSpecRecord): ChartSpecRecord {
  const type = spec.type;
  const title = {
    text: spec.title,
    subtext: spec.subtitle || null,
    left: "center",
    textStyle: { color: "#0F172A", fontSize: 15, fontWeight: 600 },
    subtextStyle: { color: "#64748B", fontSize: 11 },
  };

  if (type === "pie" || type === "donut") {
    const items = Array.isArray(spec.items) ? spec.items : [];
    return {
      title,
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { bottom: 0, textStyle: { color: "#64748B" } },
      series: [
        {
          name: spec.y_label || spec.title || "values",
          type: "pie",
          radius: type === "donut" ? ["45%", "72%"] : "72%",
          center: ["50%", "50%"],
          label: { show: true, formatter: "{b}\n{d}%", color: "#334155" },
          data: items.map((item: ChartSpecRecord, index: number) => ({
            name: item.name,
            value: item.value,
            itemStyle: { color: item.color || CANONICAL_CHART_PALETTE[index % CANONICAL_CHART_PALETTE.length] },
          })),
        },
      ],
    };
  }

  const categories = Array.isArray(spec.categories) ? spec.categories.map(String) : [];
  const inputSeries = Array.isArray(spec.series) ? spec.series : [];
  const series = inputSeries.map((input: ChartSpecRecord) => ({
    name: input.name,
    type: type === "bar" ? "bar" : "line",
    ...(type === "area" ? { areaStyle: { opacity: 0.15 } } : {}),
    data: input.data,
    smooth: type === "line" || type === "area",
  }));
  const normalizedSeries =
    type === "scatter"
      ? series.map((entry: ChartSpecRecord) => ({ ...entry, type: "scatter", symbolSize: 9, symbol: "circle" }))
      : series;

  return {
    title,
    tooltip: { trigger: "axis", valueFormatter: "(x) => x" },
    legend: { top: 0, textStyle: { color: "#64748B" } },
    grid: { left: 60, right: 24, top: 56, bottom: 56, containLabel: true },
    xAxis: {
      type: "category",
      data: categories,
      axisLine: { lineStyle: { color: "#CBD5E1" } },
      axisLabel: { color: "#64748B" },
      name: spec.x_label || null,
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: "#EEF2F7" } },
      axisLabel: { color: "#64748B" },
      name: spec.y_label || null,
    },
    series: normalizedSeries,
    color: inputSeries.map(
      (input: ChartSpecRecord, index: number) =>
        input.color || CANONICAL_CHART_PALETTE[index % CANONICAL_CHART_PALETTE.length],
    ),
  };
}
