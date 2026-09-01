# Plan 007: Restrict contained-engine control to the desktop operator

> **Executor instructions**: Do not start until Plans 004–006 are DONE. Follow every
> step and verification gate. This plan
> changes a process-spawn authority boundary; ordinary authenticated users must
> never regain it through a fallback. Never expose local paths, file hashes,
> tokens, or credentials in responses/logs. Stop on any STOP condition. A
> reviewer maintains `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/auth.ts server/src/desktopBootstrap.ts server/src/serverApp.ts server/src/routes.ts server/src/routes/contained.ts server/src/contained/configStore.ts server/src/contained/engineManager.ts server/src/contained/filePolicy.ts server/src/contained/runtime.ts server/src/routes/sources.ts server/src/routes/libraries.ts server/src/tests/agentVerticalIntegration.test.ts server/src/tests/desktopBootstrap.test.ts server/src/tests/modelRoutes.test.ts server/src/tests/serverApp.test.ts server/src/tests/contained.test.ts server/src/tests/containedEngine.test.ts server/src/tests/sourceManagementRoutes.test.ts server/src/tests/libraryRoutes.test.ts README.md docs/API.md desktop/README.md`
> Plan 004 creates the vertical route-composition test. Plan 005 intentionally
> changes `contained/runtime.ts` and supplies the
> compare-and-swap endpoint apply/restore contract consumed here. Any other
> material mismatch is a STOP condition. Plan 006 changes egress consent,
> last-mile authorization, `modelRoutes.test.ts`,
> `sourceManagementRoutes.test.ts`, and current docs; preserve those completed
> provider-revision and response contracts while editing the overlapping files.
> Plans 026, 031, 034, 035, and 037 are also completed baseline: keep
> authentication in `onRequest` with route-owned body limits, preserve paged
> catalog envelopes, retain qualification and embedding-migration routes, and
> compose through the exact workspace lock. Their expected changes are not a
> drift STOP; reconcile stale excerpts before implementing this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `advisor-plans/004-add-vertical-agent-integration-test.md`, `advisor-plans/005-bind-provider-credentials-to-origin.md`, `advisor-plans/006-bind-egress-consent-to-provider-revision.md`
- **Preserve completed baseline**: Plans 026, 031, 034, 035, and 037
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Every authenticated account can currently write global contained-engine config,
start/stop a host process, and start/cancel model downloads. The config accepts
an arbitrary absolute executable, arbitrary model path, and appended arguments;
ordinary API responses also disclose durable filesystem paths. Make process
control desktop-only and capability-based, verify exactly what is spawned, and
remove local paths from all authenticated DTOs.

## Current state

- `server/src/auth.ts:8-26` signs and verifies only user ID and email. Login and
  registration mint the same shape as desktop bootstrap.
- `server/src/desktopBootstrap.ts:34-40` creates a privileged local handoff but
  currently signs no distinct capability:

  ```ts
  return Object.freeze({
    token: signToken({ userId: user.id, email: user.email }),
    user: Object.freeze({ id: user.id, email: user.email }),
  });
  ```

- `server/src/routes/contained.ts:59-140` puts `requireAuth` on GET and every
  mutating route. An ordinary account can PUT config, POST a download, start or
  stop the engine, and cancel a download.
- `server/src/routes/contained.ts:62-66` returns raw stored config:

  ```ts
  return reply.send({
    config: await readContainedConfig(),
    engine: engineManager.snapshot(),
    downloads: downloadManager.snapshot(),
  });
  ```

- `server/src/contained/configStore.ts:26-57` accepts any absolute binary/model
  path and any bounded non-NUL `extra_args`; it stores no executable digest.
