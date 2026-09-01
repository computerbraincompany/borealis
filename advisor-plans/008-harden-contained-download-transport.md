# Plan 008: Harden contained-model download transport

> **Executor instructions**: Execute in order and run every verification. Keep
> validated loopback HTTP support for deterministic/local transfers, but permit
> HTTPS only when DNS resolves entirely to public addresses and pin that result
> to the socket. Never weaken the existing public-fetch policy. Stop on a STOP
> condition. A reviewer maintains `advisor-plans/README.md`; do not edit it.
>
> **Drift check (run first)**:
> `git diff --stat f1b9293..HEAD -- server/src/contained/downloadManager.ts server/src/contained/filePolicy.ts server/src/networkPolicy.ts server/src/tests/contained.test.ts server/src/tests/networkPolicy.test.ts server/.env.example README.md docs/API.md`
> Plan 007 changes contained authorization/config but should not replace the
> download transport. Plan 026's `onRequest` authentication and derived
> contained-download body limit are already shipped and must remain ahead of
> parsing; transport work begins only after that boundary. This expected drift
> is not a STOP condition. Reconcile the live route tests first and STOP only on
> other material transport or file-authority drift.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `advisor-plans/007-restrict-contained-engine-control.md`
- **Preserve completed baseline**: Plan 026
- **Category**: security
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Contained downloads validate only the URL's scheme/hostname spelling and then
use global `fetch`. Public HTTPS names are not checked against private/link-local
DNS results or pinned, and `localhost` is not proven to resolve only to loopback.
The transfer also has no deadline, does not request identity encoding, and
accepts loose resume metadata. Use the repository's low-level DNS-pinned
transport pattern and strictly validate the bytes appended to a partial file
before the existing SHA-256 publication boundary.

## Current state

- `server/src/contained/downloadManager.ts:57-76` accepts every HTTPS URL and
  loopback-spelled HTTP, without resolving it:

  ```ts
  const isLoopbackHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || /* IPv6 loopback */);
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new ContainedDownloadError("model downloads require HTTPS or a loopback HTTP origin");
  }
  ```

- `server/src/contained/downloadManager.ts:143-170` uses global fetch and a
  permissive resume path:

  ```ts
  const headers = { Accept: "application/octet-stream" };
  if (state.bytes_received > 0)
    headers.Range = `bytes=${state.bytes_received}-`;
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: abort.signal,
  });
  // accepts 200 or 206; parses only the total after '/'
  ```

- The streamed-byte maximum and final SHA-256 check at
  `downloadManager.ts:171-193` are valuable and must remain. `.part` files do not
  count as complete models.
- `server/src/networkPolicy.ts:119-168` already resolves public destinations,
  rejects any unsafe answer, and `requestPinned` supplies the validated address
  through the socket's `lookup` callback to prevent DNS-rebinding TOCTOU.
- `server/src/data/connectorFetch.ts:254-315` is the local exemplar for an
  injectable `{resolve,request}` transport, one operation signal, identity
  encoding, bounded streaming, and `IncomingMessage` cleanup.
- `server/src/tests/contained.test.ts:56-82` has a loopback fixture server with
  200/206 behavior. Preserve that positive path, but strengthen its range
  assertions.
- Current download rules intentionally reject redirects, URL credentials,
  queries, and fragments, and require an expected SHA-256. Keep them.

## Target contract

- `http:` is accepted only for exact loopback URL host forms, after DNS/literal
  resolution proves every address is loopback; the socket is pinned to a proven
  address.
- `https:` is accepted only when every resolved address passes the existing
  public-destination policy; private, loopback, link-local, metadata, reserved,
  and mixed public/private answers fail before request.
- HTTPS-to-private is not made safe merely by TLS or a public hostname.
- One bounded operation signal covers resolution, connect, headers, and body.
- Requests send `Accept-Encoding: identity`; encoded responses are rejected.
- Fresh downloads accept 200. Resumes accept either 200 (truncate/restart) or a
  206 whose `Content-Range` starts exactly at the existing internal-partial size, ends
  exactly at `TOTAL - 1` (the manager issues only one resumed request), and has
  internally consistent safe total/length values within the maximum.
