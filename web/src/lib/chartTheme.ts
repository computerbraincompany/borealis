export const CANONICAL_CHART_PALETTE = [
  "#6366F1",
  "#14B8A6",
  "#F59E0B",
  "#F43F5E",
  "#0EA5E9",
  "#8B5CF6",
  "#10B981",
  "#64748B",
] as const;

export interface ChartThemeTokens {
  text: string;
  mutedText: string;
  grid: string;
  line: string;
  tooltipBackground: string;
  tooltipBorder: string;
  tooltipText: string;
}

type OptionRecord = Record<string, any>;

function cssToken(style: CSSStyleDeclaration, name: string): string {
  const value = style.getPropertyValue(name).trim();
  return `hsl(${value})`;
}

export function readChartThemeTokens(root: Element = document.documentElement): ChartThemeTokens {
  const style = window.getComputedStyle(root);
  return {
    text: cssToken(style, "--chart-text"),
    mutedText: cssToken(style, "--chart-muted"),
    grid: cssToken(style, "--chart-grid"),
    line: cssToken(style, "--chart-line"),
    tooltipBackground: cssToken(style, "--chart-tooltip"),
    tooltipBorder: cssToken(style, "--chart-tooltip-border"),
    tooltipText: cssToken(style, "--chart-tooltip-foreground"),
  };
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => deepClone(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as OptionRecord).map(([key, entry]) => [key, deepClone(entry)]),
    ) as T;
  }
  return value;
}

function mapObjectOrArray(value: unknown, transform: (entry: OptionRecord) => OptionRecord): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (entry && typeof entry === "object" ? transform(entry as OptionRecord) : entry));
  }
  return value && typeof value === "object" ? transform(value as OptionRecord) : value;
}

function themeAxis(axis: OptionRecord, tokens: ChartThemeTokens): OptionRecord {
  return {
    ...axis,
    axisLabel: { ...axis.axisLabel, color: tokens.mutedText },
    nameTextStyle: { ...axis.nameTextStyle, color: tokens.mutedText },
    axisLine: {
      ...axis.axisLine,
      lineStyle: { ...axis.axisLine?.lineStyle, color: tokens.line },
    },
    axisTick: {
      ...axis.axisTick,
      lineStyle: { ...axis.axisTick?.lineStyle, color: tokens.line },
    },
    splitLine: {
      ...axis.splitLine,
      lineStyle: { ...axis.splitLine?.lineStyle, color: tokens.grid },
    },
  };
}

/** Deep-clone an ECharts option and repaint presentation chrome only. */
export function themeChartOption<T>(option: T, tokens: ChartThemeTokens): T {
  const themed = deepClone(option) as OptionRecord;

  themed.backgroundColor = "transparent";
  themed.textStyle = { ...themed.textStyle, color: tokens.text };
  themed.title = mapObjectOrArray(themed.title, (title) => ({
    ...title,
    textStyle: { ...title.textStyle, color: tokens.text },
    subtextStyle: { ...title.subtextStyle, color: tokens.mutedText },
  }));
  themed.legend = mapObjectOrArray(themed.legend, (legend) => ({
    ...legend,
    textStyle: { ...legend.textStyle, color: tokens.mutedText },
  }));
  themed.xAxis = mapObjectOrArray(themed.xAxis, (axis) => themeAxis(axis, tokens));
  themed.yAxis = mapObjectOrArray(themed.yAxis, (axis) => themeAxis(axis, tokens));
  themed.tooltip = mapObjectOrArray(themed.tooltip, (tooltip) => ({
    ...tooltip,
    backgroundColor: tokens.tooltipBackground,
    borderColor: tokens.tooltipBorder,
    textStyle: { ...tooltip.textStyle, color: tokens.tooltipText },
  }));
  themed.series = mapObjectOrArray(themed.series, (series) => {
    if (series.type !== "pie") return series;
    return {
      ...series,
      label: { ...series.label, color: tokens.text },
      labelLine: {
        ...series.labelLine,
        lineStyle: { ...series.labelLine?.lineStyle, color: tokens.line },
      },
      emphasis: {
        ...series.emphasis,
        label: { ...series.emphasis?.label, color: tokens.text },
      },
    };
  });

  return themed as T;
}
