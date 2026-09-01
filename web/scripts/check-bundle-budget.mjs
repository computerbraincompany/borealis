import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const webDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(webDirectory, "dist");
const manifestPath = path.join(distDirectory, ".vite", "manifest.json");

// Measured after the route/chart split on 2026-08-31. These leave bounded
// headroom while making an accidental eager route or ECharts import fail CI.
const MAX_INITIAL_JS_GZIP_BYTES = 240 * 1024;
const MAX_NON_INITIAL_CHUNK_GZIP_BYTES = 130 * 1024;
const REQUIRED_DYNAMIC_ENTRIES = [
  "src/components/ChartCard.tsx",
  "src/pages/SourcesView.tsx",
  "src/pages/LibrariesView.tsx",
  "src/pages/AgentsView.tsx",
  "src/pages/AutomationsView.tsx",
  "src/pages/ConnectorsView.tsx",
  "src/pages/ReportsView.tsx",
  "src/pages/SettingsView.tsx",
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  fail("Bundle manifest is missing or invalid; run the web production build first.");
}

const entries = Object.entries(manifest);
const entry = entries.find(([, value]) => value?.isEntry === true);
if (!entry) fail("Bundle manifest has no production entry.");

for (const source of REQUIRED_DYNAMIC_ENTRIES) {
  const value = manifest[source];
  if (!value || value.isDynamicEntry !== true || typeof value.file !== "string") {
    fail(`Required lazy entry is missing: ${source}`);
  }
}

function collectImports(key, collected) {
  if (collected.has(key)) return;
  const value = manifest[key];
  if (!value || typeof value.file !== "string") fail(`Manifest import is invalid: ${key}`);
  collected.add(key);
  for (const dependency of value.imports ?? []) collectImports(dependency, collected);
}

const initialKeys = new Set();
collectImports(entry[0], initialKeys);
for (const source of REQUIRED_DYNAMIC_ENTRIES) {
  if (initialKeys.has(source)) fail(`Lazy entry leaked into the initial graph: ${source}`);
}
for (const key of initialKeys) {
  const name = manifest[key]?.name;
  if (name === "echarts" || name === "zrender") fail(`Chart runtime leaked into the initial graph: ${name}`);
}

const sizes = new Map();
for (const [, value] of entries) {
  if (typeof value?.file !== "string" || !value.file.endsWith(".js") || sizes.has(value.file)) continue;
  let contents;
  try {
    contents = readFileSync(path.join(distDirectory, value.file));
  } catch {
    fail(`Manifest JavaScript file is missing: ${value.file}`);
  }
  sizes.set(value.file, gzipSync(contents, { level: 9 }).byteLength);
}

const initialFiles = [...initialKeys].map((key) => manifest[key].file).filter((file) => file.endsWith(".js"));
const initialBytes = [...new Set(initialFiles)].reduce((total, file) => total + (sizes.get(file) ?? 0), 0);
if (initialBytes > MAX_INITIAL_JS_GZIP_BYTES) {
  fail(`Initial JavaScript gzip budget exceeded: ${initialBytes} > ${MAX_INITIAL_JS_GZIP_BYTES} bytes`);
}

const nonInitial = [...sizes].filter(([file]) => !initialFiles.includes(file));
const largest = nonInitial.sort((left, right) => right[1] - left[1])[0];
if (!largest) fail("Bundle has no lazy JavaScript chunk.");
if (largest[1] > MAX_NON_INITIAL_CHUNK_GZIP_BYTES) {
  fail(`Lazy JavaScript gzip budget exceeded: ${largest[0]} is ${largest[1]} bytes`);
}

process.stdout.write(
  `Bundle budgets pass: initial JS ${initialBytes}/${MAX_INITIAL_JS_GZIP_BYTES} bytes; largest lazy chunk ${largest[0]} ${largest[1]}/${MAX_NON_INITIAL_CHUNK_GZIP_BYTES} bytes.\n`,
);
