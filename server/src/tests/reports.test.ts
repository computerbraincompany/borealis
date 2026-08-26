import { describe, expect, it } from "vitest";

import {
  REPORT_CSP,
  ReportValidationError,
  buildHtml,
  normalizeReport,
  renderMarkdown,
  renderSectionMarkdown,
  renderTables,
} from "../data/reports.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const CHART_SPEC = {
  type: "line",
  title: "Revenue <forecast>",
  categories: ["Jan", "Feb"],
  series: [{ name: "Revenue", data: [1, 2] }],
};

function reportWithChart() {
  return {
    title: "Report",
    subtitle: "",
    generated_at: "2026-08-23 00:00:00 UTC",
    sections: [{ heading: "Summary", markdown: "Body" }],
    charts: [{ id: "chart-1", spec: CHART_SPEC }],
    tables: [],
  };
}

function validReportRequest(): Record<string, unknown> {
  return {
    account_id: "account-1",
    title: "Report",
    subtitle: "Subtitle",
    sections: [{ heading: "Summary", markdown: "Body" }],
    charts: [{ id: "chart-1", spec: CHART_SPEC }],
    tables: [
      {
        columns: ["name", "value"],
        rows: [
          ["rent", 1.5],
          ["active", true],
        ],
      },
    ],
  };
}

