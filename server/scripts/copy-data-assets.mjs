import { copyFileSync, mkdirSync } from "node:fs";

const source = new URL("../src/data/assets/echarts.min.js", import.meta.url);
const destinationDirectory = new URL("../dist/data/assets/", import.meta.url);
const destination = new URL("echarts.min.js", destinationDirectory);

mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);

// Import compiled code after copying so a missing/mispackaged runtime asset
// fails the build instead of surfacing only when a desktop user renders.
const charts = await import(new URL("../dist/data/charts.js", import.meta.url));
if (typeof charts.ECHARTS_SOURCE !== "string" || charts.ECHARTS_SOURCE.length < 100_000) {
  throw new Error("compiled ECharts asset smoke test failed");
}
