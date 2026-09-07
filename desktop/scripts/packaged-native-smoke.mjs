import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRIVER_FAILURE,
  DRIVER_SUCCESS,
  nativeSmokePassed,
  summarizeNativeSmoke,
} from "./smoke-results.mjs";

const desktopDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const appBundle = path.resolve(
  process.argv[2] ??
    path.join(desktopDirectory, "release", "mac-arm64", "Borealis.app"),
);
const executable = path.join(appBundle, "Contents", "MacOS", "Borealis");
const resultArgument = process.argv[3];
const resultFile = resultArgument?.startsWith("--result-file=")
  ? resultArgument.slice("--result-file=".length)
  : undefined;
if (
  process.argv.length > 4 ||
  (resultArgument !== undefined &&
    (!resultFile || !path.isAbsolute(resultFile)))
) {
  throw new Error("invalid packaged smoke result-file argument");
}
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
  let timedOut = false;
  let spawnError = false;
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

  const result = await new Promise((resolve) => {
    let hardDeadline;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalGroup(child, "SIGKILL");
      hardDeadline = setTimeout(
        () =>
          resolve({
            code: child.exitCode,
            signal: child.signalCode,
            closed: false,
          }),
        5_000,
      );
    }, TIMEOUT_MS);
    child.once("error", () => {
      spawnError = true;
    });
    // 'exit' can precede the last stdout/stderr chunks. 'close' proves drained
    // pipes before the exact output contract is read.
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(hardDeadline);
      resolve({ code, signal, closed: true });
    });
  }).finally(() => signalGroup(child, "SIGTERM"));
  return summarizeNativeSmoke({
    ...result,
    stdout,
    stderr,
    overflow,
    timedOut,
    spawnError,
  });
}

let profile;
let result = { ...summarizeNativeSmoke(), cleanup_ok: false };
try {
  profile = await mkdtemp(
    path.join(os.tmpdir(), "borealis-packaged-native-smoke."),
  );
  await chmod(profile, 0o700);
  if (((await stat(profile)).mode & 0o777) !== 0o700)
    throw new Error("the packaged smoke profile is not private");
  result = { ...(await run(profile)), cleanup_ok: false };
} catch {
  result.setup_error = true;
} finally {
  try {
    if (profile) await rm(profile, { recursive: true, force: true });
    result.cleanup_ok = true;
  } catch {
    result.cleanup_ok = false;
  }
}
try {
  if (resultFile)
    await writeFile(resultFile, `${JSON.stringify(result)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
} catch {
  result.result_file_error = true;
}
if (
  nativeSmokePassed(result) &&
  result.cleanup_ok &&
  !result.result_file_error
) {
  process.stdout.write(DRIVER_SUCCESS);
} else {
  process.stderr.write(DRIVER_FAILURE);
  process.exitCode = 1;
}