- `server/src/contained/engineManager.ts:97-103` checks only path accessibility:

  ```ts
  const config = await requireEnabledConfig();
  await Promise.all([
    fs
      .access(config.binary_path)
      .catch(() =>
        Promise.reject(new ContainedConfigError("binary_path does not exist")),
      ),
    fs
      .access(config.model_path)
      .catch(() =>
        Promise.reject(new ContainedConfigError("model_path does not exist")),
      ),
  ]);
  ```

  It later appends caller arguments after the fixed model/host/port flags
  (`server/src/contained/engineManager.ts:116-118`):

  ```ts
  const args = [
    "-m",
    config.model_path,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    ...config.extra_args,
  ];
  // Engine output is never read or logged; health is the only signal.
  child = spawn(config.binary_path, args, { stdio: "ignore" });
  ```

- `server/src/serverApp.ts:133-160` already derives a trusted `desktop` boolean,
  validates exact loopback binding/static UI, and creates the bootstrap only in
  desktop mode. `buildBorealisApp` currently does not pass that mode into routes.
- `server/src/routes/sources.ts:197-213` and
  `server/src/routes/libraries.ts:40-57` include `file_path` in upload/reingest
  and library-member DTOs. `docs/API.md:515-518` documents that exposure.
- The stable desktop email is account identity, not authority. Do not authorize
  by comparing email; a signed literal capability plus server desktop mode is
  required.
- Engine output must remain unread/unlogged, the child must bind
  `127.0.0.1` on an OS-assigned port, and orderly shutdown must still stop it.

## Target contract

- `AuthPayload` has an optional literal desktop-operator capability. Only
  `createDesktopBootstrapSession` mints it; register/login never do.
- A mutating contained route requires both a valid signed capability and the
  server instance's trusted `desktop: true` composition option. Missing either
  returns a stable 403 without touching config, files, downloads, or processes.
- `GET /api/contained` remains authenticated for status chrome but returns a
  redacted config projection with no absolute path, executable digest, or raw
  arguments. PUT returns the same redacted projection.
- Browser/server deployments configure contained mode only out-of-band; normal
  JWTs never gain process-control authority.
- Enabled config stores a required expected SHA-256 for the engine binary.
- At the final pre-spawn proof, the model is a non-symlink regular file contained
  below the canonical `config.containedDir`; the binary is a non-symlink
  executable regular file whose recomputed digest matches config. Open-handle
  identity is rechecked against each path immediately before spawning.
- A configured model basename can never be dot-only, the reserved
  `.borealis-partials` directory, or end in `.part` under ASCII case-folding.
  Download partials never become spawnable model files.
- Engine start admission is reserved synchronously before `start()`'s first
  await. One tracked generation-bound setup promise owns config read, file
  proof, port reservation, and spawn; every post-await continuation rechecks the
  reservation. Stop invalidates and joins setup, so concurrent starts cannot
  both spawn and a pre-spawn start cannot resume after stop.
- Engine health/auto-apply is a second tracked generation-bound promise. Stop or
  child exit invalidates the generation; no late successful probe can mark or
  apply a dead child, and orderly stop awaits both setup and health before
  restoring or closing settings.
- Extra args cannot restate/override model, host, or port in split or `--x=y`
  forms.
- No source or library API DTO includes a local `file_path`.

## Commands you will need

| Purpose           | Command                                                                                                                                                                  | Expected on success                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Auth/routes       | `pnpm --filter borealis-server exec vitest run src/tests/desktopBootstrap.test.ts src/tests/modelRoutes.test.ts src/tests/contained.test.ts src/tests/serverApp.test.ts` | exit 0; normal tokens get 403 and `/api/me` is capability-free |
| File/spawn policy | `pnpm --filter borealis-server exec vitest run src/tests/containedEngine.test.ts`                                                                                        | exit 0; symlink/hash/arg cases fail before spawn               |
| DTO regressions   | `pnpm --filter borealis-server exec vitest run src/tests/sourceManagementRoutes.test.ts src/tests/libraryRoutes.test.ts`                                                 | exit 0; no `file_path`                                         |
| Server tests      | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`                                                                                   | exit 0                                                         |
| Static gates      | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`                                            | exit 0                                                         |

