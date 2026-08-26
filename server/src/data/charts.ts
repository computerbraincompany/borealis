/**
 * Canonical chart contract shared by the agent, stored chart rows, the web UI,
 * interactive reports, and Playwright PNG/PDF rendering.
 *
 * {
 *   type: "line" | "bar" | "area" | "pie" | "donut" | "scatter",
 *   title: string,
 *   subtitle: string,
 *   categories: string[],
 *   series: Array<{ name: string, data: number[], color: "#RRGGBB" }>,
 *   items: Array<{ name: string, value: number, color: "#RRGGBB" }>,
 *   x_label: string,
 *   y_label: string,
 * }
 */
import { readFileSync } from "node:fs";

export const BRAND = {
  indigo: "#6366F1",
  teal: "#14B8A6",
  amber: "#F59E0B",
  rose: "#F43F5E",
  sky: "#0EA5E9",
  violet: "#8B5CF6",
  slate: "#64748B",
  emerald: "#10B981",
} as const;

export const PALETTE = [
  BRAND.indigo,
  BRAND.teal,
  BRAND.amber,
  BRAND.rose,
  BRAND.sky,
  BRAND.violet,
  BRAND.emerald,
  BRAND.slate,
] as const;

export const SUPPORTED_CHART_TYPES = ["line", "bar", "area", "pie", "donut", "scatter"] as const;
export type ChartType = (typeof SUPPORTED_CHART_TYPES)[number];

export const MAX_CATEGORIES = 500;
export const MAX_SERIES = 20;
export const MAX_PIE_ITEMS = 100;
export const MAX_LABEL_LENGTH = 500;
export const MAX_ABSOLUTE_VALUE = 1e15;

const SUPPORTED = new Set<string>(SUPPORTED_CHART_TYPES);
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface CanonicalChartSeries {
  name: string;
  data: number[];
  color: string;
}

export interface CanonicalChartItem {
  name: string;
  value: number;
  color: string;
}

export interface CanonicalChartSpec {
  type: ChartType;
  title: string;
  subtitle: string;
  categories: string[];
  series: CanonicalChartSeries[];
  items: CanonicalChartItem[];
  x_label: string;
  y_label: string;
}

export type EChartsOption = Record<string, unknown>;

export class ChartSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartSpecError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string, allowEmpty = true): string {
  if (typeof value !== "string") throw new ChartSpecError(`${field} must be a string`);
  if (value.length > MAX_LABEL_LENGTH) throw new ChartSpecError(`${field} is too long`);
  if (!allowEmpty && !value.trim()) throw new ChartSpecError(`${field} must not be empty`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value === "boolean" || value === null || (typeof value !== "number" && typeof value !== "string")) {
    throw new ChartSpecError(`${field} must be a finite number`);
  }
  if (typeof value === "string" && !value.trim()) throw new ChartSpecError(`${field} must be a finite number`);
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > MAX_ABSOLUTE_VALUE) {
    throw new ChartSpecError(
      `${field} must be a finite number with magnitude at most ${MAX_ABSOLUTE_VALUE.toExponential().replace("e+", "e")}`
    );
  }
  return number;
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : fallback;
}

