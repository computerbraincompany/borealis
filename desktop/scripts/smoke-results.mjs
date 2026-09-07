/** Content-free packaged-smoke protocol shared by the driver and matrix. */
export const SMOKE_SUCCESS_MARKER = "BOREALIS_PACKAGED_NATIVE_SMOKE_OK";
export const SMOKE_FAILURE_MARKER = "BOREALIS_PACKAGED_NATIVE_SMOKE_FAILED";
export const DRIVER_SUCCESS = "Packaged Electron native smoke passed.\n";
export const DRIVER_FAILURE = "Packaged Electron native smoke failed.\n";
export const RETAINED_ENTITLEMENTS = Object.freeze([
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.disable-library-validation",
]);
// main.ts reports its own 30s deadline with the generic failure marker. The
// host must exclude that outcome without changing the packaged smoke protocol.
const NATIVE_SMOKE_INTERNAL_TIMEOUT_MS = 30_000;

export function summarizeCodeSignature(metadata, entitlements) {
  const flagMatch = /^CodeDirectory .*\bflags=0x([0-9a-f]+)\(/im.exec(metadata);
  const flags = flagMatch ? Number.parseInt(flagMatch[1], 16) : 0;
  const dictionary =
    Boolean(entitlements) &&
    typeof entitlements === "object" &&
    !Array.isArray(entitlements);
  const keys = dictionary ? Object.keys(entitlements) : [];
  return {
    runtime: (flags & 0x10000) !== 0,
    explicit_library_validation: (flags & 0x2000) !== 0,
    valid_entitlements:
      dictionary &&
      keys.every(
        (key) =>
          RETAINED_ENTITLEMENTS.includes(key) && entitlements[key] === true,
      ),
    entitlement_count: keys.length,
    allow_jit: dictionary && entitlements[RETAINED_ENTITLEMENTS[0]] === true,
    disable_library_validation:
      dictionary && entitlements[RETAINED_ENTITLEMENTS[1]] === true,
  };
}

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? "", "utf8");
}

function shape(value, expected) {
  const buffer = bytes(value);
  return buffer.length === 0
    ? "empty"
    : buffer.toString("utf8").trim() === expected
      ? "expected-marker"
      : "other";
}

export function summarizeNativeSmoke({
  code = null,
  signal = null,
  stdout = "",
  stderr = "",
  overflow = false,
  timedOut = false,
  spawnError = false,
  closed = false,
  durationMs = null,
} = {}) {
  return {
    schema: 1,
    exit_code: code,
    signal,
    closed,
    duration_ms: durationMs,
    timed_out: timedOut,
    spawn_error: spawnError,
    output_overflow: overflow,
    stdout_bytes: bytes(stdout).length,
    stderr_bytes: bytes(stderr).length,
    stdout_shape: shape(stdout, SMOKE_SUCCESS_MARKER),
    stderr_shape: shape(stderr, SMOKE_FAILURE_MARKER),
  };
}

export function nativeSmokePassed(result) {
  return (
    result.closed === true &&
    result.timed_out === false &&
    result.spawn_error === false &&
    result.output_overflow === false &&
    result.exit_code === 0 &&
    result.signal === null &&
    result.stdout_shape === "expected-marker" &&
    result.stderr_shape === "empty"
  );
}

export function summarizeSmokeDriver(result) {
  return {
    exit_code: result.status ?? null,
    signal: result.signal ?? null,
    spawn_error: Boolean(result.error),
    stdout_bytes: bytes(result.stdout).length,
    stderr_bytes: bytes(result.stderr).length,
    stdout_shape: shape(result.stdout, DRIVER_SUCCESS.trim()),
    stderr_shape: shape(result.stderr, DRIVER_FAILURE.trim()),
  };
}

export function expectedEntitlementResult(driver, native, shouldPass) {
  if (
    driver.error ||
    driver.signal !== null ||
    driver.status !== (shouldPass ? 0 : 1) ||
    driver.stdout !== (shouldPass ? DRIVER_SUCCESS : "") ||
    driver.stderr !== (shouldPass ? "" : DRIVER_FAILURE) ||
    native?.schema !== 1 ||
    native.cleanup_ok !== true ||
    native.closed !== true ||
    native.timed_out !== false ||
    native.spawn_error !== false ||
    native.output_overflow !== false
  )
    return false;
  // A setup error, timeout, noisy successful launch, or profile cleanup failure
  // is not evidence that removing an entitlement prevents native execution.
  return shouldPass
    ? nativeSmokePassed(native)
    : Number.isFinite(native.duration_ms) &&
        native.duration_ms >= 0 &&
        native.duration_ms < NATIVE_SMOKE_INTERNAL_TIMEOUT_MS &&
        ((Number.isInteger(native.exit_code) && native.exit_code !== 0) ||
          (typeof native.signal === "string" &&
            native.signal.startsWith("SIG")));
}