Do not install, build, format, launch a real engine, or inspect real local model
or executable contents. Tests create disposable fixtures.

## Scope

**In scope**:

- `server/src/auth.ts`
- `server/src/desktopBootstrap.ts`
- `server/src/serverApp.ts`
- `server/src/routes.ts`
- `server/src/routes/contained.ts`
- `server/src/contained/configStore.ts`
- `server/src/contained/filePolicy.ts` (create)
- `server/src/contained/engineManager.ts`
- `server/src/routes/sources.ts`
- `server/src/routes/libraries.ts`
- `server/src/tests/desktopBootstrap.test.ts`
- `server/src/tests/agentVerticalIntegration.test.ts`
- `server/src/tests/modelRoutes.test.ts`
- `server/src/tests/serverApp.test.ts`
- `server/src/tests/contained.test.ts`
- `server/src/tests/containedEngine.test.ts`
- `server/src/tests/sourceManagementRoutes.test.ts`
- `server/src/tests/libraryRoutes.test.ts`
- `README.md`
- `docs/API.md`
- `desktop/README.md`

**Out of scope**:

- New account roles/admin tables, email-based privileges, or a browser admin UI.
- Electron preload/IPC expansion; the existing one-shot bootstrap is sufficient.
- Download transport/DNS hardening; that is Plan 008.
- Bundling a binary/model, changing llama-server flags, reading child output, or
  sandboxing the engine process.
- Returning raw paths to a privileged caller; redaction is universal.
- Treating a hostile process with the same OS-user filesystem authority as an
  isolation boundary. Node does not expose portable `fexecve`, and macOS cannot
  execute the current binary through `/dev/fd`; this plan detects replacement
  through the final identity check but does not claim to defeat a same-user
  replacement in the remaining kernel-open window.

## Git workflow

- Branch: `codex/007-restrict-contained-engine-control`
- Recommended commits:
  1. `fix(security): require desktop operator capability`
  2. `fix(contained): verify engine files before spawn`
  3. `fix(api): redact local storage paths`
- Do not push, open a PR, edit the plan index, or commit fixture executables.

## Steps

### Step 1: Mint and verify a literal desktop-operator capability

Extend `AuthPayload` with an optional literal capability (for example,
`desktopOperator?: true`). `verifyToken` must preserve it only when its decoded
value is exactly `true`; reject/omit all other types. Keep user ID/email checks,
HS256 restriction, and seven-day expiry.

Have `createDesktopBootstrapSession` include the capability. Keep registration
and login token creation unchanged. Add an auth helper that reads the verified
claim from `req.user`; never infer authority from `DESKTOP_ACCOUNT_EMAIL`.

Do not serialize the enlarged internal auth object. Change `/api/me` to project
only its existing public user ID and email fields explicitly; the capability
must be absent even when the request used a desktop-bootstrap token. Search for
any other whole-`req.user` response and replace it with the existing public DTO
projection rather than adding the claim to a schema.

Tests must prove:

- desktop bootstrap has the claim;
- registration/login-style tokens do not;
- a token with the desktop email but no claim is unprivileged; and
- a false/string/array claim is not accepted as capability; and
- `/api/me` has the identical public body for a normal or desktop-bootstrap
  session and never includes the capability field.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/desktopBootstrap.test.ts src/tests/modelRoutes.test.ts`
→ exit 0.

### Step 2: Pass trusted desktop mode into route composition

Add `desktop?: boolean` to `BuildBorealisAppOptions`. Pass the already-derived
`desktop` value from `startBorealisServer` into `buildBorealisApp`, then through a
typed routes option to a contained-routes factory. Do not read request headers,
host, email, or mutable environment inside the authorization decision.

Update Plan 004's real route registration to pass an explicit
`{ desktop: false }` test option while leaving its provider, route, agent, tool,
persistence, and SSE assertions unchanged. This is a composition-only update;
never mint the operator claim in that browser-mode vertical test. Later Plan
014 extends the same options object with an injected scheduler capability.

Create a `requireDesktopOperator` prehandler/factory that first applies normal
authentication, then requires `options.desktop === true` and the literal claim.
Return a stable generic 403 with request ID and no mode/account/path detail.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/serverApp.test.ts src/tests/contained.test.ts`
→ exit 0; ordinary auth and forged-email-without-claim get 403 in desktop mode,
and even a claimed token gets 403 in non-desktop mode.
Then run
`pnpm --filter borealis-server exec vitest run --config vitest.integration.config.ts src/tests/agentVerticalIntegration.test.ts`
→ exit 0 with Plan 004's complete turn behavior unchanged under the explicit
browser-mode option.

