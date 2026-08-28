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
process.stdout.write("Copied the Borealis server and web runtime.\n");
