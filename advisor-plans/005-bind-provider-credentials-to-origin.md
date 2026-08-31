# Plan 005: Bind every provider credential to one endpoint origin

> **Executor instructions**: Follow this plan exactly and run each verification.
> This work handles credential material: never print, snapshot, or include a
> credential value in failures, logs, commits, or documentation. Stop on any
> STOP condition. A reviewer maintains `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/settingsStore.ts server/src/runtimeSettings.ts server/src/llm.ts server/src/contained/runtime.ts server/src/tests/settingsStore.test.ts server/src/tests/settingsRoutes.test.ts server/src/tests/runtimeSettings.test.ts server/src/tests/llm.test.ts server/src/tests/containedRuntime.test.ts server/.env.example README.md docs/API.md`
> A mismatch with the current-state excerpts is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

The saved provider key is currently independent of `llm_base_url`. A PATCH or
connection preview that changes only the endpoint preserves the old key, so the
next probe, model call, or embedding can send a credential intended for origin A
to origin B. Persist an explicit non-secret origin binding, clear credentials on
unpaired origin changes, and migrate legacy settings fail-closed without losing
the user's non-secret model configuration.

## Current state

- `server/src/settingsStore.ts:66-73` persists a key but no binding:

  ```ts
  interface PersistedSettingsFile {
    readonly version: typeof SETTINGS_FILE_VERSION;
    readonly llm_base_url: string;
    readonly llm_api_key?: string;
    readonly lm_studio_base_url?: string;
    readonly default_chat_model: string;
    readonly default_embed_model: string;
  }
  ```

- `server/src/settingsStore.ts:318-331` explicitly carries an omitted key across
  every patch, including an origin change:

  ```ts
  return validateCompleteSettings({
    llmBaseUrl: patch.llmBaseUrl ?? current.llmBaseUrl,
    apiKey: patch.apiKey === undefined ? current.apiKey : patch.apiKey === null ? undefined : patch.apiKey,
    lmStudioBaseUrl:
      patch.lmStudioBaseUrl === undefined
        ? current.lmStudioBaseUrl
        : patch.lmStudioBaseUrl === null
          ? undefined
          : patch.lmStudioBaseUrl,
    chatModel: patch.chatModel ?? current.chatModel,
    embedModel: patch.embedModel ?? current.embedModel,
  });
  ```

- `server/src/routes/settings.ts:113-116` applies that same preview result to a
  body-free `/v1/models` probe. `probeSettingsConnection` adds an Authorization
  header whenever `settings.apiKey` is present.
- `server/src/llm.ts:321-337` caches a client by runtime revision and points it at
  `snapshot.settings.llmBaseUrl`; it assumes the store has already made the key
  safe for that origin.
- `server/src/tests/settingsStore.test.ts:75-90` and
  `server/src/tests/settingsRoutes.test.ts:89-133` prove omission preserves a key
  for model-only updates, but have no endpoint-change case. Preserve the
  model-only behavior. Test credential literals in those files are fixtures;
  never reproduce their values.
- `server/src/contained/runtime.ts:12-32` temporarily swaps only the origin and
  remembers only `previousBaseUrl`. The contained engine must switch to loopback
  without inheriting a remote key, then restore the original origin/key pair.
- Settings writes are serialized and atomic with mode `0600`; preserve that
  boundary. Public responses expose only `llm_api_key_configured`.
- The current atomic writer renames its temporary file and then performs a
  throwing `chmod` on the published path. That makes the durable commit point
  ambiguous: rename may have changed settings even though the patch reports
  failure. The mutation receipt/token contract below requires exactly one
  observable commit point.
- `modelEndpointOriginsEquivalent` already canonicalizes exact origins and
  equivalent loopback spellings. Reuse it for bindings.

## Target contract

- Settings file version 2 stores `llm_api_key_origin` only when it stores
  `llm_api_key`; the two fields are an inseparable pair.
- An effective key exists only when its bound origin is equivalent to the
  effective `llmBaseUrl`.
- A base-URL PATCH/preview with an omitted key clears the effective key when the
  origin changes. Supplying URL and key together atomically binds the new pair.
- Model-only and health-endpoint-only patches preserve the pair. Explicit `null`
  still clears it.
- A version-1 settings file preserves its endpoint/model fields but drops its
  unbound saved key and reports the key unconfigured until the user re-enters it.
- A process environment key is bound to one effective origin for that process.
  If the endpoint is also environment-managed, use that origin. If only the key
  is environment-managed, capture the first effective persisted/default origin,
  expose `llm_base_url` as managed for that process, and reject API attempts to
  retarget it. A direct file edit plus restart remains an explicit operator
  rebind.