### Step 3: Apply capability enforcement to every mutation and redact reads

Use the new prehandler on exactly:

- `PUT /api/contained/config`
- `POST /api/contained/downloads`
- `DELETE /api/contained/downloads/:filename`
- `POST /api/contained/engine/start`
- `POST /api/contained/engine/stop`

Keep `GET /api/contained` under ordinary authentication, but project config to
safe status fields such as `enabled`, binary/model basenames, whether a binary
digest is configured, and extra-argument count. Do not return `binary_path`,
`model_path`, `binary_sha256`, or the argument array. Apply the same projection
to the PUT response.

For every denied mutation, spy on injected/test managers and assert zero side
effects. A real desktop-operator claim under `desktop: true` must retain success.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0 with a table-driven check over all five mutations and GET/PUT redaction.

### Step 4: Make contained configuration spawn-safe

Add a required 64-hex `binary_sha256` when `enabled` is true and persist it in
`contained.json`. Existing enabled configs without it must fail closed with a
generic reconfiguration error; disabled configs remain readable. Never return
the digest through HTTP or log it.

Reject extra arguments that can override fixed process authority. At minimum,
deny exact `-m`, `--model`, `--host`, and `--port` tokens, their `--flag=value`
forms, and any following-value form. Validate the complete argument array before
writing config and again before spawn for defense in depth. Preserve the count
and character budgets for allowed llama tuning flags.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts src/tests/containedEngine.test.ts`
→ exit 0; legacy enabled config, missing digest, invalid digest, and every
reserved-flag spelling are rejected without spawn.

### Step 5: Prove model and executable files immediately before spawn

Create `server/src/contained/filePolicy.ts` with small testable helpers:

- export one shared reserved-artifact predicate and the fixed internal partial
  directory basename `.borealis-partials` for Plan 008. Under ASCII
  case-folding, reject a dot-only basename, that internal directory name, and
  every basename ending `.part`;
- canonicalize `config.containedDir`, reject a symlink/non-directory root, and
  prove the configured model is a non-symlink regular file lexically and really
  below it; reject symlink path components and the root itself;
- prove the binary path and its components resolve exactly, final entry is a
  non-symlink regular file, and `fs.access(..., X_OK)` succeeds;
- open the binary without following the final symlink, verify its file identity
  with `fstat`, stream a SHA-256 from that handle, and compare the expected
  digest with `timingSafeEqual`; and
- open the model with the same no-follow/regular-file discipline and retain both
  handles; and
- immediately before spawn, re-stat both canonical paths and compare device,
  inode, size, and high-resolution modification/change timestamps with their
  retained `fstat` identities. Return a disposable proof object containing only
  canonical paths and open handles to `engineManager.start`.

Call this proof after reading enabled config and immediately before reserving a
port/spawning. Apply the reserved-artifact predicate to the configured model's
basename before opening it; an active/abandoned download partial must never be
accepted even when it is otherwise a regular file below the root. Add a narrow
injected hook between hashing and the final identity
check so tests can replace either path at that boundary; replacement must reject
before `spawn`. Keep both parent handles open until `spawn` either succeeds or
emits its immediate error, then close them on every success/failure/stop path.
Preserve path-based `spawn(file,args,{stdio:"ignore"})`, exact loopback flags,
and ignored output. Generic errors may identify the invalid field but must not
echo paths or hashes. The final stat closes deterministic application races; do
not describe it as an OS sandbox or fd-bound execution guarantee.

Tests use disposable executable/model files and cover: valid file; model outside
root; final symlink; symlinked parent; directory/device instead of regular file;
dot-only/reserved-directory model basename; `.part`, `.PART`, and mixed-case
suffixes; non-executable binary; digest mismatch; binary replaced between config and
start; binary or model replaced through the post-hash test hook before final
identity proof; handle cleanup; and no spawn call for every failure.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/containedEngine.test.ts`
→ exit 0.

