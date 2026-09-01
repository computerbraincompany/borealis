# Plan 019: Add packaged Electron lifecycle acceptance coverage

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm its expected result before proceeding. If a “STOP condition” occurs, stop and report — do not improvise. When complete, update this plan’s row in `advisor-plans/README.md` unless a reviewer told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- desktop/src/main.ts desktop/src/packagedLifecycleProbe.ts desktop/src/packagedLifecycleProbe.test.ts desktop/scripts/packaged-lifecycle-smoke.mjs desktop/package.json .github/workflows/ci.yml`
> Plans 002, 014, 032, 033, 036, and 037 intentionally changed command/runtime
> ownership, Electron fuses and utility environment, copied lazy assets, the
> packaged native OCR smoke, and server workspace locking. Read those completed
> plans and the live implementations first. They are required baseline, not a
> drift STOP: add lifecycle observation beside the existing packaged fuse/
> ASAR/native/OCR/entitlement gates without replacing or weakening any of them.
> **Read-only dependency check**: inspect `desktop/scripts/after-pack.cjs`,
> `desktop/scripts/fuse-policy.mjs`, `desktop/scripts/inspect-fuses.mjs`,
> `desktop/scripts/copy-runtime.mjs`,
> `desktop/scripts/packaged-native-smoke.mjs`, and
> `desktop/scripts/entitlement-matrix.mjs`. They are not editable here.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/002-make-desktop-verification-source-current.md`, `advisor-plans/014-create-owned-application-runtime.md`, `advisor-plans/032-harden-electron-fuses.md`, `advisor-plans/033-split-web-route-and-chart-bundles.md`, `advisor-plans/036-add-bounded-local-ocr.md`
- **Preserve completed baseline**: Plans 032, 033, 035, 036, and 037
- **Category**: tests
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

CI proves compiled desktop units, renderer isolation, native addon ABI loading, and packaging, but never launches the normal packaged application. Regressions in first-launch account bootstrap, real UI loading, copied-runtime startup, persistent-profile reuse, or orderly utility-process shutdown can therefore ship despite every gate passing. Add a content-free acceptance probe around the actual packaged binary without introducing a debug IPC or weakening the hardened renderer.

## Current state

- At the planned commit, `desktop/package.json:11-28` has `package:unsigned`, `package:native:smoke`, `native:smoke`, `render:smoke`, and `verify`, but no packaged lifecycle command. Plan 002 may rename or regroup these scripts; use its final source-current command contract rather than restoring this stale shape.
- `.github/workflows/ci.yml:53-66` builds the desktop, creates the unsigned app, runs only the packaged native smoke, and uploads artifacts. It never launches the app’s normal main entry.
- `desktop/src/main.ts:89-98` starts the actual runtime and window:

  ```ts
  async start(): Promise<void> {
    await this.#prepareStorage();
    await this.#assertRuntime();
    this.#installBootstrapHandler();
    const ready = await this.#startBackend();
    this.#origin = appOrigin(ready.port);
    this.#vault.store(ready.bootstrap);
    this.#configureApplicationSession();
    this.#createWindow();
  }
  ```

- The one-shot bootstrap is consumed only by the trusted main renderer at `desktop/src/main.ts:156-167`:

  ```ts
  if (event.sender !== this.#window.webContents) return null;
  const senderUrl = event.senderFrame?.url;
  if (!senderUrl || !isTrustedAppUrl(senderUrl, this.#origin)) return null;
  return this.#vault.consume();
  ```