- No response or log gains a credential or binding field.
- Contained-mode restore is an atomic compare-and-swap over the complete
  engine-applied effective settings snapshot **and** an opaque process-local
  mutation token. Every successful persistent Settings PATCH advances that
  token even when effective values are unchanged; preview never does. Any
  intervening Settings write, including A→human→A or a same-value PATCH, makes
  restore a no-op rather than overwriting the human choice.
- If a contained child crashes and another is applied before the first is
  explicitly stopped, the apply state preserves the first pre-engine origin/key
  pair while advancing only the expected engine-applied snapshot. Stopping the
  replacement restores the original human provider, never the dead first
  engine.
- A lost conditional replacement apply clears the entire old restore chain.
  Later stop/retry work can never match a stale dead-engine snapshot and restore
  over a human value that happens to equal it.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Store tests | `pnpm --filter borealis-server exec vitest run src/tests/settingsStore.test.ts src/tests/runtimeSettings.test.ts` | exit 0 |
| Route/wire tests | `pnpm --filter borealis-server exec vitest run src/tests/settingsRoutes.test.ts src/tests/llm.test.ts` | exit 0; no cross-origin Authorization |
| Contained restore tests | `pnpm --filter borealis-server exec vitest run src/tests/containedRuntime.test.ts` | exit 0 |
| Server suite | `pnpm --filter borealis-server test` | exit 0 |
| Static gates | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0 |

Do not install dependencies, build, run a formatter, or inspect real settings or
environment files. Use generated test-only values in memory.

## Scope

**In scope**:

- `server/src/settingsStore.ts`
- `server/src/runtimeSettings.ts`
- `server/src/llm.ts`
- `server/src/contained/runtime.ts`
- `server/src/tests/settingsStore.test.ts`
- `server/src/tests/settingsRoutes.test.ts`
- `server/src/tests/runtimeSettings.test.ts`
- `server/src/tests/llm.test.ts`
- `server/src/tests/containedRuntime.test.ts` (create)
- `server/.env.example`
- `README.md`
- `docs/API.md`

**Out of scope**:

- Changing supported provider schemes/origin validation.
- Encrypting settings, using Keychain, rotating credentials, or returning keys.
- Remote-egress consent; that is Plan 006.
- Settings UI redesign or adding a second provider.
- Reading any developer/user `.env` or settings file.

## Git workflow

- Branch: `codex/005-bind-provider-credentials-to-origin`
- Commit: `fix(security): bind provider credentials to origins`
- Do not push, open a PR, edit the plan index, or include credential values in
  commit text.

## Steps

### Step 1: Version and validate the persisted credential binding

In `server/src/settingsStore.ts`:

1. bump `SETTINGS_FILE_VERSION` from 1 to 2;
2. add an optional `llm_api_key_origin` to the v2 persisted shape;
3. represent the origin binding internally (for example, optional
   `apiKeyOrigin` beside `apiKey` in effective settings);
4. require both key and origin or neither, canonicalize the origin through the
   existing endpoint parser, and require origin equivalence with `llmBaseUrl`;
5. write both fields together atomically; and
6. decode version 1 as a legacy input: preserve valid non-secret endpoint,
   health endpoint, and model fields, deliberately omit the unbound key, and
   let the next successful PATCH write v2. Do not reject the whole file merely
   because its credential predates binding.

A malformed v2 pair (one field missing, invalid origin, or mismatch) must never
become an effective credential. Preserve opaque error handling and the 32 KiB
file bound.

Make `rename(temp, settingsPath)` the explicit final throwing commit step of the
atomic writer. Create the temporary file with `wx` and mode `0600`, verify or
repair that temporary handle's mode before sync/close/rename, and perform every
required fallible validation/hardening step before rename. After rename, do not
run a throwing `chmod` or other state-changing operation whose failure could
make the caller report rejection after the file committed. Directory fsync may
remain best-effort and content-free, matching the repository's durability
contract. The write queue advances its mutation token and publishes its receipt
whenever rename committed; there is no path where the durable file changes but
the token/receipt remains old.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/settingsStore.test.ts`
→ exit 0 with new v1 migration, v2 round-trip, missing-half, and mismatched-origin
cases. Add a persistence seam proving every injected pre-rename hardening
failure leaves the old file/token in place, while successful rename produces
the new file and exactly one new token. Prove no throwing post-rename chmod path
exists.

### Step 2: Make patch and preview origin-aware

Refactor `applyPatch` around the normalized target origin:

- explicit non-null `apiKey` binds to the target origin, including an atomic
  URL+key patch;
- explicit null clears key and binding;
- omitted key preserves the pair only if the target origin is equivalent to the
  current bound origin;
- omitted key on a different origin clears both in `patch` and `preview`;
- changes to model IDs or `lmStudioBaseUrl` alone preserve both.

Keep the public response shape unchanged. The settings test route must therefore
probe a draft new origin without sending the saved old-origin Authorization
header.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/settingsRoutes.test.ts`
→ exit 0; an injected fetch records no Authorization header for a URL-only
cross-origin preview, while an atomic URL+test-key preview records the expected
test header without persisting it.