### Step 6: Own setup, health, and auto-apply through one child generation

Add a synchronous single-start reservation before any setup await. On entry,
`start()` must reject when a prior setup, child, health pump, or stop is active;
otherwise it increments a generation, marks a start slot reserved, creates a
stable tracked completion promise, and stores it before returning to the event
loop. Launch the async setup only after that reservation/promise exists (for
example through a deferred microtask), so a synchronous throw cannot finalize
before ownership is visible.

The tracked `startPump: Promise<void> | undefined` owns every pre-spawn phase:
enabled-config read, complete argument validation, model/binary open-handle
proof, port reservation, final path/handle identity check, spawn, immediate
spawn-error handling, and proof-handle closure. After **every** await in that
path, recheck the exact generation, start entry, and stop flag before beginning
the next phase or mutating status. A stale/canceled setup closes its own proof
handles and exits without spawn. Only the exact entry's finalizer may clear
`startPump`; status from an invalid generation is inert. Once final identity has
been checked, assign the exact child/port and install its listeners plus health
pump in the same synchronous turn as `spawn`, before the setup promise resolves.

Replace detached `void waitUntilHealthy()` work with one
`healthPump: Promise<void> | undefined` owned by the manager. Give each start a
monotonically increasing generation token and capture the exact child and port.
The health loop, `autoApply`, and every continuation after `probe`, poll delay,
environment-management lookup, or endpoint apply must recheck all of these
before changing state or beginning the next operation:

- the captured generation is still current;
- `child` is the same captured process;
- stop has not been requested; and
- status still belongs to that start in `starting`/the expected phase.

Clear the pump only from an identity-checked `finally`. A new start while a
prior crashed/start generation's pump is still settling must await it or fail
with the stable already-settling error; it may not install a second health pump.
The child `exit` listener synchronously invalidates its generation before
clearing child state, so a probe result for a dead/replaced child is inert.

Make `stop()` reserve/cache one stop promise, synchronously invalidate the
generation, prevent new starts, and capture the exact setup pump, health pump,
and child before its first await. Signal/kill the captured child if present,
then await setup and health (including an apply already in flight). A setup that
had not spawned must observe invalidation and settle without spawning; if spawn
already happened in its final synchronous section, stop's captured/joined setup
must expose that exact child for the same stop operation rather than orphaning
it.

For a running child, send `SIGTERM`, wait the existing bounded exit deadline,
then send `SIGKILL` if necessary and wait a second bounded post-kill deadline for
that exact child's `exit`/`close`. Do not restore settings, clear child identity,
resolve stop, close the application runtime, or permit the desktop `stopped`
acknowledgement merely because `kill()` returned. If the exact process still
cannot be observed exited after the post-kill bound, fail stop with a stable
content-free lifecycle error so the caller withholds graceful-stopped success;
do not pretend shutdown completed. Retain the exact child identity and a
terminal poisoned stop reservation in that case. Never restore, clear to
`stopped`, or admit another setup/spawn in the process, even if a late exit event
arrives; recovery requires process restart unless a separately reviewed
exact-child recovery state machine is added later.

Only after no setup/health continuation can spawn or apply and the exact child
is observed exited may stop run Plan 005's compare-and-swap restore and return.
Clear the stop reservation only by exact identity after this completes; a new
start remains rejected while stop settles. Plan 014 can then rely on
`engineManager.stop()` settling before runtime settings close. Preserve bounded
probe/kill deadlines and never read child output.