- Shutdown currently sends a typed utility message and waits up to eight seconds before killing it (`desktop/src/main.ts:118-135`). The positive orderly acknowledgment arrives through `message.type === "stopped"` at `desktop/src/main.ts:213-216`. Plan 014 moves lifecycle ownership; instrument its final equivalent rather than adding a competing shutdown owner.
- The window keeps `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, navigation controls, and a one-operation preload (`desktop/src/main.ts:295-372`, `desktop/src/preload.cts:14-18`). These controls are invariants.
- `desktop/scripts/native-smoke.cjs:11-60` is a content-free script exemplar: it uses a temporary directory and emits only fixed/synthetic result fields. It tests addon resolution, not the application lifecycle.
- `server/src/desktopHost.ts:25-33` posts `{ type: "stopped" }` only from the owned service lifecycle’s `onStopped` callback. After plan 014, the same semantic acknowledgment must remain the success condition.

## Commands you will need

| Purpose                | Command                                                     | Expected on success                                                       |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Desktop unit gate      | `pnpm --filter borealis-desktop verify`                     | exit 0; unit, format, native, and render checks pass                      |
| Package                | `pnpm package:unsigned`                                     | exit 0; arm64 app exists at the package script’s documented output        |
| Lifecycle acceptance   | `pnpm --filter borealis-desktop package:lifecycle:smoke`    | exit 0 after two packaged launches and graceful stops                     |
| Existing package smoke | `pnpm --filter borealis-desktop package:native:smoke`       | exit 0; fuse/ASAR/native/raster-OCR checks remain intact                  |
| Entitlement matrix     | `pnpm --filter borealis-desktop package:entitlements:smoke` | exit 0 for the reviewed exact entitlement allowlist and negative variants |
| Repository gate        | `pnpm verify`                                               | exit 0 and prints `ALL GATES GREEN`                                       |

Run packaging commands only on the supported Apple Silicon macOS 13+ host with a graphical session.

## Scope

**In scope** (the only files you should modify):

- `desktop/src/main.ts`
- `desktop/src/packagedLifecycleProbe.ts` (create)
- `desktop/src/packagedLifecycleProbe.test.ts` (create)
- `desktop/scripts/packaged-lifecycle-smoke.mjs` (create)
- `desktop/package.json`
- `.github/workflows/ci.yml`

If plan 014 moved the main-process lifecycle to a new owner module, that exact module replaces `desktop/src/main.ts` in scope; STOP and record the substitution before editing. Do not edit both ownership paths.

**Out of scope**:

- New renderer/preload APIs, test-only IPC, DevTools/debug ports, disabled sandboxing, navigation exceptions, Node integration, or permission changes.
- Reading or printing bootstrap tokens, signing-secret contents, provider settings, user records, ports, absolute profile paths, utility output, or service URLs.
- Model calls, report rendering, signing, notarization, DMG installation, or release distribution.
- Changing app startup/shutdown behavior outside the packaged acceptance mode.
- Documentation; plan 023 owns it.

## Git workflow

- Branch: `codex/019-packaged-lifecycle-test`
- Use conventional commits. An observed repository example is `docs: document personal default models and mark M11 done`.
- Suggested commit: `test: add packaged Electron lifecycle smoke`
- Do not push, publish artifacts, or open a PR unless explicitly requested.

## Steps

### Step 1: Confirm predecessor contracts and define a pure probe state machine

Confirm plans 002, 014, 032, 033, and 036 are `DONE`. Record the final
supported packaging output path and the single owner that starts/stops the
backend. Confirm the production fuses, positive utility environment allowlist,
ASAR-only loading/integrity, required lazy-entry manifest check, build budget,
unpacked JXA helper, real raster-only Vision smoke, and entitlement matrix all
pass before adding lifecycle coverage. Do not reintroduce commands removed by
plan 002, bypass the runtime abstraction created by plan 014, or duplicate any
existing package smoke.

Create `desktop/src/packagedLifecycleProbe.ts` with no Electron imports. It should accept only boolean lifecycle facts/events and return fixed actions. A successful run requires all of these, in either safe order:

1. the real packaged main window completed its initial same-origin load;
2. the trusted renderer invoked and successfully consumed the one-shot bootstrap once;
3. that renderer then completed an exact same-origin authenticated
   `GET /api/me` with status 200;
4. the app requested normal quit; and
5. the owned backend/runtime delivered its orderly stopped acknowledgment before the kill deadline.

Expose the fixed marker constants `BOREALIS_LIFECYCLE_READY` and `BOREALIS_LIFECYCLE_STOPPED`. No marker may contain dynamic data. Duplicate/out-of-order events must not produce duplicate success or turn a forced kill into success.

**Verify**: `pnpm --filter borealis-desktop build && pnpm --filter borealis-desktop test` → exit 0; pure state-machine tests pass under Node.

### Step 2: Add a narrowly gated packaged-main acceptance mode

Integrate the pure probe with the final main-process lifecycle owner. Activate
it only when `app.isPackaged` is true and Electron's command line contains one
dedicated exact switch, following the existing packaged-native-smoke pattern.
Do not add an environment escape hatch: Plan 032's positive utility environment
allowlist remains authoritative, and neither the lifecycle switch nor any
inherited debug/Node variable may reach the utility process. Normal development
and packaged launches must take the existing path byte-for-byte except for inert
event observations.

Observe the real window’s successful initial load and the existing trusted
bootstrap handler’s successful non-null consume. In acceptance mode only,
install an inert `session.webRequest.onCompleted` observer and accept an API
fact only when the method is `GET`, the normalized URL is exactly
`${origin}/api/me`, the status is 200, `fromCache` is false, `resourceType` is
`xhr`, and `details.webContentsId` exactly equals the main window's current
`webContents.id` after bootstrap consumption. Inspect no body, authorization
header, token, response content, or dynamic URL in output, and remove the
listener during cleanup. A 401/redirect/error is not readiness. When load,
bootstrap consumption, and this authenticated API fact have all happened,
write the fixed ready marker to stdout once and call the normal `app.quit()`
path. When the final owned runtime reports its graceful stopped acknowledgment,
write the fixed stopped marker once and exit zero. If startup, UI load,
bootstrap, authenticated API, runtime stop, or the existing shutdown deadline
fails, emit no success marker for that phase and exit nonzero. Never call the
probe’s graceful-stop transition from a utility-process `exit` event or timeout
fallback.

Do not add IPC, preload surface, renderer query parameters, local HTTP routes, exposed ports, or special navigation. The test mode is a main-process observer and auto-quit trigger only.

**Verify**: `pnpm --filter borealis-desktop typecheck && pnpm --filter borealis-desktop test && pnpm --filter borealis-desktop format:check` → exit 0; normal lifecycle unit tests and new probe tests pass.

### Step 3: Launch the actual packaged binary twice

Create `desktop/scripts/packaged-lifecycle-smoke.mjs`. Resolve exactly
`desktop/release/mac-arm64/Borealis.app/Contents/MacOS/Borealis` from the
repository root produced by `pnpm package:unsigned`; this plan does not inherit
an unspecified output path from Plan 002. If the final producer uses a
different explicit path, STOP and revise the producer plus both packaged smokes
together. Use `lstat` on that exact target and require a regular, non-symlink
file; resolve its real path and prove it remains inside that exact expected
`.app` bundle. Run `/usr/bin/lipo -archs <exact-binary>` and require the
tokenized result to be exactly `arm64`. Do not fall back to a directory search,
`open`, or an arbitrary executable.

Make one absolute temporary root with mode 0700 and distinct mode-0700
`profile/`, `home/`, and `tmp/` children. Build the child environment as an
allowlist: preserve only `PATH`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`,
and `CI` when present; set `HOME` and `TMPDIR` to those isolated children. Do
not inherit `BOREALIS_*`, `LLM_*`,
`LITELLM_*`, `JWT_*`, `HOST`, `PORT`, `STATIC_WEB_DIR`, `RENDER_BACKEND`,
signing/notarization variables, Electron logging/debug flags, `NODE_OPTIONS`, or
`DYLD_*`.

