import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requestElectronRender: vi.fn() }));

vi.mock("../electronRender.js", () => ({ requestElectronRender: mocks.requestElectronRender }));

import { chartDocument, renderChartPng, renderReportPdf } from "../data/playwrightRender.js";

const CHART_SPEC = {
  type: "bar",
  title: "</script><script>globalThis.pwned=true</script>",
  categories: ["Jan", "Feb"],
  series: [{ name: "Total", data: [2, 4] }],
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let previousRenderBackend: string | undefined;

beforeEach(() => {
  previousRenderBackend = process.env.RENDER_BACKEND;
  process.env.RENDER_BACKEND = "electron";
  mocks.requestElectronRender.mockReset();
});

afterEach(() => {
  if (previousRenderBackend === undefined) delete process.env.RENDER_BACKEND;
  else process.env.RENDER_BACKEND = previousRenderBackend;
});

describe("Playwright renderer Electron dispatch", () => {
  it("normalizes chart input and dispatches only the bounded self-contained chart document", async () => {
    const png = Buffer.concat([PNG_SIGNATURE, Buffer.from("chart")]);
    mocks.requestElectronRender.mockResolvedValueOnce(png);

    await expect(renderChartPng(CHART_SPEC)).resolves.toBe(png);
    expect(mocks.requestElectronRender).toHaveBeenCalledOnce();
    const [kind, html, signal] = mocks.requestElectronRender.mock.calls[0] as [string, string, AbortSignal?];
    expect(kind).toBe("png");
    expect(signal).toBeUndefined();
    expect(html).toBe(chartDocument(CHART_SPEC as never));
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("</script><script>globalThis.pwned=true</script>");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });

  it("renders report charts first and embeds only their returned PNG bytes in the final PDF HTML", async () => {
    const firstPng = Buffer.concat([PNG_SIGNATURE, Buffer.from("first-chart")]);
    const secondPng = Buffer.concat([PNG_SIGNATURE, Buffer.from("second-chart")]);
    const pdf = Buffer.from("%PDF-1.7 desktop");
    mocks.requestElectronRender
      .mockResolvedValueOnce(firstPng)
      .mockResolvedValueOnce(secondPng)
      .mockResolvedValueOnce(pdf);

    await expect(
      renderReportPdf({
        account_id: "account-1",
        title: "Desktop report",
        sections: [{ heading: "Summary", markdown: "No remote content. ![x](https://example.invalid/x.png)" }],
        charts: [
          { id: "chart-1", spec: { ...CHART_SPEC, title: "First" } },
          { id: "chart-2", spec: { ...CHART_SPEC, title: "Second" } },
        ],
        tables: [],
      })
    ).resolves.toBe(pdf);

    expect(mocks.requestElectronRender).toHaveBeenCalledTimes(3);
    expect(mocks.requestElectronRender.mock.calls.map((call) => call[0])).toEqual(["png", "png", "pdf"]);
    const finalHtml = mocks.requestElectronRender.mock.calls[2]?.[1] as string;
    expect(finalHtml).toContain(`data:image/png;base64,${firstPng.toString("base64")}`);
    expect(finalHtml).toContain(`data:image/png;base64,${secondPng.toString("base64")}`);
    expect(finalHtml).not.toContain("https://example.invalid");
    expect(finalHtml).not.toMatch(/<script[\s>]/i);
  });

  it("forwards one AbortSignal to every desktop request and stops before the PDF after cancellation", async () => {
    const controller = new AbortController();
    mocks.requestElectronRender.mockImplementationOnce(async (_kind, _html, signal: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return PNG_SIGNATURE;
    });

    await expect(
      renderReportPdf(
        {
          account_id: "account-1",
          title: "Cancelled",
          sections: [],
          charts: [{ id: "chart-1", spec: { ...CHART_SPEC, title: "Chart" } }],
          tables: [],
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.requestElectronRender).toHaveBeenCalledOnce();
  });

  it("rejects invalid chart/report input before sending anything to Electron", async () => {
    expect(() => renderChartPng({ type: "unknown" })).toThrow();
    expect(() => renderReportPdf({ charts: "not-an-array" })).toThrow();
    expect(mocks.requestElectronRender).not.toHaveBeenCalled();
  });
});