In `containedEngine.test.ts`, first defer config read, file proof, and port
reservation at separate boundaries. At each boundary call stop, release it, and
prove stop remains pending until setup settles, spawn is never called, handles
close, and a concurrent second start is rejected before doing setup. Also hold
setup immediately after synchronous spawn and prove stop observes/terminates
that exact child rather than returning around it.

Then hold a probe immediately before it resolves true,
call stop, then release it. Prove stop waits, state never becomes healthy, and
apply is never called. Separately hold an already-entered apply, call stop,
release it, and prove restore runs after apply settles and before stop returns.
Cover child exit during a deferred probe, rapid crash/restart, concurrent stop,
identity-checked setup/health/stop cleanup, and no leaked timer/listener. Add a
stubborn-child case that ignores TERM: stop escalates to KILL, remains unsettled
until that exact child's deferred exit/close arrives, and reports a stable
failure rather than graceful completion if the post-kill exit bound expires.
After that timeout, assert a new start is rejected before config/proof/port/spawn
work and the poisoned exact-child ownership is not cleared by a late event.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/containedEngine.test.ts`
→ exit 0 with concurrent/pre-spawn start, late-probe/apply, crash/restart,
stubborn-child, and complete stop-drain regressions.

### Step 7: Remove local file paths from source/library DTOs

Delete `file_path` only from the API projection functions in
`server/src/routes/sources.ts` and `server/src/routes/libraries.ts`. Do not remove
the internal `SourceRecord.filePath`; ingestion and cleanup require it. Add
negative assertions to upload, reingest, and library-detail tests.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/sourceManagementRoutes.test.ts src/tests/libraryRoutes.test.ts`
→ exit 0 and serialized JSON contains no `file_path` key.

### Step 8: Update current API/operator documentation

Update README, `docs/API.md`, and `desktop/README.md`:

- contained mutations are desktop-operator-only and browser deployments use
  out-of-band configuration;
- GET/PUT return redacted config status;
- enabled config requires a verified executable digest;
- model files must reside under the contained model directory and symlinks are
  rejected; reserved `.part` artifacts can never be selected as models;
- reserved network/model flags cannot appear in `extra_args`; and
- source/library responses no longer expose local paths.

Do not describe the signed claim as a user-manageable token or publish its raw
JWT field as an API feature.

**Verify**:
`pnpm --filter borealis-server format:check` → exit 0.

### Step 9: Run full server gates

**Verify**:

- `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`
  → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.
- `rg -n 'file_path:' server/src/routes/sources.ts server/src/routes/libraries.ts`
  → no matches.
- `rg -n 'preHandler: requireAuth' server/src/routes/contained.ts` → matches the
  read-only GET only; every mutation uses desktop-operator enforcement.

## Test plan

- Auth: literal capability, no claim on normal sessions, forged email denied,
  malformed claims denied, and `/api/me` explicitly projects a capability-free
  public DTO for both session types.
- Route matrix: each mutation under unauthenticated, ordinary authenticated,
  claimed non-desktop, and claimed desktop conditions; zero denied side effects.
- Redaction: GET and PUT responses contain no paths, digest, or raw args.
- File policy: containment, symlinks, regular/executable type, digest,
  reserved partial basenames, pre-start and post-hash/pre-final-check
  replacement, handle cleanup, and reserved-argument cases all fail before
  spawn.
- Engine setup: synchronous single-start reservation, deferred tracked setup,
  generation checks after config/proof/port awaits, stop-before-spawn drainage,
  and exact-child capture for a spawn concurrent with stop.
- Positive engine test retains exact `-m`, `--host 127.0.0.1`, OS port, allowed
  tuning args, health, and stop behavior.