Declare exact script constants `LAUNCH_TIMEOUT_MS = 60_000`,
`TERMINATION_GRACE_MS = 5_000`, `KILL_SETTLE_MS = 5_000`, and
`MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024` (combined stdout/stderr per launch).
Spawn the exact binary with exactly two application arguments: the dedicated
`--borealis-packaged-lifecycle-smoke` switch and
`--user-data-dir=<absolute profile path>`, so both launches exercise only the
disposable profile and never the installed app's default data. Make each launch
the leader of its own POSIX process group/session (`detached: true` on this
macOS-only script), retain its exact numeric child PID as the process-group ID,
keep piped output attached, and apply the hard launch deadline. Never use
`open`, `pkill`, process-name matching, a broad user/session kill, or a PID
discovered by scanning. Do not `unref` the child. On deadline, output overflow,
marker validation failure while the app is live, or any other early validation
failure, send `SIGTERM` to only that negative process-group ID, wait 5 seconds,
escalate that same group to `SIGKILL` if it still exists, and allow 5 seconds
for the tracked child's `exit`/`close` completion. Never remove the temporary
root before that completion; if the child still cannot settle, retain it, emit
only the fixed cleanup-failure category, and let the CI step's outer timeout
terminate the smoke rather than detaching or broadly killing anything. Treat
either escalation or a surviving group as failure.

