import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  }
  return browser;
}

/**
 * Render a fully self-contained HTML string to a PDF buffer using headless
 * Chromium. Waits for embedded ECharts canvases to paint before printing so
 * charts are included pixel-perfect.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 1080, height: 1400 } });
  try {
    await page.setContent(html, { waitUntil: "networkidle", timeout: 30000 });
    // let echarts paint (up to ~10s)
    await page
      .waitForFunction(
        () => document.querySelectorAll(".chart-block").length === 0
          || document.querySelectorAll(".chart-block canvas").length === document.querySelectorAll(".chart-block").length,
        { timeout: 12000 }
      )
      .catch(() => {});
    await page.waitForTimeout(600);
    const buf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
    return Buffer.from(buf);
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
