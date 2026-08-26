import { describe, expect, it } from "vitest";

import {
  __renderIsolatedHtmlPdfForTests,
  CHART_VIEWPORT,
  isAllowedRenderUrl,
  renderChartPng,
  renderReportPdf,
  type RenderRouteEvent,
} from "../data/playwrightRender.js";

const CHART_SPEC = {
  type: "bar",
  title: "Monthly spending",
  subtitle: "CAD",
  categories: ["Jan", "Feb"],
  series: [
    { name: "Groceries", data: [320, 410] },
    { name: "Rent", data: [1_200, 1_200] },
  ],
  x_label: "Month",
  y_label: "Amount",
};

describe("isolated Playwright rendering", () => {
  it("renders an exact 1330x728 valid PNG without external requests", async () => {
    const routes: RenderRouteEvent[] = [];
    const png = await renderChartPng(CHART_SPEC, undefined, { onRoute: (event) => routes.push(event) });

    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(CHART_VIEWPORT.width);
    expect(png.readUInt32BE(20)).toBe(CHART_VIEWPORT.height);
    expect(routes.filter((event) => !event.allowed)).toEqual([]);
  }, 30_000);

  it("renders a real PDF, including static inline chart images", async () => {
    const routes: RenderRouteEvent[] = [];
    const pdf = await renderReportPdf(
      {
        account_id: "account-1",
        title: "PDF smoke",
        subtitle: "",
        generated_at: "2026-08-23 00:00:00 UTC",
        sections: [{ heading: "Summary", markdown: "A **rendered** report." }],
        charts: [{ id: "chart-1", spec: CHART_SPEC }],
        tables: [{ columns: ["value"], rows: [["safe"]] }],
      },
      undefined,
      { onRoute: (event) => routes.push(event) }
    );

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(10_000);
    expect(routes.every((event) => event.allowed || !/^https?:|^file:/i.test(event.url))).toBe(true);
  }, 30_000);

  it("denies every resource URL except exact about:blank and inline PNGs", () => {
    expect(isAllowedRenderUrl("about:blank")).toBe(true);
    expect(isAllowedRenderUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAllowedRenderUrl("https://example.invalid/private.png")).toBe(false);
    expect(isAllowedRenderUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isAllowedRenderUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedRenderUrl("ftp://example.invalid/file")).toBe(false);
    expect(isAllowedRenderUrl("data:text/plain;base64,SGVsbG8=")).toBe(false);
    expect(isAllowedRenderUrl("blob:https://example.invalid/id")).toBe(false);
  });

  it("intercepts HTTP resources and never permits file resources from raw HTML", async () => {
    const routes: RenderRouteEvent[] = [];
    const pdf = await __renderIsolatedHtmlPdfForTests(
      `<html><body>
        <img src="https://example.invalid/private.png">
        <img src="http://169.254.169.254/latest/meta-data/">
        <img src="file:///etc/passwd">
      </body></html>`,
      undefined,
      { onRoute: (event) => routes.push(event) }
    );

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(routes).toEqual(
      expect.arrayContaining([
        { url: "https://example.invalid/private.png", allowed: false },
        { url: "http://169.254.169.254/latest/meta-data/", allowed: false },
      ])
    );
    expect(routes.some((event) => event.allowed && /^(https?:|file:)/i.test(event.url))).toBe(false);
  }, 30_000);

  it("strips markdown-origin images before Chromium sees the static report", async () => {
    const routes: RenderRouteEvent[] = [];
    const pdf = await renderReportPdf(
      {
        account_id: "account-1",
        title: "No egress",
        sections: [
          {
            heading: "Untrusted",
            markdown:
              "![local](file:///etc/passwd) ![remote](http://169.254.169.254/latest/meta-data/) " +
              "![inline](data:image/png;base64,iVBORw0KGgo=)",
          },
        ],
        charts: [],
        tables: [],
      },
      undefined,
      { onRoute: (event) => routes.push(event) }
    );

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(routes).toEqual([]);
  }, 30_000);

  it("closes Chromium and preserves AbortError cancellation", async () => {
    const controller = new AbortController();
    const pending = renderChartPng(CHART_SPEC, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  }, 30_000);
});