- The actual bytes must match declared lengths when present, the file is fsynced
  before hashing, and checksum success still precedes atomic rename.
- Plan 007's shared filename policy rejects dot-only names, the reserved
  `.borealis-partials` basename, and every final filename ending in `.part`
  under ASCII case-folding. Active reservations and direct-child namespace
  collision checks use the same conservative ASCII-lowercase key, so
  `Model.gguf` and `model.gguf` cannot race or behave differently on
  case-sensitive versus default case-insensitive macOS filesystems.
- `start()` installs the exact per-key reservation, abort controller, state,
  and tracked run promise synchronously before its first `await`. A concurrent
  same-name/case-alias start therefore fails before filesystem or transport
  work, and only that exact entry may release the reservation.
- Partials live only below the real, non-symlink
  `<contained>/.borealis-partials/` directory. Ambiguous legacy root-level
  `*.part` entries are never read, migrated, truncated, or deleted. A
  pre-existing final entry or ASCII-case alias blocks the download, whatever
  its file type.
- The contained-model directory, internal partial directory, final model entry,
  and partial entry are proven with the no-symlink regular-file discipline
  introduced by Plan 007.
- The partial file is opened exactly once with `O_NOFOLLOW`; resume size,
  streaming, fsync, and SHA-256 all use that same verified handle. Replacing the
  pathname after it is opened fails publication and never mutates the
  replacement or an outside target.
- Immediately before publication, the internal partial pathname still has to
  identify the opened file. Atomic rename remains the publication boundary. As
  in Plan 007, this protects application-controlled races and symlink attacks;
  it is not an OS sandbox against a hostile user with write access to the model
  directory.
- Each entry has one synchronous `publicationStarted` point of no return after
  its final abort/identity/namespace checks and immediately before `rename` is
  initiated. Cancel accepted before that point joins cleanup and publishes
  nothing. Cancel arriving at/after it is too late, does not mark the entry
  canceled or abort publication, joins the run, and returns the existing false/
  not-canceled result. Quiescence always joins publication and directory fsync.
- The manager has an idempotent process-lifecycle boundary. `quiesceAndDrain()`
  stops admission synchronously, aborts each exact entry that has not begun
  publication, and joins publishing entries without changing their outcome. It
  awaits all setup, transport, writer, verification, publication, directory-
  fsync, handle-cleanup, and reservation promises. `beginLifecycle()` can
  re-enable admission only after that drain;
  Plan 014 must await the drain before settings/storage close or the desktop
  `stopped` acknowledgement.

## Commands you will need

| Purpose               | Command                                                                                                                       | Expected on success                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Download tests        | `pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`                                                   | exit 0; transport, artifact ownership, case-alias reservation, publication/cancel linearization, and manager-drain cases pass |
| Shared network policy | `pnpm --filter borealis-server exec vitest run src/tests/networkPolicy.test.ts`                                               | exit 0; existing public fetch remains fail-closed                                                                             |
| Server tests          | `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`                                        | exit 0                                                                                                                        |
| Static gates          | `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check` | exit 0                                                                                                                        |

Do not install, build, format, access the public internet, or download a real
model. All transport tests use injected responses or loopback fixtures.

## Scope

**In scope**:

- `server/src/networkPolicy.ts`
- `server/src/contained/downloadManager.ts`
- `server/src/contained/filePolicy.ts`
- `server/src/tests/networkPolicy.test.ts`
- `server/src/tests/contained.test.ts`
- `server/.env.example`
- `README.md`
- `docs/API.md`

**Out of scope**:

- Contained route authorization, config, executable verification, or engine
  spawn behavior (Plan 007), except extending its shared contained-file proof
  helpers for download artifacts.
- Connector and agent `fetch_url` behavior except shared helper refactoring that
  preserves their current tests exactly.
- Redirect support, signed-query URLs, proxy support, mirrors, parallel chunks,
  or a download UI.
- Changing the 64 GiB default maximum or checksum algorithm.

## Git workflow

