import assert from "node:assert/strict";
import test from "node:test";
import {
  DRIVER_FAILURE,
  DRIVER_SUCCESS,
  expectedEntitlementResult,
  nativeSmokePassed,
  summarizeNativeSmoke,
  summarizeSmokeDriver,
} from "./smoke-results.mjs";

const driver = (passed) => ({
  status: passed ? 0 : 1,
  signal: null,
  stdout: passed ? DRIVER_SUCCESS : "",
  stderr: passed ? "" : DRIVER_FAILURE,
});
const native = (changes = {}) => ({
  ...summarizeNativeSmoke({
    code: 1,
    closed: true,
    durationMs: 1_000,
    stderr: "BOREALIS_PACKAGED_NATIVE_SMOKE_FAILED\n",
    ...changes,
  }),
  cleanup_ok: true,
});

test("retained pair requires exact native success and clean wrapper/profile", () => {
  const result = native({
    code: 0,
    stdout: "BOREALIS_PACKAGED_NATIVE_SMOKE_OK\n",
    stderr: "",
  });
  assert.equal(nativeSmokePassed(result), true);
  assert.equal(expectedEntitlementResult(driver(true), result, true), true);
  assert.equal(
    expectedEntitlementResult(
      driver(true),
      { ...result, cleanup_ok: false },
      true,
    ),
    false,
  );
  assert.equal(expectedEntitlementResult(driver(true), result, false), false);
});

test("negative removals require a real native nonzero exit or signal", () => {
  assert.equal(expectedEntitlementResult(driver(false), native(), false), true);
  assert.equal(
    expectedEntitlementResult(
      driver(false),
      native({ code: null, signal: "SIGTRAP" }),
      false,
    ),
    true,
  );
  assert.equal(
    expectedEntitlementResult(
      driver(false),
      native({
        code: 0,
        stdout: "BOREALIS_PACKAGED_NATIVE_SMOKE_OK\n",
        stderr: "unexpected private path",
      }),
      false,
    ),
    false,
  );
  for (const changes of [
    { timedOut: true },
    { spawnError: true },
    { overflow: true },
    { closed: false },
  ]) {
    assert.equal(
      expectedEntitlementResult(driver(false), native(changes), false),
      false,
    );
  }
  assert.equal(
    expectedEntitlementResult(
      driver(false),
      { ...native(), cleanup_ok: false },
      false,
    ),
    false,
  );
  assert.equal(
    expectedEntitlementResult(
      { ...driver(false), error: new Error("private detail") },
      native(),
      false,
    ),
    false,
  );
  assert.equal(expectedEntitlementResult(driver(false), null, false), false);
});

test("diagnostics retain exit and output shape without raw contents or errors", () => {
  const result = summarizeNativeSmoke({
    code: 7,
    signal: null,
    closed: true,
    stdout: "secret-file-path",
    stderr: "private exception body",
  });
  assert.equal(result.exit_code, 7);
  assert.equal(result.stdout_shape, "other");
  assert.equal(result.stderr_bytes, 22);
  const wrapper = summarizeSmokeDriver({
    status: 1,
    signal: null,
    stdout: "secret-file-path",
    stderr: "private exception body",
    error: new Error("private error"),
  });
  assert.equal(wrapper.spawn_error, true);
  const serialized = JSON.stringify({ result, wrapper });
  for (const secret of [
    "secret-file-path",
    "private exception body",
    "private error",
  ])
    assert.equal(serialized.includes(secret), false);
});

test("negative evidence excludes the packaged main's internal deadline", () => {
  for (const durationMs of [
    null,
    undefined,
    -1,
    NaN,
    Infinity,
    30_000,
    30_001,
    45_000,
  ]) {
    for (const outcome of [{ code: 1 }, { code: null, signal: "SIGABRT" }]) {
      assert.equal(
        expectedEntitlementResult(
          driver(false),
          native({ ...outcome, durationMs }),
          false,
        ),
        false,
      );
    }
  }
  assert.equal(
    expectedEntitlementResult(
      driver(false),
      native({ durationMs: 29_999 }),
      false,
    ),
    true,
  );
  assert.equal(
    expectedEntitlementResult(
      driver(true),
      native({
        code: 0,
        stdout: "BOREALIS_PACKAGED_NATIVE_SMOKE_OK\n",
        stderr: "",
        durationMs: 30_001,
      }),
      true,
    ),
    true,
  );
});