For each launch:

- buffer at most 64 KiB combined stdout/stderr; terminate and fail on the byte that would exceed it;
- require exit code zero and each fixed marker exactly once, in ready-then-stopped order;
- after child exit, prove the exact launch process group no longer exists; a surviving Electron/utility descendant is a failed launch and must be cleaned through the same bounded group-only TERM→KILL path;
- do not echo captured child output on success;
- on failure, report only a fixed phase/error category — never child output or dynamic paths;
- use `lstat` after startup to require the profile itself plus `lancedb/`, `uploads/`, and `reports/` as real non-symlink directories, and `borealis.sqlite` plus `jwt.secret` as real non-symlink regular files; require the signing-secret mode bits to be 0600. Do not require `settings.json`, which startup does not necessarily create, and do not print any path or file content.

After launch one, read the signing-secret file only into memory. Launch again with the same profile in a new exact process group, require the same lifecycle result, read it again, and use a constant-time comparison to prove the existing secret was reused. Never serialize, snapshot, hash for output, or include either value in an assertion message. In `finally`, settle the active launch first: perform the bounded exact-group termination if needed and await child exit. Only then remove the temporary profile. Apply that ordering on timeout and every validation-failure path so no utility process can retain handles into a deleted/reused profile.

Add `package:lifecycle:smoke` to `desktop/package.json`. It must consume an already built unsigned app and must not silently package, sign, or install dependencies.

**Verify**:
`pnpm package:unsigned && pnpm --filter borealis-desktop package:native:smoke && pnpm --filter borealis-desktop package:entitlements:smoke && pnpm --filter borealis-desktop package:lifecycle:smoke`
→ packaging exits 0; the existing fuse/ASAR/native/raster-OCR and entitlement
checks pass unchanged, then the lifecycle script launches and gracefully stops
the same packaged app twice without dynamic output.

### Step 4: Put the acceptance check in the macOS package job

In `.github/workflows/ci.yml`, run the lifecycle smoke after unsigned packaging
and alongside, not instead of, the existing packaged-native and entitlement
matrix checks before artifact upload. Keep all three on the supported Apple
Silicon macOS job and give the lifecycle step a bounded timeout. Do not add
signing/notarization credentials or upload the temporary profile.

Run the desktop and repository gates after editing the workflow.

**Verify**:
`pnpm --filter borealis-desktop verify && pnpm package:unsigned && pnpm --filter borealis-desktop package:native:smoke && pnpm --filter borealis-desktop package:entitlements:smoke && pnpm --filter borealis-desktop package:lifecycle:smoke && pnpm verify`
→ every command exits 0; repository output ends with `ALL GATES GREEN`.

## Test plan

- `packagedLifecycleProbe.test.ts`: permutations of load, bootstrap, and
  authenticated-API completion; rejection of API 401, redirects, wrong origin,
  wrong method, wrong webContents, or cached responses; exactly-once ready;
  normal quit request; graceful acknowledgment;
  duplicate events; premature exit; timeout; and forced-kill rejection.
