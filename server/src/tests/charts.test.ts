import { describe, expect, it } from "vitest";

import {
  ChartSpecError,
  ECHARTS_SOURCE,
  MAX_ABSOLUTE_VALUE,
  MAX_CATEGORIES,
  PALETTE,
  echartsOption,
  normalize,
} from "../data/charts.js";

const VALID_SPEC = {
  type: "bar",
  title: "Monthly spending",
  subtitle: "CAD",
  categories: ["Jan", "Feb"],
  series: [{ name: "Groceries", data: [320, 410] }],
  items: [{ name: "Food", value: 100 }],
  x_label: "Month",
  y_label: "Amount",
};

describe("canonical chart spec", () => {
  it("fills defaults, converts finite numeric strings, assigns colors, and drops extras", () => {
    const normalized = normalize({
      type: "line",
      title: "t",
      categories: ["x"],
      series: [{ name: "A", data: ["1.5"], color: "unsafe", ignored: { private: true } }],
      items: [{ name: "unused", value: "2" }],
      ignored: "value",
    });

    expect(normalized).toEqual({
      type: "line",
      title: "t",
      subtitle: "",
      categories: ["x"],
      series: [{ name: "A", data: [1.5], color: PALETTE[0] }],
      items: [{ name: "unused", value: 2, color: PALETTE[0] }],
      x_label: "",
      y_label: "",
    });
  });

  it("preserves only exact six-digit hex colors", () => {
    const normalized = normalize({
      type: "bar",
      categories: ["x"],
      series: [
        { name: "A", data: [1], color: "#aBc123" },
        { name: "B", data: [2], color: "red" },
      ],
    });
    expect(normalized.series.map((series) => series.color)).toEqual(["#aBc123", PALETTE[1]]);
  });

  it.each([null, [], "not an object", { type: "bogus" }])("rejects unsupported or non-object input", (spec) => {
    expect(() => normalize(spec)).toThrow(ChartSpecError);
  });

  it.each(["line", "bar", "area", "scatter"] as const)("builds the exact %s axis option", (type) => {
    const option = echartsOption({ ...VALID_SPEC, type }) as any;
    expect(option.xAxis).toMatchObject({ type: "category", data: ["Jan", "Feb"], name: "Month" });
    expect(option.yAxis).toMatchObject({ type: "value", name: "Amount" });
    expect(option.series.map((series: any) => series.type)).toEqual([
      type === "scatter" ? "scatter" : type === "bar" ? "bar" : "line",
    ]);
    expect(option.series[0].smooth).toBe(type === "line" || type === "area");
    if (type === "area") expect(option.series[0].areaStyle).toEqual({ opacity: 0.15 });
    if (type === "scatter") expect(option.series[0]).toMatchObject({ symbolSize: 9, symbol: "circle" });
  });

  it.each(["pie", "donut"] as const)("builds the exact %s option", (type) => {
    const option = echartsOption({ ...VALID_SPEC, type }) as any;
    expect(option.series[0]).toMatchObject({
      type: "pie",
      radius: type === "donut" ? ["45%", "72%"] : "72%",
      data: [{ name: "Food", value: 100, itemStyle: { color: PALETTE[0] } }],
    });
  });

  it.each(["abc", Infinity, -Infinity, Number.NaN, null, true, -1, ""])("rejects invalid pie value %s", (value) => {
    expect(() => normalize({ type: "pie", items: [{ name: "x", value }] })).toThrow(ChartSpecError);
  });

  it.each([
    { type: "line", categories: ["x"], series: [] },
    { type: "line", categories: [1], series: [{ name: "A", data: [1] }] },
    { type: "bar", categories: ["x", "y"], series: [{ name: "A", data: [1] }] },
    { type: "scatter", categories: ["x"], series: [{ name: "A", data: [Number.NaN] }] },
    { type: "pie", items: [{ name: "x", value: 0 }] },
  ])("rejects empty, mismatched, or non-finite shapes", (spec) => {
    expect(() => normalize(spec)).toThrow(ChartSpecError);
  });

  it.each(["line", "bar", "area", "scatter"] as const)("accepts the magnitude boundary for %s", (type) => {
    expect(
      normalize({
        type,
        categories: ["boundary"],
        series: [{ name: "positive", data: [MAX_ABSOLUTE_VALUE] }],
      }).series[0].data[0]
    ).toBe(MAX_ABSOLUTE_VALUE);
    expect(
      normalize({
        type,
        categories: ["boundary"],
        series: [{ name: "negative", data: [-MAX_ABSOLUTE_VALUE] }],
      }).series[0].data[0]
    ).toBe(-MAX_ABSOLUTE_VALUE);
  });

  it("rejects values, labels, and collection sizes beyond canonical limits", () => {
    expect(() =>
      normalize({
        type: "line",
        categories: ["x"],
        series: [{ name: "outside", data: [MAX_ABSOLUTE_VALUE + 1] }],
      })
    ).toThrow(/magnitude at most/);
    expect(() =>
      normalize({ type: "line", categories: ["x".repeat(501)], series: [{ name: "A", data: [1] }] })
    ).toThrow(/too long/);
    expect(() =>
      normalize({
        type: "line",
        categories: Array.from({ length: MAX_CATEGORIES + 1 }, () => "x"),
        series: [],
      })
    ).toThrow(/at most 500 categories/);
  });

  it("loads the vendored ECharts 5 bundle", () => {
    expect(ECHARTS_SOURCE.length).toBeGreaterThan(100_000);
    expect(ECHARTS_SOURCE).not.toContain("https://cdn.jsdelivr.net");
  });
});
