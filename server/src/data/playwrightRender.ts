import type { Browser, BrowserContext, Page, Route } from "playwright";

import { ECHARTS_SOURCE, echartsOption, normalize, type CanonicalChartSpec } from "./charts.js";
import { buildHtml, normalizeReport, type NormalizedReport } from "./reports.js";
import { requestElectronRender } from "../electronRender.js";

export const CHART_VIEWPORT = { width: 1330, height: 728 } as const;
const MAX_EMBEDDED_RESOURCE_URL_BYTES = 8 * 1024 * 1024;

export interface RenderRouteEvent {
  url: string;
  allowed: boolean;
}

export interface RenderHooks {
  onRoute?: (event: RenderRouteEvent) => void;
}

function abortError(): Error {
  const error = new Error("operation cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export function isAllowedRenderUrl(url: string): boolean {
  if (url === "about:blank") return true;
  if (Buffer.byteLength(url, "utf8") > MAX_EMBEDDED_RESOURCE_URL_BYTES) return false;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/i.test(url);
}

async function routeResource(route: Route, hooks?: RenderHooks): Promise<void> {
  const url = route.request().url();
  const allowed = isAllowedRenderUrl(url);
  hooks?.onRoute?.({ url, allowed });
  if (allowed) await route.continue();
  else await route.abort("blockedbyclient");
}

async function isolatedPage<T>(
  signal: AbortSignal | undefined,
  hooks: RenderHooks | undefined,
  operation: (page: Page, context: BrowserContext) => Promise<T>
): Promise<T> {
  throwIfAborted(signal);
  let browser: Browser | undefined;
  const onAbort = () => {
    if (browser) void browser.close().catch(() => {});
  };
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    throwIfAborted(signal);
    const context = await browser.newContext({
      acceptDownloads: false,
      deviceScaleFactor: 1,
      javaScriptEnabled: true,
      offline: true,
      serviceWorkers: "block",
      viewport: CHART_VIEWPORT,
    });
    await context.route("**/*", (route) => routeResource(route, hooks));
    await context.routeWebSocket("**/*", (socket) => {
      hooks?.onRoute?.({ url: socket.url(), allowed: false });
      socket.close();
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.dismiss());
    const result = await operation(page, context);
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await browser?.close().catch(() => {});
  }
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function chartDocument(spec: CanonicalChartSpec): string {
  const option = { ...echartsOption(spec), animation: false };
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body,#chart{width:100%;height:100%;margin:0;background:#fff;overflow:hidden}</style>
<script>${ECHARTS_SOURCE}</script></head>
<body><div id="chart"></div><script>
window.__borealisChartReady = false;
var chart = echarts.init(document.getElementById('chart'), null, {renderer:'canvas'});
chart.setOption(${scriptJson(option)});
requestAnimationFrame(function(){requestAnimationFrame(function(){window.__borealisChartReady = true;});});
</script></body></html>`;
}

async function renderChartOnPage(page: Page, specValue: unknown): Promise<Buffer> {
  const spec = normalize(specValue);
  await page.setViewportSize(CHART_VIEWPORT);
  await page.setContent(chartDocument(spec), { waitUntil: "load" });
  await page.waitForFunction(() => (globalThis as { __borealisChartReady?: boolean }).__borealisChartReady === true);
  const png = await page.screenshot({ type: "png", fullPage: false });
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("chart rendering failed");
  }
  return png;
}

export function renderChartPng(specValue: unknown, signal?: AbortSignal, hooks?: RenderHooks): Promise<Buffer> {
  const spec = normalize(specValue);
  if (process.env.RENDER_BACKEND === "electron") {
    return requestElectronRender("png", chartDocument(spec), signal).then(validatePng);
  }
  return isolatedPage(signal, hooks, (page) => renderChartOnPage(page, spec));
}

async function pdfFromPage(page: Page, html: string): Promise<Buffer> {
  await page.setContent(html, { waitUntil: "load" });
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" },
  });
  if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("report PDF rendering failed");
  return pdf;
}

export function renderReportPdf(reportValue: unknown, signal?: AbortSignal, hooks?: RenderHooks): Promise<Buffer> {
  const report = normalizeReport(reportValue, true);
  if (process.env.RENDER_BACKEND === "electron") return renderReportPdfWithElectron(report, signal);
  return isolatedPage(signal, hooks, async (page) => {
    const chartImages = new Map<string, string>();
    for (const chart of report.charts) {
      throwIfAborted(signal);
      chartImages.set(chart.id, (await renderChartOnPage(page, chart.spec)).toString("base64"));
    }
    const staticHtml = buildHtml(report, { static: true, chartImages });
    return pdfFromPage(page, staticHtml);
  });
}

async function renderReportPdfWithElectron(report: NormalizedReport, signal?: AbortSignal): Promise<Buffer> {
  const chartImages = new Map<string, string>();
  for (const chart of report.charts) {
    throwIfAborted(signal);
    chartImages.set(
      chart.id,
      validatePng(await requestElectronRender("png", chartDocument(chart.spec), signal)).toString("base64")
    );
  }
  throwIfAborted(signal);
  return validatePdf(await requestElectronRender("pdf", buildHtml(report, { static: true, chartImages }), signal));
}

function validatePng(value: Buffer): Buffer {
  if (!value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("chart rendering failed");
  }
  return value;
}

function validatePdf(value: Buffer): Buffer {
  if (!value.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("report PDF rendering failed");
  return value;
}

/** Test-only raw HTML entry point; production renders only validated reports. */
export function __renderIsolatedHtmlPdfForTests(
  html: string,
  signal?: AbortSignal,
  hooks?: RenderHooks
): Promise<Buffer> {
  if (process.env.NODE_ENV !== "test") throw new Error("test-only renderer");
  return isolatedPage(signal, hooks, (page) => pdfFromPage(page, html));
}

export type { NormalizedReport };
