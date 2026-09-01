import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";

import {
  electronBuilderFuseConfiguration,
  expectedFuseEntries,
} from "./fuse-policy.mjs";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJson = JSON.parse(
  readFileSync(path.join(desktopDirectory, "package.json"), "utf8"),
);
const appBundle = path.resolve(
  process.argv[2] ??
    path.join(desktopDirectory, "release", "mac-arm64", "Borealis.app"),
);
function assertTrackedConfiguration() {
  const configured = packageJson.build?.electronFuses;
  if (!configured) {
    throw new Error("the tracked Electron fuse configuration is incomplete");
  }
  const configuredKeys = Object.keys(configured).sort();
  const expectedKeys = Object.keys(electronBuilderFuseConfiguration).sort();
  if (JSON.stringify(configuredKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      "the tracked Electron fuse configuration contains an unknown key",
    );
  }
  for (const name of expectedKeys) {
    if (configured[name] !== electronBuilderFuseConfiguration[name]) {
      throw new Error("the tracked Electron fuse configuration drifted");
    }
  }
}

async function assertPackagedFuses() {
  if (!statSync(appBundle).isDirectory()) {
    throw new Error("the packaged application is unavailable");
  }
  const knownOptions = Object.values(FuseV1Options).filter(Number.isInteger);
  if (knownOptions.length !== expectedFuseEntries.length) {
    throw new Error("the Electron fuse wire contains an unreviewed option");
  }
  const wire = await getCurrentFuseWire(appBundle);
  if (wire.version !== FuseVersion.V1) {
    throw new Error("the packaged application uses an unexpected fuse version");
  }
  const fuseIndexes = Object.keys(wire).filter((key) => /^\d+$/.test(key));
  if (fuseIndexes.length !== expectedFuseEntries.length) {
    throw new Error("the packaged Electron fuse wire has an unknown length");
  }
  for (const [option, enabled] of expectedFuseEntries) {
    const wanted = (enabled ? "1" : "0").charCodeAt(0);
    if (wire[option] !== wanted) {
      throw new Error("the packaged Electron fuse wire drifted");
    }
  }
}

function assertAsarIntegrity() {
  const resources = path.join(appBundle, "Contents", "Resources");
  const archive = path.join(resources, "app.asar");
  if (!statSync(archive).isFile() || existsSync(path.join(resources, "app"))) {
    throw new Error("the packaged application is not ASAR-only");
  }
  const info = JSON.parse(
    execFileSync(
      "/usr/bin/plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        path.join(appBundle, "Contents", "Info.plist"),
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    ),
  );
  const integrity = info.ElectronAsarIntegrity?.["Resources/app.asar"];
  if (
    integrity?.algorithm !== "SHA256" ||
    typeof integrity.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(integrity.hash)
  ) {
    throw new Error("the packaged ASAR integrity metadata is missing");
  }
}

function assertUnpackedOcrHelper() {
  const helper = path.join(
    appBundle,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "runtime",
    "server",
    "dist",
    "data",
    "assets",
    "pdf-ocr.jxa",
  );
  const stat = lstatSync(helper);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    realpathSync(helper) !== helper ||
    stat.size > 64 * 1024
  ) {
    throw new Error("the packaged OCR helper is not an exact bounded file");
  }
  const contents = readFileSync(helper, "utf8");
  if (
    !contents.includes('ObjC.import("Vision")') ||
    /https?:|fetch\(|curl|XMLHttpRequest/.test(contents)
  ) {
    throw new Error("the packaged OCR helper failed its offline policy");
  }
}

try {
  assertTrackedConfiguration();
  await assertPackagedFuses();
  assertAsarIntegrity();
  assertUnpackedOcrHelper();
  process.stdout.write(
    "Packaged Electron fuses and ASAR integrity verified.\n",
  );
} catch {
  process.stderr.write("Packaged Electron fuse inspection failed.\n");
  process.exitCode = 1;
}