- Branch: `codex/008-harden-contained-download-transport`
- Commit: `fix(security): harden contained download transport`
- Do not push, open a PR, edit the plan index, or commit downloaded/partial files.

## Steps

### Step 1: Add explicit public-versus-loopback resolution helpers

In `server/src/networkPolicy.ts`, keep `resolvePublicDestination` semantics
unchanged. Add narrowly named reusable helpers for contained downloads:

- recognize exact loopback IP literals and `localhost` without accepting
  suffix/lookalike names;
- resolve loopback names with the same abort-aware DNS pattern, require at least
  one result and require every result to be loopback;
- route public HTTPS to `resolvePublicDestination`; and
- route validated loopback HTTP to the loopback resolver, rejecting every other
  scheme/host combination.

Return the existing `ResolvedAddress[]` and use `requestPinned` unchanged for
socket pinning/TLS hostname verification. Do not add loopback allowances to
`resolvePublicDestination`, because connectors and `fetch_url` must continue to
reject them.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/networkPolicy.test.ts`
→ exit 0 with new tests for public HTTPS, private/mixed HTTPS, exact IPv4/IPv6
loopback HTTP, localhost resolving only loopback, and poisoned localhost/public
resolution.

### Step 2: Replace global fetch with an injectable pinned transport

Define a contained download transport interface matching the repository pattern:

```ts
interface ContainedDownloadTransport {
  resolve(url: URL, signal: AbortSignal): Promise<ResolvedAddress[]>;
  request(
    url: URL,
    addresses: ResolvedAddress[],
    signal: AbortSignal,
    headers: Record<string, string>,
  ): Promise<IncomingMessage>;
}
```

Let `createContainedDownloadManager` accept optional transport, maximum bytes,
and timeout dependencies for tests. Production defaults use the new resolver and
`requestPinned`. Parse/validate the URL once, then use one combined cancel plus
timeout signal for resolution, request, and body iteration. Name the operator
override `CONTAINED_DOWNLOAD_TIMEOUT_MS`: default `86_400_000` (24 hours),
minimum `60_000` (one minute), and maximum `604_800_000` (seven days). Accept
only safe integers in that closed range; absent/empty/invalid values use the
default. Document those exact units and bounds in `server/.env.example`.

Send `Accept: application/octet-stream`, `Accept-Encoding: identity`, and a
fixed product User-Agent. Destroy every rejected response. Map policy, timeout,
and transport failures to stable content-free download errors; never echo URL,
address, response body, or exception.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0; injected transport sees the exact headers and one shared signal, and a
timeout reaches failed/canceled state without a completed file.

### Step 3: Validate fresh and resumed response contracts

Implement strict header parsers using safe integers:

- reject `Content-Encoding` unless absent or `identity`;
- on a fresh request, accept only 200 and start from zero;
- on a resume, accept 200 by truncating/restarting, or accept 206 only with
  `Content-Range: bytes START-END/TOTAL` where `START` equals existing size,
  `END >= START`, `END === TOTAL - 1`, all values are safe, and `TOTAL <= max`;
- if `Content-Length` is present, require it to equal the expected segment length
  `TOTAL - START` for 206 and keep total within max for 200;
- reject 206 without an existing partial or without a valid range; and
- after streaming, require received segment bytes to equal declared/expected
  segment length when known. Premature EOF is failure, not a resumable success.

Do not remove an existing partial merely because a network/policy failure is
retryable. Do remove it on checksum mismatch as today. Ensure a server returning
200 to a Range request truncates rather than appends.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0 with cases for exact resume, wrong start, missing/malformed range,
unsafe total, inconsistent content length, premature EOF, encoded body, 200
restart, and maximum streamed bytes.

### Step 4: Reserve each filename synchronously and make the manager drainable

Reuse Plan 007's shared reserved-artifact predicate. Convert an accepted
filename to a conservative ASCII-lowercase key for all in-memory ownership and
cancellation lookups while preserving the original spelling only in the public
state and selected final pathname. Reject dot-only names,
`.borealis-partials` in any ASCII case, and any name ending in `.part` in any
ASCII case before touching the filesystem.

Refactor `start()` so no asynchronous gap exists between checking and owning a
target:

1. synchronously validate URL, filename, digest, and lifecycle admission;
2. reject an existing active reservation for the case-folded key;
3. synchronously create the state, abort controller, exact entry identity, and
   a stable completion promise, store that promise on the entry, and install the
   entry in an `activeReservations` map;
4. only after the entry and promise are installed, launch one deferred async run
   function containing **all** filesystem setup, resolution, request, body,
   hash, publication, and cleanup awaits; settle the already-stored completion
   promise from that run's identity-checked finalizer; and
5. remove the reservation only from the run's identity-checked finalizer when
   `activeReservations.get(key) === entry` and every owned writer/handle is
   settled.

Do not use a check-then-await-then-insert sequence. Terminal snapshot/history
state is not an active reservation and cannot authorize cleanup. A retry may
replace terminal state only after the exact prior run promise has settled and
released its reservation. `cancel()` must case-fold its input, capture the exact
entry, and linearize against its synchronous `publicationStarted` flag. Before
that point it sets the explicit-cancel reason, aborts, awaits the run, and
returns true only after owned cleanup. At or after that point it must not alter
state or signal the run; it awaits completion and returns false because
publication is already committed to finishing. Owned-artifact cleanup belongs
to that joined run and must never be an independent early `rm`. The deferred
launch is load-bearing: the run must not be able to throw/finalize synchronously
before its map entry and completion promise exist.

Add manager lifecycle methods. The manager may begin in its current accepting
state for backward compatibility. `quiesceAndDrain()` must set admission false
and capture all exact reservations synchronously before its first await. Abort
only entries whose publication point has not begun; publishing entries are
joined without changing state. Cache the drain promise for idempotence and await
every captured run through its finalizer. A start after quiescence fails without
state, filesystem, DNS, or request work. `beginLifecycle()` may reopen admission only when the prior drain
has settled and the active-reservation map is empty; advance a lifecycle epoch
so stale completions can mutate only their captured entry. It is idempotent
within the initial active lifecycle, but it must reject an attempted reopen
while drainage is incomplete. A successful reopen clears only the settled drain
for the new epoch. Plan 014 provides the exclusive application owner that calls
these process-wide methods.

Distinguish an accepted explicit cancel from lifecycle quiescence and a too-late
cancel. Accepted cancel removes only its identity-proven owned partial after the
writer and handle settle. Quiescence may leave only that same proven, closed,
singly-linked regular partial for a later resume; if publication already began,
it awaits publication/fsync instead. A too-late cancel joins without changing
the eventual complete/failed state. None may leave a request, reader, timer,
writer, file handle, or run promise alive. Replaced/unproven pathnames are left
untouched.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0 with a deferred-preparation double-start test proving exactly one of
same-spelling and mixed-case aliases owns a reservation/issues a request; mixed-
case cancel addresses that exact owner; quiescence rejects new work immediately
and remains pending until deferred request/writer/handle cleanup settles; a
second quiesce joins the same drain; and `beginLifecycle()` cannot reopen early
but permits a clean subsequent run after drainage.

### Step 5: Open and prove download artifacts without following links

Extend Plan 007's `server/src/contained/filePolicy.ts` helpers rather than
inventing a second path policy. Canonicalize the contained-model root and prove
that the root and every path component are real directories, not symlinks.
Create or open exactly one reserved `.borealis-partials` direct child at mode
`0700`, then prove with `lstat`/real-path checks that it is a real non-symlink
directory below the canonical root. A pre-existing symlink or non-directory at
that name fails closed.

Use direct-child directory enumeration plus exact `lstat` immediately before
transfer and again before publication to reject any final-path entry or
ASCII-case alias — regular file, symlink (including dangling), directory, FIFO,
socket, or device. Apply the same case-folded collision check inside the partial
directory for `${filename}.part`. These scans complement the synchronous
application reservation; they do not claim an OS lock against a hostile process
with the same directory authority.

New and resumable partials live only at
`<contained>/.borealis-partials/${filename}.part`. Never treat a root-level
`${filename}.part` as a resumable partial: it may be a completed legacy model
whose name happens to end in `.part`. Leave every such root entry byte-for-byte
untouched, while Plan 007's predicate prevents selecting it as a model.

Open the internal partial once and retain that handle for the complete attempt:

- when the pathname is absent, use numeric flags equivalent to
  `O_RDWR | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`;
- when it exists, use `O_RDWR | O_APPEND | O_NOFOLLOW`, then require `fstat` to
  report a regular file with link count exactly one and require `lstat` plus
  `fstat` to identify the same device/inode; and
- derive resume size only from the opened handle's `fstat`, never from a
  pre-open `stat` or state row.

Reject every non-regular, symlink, or multiply-linked partial before truncating
or appending. A 200 response to a resume request may restart the transfer, but truncate through
the already-proven handle. Keep this handle open across streaming, restart,
sync, and hashing. Add a narrow injected post-open/pre-publication hook for
deterministic replacement tests; it must be package-internal and unreachable
from production route inputs.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0; a pre-existing internal partial symlink or hard link to an outside
sentinel, dangling symlink, directory, FIFO, and other non-regular entry all
fail without changing the target/sentinel, issuing a request, or creating a
final file. Cover final/partial mixed-case aliases, a symlinked reserved
directory, rejected dot-only/reserved/`.part` final names, and a root-level
`model.gguf.part` sentinel that remains untouched while `model.gguf` uses only
the internal partial directory.

### Step 6: Hash the verified handle and publish only its identity

After transport success, call `sync()` on the retained partial handle and
compute SHA-256 by reading from that same handle (for example with positional
reads or a stream using `autoClose: false`). Do not close and reopen the path for
hashing. Retain the original open-time device/inode/link/type proof, then take a
**fresh post-write, post-sync, post-hash `fstat`** from that same handle. Require
the fresh result to remain the original regular device/inode with link count
one; use the fresh result, not the necessarily stale pre-write size/timestamps,
as the final publication identity. On checksum mismatch, settle the writer and
remove the partial only after `lstat` still matches that fresh final identity;
otherwise close and leave the replacement untouched. Never follow or unlink an
unproven entry.

Immediately before rename, `lstat` the internal partial pathname and compare device,
inode, link count (still exactly one), file type, size, and high-resolution
modification/change timestamps with
the fresh final `fstat` identity. If it no longer names that exact regular file,
close and fail without deleting or publishing the replacement.
Immediately re-`lstat` the final path and require `ENOENT`; every other result or
error or ASCII-case alias blocks publication. Close the verified handle,
perform one final synchronous abort/cancel check, then set
`entry.publicationStarted = true` synchronously as the linearization point
immediately before initiating rename. No await may separate that final check,
the flag, and the `rename(...)` call. Atomically rename the internal partial to
the still-absent final path, and best-effort fsync both the internal partial
directory and containing model directory, matching the atomic settings-file
pattern in `server/src/settingsStore.ts`. Because both directories are below the
same canonical root, publication stays a same-filesystem atomic rename. Keep
the reservation and run promise active through both directory-fsync attempts;
never mark state `complete` before they finish.

The joined run implements Step 4's linearized outcomes. An explicit cancel
accepted before `publicationStarted` aborts and awaits the active reader/writer,
closes the retained handle, and removes the partial only if it still identifies
the attempt's file. A cancel at/after the flag is too late: it neither sets
`canceled` nor aborts/deletes anything, joins the rename/fsync run, and returns
false. Lifecycle quiescence before the flag may preserve only a proven closed
partial for resume; at/after the flag it joins publication to its complete or
failed terminal state. A late writer must not recreate bytes after an accepted
cancel returns, and no rename/fsync may outlive any joined operation. Keep
cancel and drain idempotent and bounded. Document the residual same-OS-user
directory replacement race consistently with Plan 007; do not claim fd-bound
rename or filesystem isolation that the path-based publication does not provide.

**Verify**:
`pnpm --filter borealis-server exec vitest run src/tests/contained.test.ts`
→ exit 0; same-handle hashing is observed; replacement through the test hook
fails without touching replacement/outside bytes; an accepted pre-publication
cancel leaves neither final nor owned partial file; checksum mismatch removes
only the owned partial; and successful rename begins with the expected exact
bytes. Assert the open-time snapshot changes as bytes are written, a fresh
post-hash `fstat` is captured, and the pathname comparison uses that fresh
size/high-resolution timestamp snapshot while preserving the original
device/inode proof. With injected deferred rename and deferred directory fsync, prove a
post-linearization cancel returns false only after joining and never changes the
complete/failed outcome, while quiescence stays unsettled until publication and
both fsync attempts settle. A hook immediately before the linearization point
must let an accepted cancel prevent the rename entirely.

### Step 7: Update transport and lifecycle documentation

Update README, `docs/API.md`, and `server/.env.example` with:

- public HTTPS DNS validation/pinning;
- separately validated loopback HTTP support;
- no redirects or encoded responses;
- strict resume range behavior;
- the exact `CONTAINED_DOWNLOAD_TIMEOUT_MS` 24-hour default and one-minute to
  seven-day bounds; and
- SHA-256 plus fsync/atomic publication.

Also document that contained download paths reject symlinks and non-regular
files; filenames are case-folded for ownership and reject the shared reserved
forms; resumable partials live below `.borealis-partials`; ambiguous legacy
root-level `*.part` entries are untouched; and resume, hashing, and publication
are tied to one opened partial file. State that orderly application shutdown
quiesces and joins every download before reporting stopped. Do not describe
this as protection from another local user who can mutate the model directory.

Do not claim certificate pinning; the implementation pins the validated DNS
address while normal TLS hostname verification remains in force.

**Verify**:
`pnpm --filter borealis-server format:check` → exit 0.

### Step 8: Run complete server gates

**Verify**:

- `pnpm --filter borealis-server test && pnpm --filter borealis-server test:integration`
  → exit 0.
- `pnpm --filter borealis-server typecheck && pnpm --filter borealis-server lint && pnpm --filter borealis-server format:check`
  → exit 0.
- `rg -n 'fetch\(' server/src/contained/downloadManager.ts` → no matches; the
  contained manager uses the injected pinned transport.
- `rg -n 'resolvePublicDestination' server/src/networkPolicy.ts server/src/data/connectorFetch.ts`
  → existing public consumers still use the public-only resolver.

## Test plan

- Resolution: public HTTPS success, private/link-local/mixed DNS rejection,
  loopback HTTP success, poisoned localhost rejection, no request after failure.
- Pinning: request receives the exact resolved address and does not perform an
  unconstrained second lookup.
- Headers/deadline: identity encoding requested, encoded responses rejected,
  one signal across phases, timeout/cancel cleanly terminates.
- Resume: correct full-tail 206, 200 restart, no-partial 206, wrong
  start/nonterminal end/total,
  malformed/oversized/contradictory declarations, premature EOF.
- Reservation: the first same-name/case-alias start owns the key before any
  await; the loser performs no filesystem/DNS/request work; mixed-case cancel
  joins the exact entry; exact-identity finalization cannot delete a retry.
- Lifecycle: quiescence rejects admission synchronously, aborts and joins
  deferred setup/request/writer/handle work, is idempotent, leaves at most a
  proven closed resumable partial before publication, joins deferred
  rename/directory-fsync after publication, and permits a new lifecycle only
  after drain.
- Publication race: accepted cancel immediately before the point of no return
  prevents rename; cancel during deferred rename or either directory fsync is
  too late, joins, returns false, and cannot overwrite the terminal outcome.
- Files: dot-only/reserved/`.part` final-name rejection; final and partial
  case-alias conflicts; real `.borealis-partials` directory; new/resumed
  no-follow open; symlink/hard-link/dangling-symlink/directory/FIFO rejection;
  outside and legacy root-level `.part` sentinels unchanged; resume size from
  `fstat`; one handle across truncate/write/fsync/hash; replacement identity
  failure; checksum cleanup of only the owned internal partial; atomic
  cross-directory final rename; and cancellation after writer settlement leaves
  no owned artifact.
- Existing `networkPolicy.test.ts` remains green to prove no weakening of
  connector/agent public fetch rules.

## Done criteria

- [ ] Public HTTPS connects only to a validated, pinned public address.
- [ ] Loopback HTTP works only after every resolved address is proven loopback.
- [ ] Private/mixed DNS and rebinding attempts make zero unsafe requests.
- [ ] One bounded signal covers DNS through final body byte.
- [ ] Identity encoding and strict range/length contracts are enforced.
- [ ] Size and SHA-256 gates remain at the streamed/file boundary.
- [ ] A synchronous ASCII-case-folded reservation makes concurrent aliases
      mutually exclusive before any await; cancel and release use exact entry
      identity.
- [ ] Dot-only, `.borealis-partials`, and ASCII-case-insensitive `.part` final
      names are rejected through Plan 007's shared predicate.
- [ ] Final, reserved-directory, and internal-partial paths cannot follow
      symlinks or accept multiply-linked/non-regular entries, and outside plus
      root-level legacy `.part` sentinels are unchanged in every negative test.
- [ ] Resume size, writes, fsync, and SHA-256 use one verified internal-partial handle;
      path replacement fails before publication.
- [ ] An accepted pre-publication cancel/checksum failure cannot leave a
      completed model; a post-linearization cancel is explicitly too late,
      joins, returns false, and never relabels/deletes the publication.
- [ ] Lifecycle quiescence leaves no live async work or handle: before
      publication it leaves at most a proven closed resumable partial, and after
      publication it waits for rename plus both directory-fsync attempts.
- [ ] Plan 014 can quiesce/drain the manager before runtime teardown, then begin
      a later sequential lifecycle only after the prior drain settles.
- [ ] Connector and `fetch_url` public policies are unchanged and tested.
- [ ] All test/static gates pass and only in-scope files changed.

## STOP conditions

Stop and report if:

- Plan 007 is incomplete or contained downloads are still available to ordinary
  authenticated accounts;
- the existing public resolver would need to allow loopback/private destinations;
- normal TLS hostname verification is lost when pinning an address;
- a supported runtime cannot stream `IncomingMessage` with the current Node 22
  baseline;
- the supported Node 22/macOS baseline cannot open the partial with
  `O_NOFOLLOW`, compare `lstat`/`fstat` identity, or hash the retained handle;
- a per-filename/case-alias reservation cannot be installed with its tracked run
  promise synchronously before `start()`'s first await;
- the reserved `.borealis-partials` directory cannot be created and proven
  without following a symlink, or publication would cross filesystems;
- safe cleanup would require following or recursively deleting an unproven
  `.part` or final entry;
- quiescence cannot synchronously close admission and await every exact
  setup/request/writer/handle/run owner before application shutdown proceeds;
- cancel and quiescence cannot linearize on one synchronous publication flag,
  or a cancel after rename begins would need to claim success/delete a final;
- safe resume would require trusting an ambiguous/multipart `Content-Range`;
- a timeout cannot cover DNS, connect, headers, and streaming with one signal;
- any test attempts public internet access; or
- any verification fails twice after one reasonable correction.

## Maintenance notes

- Keep loopback and public resolution separate in names and tests. A generic
  “allowed destination” helper is likely to be reused unsafely.
- DNS address pinning is not certificate pinning; do not conflate them in future
  docs or reviews.
- If redirects or signed query URLs are added later, every hop/URL must repeat
  full parsing, scheme, DNS, pinning, and credential-leak analysis.
- Keep `.borealis-partials` and the reserved-artifact predicate centralized in
  Plan 007's `filePolicy.ts`; engine selection and download publication must
  reject the same case-folded namespace.
- A download state row is observability, not ownership. Only the exact active
  reservation/run identity may abort, clean up, or release a filename.
- `publicationStarted` is the cancel point of no return. Keep the final abort
  check, flag assignment, and rename initiation in one synchronous turn, and
  keep the reservation through destination/source directory fsync.
- Any new application shutdown path must call and await `quiesceAndDrain()`;
  Plan 014 is the composition owner, and no desktop `stopped` acknowledgement
  may precede that drain.
