import { optionFromCanonicalSpec } from "@/lib/chartOption";

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
