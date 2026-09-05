import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTEGRATION_TEST_FILES } from "./vitestTestPartitions.js";

// Metadata-only test: it never imports either Vitest config, so the test
// process stays decoupled from config loading. The manifest is the only
// membership authority; unit membership is everything not listed there.
const testsDir = fileURLToPath(new URL(".", import.meta.url));
const serverRootDir = fileURLToPath(new URL("../../", import.meta.url));
const THIS_TEST = "src/tests/vitestPartitions.test.ts";
const integrationFiles: readonly string[] = INTEGRATION_TEST_FILES;

async function discoverServerTests(): Promise<string[]> {
  const entries = await readdir(testsDir, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".test.ts"))
    .map((entry) => `src/tests/${entry.split(path.sep).join("/")}`)
    .sort();
}

describe("Vitest suite partitions", () => {
  it("lists no duplicate paths in the integration manifest", () => {
    expect(new Set(integrationFiles).size).toBe(integrationFiles.length);
  });

  it("has integration entries that exist on disk as .test.ts files", async () => {
    for (const file of integrationFiles) {
      expect(file.endsWith(".test.ts")).toBe(true);
      await access(path.join(serverRootDir, file));
    }
  });

  it("assigns every discovered test file to exactly one suite", async () => {
    const discovered = await discoverServerTests();
    const integrationSet = new Set<string>(integrationFiles);
    const integrationDiscovered = discovered.filter((file) => integrationSet.has(file));
    const unit = discovered.filter((file) => !integrationSet.has(file));

    // Every manifest entry is a real discovered test file.
    for (const file of integrationFiles) {
      expect(discovered).toContain(file);
    }

    // The two suites are disjoint.
    expect(unit.filter((file) => integrationSet.has(file))).toEqual([]);
    expect(unit.filter((file) => integrationDiscovered.includes(file))).toEqual([]);

    // The two suites cover every discovered test file.
    expect([...unit, ...integrationDiscovered].sort()).toEqual(discovered);
  });

  it("classifies this partition invariant test as a unit test", async () => {
    const discovered = await discoverServerTests();
    expect(discovered).toContain(THIS_TEST);
    expect(integrationFiles).not.toContain(THIS_TEST);
  });
});
