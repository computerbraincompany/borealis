import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error("the hardened-runtime entitlement matrix requires macOS");

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagedApp = path.resolve(
  process.argv[2] ??
    path.join(desktopDirectory, "release/mac-arm64/Borealis.app"),
);
const sourceEntitlements = path.join(
  desktopDirectory,
  "build/entitlements.mac.plist",
);
const sourceInheritedEntitlements = path.join(
  desktopDirectory,
  "build/entitlements.mac.inherit.plist",
);
const packagedSmoke = path.join(
  desktopDirectory,
  "scripts/packaged-native-smoke.mjs",
);
const retainedKeys = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation",
];
const matrix = [
  { name: "retained pair", remove: null, shouldPass: true },
  { name: "without allow-jit", remove: retainedKeys[0], shouldPass: false },
  {
    name: "without disable-library-validation",
    remove: retainedKeys[1],
    shouldPass: false,
  },
];

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "borealis-entitlement-matrix."),
);
try {
  for (const filename of [sourceEntitlements, sourceInheritedEntitlements]) {
    const parsed = JSON.parse(
      run(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", filename],
        "parse tracked entitlements",
        true,
      ),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("tracked entitlements are not a dictionary");
    }
    const keys = Object.keys(parsed).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...retainedKeys].sort())) {
      throw new Error(
        "tracked entitlements differ from the reviewed exact allowlist",
      );
    }
    for (const key of retainedKeys) {
      if (parsed[key] !== true)
        throw new Error(`tracked entitlement is not enabled: ${key}`);
    }
  }
  const trackedPlist = await readFile(sourceEntitlements, "utf8");

  for (const entry of matrix) {
    const appCopy = path.join(
      temporaryDirectory,
      `${entry.name.replaceAll(/[^a-z]+/g, "-")}.app`,
    );
    const variantPlist = path.join(
      temporaryDirectory,
      `${entry.name.replaceAll(/[^a-z]+/g, "-")}.plist`,
    );
    run("/bin/cp", ["-cR", packagedApp, appCopy], "copy packaged app");
    let variant = trackedPlist;
    if (entry.remove) {
      const entitlementEntry = `  <key>${entry.remove}</key>\n  <true/>\n`;
      const withoutEntitlement = variant.replace(entitlementEntry, "");
      if (withoutEntitlement === variant)
        throw new Error(
          `could not remove entitlement variant: ${entry.remove}`,
        );
      variant = withoutEntitlement;
    }
    await writeFile(variantPlist, variant, { encoding: "utf8", mode: 0o600 });
    run(
      "/usr/bin/codesign",
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--options",
        "runtime",
        "--entitlements",
        variantPlist,
        appCopy,
      ],
      "ad-hoc hardened-runtime signing",
    );
    const inspection = run(
      "/usr/bin/codesign",
      ["-d", "--verbose=4", "--entitlements", "-", appCopy],
      "codesign inspection",
      true,
    );
    if (!inspection.includes("runtime"))
      throw new Error(`runtime flag missing for ${entry.name}`);
    for (const key of retainedKeys) {
      const expected = key !== entry.remove;
      if (inspection.includes(key) !== expected)
        throw new Error(`unexpected ${key} state for ${entry.name}`);
    }
    const smoke = spawnSync(process.execPath, [packagedSmoke, appCopy], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const expectedStatus = entry.shouldPass ? 0 : 1;
    const expectedStdout = entry.shouldPass
      ? "Packaged Electron native smoke passed.\n"
      : "";
    const expectedStderr = entry.shouldPass
      ? ""
      : "Packaged Electron native smoke failed.\n";
    if (
      smoke.error ||
      smoke.signal !== null ||
      smoke.status !== expectedStatus ||
      smoke.stdout !== expectedStdout ||
      smoke.stderr !== expectedStderr
    ) {
      throw new Error(`unexpected packaged smoke result for ${entry.name}`);
    }
    const passed = smoke.status === 0 && smoke.signal === null;
    process.stdout.write(
      `Entitlement matrix: ${entry.name} ${passed ? "passed" : "failed as required"}.\n`,
    );
    await rm(appCopy, { recursive: true, force: true });
  }
  process.stdout.write("Hardened-runtime entitlement matrix passed.\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, stage, returnOutput = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0 || result.signal !== null || result.error)
    throw new Error(`${stage} failed`);
  return returnOutput ? `${result.stdout ?? ""}\n${result.stderr ?? ""}` : "";
}
