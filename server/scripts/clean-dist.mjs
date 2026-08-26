import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(serverRoot, "dist");
if (path.dirname(dist) !== serverRoot || path.basename(dist) !== "dist") {
  throw new Error("refusing to clean an unexpected build directory");
}
await rm(dist, { recursive: true, force: true });
