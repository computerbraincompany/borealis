# Plan 024: Upload and attach files without leaving the chat

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's status row in
> `plans/README.md` unless the reviewer tells you they maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 67cc7db..HEAD -- web/src/pages/ChatView.tsx web/src/components/ChatSourcePicker.tsx web/src/lib/api.ts web/src/pages/SourcesView.tsx plans/README.md`
> If any in-scope file changed, compare the excerpts below with live code. An
> unexplained mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (an upload may succeed even if a later source-scope save fails)
- **Depends on**: `plans/022-scope-chat-data-sources.md`, `plans/023-add-light-dark-theme.md`
- **Category**: direction / bug / ux
- **Planned at**: commit `67cc7db`, 2026-08-23

## Why this matters

North supports uploading a file from the chat bar and immediately using it in
that conversation. Borealis already has a durable upload API and a per-chat
source picker, but the user must leave chat, visit Sources, upload, wait, return,
and select the file. A transient source-list error also leaves the picker
looking permanently busy with no explanation or retry. This plan closes both
gaps inside the existing upload and source-scope architecture.

Official behavior references:

- <https://private.docs.cohere.com/docs/get-started/north-chat> documents the
  chat-bar attachment workflow and visible source readiness/removal.
- <https://private.docs.cohere.com/docs/get-started/tools/my-files/home>
  documents that files uploaded from chat remain available in My Files.

## Current state

- `web/src/lib/api.ts:239-245` already exposes `sourcesApi.upload(file)` and
  returns the newly created processing source.
- `web/src/pages/SourcesView.tsx:28-45,79-90` is the only UI that invokes that
  API; its file accept list is the canonical browser list for this plan.
- `web/src/pages/ChatView.tsx:102-116` records source-list failure only as a
  boolean and retains no actionable message:

```ts
try {
  const latest = await sourcesApi.list();
  setSources(latest);
  setSourcesUnavailable(false);
} catch {
  setSourcesUnavailable(true);
}
```

- `web/src/pages/ChatView.tsx:692-701` passes
  `sourcesLoading || sourcesUnavailable` as `sourcesLoading`.
- `web/src/components/ChatSourcePicker.tsx:113-128` disables its trigger while
  `sourcesLoading`, so an unavailable request is indistinguishable from work
  still in progress.
- `ChatSourcePicker.tsx:256-260` sends an empty-state user to the Sources page.

Conventions to preserve:

- Source scope is load-bearing: `all` stays dynamic; `selected + []` means
  explicitly none. Uploading must never silently convert either mode.
- A newly uploaded source can be selected while its status is `index`; the
  turn snapshot excludes it until it becomes `ready`.
- Use the existing authenticated API wrapper, semantic theme tokens, local
  Button/Dialog/Input components, and Lucide icons. Do not add a dependency.
- The picker is keyed by chat ID in `ChatView`; local draft selection must not
  leak across chat navigation.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Web typecheck | `cd web && npm run typecheck` | exit 0 |
| Web build | `cd web && npm run build` | exit 0; existing large-chunk warning allowed |
| Full gate | `./scripts/verify.sh` | all gates green |

## Scope

**In scope**:

- `web/src/pages/ChatView.tsx`
- `web/src/components/ChatSourcePicker.tsx`
- `web/src/lib/api.ts` only if an exported upload result type is useful
- `plans/README.md`

**Out of scope**:

- Server upload, ingestion, file-size, duplicate-name, MIME, or storage logic.
- `@` mention parsing, drag-and-drop, clipboard image upload, source preview,
  OCR, multimodality, folders/libraries, or connector creation.
- Automatically sending a prompt after upload.
- Automatically changing an `all` chat to `selected`, or attaching a file to
  a different chat after navigation.
- Reworking the standalone Sources page.

## Git workflow

- Branch: `codex/024-attach-files-in-chat`
- Conventional commit example: `feat: attach uploads from chat`
- Do not push independently; the primary reviewer will integrate and push.

## Steps

### Step 1: Separate loading from unavailable source state

Replace `sourcesUnavailable: boolean` with a recoverable error string (or an
equivalent discriminated state) in `ChatView.tsx`:

- `sourcesLoading` means only an outstanding initial/manual request.
- On a failed poll, retain the last successful `sources` array and attached
  chips. Record a stable user-facing error without exposing a raw response.
- A successful poll clears the error.
- Pass distinct `sourcesError` and `onRetrySources` props to the picker. Do not
  fold an error back into `sourcesLoading`.

In `ChatSourcePicker`, keep the trigger usable when the catalog is unavailable.
Inside the dialog, show the error plus a Retry button. Existing attached chips
remain authoritative; catalog-dependent checkboxes may be read-only until
retry succeeds.

**Verify**: `cd web && npm run typecheck` exits 0. Inspecting the props shows
that a rejected request cannot produce a permanent spinner.

### Step 2: Add a chat-local upload action

Add a visually hidden single-file input and an `Upload file` button to the
picker. Reuse this exact accept list from `SourcesView`:

```text
.csv,.tsv,.xlsx,.xls,.parquet,.jsonl,.pdf,.docx,.doc,.txt,.md
```

The picker receives an async `onUpload(file): Promise<Source>` callback.
`ChatView` implements it with `sourcesApi.upload`, then inserts/replaces the
returned source in its source catalog without waiting for the next poll.

Required state behavior:

- Disable upload while the picker is saving/uploading or chat settings/stream
  state already disables the picker.
- Show the file name while uploading and an inline, recoverable error on
  failure; never use `alert()`.
- Clear the native input value after each attempt so selecting the same file
  again triggers `change`.
- If draft mode is `selected`, add the returned ID to the draft selection,
  respecting the existing 100-source cap. The user still presses Apply, so a
  successful upload followed by Cancel leaves the file safely stored but not
  attached.
- If draft mode is `all`, do not change modes or membership: dynamic-all
  already includes the new source.
- Render the returned `index` source immediately with the existing Processing
  status; polling later transitions it to ready/error.

**Verify**: web typecheck/build pass.

### Step 3: Verify failure and navigation semantics

Run the app and check this matrix:

1. Selected-empty chat -> upload -> processing row becomes selected in the
   draft -> Apply -> processing chip appears; Send is allowed but the prompt
   states that source is not ready until ingestion completes.
2. All-sources chat -> upload -> mode remains all.
3. Upload failure -> dialog stays open, scope is unchanged, retry is possible.
4. Source-list failure after a successful load -> prior source list/chips remain
   visible and a Retry action replaces the indefinite spinner.
5. Navigate to another chat during/after upload -> no scope mutation is applied
   to that other chat; the uploaded file remains globally available.

**Verify**: `./scripts/verify.sh` and `cd web && npm run build` both pass.

## Test plan

- No web test runner exists, so typecheck/build plus the five-case browser
  matrix are required.
- Use the existing source API unchanged; server tests must stay green.
- Verify keyboard access to Upload and Retry and that error text has
  `role="alert"`.

## Done criteria

- [ ] A file can be uploaded from the source picker without leaving chat.
- [ ] Selected mode adds the new processing source only to the local draft;
      all mode remains all.
- [ ] A failed source-list request has a visible Retry path and no permanent
      loading spinner.
- [ ] Active chips and prior successful catalog data survive transient errors.
- [ ] `cd web && npm run typecheck && npm run build` exits 0.
- [ ] `./scripts/verify.sh` reports `ALL GATES GREEN`.

## STOP conditions

Stop and report if:

- Uploading requires a server API or ingestion-contract change.
- The implementation cannot distinguish a stored upload from an attached
  source without changing selected-empty semantics.
- Fixing navigation would require a global upload/job manager.
- Verification fails twice after a reasonable correction.

## Maintenance notes

- Keep the accept list synchronized with `SourcesView` until it is extracted
  into a shared constant in a later cleanup.
- An uploaded file is intentionally durable even when the picker is cancelled.
- Exact inline mentions and source previews remain separate future features.
