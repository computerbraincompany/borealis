import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nativePackages = [
  "better-sqlite3",
  "@lancedb/lancedb",
  "@duckdb/node-api",
];

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

function isolatePackage(name) {
  const destination = path.join(
    desktopDirectory,
    "node_modules",
    ...name.split("/"),
  );
  if (!existsSync(destination)) return;
  if (!lstatSync(destination).isSymbolicLink()) return;
  const realDestination = realpathSync(destination);
  if (name.includes("/")) {
    isolateScope(
      path.join(desktopDirectory, "node_modules", name.split("/")[0]),
      path.dirname(realDestination),
      new Set(),
    );
    return;
  }
  replaceWithCopy(destination, realDestination);
}

for (const name of nativePackages) isolatePackage(name);
