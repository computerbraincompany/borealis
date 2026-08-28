import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryDirectory = path.resolve(desktopDirectory, "..");
const nativePackages = [
  "better-sqlite3",
  "@lancedb/lancedb",
  "@duckdb/node-api",
];

function packageDestination(name) {
  return path.join(desktopDirectory, "node_modules", ...name.split("/"));
}

function readPackage(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

function replaceWithCopy(destination, source) {
  if (existsSync(destination) && !lstatSync(destination).isSymbolicLink()) {
    return;
  }
  const temporary = `${destination}.borealis-isolate`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, temporary, { recursive: true, dereference: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(temporary, destination);
}

function isolateScope(destinationScope, sourceScope, visited) {
  const realSourceScope = realpathSync(sourceScope);
  if (visited.has(realSourceScope)) return;
  visited.add(realSourceScope);
  mkdirSync(destinationScope, { recursive: true });
  for (const entry of readdirSync(realSourceScope)) {
    const source = path.join(realSourceScope, entry);
    const destination = path.join(destinationScope, entry);
    const realSource = realpathSync(source);
    replaceWithCopy(destination, realSource);
    const nestedScope = path.dirname(realSource);
    if (nestedScope !== realSourceScope) {
      isolateScope(destinationScope, nestedScope, visited);
    }
  }
}

function pnpmVirtualModules(name, version) {
  const store = path.join(repositoryDirectory, "node_modules", ".pnpm");
  if (!existsSync(store)) return undefined;
  const encoded = name.replace("/", "+");
  const prefix = `${encoded}@${version}`;
  const matches = readdirSync(store)
    .filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`))
    .sort((left, right) => left.length - right.length);
  if (matches.length === 0) return undefined;
  return path.join(store, matches[0], "node_modules");
}

function virtualModulesForPackage(name, packageDirectory) {
  const pkg = readPackage(packageDirectory);
  const fromStore = pnpmVirtualModules(name, pkg.version);
  if (fromStore && existsSync(fromStore)) return fromStore;
  let directory = packageDirectory;
  for (const _segment of name.split("/")) {
    directory = path.dirname(directory);
  }
  if (path.basename(directory) === "node_modules" && existsSync(directory)) {
    return directory;
  }
  throw new Error(
    `Could not locate pnpm virtual-store modules for ${name}@${pkg.version}`,
  );
}

function isInsidePnpmStore(absolutePath) {
  return absolutePath.split(path.sep).includes(".pnpm");
}

function isolatedDesktopCopy(name) {
  const destination = packageDestination(name);
  if (!existsSync(destination)) return undefined;
  const realDestination = realpathSync(destination);
  if (isInsidePnpmStore(realDestination)) return undefined;
  return destination;
}

function nestDependency(parentDirectory, name, source, visited) {
  const destination = path.join(
    parentDirectory,
    "node_modules",
    ...name.split("/"),
  );
  const isolated = isolatedDesktopCopy(name);
  if (isolated) {
    mkdirSync(path.dirname(destination), { recursive: true });
    if (existsSync(destination))
      rmSync(destination, { recursive: true, force: true });
    symlinkSync(
      path.relative(path.dirname(destination), isolated),
      destination,
    );
    return;
  }
  const realSource = realpathSync(source);
  if (visited.has(realSource)) {
    if (!existsSync(destination)) replaceWithCopy(destination, realSource);
    return;
  }
  visited.add(realSource);
  replaceWithCopy(destination, realSource);
  nestProductionDependencies(name, destination, visited);
}

function nestProductionDependencies(name, packageDirectory, visited) {
  const virtualModules = virtualModulesForPackage(name, packageDirectory);
  const pkg = readPackage(packageDirectory);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) {
    const source = path.join(virtualModules, ...dependency.split("/"));
    const isolated = isolatedDesktopCopy(dependency);
    if (!existsSync(source) && !isolated) {
      throw new Error(
        `Isolated ${name} is missing production dependency ${dependency}`,
      );
    }
    nestDependency(
      packageDirectory,
      dependency,
      existsSync(source) ? source : isolated,
      visited,
    );
  }
}

function isolatePackage(name) {
  const destination = packageDestination(name);
  if (!existsSync(destination)) return;
  if (lstatSync(destination).isSymbolicLink()) {
    const realDestination = realpathSync(destination);
    if (name.includes("/")) {
      isolateScope(
        path.join(desktopDirectory, "node_modules", name.split("/")[0]),
        path.dirname(realDestination),
        new Set(),
      );
    } else {
      replaceWithCopy(destination, realDestination);
    }
  }
}

export function assertIsolatedNativeRequires() {
  const desktopRequire = createRequire(
    path.join(desktopDirectory, "package.json"),
  );
  for (const name of nativePackages) {
    desktopRequire.resolve(name);
    const packageRequire = createRequire(
      path.join(packageDestination(name), "package.json"),
    );
    for (const dependency of Object.keys(
      readPackage(packageDestination(name)).dependencies ?? {},
    )) {
      packageRequire.resolve(dependency);
    }
  }
}

export function isolateNativeAddons() {
  for (const name of nativePackages) isolatePackage(name);
  for (const name of nativePackages) {
    nestProductionDependencies(name, packageDestination(name), new Set());
  }
  assertIsolatedNativeRequires();
}

const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) isolateNativeAddons();