- Engine lifecycle: deferred probe true after stop/exit is inert; in-flight
  apply drains before restore; crash/restart uses one generation-bound pump;
  concurrent stop leaks no timers/listeners; TERM escalation joins exact-child
  exit/close after KILL or fails without reporting graceful stop.
- Source/library: list/upload/reingest/detail DTOs contain no local path.

## Done criteria

- [ ] No normal JWT can mutate contained config/download/engine state.
- [ ] Desktop email alone grants nothing; capability plus desktop mode is required.
- [ ] No public auth response, including `/api/me`, serializes the capability.
- [ ] GET/PUT contained responses reveal no absolute path, digest, or raw args.
- [ ] Engine binary and contained model pass open-handle/path-identity proof at
      the final pre-spawn check; the documentation does not claim fd-bound
      execution or same-user filesystem isolation.
- [ ] Binary digest and executable bit are verified; mismatch causes no spawn.
- [ ] Dot-only/reserved/ASCII-case-insensitive `.part` model basenames fail
      before open/spawn through the predicate shared with Plan 008.
- [ ] Extra args cannot override model, host, or port.
- [ ] Source and library DTOs contain no `file_path`.
- [ ] Existing loopback spawn/output/shutdown invariants remain tested.
- [ ] Start owns one synchronous reservation and tracked pre-spawn setup promise;
      a concurrent start or stop cannot permit a late or duplicate spawn.
- [ ] Stop/child exit invalidates and drains the tracked health/auto-apply pump;
      no late probe can apply a dead child or outlive settings close.
- [ ] Stop observes the exact child's exit/close after TERM or KILL before
      restore/runtime closure; a child that cannot be reaped prevents graceful
      stopped success and permanently poisons new starts for that process.
- [ ] All server test and static gates pass; only in-scope files changed.

## STOP conditions

Stop and report if:

- desktop bootstrap is no longer the only trusted session handoff;
- a normal login/registration path already mints a capability or role that
  conflicts with this literal claim;
- trusted desktop mode cannot be passed from `startBorealisServer` without
  deriving it from request-controlled data;
- supporting the configured binary requires allowing a symlink or an unverifiable
  executable;
- `.part`/reserved partial artifacts must remain selectable as engine models;
- config/file/port setup cannot be synchronously reserved, generation-checked
  after each await, and joined by stop before any late spawn;
- health probing or endpoint apply cannot be bound to an exact child generation
  and drained before restore/settings close;
- the supported child-process seam cannot observe exact-child exit/close after
  TERM→KILL escalation within a second bounded deadline;
- a post-KILL exit timeout cannot retain poisoned exact-child ownership and
  reject every later start without setup/spawn;
- the implementation or documentation requires claiming portable fd-bound
  execution or defense against a hostile process with the same OS-user
  filesystem authority;
- a valid llama-server option is found to override model/host/port under a name
  not covered here; report it and expand the explicit denylist only after review;
- production requires browser accounts to control host processes (that needs a
  separately designed admin authority); or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- The capability authorizes host process control, not general administration;
  do not reuse it casually.
- Reviewers should scrutinize prehandler ordering, zero-side-effect 403 tests,
  the final open-handle/path identity check and its explicitly narrow threat
  model, and every allowed extra arg.
- Setup, health, and stop are one generation even though they use separate
  tracked promises. A new await in any pre-spawn phase needs a post-await
  identity check and stop must join it.
- Future contained UIs should invoke these routes only from the desktop bootstrap
  session; do not add capability issuance to the browser API.
- `.borealis-partials`, dot-only names, and the ASCII-case-insensitive `.part`
  suffix form one shared filename contract across engine selection and Plan
  008's download manager; change the predicate and both suites together.
- Health probing and live endpoint apply are child-generation work. Keep their
  promise owned by the engine manager and joined by `stop()` before endpoint
  restoration or runtime-settings closure.
- A stop timeout is not a released lock. Preserve the poisoned stop/child
  identity until process exit; never trade availability for a possible second
  engine beside an unobserved first one.