describe("report HTML", () => {
  it.each([
    "<script>alert(1)</script>",
    '<a href="jav&#x61;script:alert(1)">x</a>',
    "<img src=x onerror=alert(1)>",
    "<style>@import url(evil)</style>",
    "<svg onload=alert(1)>",
    '<a href="javascript:x">y</a>',
    '<iframe src="https://evil"></iframe>',
  ])("escapes LLM-authored raw HTML: %s", (payload) => {
    const output = renderSectionMarkdown(payload);
    expect(output).toContain("&lt;");
    expect(output).not.toMatch(/<(script|iframe|img|style|svg|a)\b/i);
  });

  it("retains markdown tables, fenced code, headings, bold, and line breaks", () => {
    const output = renderSectionMarkdown("**bold**\n\n# head\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\na < b;\n```");
    expect(output).toContain("<strong>bold</strong>");
    expect(output).toContain("<h1>head</h1>");
    expect(output).toContain("<table>");
    expect(output).toContain("<pre><code>");
    expect(output).not.toContain("a < b");
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
  });

  it("strips markdown images and inline chart tokens", () => {
    const output = renderSectionMarkdown(
      "before ![remote](https://example.invalid/image.png) ![inline](data:image/png;base64,iVBORw0KGgo=) " +
        ":::chart:abc-123::: ![attached](chart:abc-123) after"
    );
    expect(output).not.toContain("<img");
    expect(output).not.toContain("example.invalid");
    expect(output).not.toContain("data:image");
    expect(output).not.toContain("chart:abc-123");
  });

  it("neutralizes disallowed schemes while retaining safe and relative links", () => {
    const output = renderSectionMarkdown(
      "[bad](javascript:alert(1)) [good](https://example.com) [mail](mailto:a@b.c) [relative](docs/x)"
    );
    expect(output).toContain('<a href="#">bad</a>');
    expect(output).toContain('<a href="https://example.com">good</a>');
    expect(output).toContain('<a href="mailto:a@b.c">mail</a>');
    expect(output).toContain('<a href="docs/x">relative</a>');
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,x",
    "vbscript:msgbox(1)",
    "java&#x09;script:alert(1)",
    "java&Tab;script&colon;alert(1)",
    "java&amp;Tab;script&amp;colon;alert(1)",
  ])("neutralizes obfuscated link scheme %s", (href) => {
    expect(renderSectionMarkdown(`[bad](${href})`)).toContain('<a href="#">bad</a>');
  });

  it("does not double-encode allowed href entities", () => {
    const output = renderSectionMarkdown("[query](https://example.com/search?a=1&b=two)");
    expect(output).toContain('href="https://example.com/search?a=1&amp;b=two"');
    expect(output).not.toContain("&amp;amp;");
  });

  it("renders only rectangular tables, escaping values and capping bodies at 60 rows", () => {
    expect(renderTables([{ columns: ["a"], rows: [["x", "y"]] }])).toBe("");
    const rows = Array.from({ length: 61 }, (_, index) => [index === 0 ? null : `<${index}>`]);
    const output = renderTables([{ columns: ["a<b"], rows }]);
    expect(output).toContain("<th>a&lt;b</th>");
    expect(output).toContain("<td></td>");
    expect(output).toContain("&lt;59&gt;");
    expect(output).not.toContain("&lt;60&gt;");
    expect(output.match(/<tr>/g)).toHaveLength(62);
    expect(output).toContain("61 rows");
  });

  it("builds escaped interactive HTML with one CSP and no remote fallback", () => {
    const dangerous = 'Revenue "quoted" & <script>boom</script>';
    const output = buildHtml({
      title: "My <Report>",
      subtitle: "",
      generated_at: '<img src=x onerror="boom"> & now',
      sections: [{ heading: "H", markdown: "Body" }],
      charts: [
        {
          id: 'id" autofocus onfocus="boom',
          spec: {
            type: "bar",
            title: dangerous,
            categories: [dangerous],
            series: [{ name: dangerous, data: [1] }],
          },
        },
      ],
      tables: [],
    });
    expect(output).toContain("My &lt;Report&gt;");
    expect(output).toContain("data-option=");
    expect(output).not.toContain('<img src=x onerror="boom">');
    expect(output).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; now");
    expect(output.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(output).toContain(REPORT_CSP);
    expect(output).not.toContain("jsdelivr");
  });

  it("builds script-free static HTML containing only supplied inline chart PNGs", () => {
    const output = buildHtml(reportWithChart(), {
      static: true,
      chartImages: new Map([["chart-1", PNG_1X1]]),
    });
    expect(output).toContain(`<img src="data:image/png;base64,${PNG_1X1}"`);
    expect(output).toContain('alt="Revenue &lt;forecast&gt;"');
    expect(output).not.toContain("data-option");
    expect(output).not.toContain("<script>");
  });
});

describe("report validation", () => {
  it.each([
    ["title", "x".repeat(201)],
    ["subtitle", "x".repeat(501)],
    ["sections", Array.from({ length: 21 }, () => ({ markdown: "x" }))],
    ["sections", [{ heading: "x".repeat(201), markdown: "body" }]],
    ["sections", [{ markdown: "x".repeat(50_001) }]],
    ["charts", Array.from({ length: 21 }, (_, index) => ({ id: `chart-${index}`, spec: CHART_SPEC }))],
    ["tables", Array.from({ length: 9 }, () => ({ columns: ["x"], rows: [[1]] }))],
    ["tables", [{ columns: Array.from({ length: 33 }, () => "x"), rows: [] }]],
    ["tables", [{ columns: ["x".repeat(201)], rows: [] }]],
    ["tables", [{ columns: ["x"], rows: Array.from({ length: 61 }, () => [1]) }]],
    ["tables", [{ columns: ["x"], rows: [["x".repeat(501)]] }]],
    ["tables", [{ columns: ["x"], rows: [[{ nested: "value" }]] }]],
    ["tables", [{ columns: ["x"], rows: [[Number.NaN]] }]],
    ["tables", [{ columns: ["x", "y"], rows: [[1]] }]],
  ] as const)("rejects nested limit or unsafe cell in %s", (field, value) => {
    const payload = validReportRequest();
    payload[field] = value;
    expect(() => normalizeReport(payload, true)).toThrow(ReportValidationError);
  });

  it("canonicalizes chart specs and drops arbitrary chart-spec extras", () => {
    const payload = validReportRequest();
    payload.charts = [
      {
        id: "chart-1",
        spec: { ...CHART_SPEC, ignored: { deep: [{ secret: "x".repeat(10_000) }] } },
      },
    ];
    const normalized = normalizeReport(payload, true);
    expect(normalized.charts[0].spec).not.toHaveProperty("ignored");
    expect(normalized.charts[0].spec.type).toBe("line");
  });

  it("explicitly preserves Pydantic parity by rejecting unresolved_chart_ids as an extra field", () => {
    const payload = { ...validReportRequest(), unresolved_chart_ids: ["chart-private"] };
    expect(() => normalizeReport(payload, true)).toThrow(ReportValidationError);
  });

  it("requires a valid account only at the facade boundary", () => {
    expect(normalizeReport({ title: "Direct HTML" })).toMatchObject({ title: "Direct HTML" });
    expect(() => normalizeReport({ title: "Facade" }, true)).toThrow(ReportValidationError);
    expect(() => normalizeReport({ account_id: "bad account", title: "Facade" }, true)).toThrow(ReportValidationError);
  });
});