### Step 3: Bind environment credentials for the process lifetime

Extend environment resolution without adding a new secret-bearing variable.
When an environment API key is present:

- bind it to the explicit environment base URL when one is present;
- otherwise capture the first effective persisted/default origin inside the
  store and mark `llm_base_url` managed as well as `llm_api_key`;
- reject PATCH/preview attempts to change the locked base URL with the existing
  `SettingsEnvironmentOverrideError`; and
- ensure a malformed or changed persisted origin cannot silently carry the
  environment key elsewhere during the same process.

Update runtime equality/revision logic to include the non-secret binding so an
effective credential change invalidates the cached client.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/settingsStore.test.ts src/tests/runtimeSettings.test.ts src/tests/llm.test.ts`
→ exit 0; tests cover explicit env URL+key, key-only origin lock, legacy aliases,
and a client rebuild only when effective settings change.

### Step 4: Preserve contained-mode switching without credential leakage

Add narrow internal Settings mutation receipts and a compare-and-patch operation
inside the store's existing serialized write queue. Maintain an opaque
process-local token (prefer an identity object/brand rather than a wrapping
counter). Initialize it with the loaded state and replace it on **every**
successful persistent `patch`, including a no-op/same-value PATCH; `preview` and
failed validation never advance it. The token is runtime concurrency authority,
not persisted data, and must never appear in public snapshots, HTTP, logs,
serialization, equality diagnostics, or test output/snapshots. Focused tests may
hold it opaquely only to exercise the internal conditional operation.

The internal atomic apply operation captures the complete before-settings,
applies a patch, and returns the complete after-settings plus its new opaque
token as one write-queue receipt. The conditional form accepts an expected token
and complete `EffectiveLlmSettings`, rereads/resolves inside that same critical
section, and applies only when token identity and every effective field
(including key/binding) match. On success return an internal receipt; on
mismatch return only `{ applied: false }`, never current settings, credential,
binding, token, or field-level comparison. Do not implement either operation as
a read followed by existing `patch`, because that leaves a race. Public PATCH
still returns only its existing redacted snapshot.

In `server/src/contained/runtime.ts`, use the one-queue atomic receipt to capture
the previous effective origin/key and apply the contained loopback origin with
an explicit key clear. Store the exact after-settings **and returned mutation
token** as the restore expectation. On stop, atomically restore the original
origin/key pair only if both the complete live settings and opaque token still
match that engine-applied receipt. A human endpoint, key-only (including a new
key at the same loopback origin), model, health-endpoint, same-value, or A→H→A
write makes the CAS a no-op; discard the restore record without overwriting it.
Never expose or log either saved value or the token.

Make reapply after a child crash explicit. The restore record contains both the
original pre-engine origin/key pair and the latest complete engine-applied
snapshot. When applying replacement engine B:

- if live effective settings and the mutation token still exactly equal the
  prior applied receipt for dead engine A, preserve the original pair,
  atomically apply keyless B, and replace only the expected applied receipt;
- if live settings differ, a human/operator write won the race: start a new
  restore chain from that live origin/key pair before atomically applying B; and
- if the conditional apply loses another settings race, do not overwrite it;
  clear the entire prior restore record before reporting auto-apply failure. B
  was not applied by this chain, so its eventual stop has no authority to reuse
  A's stale expected snapshot or original restore pair.

Never let a later apply replace the original restore pair with a prior engine's
loopback origin. This state remains process-local and is cleared after a
successful restore or any restore CAS mismatch.

Export or inject only the minimal endpoint-apply factory needed for a focused
`server/src/tests/containedRuntime.test.ts`. Assert headers at two loopback
fixture servers rather than inspecting a key value in output: the contained
origin gets no Authorization, and the restored original origin gets its
configured header. Also cover intervening endpoint, same-origin key-only, and
model-only writes; each must defeat the atomic restore and remain untouched.
Add a deterministic race in which the intervening write is queued between the
restore request and its store critical section, proving the conditional write
cannot overwrite it.

Add ABA regressions: after engine apply A, perform human H then deliberately
write the exact complete values of A before stop; separately perform a
same-value PATCH while A is active. Although values at stop equal the applied
snapshot, the opaque token differs, so restore must not run. Assert token values
only through behavior/spy calls; never serialize, snapshot, or print the token.

Add crash/reapply sequences without calling the first restore: remote R with a
key → keyless engine A → keyless engine B → stop B must restore R and its
matching header, never A. Repeat with a human write after A crashes and before B
applies; B's eventual stop restores/preserves that human pair. Add a conditional
apply race and prove the human write wins, the old chain is cleared, and no
later stop can use it. After the lost apply, write a human configuration whose
complete effective values deliberately equal dead engine A's prior applied
snapshot; stopping B must still leave it untouched and must not restore R.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/containedRuntime.test.ts src/tests/llm.test.ts`
→ exit 0.

