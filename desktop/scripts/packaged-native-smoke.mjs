import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appBundle = path.resolve(
  process.argv[2] ??
    path.join(desktopDirectory, "release", "mac-arm64", "Borealis.app"),
);
const executable = path.join(appBundle, "Contents", "MacOS", "Borealis");
const SUCCESS_MARKER = "BOREALIS_PACKAGED_NATIVE_SMOKE_OK";
const MAX_OUTPUT_BYTES = 16 * 1024;
const TIMEOUT_MS = 45_000;
const LAUNCH_ENVIRONMENT_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "USER",
  "LOGNAME",
]);

function launchEnvironment() {
  const environment = {};
  for (const key of LAUNCH_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  // These values intentionally exercise the disabled production fuses. The
  // main process must still launch normally, and none may reach the utility.
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.NODE_OPTIONS = "--require=/__borealis_missing_injection__.cjs";
  environment.NODE_EXTRA_CA_CERTS = "/__borealis_missing_extra_ca__.pem";
  return environment;
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function run(profile) {
  if (!(await stat(executable)).isFile()) {
    throw new Error("the packaged application executable is unavailable");
  }
  const child = spawn(
    executable,
    [
      "--borealis-packaged-native-smoke",
      `--user-data-dir=${profile}`,
      "--inspect=127.0.0.1:0",
    ],
    {
      detached: true,
      env: launchEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  const append = (current, chunk) => {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    if (next.length > MAX_OUTPUT_BYTES) {
      overflow = true;
      signalGroup(child, "SIGKILL");
      return next.subarray(0, MAX_OUTPUT_BYTES);
    }
    return next;
  };
  child.stdout.on("data", (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = append(stderr, chunk);
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signalGroup(child, "SIGKILL");
      reject(new Error("the packaged native smoke timed out"));
    }, TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  }).finally(() => signalGroup(child, "SIGTERM"));

  if (
    overflow ||
    result.code !== 0 ||
    result.signal !== null ||
    stdout.toString("utf8").trim() !== SUCCESS_MARKER ||
    stderr.length !== 0
  ) {
    throw new Error("the packaged native smoke failed");
  }
}

const profile = await mkdtemp(
  path.join(os.tmpdir(), "borealis-packaged-native-smoke."),
);
try {
  await chmod(profile, 0o700);
  if (((await stat(profile)).mode & 0o777) !== 0o700) {
    throw new Error("the packaged smoke profile is not private");
  }
  await run(profile);
  process.stdout.write("Packaged Electron native smoke passed.\n");
} catch {
  process.stderr.write("Packaged Electron native smoke failed.\n");
  process.exitCode = 1;
} finally {
  await rm(profile, { recursive: true, force: true });
}
