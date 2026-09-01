import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const serverDirectory = path.join(repositoryDirectory, "server");
const serverDist = path.join(serverDirectory, "dist");
const webDist = path.join(repositoryDirectory, "web", "dist");
const runtimeDirectory = path.join(desktopDirectory, "runtime");
const runtimeServer = path.join(runtimeDirectory, "server");

async function requireDirectory(directory, label) {
  const value = await stat(directory).catch(() => undefined);
  if (!value?.isDirectory())
    throw new Error(
      `${label} is missing; build it before copying the desktop runtime`,
    );
}

async function installedVersion(packageDirectory, name) {
  const require = createRequire(path.join(packageDirectory, "package.json"));
  let packageJsonPath;
  try {
    packageJsonPath = require.resolve(`${name}/package.json`);
  } catch {
    packageJsonPath = path.join(
      packageDirectory,
      "node_modules",
      ...name.split("/"),
      "package.json",
    );
  }
  const installed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof installed.version !== "string" || installed.version.length === 0) {
    throw new Error(`Could not resolve installed version for ${name}`);
  }
  return installed.version;
}

async function verifyCopiedWebManifest() {
  const webRuntime = path.join(runtimeDirectory, "web");
  const manifestPath = path.join(webRuntime, ".vite", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("web runtime manifest is missing or invalid");
  }
  const requiredDynamicEntries = [
    "src/components/ChartCard.tsx",
    "src/pages/SourcesView.tsx",
    "src/pages/LibrariesView.tsx",
    "src/pages/AgentsView.tsx",
    "src/pages/AutomationsView.tsx",
    "src/pages/ConnectorsView.tsx",
    "src/pages/ReportsView.tsx",
    "src/pages/SettingsView.tsx",
  ];
  for (const entry of requiredDynamicEntries) {
    if (manifest[entry]?.isDynamicEntry !== true) {
      throw new Error(`web runtime is missing lazy entry ${entry}`);
    }
  }

  const referencedFiles = new Set();
  for (const value of Object.values(manifest)) {
    if (!value || typeof value !== "object")
      throw new Error("web runtime manifest contains an invalid entry");
    for (const candidate of [
      value.file,
      ...(value.css ?? []),
      ...(value.assets ?? []),
    ]) {
      if (typeof candidate !== "string") continue;
      if (
        candidate.includes("\0") ||
        candidate.includes("\\") ||
        path.posix.isAbsolute(candidate) ||
        path.posix.normalize(candidate) !== candidate ||
        candidate.startsWith("../")
      ) {
        throw new Error("web runtime manifest contains an unsafe asset path");
      }
      referencedFiles.add(candidate);
    }
  }
  for (const relative of referencedFiles) {
    if (
      !(
        await stat(path.join(webRuntime, relative)).catch(() => undefined)
      )?.isFile()
    ) {
      throw new Error(`web runtime asset is missing: ${relative}`);
    }
  }
}

await Promise.all([
  requireDirectory(serverDist, "server/dist"),
  requireDirectory(webDist, "web/dist"),
]);
const desktopPackage = JSON.parse(
  await readFile(path.join(desktopDirectory, "package.json"), "utf8"),
);
const serverPackage = JSON.parse(
  await readFile(path.join(serverDirectory, "package.json"), "utf8"),
);
const missingRuntimeDependencies = Object.keys(
  serverPackage.dependencies ?? {},
).filter((name) => !Object.hasOwn(desktopPackage.dependencies ?? {}, name));
if (missingRuntimeDependencies.length > 0) {
  throw new Error(
    `desktop/package.json is missing server runtime dependencies: ${missingRuntimeDependencies.join(", ")}`,
  );
}
const runtimeVersionMismatches = [];
for (const name of Object.keys(serverPackage.dependencies ?? {})) {
  const serverVersion = await installedVersion(serverDirectory, name);
  const desktopVersion = await installedVersion(desktopDirectory, name);
  if (serverVersion !== desktopVersion) {
    runtimeVersionMismatches.push(
      `${name} (server ${serverVersion}, desktop ${desktopVersion})`,
    );
  }
}
if (runtimeVersionMismatches.length > 0) {
  throw new Error(
    `desktop runtime dependency versions do not match pnpm-lock.yaml overrides: ${runtimeVersionMismatches.join(", ")}`,
  );
}
await rm(runtimeDirectory, { recursive: true, force: true });
await mkdir(runtimeServer, { recursive: true });
await Promise.all([
  cp(serverDist, path.join(runtimeServer, "dist"), {
    recursive: true,
    force: true,
  }),
  cp(webDist, path.join(runtimeDirectory, "web"), {
    recursive: true,
    force: true,
  }),
]);
await verifyCopiedWebManifest();
await writeFile(
  path.join(runtimeServer, "package.json"),
  `${JSON.stringify({ name: "borealis-server-runtime", private: true, type: "module" }, null, 2)}\n`,
  "utf8",
);
const backendEntry = path.join(runtimeServer, "dist", "desktopHost.js");
if (!(await stat(backendEntry).catch(() => undefined))?.isFile()) {
  throw new Error(
    "server/dist/desktopHost.js is missing; the desktop IPC host must be built first",
  );
}
const ocrHelper = path.join(
  runtimeServer,
  "dist",
  "data",
  "assets",
  "pdf-ocr.jxa",
);
const ocrHelperContents = await readFile(ocrHelper, "utf8").catch(() => "");
if (
  !ocrHelperContents.includes('ObjC.import("Vision")') ||
  /https?:|fetch\(|curl|XMLHttpRequest/.test(ocrHelperContents)
) {
  throw new Error("the copied desktop runtime OCR helper is missing or unsafe");
}
process.stdout.write("Copied the Borealis server and web runtime.\n");