### Step 5: Document the new operator-visible behavior

Update `server/.env.example`, `README.md`, and the Settings section of
`docs/API.md`:

- saved keys are origin-bound;
- changing an origin without a new key clears the saved credential;
- version-1 unbound keys require one-time re-entry;
- key-only environment configuration locks the resolved base URL for that
  process; and
- contained mode temporarily clears the remote key and restores it only with
  its original origin.

Keep privacy language explicit but never include a credential example.

**Verify**:
`pnpm --filter borealis-server format:check` → exit 0.

### Step 6: Run the complete focused gates

**Verify**:

- `pnpm --filter borealis-server test` → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.
- `rg -n 'llm_api_key_origin' server/src/settingsStore.ts server/src/tests docs/API.md README.md`
  → matches only the internal persisted contract, tests, and operator docs; no
  public response serializer exposes it.

## Test plan

- Store: v2 paired round-trip; v1 non-secret preservation with key dropped;
  malformed half-pairs; mismatched pair; same-origin model update; different-
  origin URL-only patch; atomic URL+key patch; explicit clear; loopback-equivalent
  origin.
- Environment: explicit URL+key pair; key-only process lock; API retarget rejected;
  direct restart behavior; compatibility aliases.
- Route: redacted response; preview does not persist; cross-origin preview omits
  Authorization; paired preview sends it only to the intended fixture origin.
- LLM/contained: cached client uses only a matching key; contained loopback is
  keyless; original pair restores only through the atomic full-snapshot CAS;
  endpoint, same-origin key-only, model-only, same-value, A→H→A, and queued-race
  changes win through the opaque mutation token; a
  crash/reapply chain restores the first human provider rather than a dead
  engine origin; a lost replacement apply clears the chain even if later human
  settings equal the dead engine snapshot.

## Done criteria

- [ ] No effective key can exist without an equivalent normalized origin binding.
- [ ] A URL-only origin change cannot send or persist the previous origin's key.
- [ ] Model-only updates still preserve the matching credential.
- [ ] Legacy v1 settings preserve non-secret fields and deactivate the unbound key.
- [ ] Environment keys cannot be retargeted through the Settings API.
- [ ] Contained mode does not leak or permanently discard the prior matching key.
- [ ] Contained restore cannot overwrite an intervening settings write, including
      a key-only change at the same loopback origin, a same-value PATCH, or an
      A→human→A value cycle.
- [ ] Reapplying after a contained child crash preserves the original pre-engine
      origin/key pair and never records a dead engine as the restore target.
- [ ] A lost conditional reapply discards the complete restore chain; a later
      human value equal to a dead engine snapshot cannot revive it.
- [ ] Public settings/status/error/log shapes contain no key or binding origin.
- [ ] Settings rename is the sole durable commit point; no reported write
      failure can leave a committed file with the prior mutation token/receipt.
- [ ] All focused and server static gates pass.
- [ ] `git status --short` contains only in-scope files.

## STOP conditions

Stop and report if:

- `SETTINGS_FILE_VERSION` is no longer 1 at plan start;
- a safe legacy decode cannot preserve non-secret settings while dropping the
  unbound credential;
- changing patch semantics requires returning the key or binding in an API;
- contained mode cannot restore the prior pair without persisting a second
  credential copy;
- the settings write queue cannot support a single critical-section
  mutation receipt/compare-and-patch with an unexposed opaque token and no
  credential material;
- settings publication cannot make every fallible hardening step precede the
  final rename, or a failure can occur after durable commit but before token
  advancement;
- a replacement contained engine cannot conditionally advance the applied
  snapshot while preserving the original restore pair;
- a failed conditional replacement apply cannot atomically invalidate the old
  in-memory restore chain before any later stop can observe it;
- a real credential or environment file is encountered (reference location and
  credential type only; never read or reproduce its value);
- any in-scope public API shape has already changed; or
- a verification fails twice after one reasonable correction.

## Maintenance notes

- Any future multi-provider design must store credentials per canonical origin,
  not revive one process-global key.
- Review every new caller of `SettingsStore.preview`: preview is an outbound
  credential boundary even though it is non-persistent.
- The contained restore token must advance on every successful persistent write,
  not only effective-value changes. It is intentionally separate from the LLM
  client revision and is never a public API field.
- Treat settings rename as the write/token linearization point. Never add a
  throwing post-rename mutation unless the persistence API can positively
  report that commit and advance the receipt despite that later failure.
- The binding origin is non-secret but remains internal because public settings
  already expose the selected endpoint itself.
- A restore record is authority, not a cache. Any failed conditional reapply
  invalidates the whole chain; never retain a stale expectation for convenience.
