const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const desktopDirectory = path.join(__dirname, "..");
const backendEntry = path.join(
  desktopDirectory,
  "runtime",
  "server",
  "dist",
  "desktopHost.js",
);
const desktopRequire = createRequire(
  existsSync(backendEntry)
    ? backendEntry
    : path.join(desktopDirectory, "package.json"),
);
const loaded = ["better-sqlite3", "@lancedb/lancedb", "@duckdb/node-api"].map(
  (name) => {
    desktopRequire(name);
    return name;
  },
);
process.parentPort.postMessage({
  ok: true,
  process: "utility",
  native: loaded,
  from: existsSync(backendEntry) ? "desktopHost" : "package",
});
