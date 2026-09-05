import { optionFromCanonicalSpec, chatChartLayout } from "@/lib/chartOption";

const seriesSpec = (type: string) => ({
  type,
  title: "Trend",
  subtitle: "Monthly",
  categories: ["Jan"],
  series: [{ name: "Total", data: [10] }],
  items: [],
  x_label: "Month",
  y_label: "Amount",
});

describe("canonical chart fallback", () => {
  it("matches the canonical donut and pie geometry", () => {
    const donut = optionFromCanonicalSpec({
      ...seriesSpec("donut"),
      series: [],
      items: [{ name: "Food", value: 10 }],
    });
    const pie = optionFromCanonicalSpec({ ...seriesSpec("pie"), series: [], items: [{ name: "Food", value: 10 }] });

    expect(donut.series[0]).toMatchObject({
      radius: ["45%", "72%"],
      center: ["50%", "50%"],
      label: { show: true, formatter: "{b}\n{d}%" },
    });
    expect(pie.series[0].radius).toBe("72%");
  });

  it("matches the canonical area and scatter series constants", () => {
    const area = optionFromCanonicalSpec(seriesSpec("area"));
    const scatter = optionFromCanonicalSpec(seriesSpec("scatter"));

    expect(area.series[0]).toMatchObject({ type: "line", areaStyle: { opacity: 0.15 }, smooth: true });
    expect(scatter.series[0]).toMatchObject({
      type: "scatter",
      symbolSize: 9,
      symbol: "circle",
      smooth: false,
    });
    expect(scatter.grid.left).toBe(60);
  });
});

describe("chat chart layout", () => {
  it("separates headings and fits long category bars without changing the saved option", () => {
    const base = optionFromCanonicalSpec({ ...seriesSpec("bar"), categories: ["A very long payee name"] });
    const { option, height } = chatChartLayout(base, 360);
    expect(option.title.show).toBe(false);
    expect(option.legend.show).toBe(false);
    expect(option.xAxis.type).toBe("value");
    expect(option.yAxis).toMatchObject({ type: "category", inverse: true, name: "", axisLabel: { interval: 0 } });
    expect(option.yAxis.axisLabel.width).toBeLessThan(150);
    expect(base.xAxis.type).toBe("category");
    expect(base.title.text).toBe("Trend");
    expect(height).toBeGreaterThanOrEqual(280);
  });

  it("reserves legend space and keeps dense timelines in their original order", () => {
    const base = optionFromCanonicalSpec({
      ...seriesSpec("line"),
      series: [
        { name: "A", data: [1] },
        { name: "B", data: [2] },
      ],
    });
    const { option } = chatChartLayout(base, 360);
    expect(option.legend).toMatchObject({ show: true, type: "scroll" });
    expect(option.grid.top).toBe(44);
    expect(option.xAxis.type).toBe("category");
    expect(option.xAxis.axisLabel.hideOverlap).toBe(true);
  });
});