- `packaged-lifecycle-smoke.mjs`: real packaged first launch, one-shot bootstrap, same-origin UI load, graceful runtime stop, same-profile relaunch, signing-secret continuity checked only in memory, single-instance lock release, exact process-group cleanup, and no surviving utility descendant after success/failure/timeout.
- Existing `contracts.test.ts`, `policies.test.ts`, `runtime.test.ts`, renderer
  smoke, fuse inspection, lazy-manifest/build-budget checks, packaged native
  raster-OCR smoke, and entitlement matrix remain green.
- CI executes the package lifecycle test before artifact upload so a failed normal launch blocks distribution.

## Done criteria

- [ ] The actual packaged main entry launches twice with the exact absolute
      `--user-data-dir` for one isolated profile and exits zero both times;
      isolated HOME/TMPDIR prevent fallback into operator state.
- [ ] A run succeeds only after real UI load, trusted one-shot bootstrap
      consumption, a subsequent exact same-origin authenticated `/api/me` 200,
      normal quit, and orderly runtime-stopped acknowledgment.
- [ ] Timeout/kill, utility exit without acknowledgment, malformed/duplicate markers, or excess child output fail closed.
- [ ] Each launch owns one exact process group; deadline and early-failure cleanup use bounded group-only TERM→KILL escalation, await child exit before profile removal, and leave no child/process-group leak.
- [ ] No test IPC/debug surface or renderer hardening exception was added.
- [ ] No secret, token, endpoint, port, path, child output, or persisted content is printed or stored in artifacts.
- [ ] Plan-002 command semantics and plan-014 runtime ownership remain intact.
- [ ] Plans 032/033/036 remain intact: production fuses and the positive utility
      environment allowlist are unchanged; all hashed lazy/chart assets remain
      copied and budgeted offline; the unpacked helper and real raster-only
      packaged OCR smoke still pass before lifecycle acceptance.
- [ ] Desktop/package checks and `pnpm verify` pass with `ALL GATES GREEN`.
- [ ] Only in-scope files plus the optional index status row are modified.
- [ ] Plan 019 is marked `DONE` unless the reviewer owns the index.

## STOP conditions

Stop and report if:

- Plans 002, 014, 032, 033, or 036 are not `DONE`, or their final command,
  runtime, fuse/environment, lazy-asset, or OCR contracts differ from their
  completion records.
- The real packaged lifecycle can only be observed by adding privileged IPC, a debug port, Node integration, a navigation exception, or an unauthenticated HTTP endpoint.
- The smoke cannot distinguish an orderly stopped acknowledgment from utility exit or the eight-second kill fallback.
- The packaged launch cannot own an exact POSIX process group, or the script cannot bound TERM→KILL cleanup and await the tracked child before profile removal without broad process matching.
- `safeStorage` is unavailable in the supported CI graphical session, or the packaged app cannot launch there after one evidence-based correction.
- The test would need to print/read out bootstrap session values, settings, account rows, service URLs, or secret material. In-memory equality of the signing-secret bytes is the only permitted content access.
- The packaged output path is ambiguous after plan 002, or lifecycle ownership is split after plan 014.
- Adding the lifecycle mode would require weakening a fuse, passing an extra
  utility-process environment variable, changing ASAR/unpacked policy, skipping
  a lazy asset, or replacing the existing packaged native/OCR or entitlement
  gate.
- A required fix is out of scope or a verification fails twice.

## Maintenance notes

- Keep this acceptance test at the packaged-binary boundary. Unit tests cannot replace it, and it should not grow into a model-backed product E2E.
- Any future shutdown phase must join the owned runtime’s stopped acknowledgment before the stopped marker is eligible.
- When packaging output changes, update the package producer and both package smokes together; never search broad directories for an executable.
- Plan 023 must replace the documented manual first-launch/shutdown gap with this exact command and its actual coverage, while retaining live-model/signing exclusions.