export function normalize(specValue: unknown): CanonicalChartSpec {
  if (!isRecord(specValue)) throw new ChartSpecError("chart spec must be an object");
  const chartType = specValue.type;
  if (typeof chartType !== "string" || !SUPPORTED.has(chartType)) {
    throw new ChartSpecError(
      `unsupported chart type ${JSON.stringify(chartType)}; use one of ${JSON.stringify([...SUPPORTED_CHART_TYPES].sort())}`
    );
  }
  const type = chartType as ChartType;
  const title = text(specValue.title ?? "", "title");
  const subtitle = text(specValue.subtitle ?? "", "subtitle");
  const xLabel = text(specValue.x_label ?? "", "x_label");
  const yLabel = text(specValue.y_label ?? "", "y_label");
  const categoriesValue = specValue.categories ?? [];
  const seriesValue = specValue.series ?? [];
  const itemsValue = specValue.items ?? [];
  if (!Array.isArray(categoriesValue)) throw new ChartSpecError("categories must be an array");
  if (!Array.isArray(seriesValue)) throw new ChartSpecError("series must be an array");
  if (!Array.isArray(itemsValue)) throw new ChartSpecError("items must be an array");
  if (categoriesValue.length > MAX_CATEGORIES) {
    throw new ChartSpecError(`charts support at most ${MAX_CATEGORIES} categories`);
  }
  if (seriesValue.length > MAX_SERIES) throw new ChartSpecError(`charts support at most ${MAX_SERIES} series`);
  if (itemsValue.length > MAX_PIE_ITEMS) {
    throw new ChartSpecError(`charts support at most ${MAX_PIE_ITEMS} pie items`);
  }

  const categories = categoriesValue.map((value, index) => text(value, `categories[${index}]`));
  const series = seriesValue.map((candidate, index): CanonicalChartSeries => {
    if (!isRecord(candidate)) throw new ChartSpecError(`series[${index}] must be an object`);
    const name = text(candidate.name ?? "", `series[${index}].name`, false);
    if (!Array.isArray(candidate.data)) throw new ChartSpecError(`series[${index}].data must be an array`);
    if (candidate.data.length !== categories.length) {
      throw new ChartSpecError(`series[${index}].data must match categories length`);
    }
    return {
      name,
      data: candidate.data.map((value, dataIndex) => finiteNumber(value, `series[${index}].data[${dataIndex}]`)),
      color: safeColor(candidate.color, PALETTE[index % PALETTE.length]),
    };
  });

  const items = itemsValue.map((candidate, index): CanonicalChartItem => {
    if (!isRecord(candidate)) throw new ChartSpecError(`items[${index}] must be an object`);
    const value = finiteNumber(candidate.value, `items[${index}].value`);
    if (value < 0) throw new ChartSpecError(`items[${index}].value must not be negative`);
    return {
      name: text(candidate.name ?? "", `items[${index}].name`, false),
      value,
      color: safeColor(candidate.color, PALETTE[index % PALETTE.length]),
    };
  });

  if (type === "pie" || type === "donut") {
    const total = items.reduce((sum, item) => sum + item.value, 0);
    if (!items.length || !Number.isFinite(total) || total <= 0) {
      throw new ChartSpecError("pie and donut charts require at least one positive item");
    }
  } else if (!categories.length || !series.length) {
    throw new ChartSpecError(`${type} charts require categories and series`);
  }

  return {
    type,
    title,
    subtitle,
    categories,
    series,
    items,
    x_label: xLabel,
    y_label: yLabel,
  };
}

export function echartsOption(specValue: unknown): EChartsOption {
  const spec = normalize(specValue);
  const title = {
    text: spec.title,
    subtext: spec.subtitle || null,
    left: "center",
    textStyle: { color: "#0F172A", fontSize: 15, fontWeight: 600 },
    subtextStyle: { color: "#64748B", fontSize: 11 },
  };

  if (spec.type === "pie" || spec.type === "donut") {
    return {
      title,
      tooltip: { trigger: "item", formatter: "{b}: {c} ({d}%)" },
      legend: { bottom: 0, textStyle: { color: "#64748B" } },
      series: [
        {
          name: spec.y_label || spec.title || "values",
          type: "pie",
          radius: spec.type === "donut" ? ["45%", "72%"] : "72%",
          center: ["50%", "50%"],
          label: { show: true, formatter: "{b}\n{d}%", color: "#334155" },
          data: spec.items.map((item) => ({
            name: item.name,
            value: item.value,
            itemStyle: { color: item.color },
          })),
        },
      ],
    };
  }

  const series = spec.series.map((entry) => ({
    name: entry.name,
    type: spec.type === "bar" ? "bar" : "line",
    ...(spec.type === "area" ? { areaStyle: { opacity: 0.15 } } : {}),
    data: entry.data,
    smooth: spec.type === "line" || spec.type === "area",
  }));
  return {
    title,
    tooltip: { trigger: "axis", valueFormatter: "(x) => x" },
    legend: { top: 0, textStyle: { color: "#64748B" } },
    grid: { left: 60, right: 24, top: 56, bottom: 56, containLabel: true },
    xAxis: {
      type: "category",
      data: spec.categories.map(String),
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
    series:
      spec.type === "scatter"
        ? series.map((entry) => ({ ...entry, type: "scatter", symbolSize: 9, symbol: "circle" }))
        : series,
    color: spec.series.map((entry) => entry.color),
  };
}

/** Vendored ECharts 5 bundle used by both report HTML and isolated Chromium. */
export const ECHARTS_SOURCE = readFileSync(new URL("./assets/echarts.min.js", import.meta.url), "utf8");
