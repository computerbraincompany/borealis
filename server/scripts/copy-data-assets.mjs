import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const source = new URL("../src/data/assets/echarts.min.js", import.meta.url);
const ocrSource = new URL("../src/data/assets/pdf-ocr.jxa", import.meta.url);
const destinationDirectory = new URL("../dist/data/assets/", import.meta.url);
const destination = new URL("echarts.min.js", destinationDirectory);
const ocrDestination = new URL("pdf-ocr.jxa", destinationDirectory);

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
copyFileSync(ocrSource, ocrDestination);
const ocrHelper = readFileSync(ocrDestination, "utf8");
if (!ocrHelper.includes('ObjC.import("Vision")') || /https?:|fetch\(|curl|XMLHttpRequest/.test(ocrHelper)) {
  throw new Error("compiled local OCR helper failed its offline asset policy");
}

// Import compiled code after copying so a missing/mispackaged runtime asset
// fails the build instead of surfacing only when a desktop user renders.
const charts = await import(new URL("../dist/data/charts.js", import.meta.url));
if (typeof charts.ECHARTS_SOURCE !== "string" || charts.ECHARTS_SOURCE.length < 100_000) {
  throw new Error("compiled ECharts asset smoke test failed");
}
