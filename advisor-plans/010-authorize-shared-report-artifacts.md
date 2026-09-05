# Plan 010: Authorize shared report artifacts consistently

> **Reconciliation (2026-09-06):** M07 fixed the user-visible shared-read and
> payload-disclosure defects in `b54b0e3`. Current report routes authorize
> recipient detail/HTML/PDF under the owner's storage scope and keep the stored
> payload owner-only; `reportChartRoutes.test.ts` covers this behavior. The
> resolver consolidation specified below remains separate work. The pre-fix
> excerpts are historical: re-scope this plan to remaining consolidation and
> verification rather than treating shared reads as broken or weakening the
> existing recipient regression. This review does not mark the full plan DONE.

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If a STOP condition occurs, stop and report; do not improvise. When complete, update this plan's row in `advisor-plans/README.md` unless the reviewer owns index maintenance.
>
> **Drift check (run first)**: `git diff --stat f1b9293..HEAD -- server/src/routes/reports.ts server/src/tests/reportChartRoutes.test.ts`
> Plans 026, 028, and 031 intentionally changed report body/auth boundaries,
> chart provenance, and report/share catalog pagination. Preserve `onRequest`
> authentication, derived body limits, published-chart `run_id`/`chat_id`, and
> `{ items, next_cursor }` list envelopes while centralizing shared artifact
> authorization. These changes are not a drift STOP; stop only for a different
> authorization or artifact-resolution contract.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Preserve completed baseline**: Plans 026, 028, and 031
- **Category**: bug
- **Planned at**: commit `f1b9293`, 2026-08-30

## Why this matters

Report sharing promises a recipient read-only access to the report detail, HTML, and PDF. The detail endpoint honors that grant, but the two artifact endpoints still perform an owner-only lookup, so the visible Preview and Download actions on every shared report fail with 404. Centralizing the read authorization decision fixes the feature without broadening rename, delete, share-management, or filesystem authority.

## Current state

- `server/src/routes/reports.ts:40-56` resolves an owner row first and then a recipient grant for report detail:

  ```ts
  const accountId = getAccountId(req);
  let row = await storageRuntime().runs.getPublishedReport(
    accountId,
    (req.params as any).id,
  );
  let sharedByAccount = false;
  let ownerId = accountId;
  if (!row) {
    ownerId =
      (await storageRuntime().runs.getReportShareOwner(
        accountId,
        (req.params as any).id,
      )) ?? "";
    if (ownerId) {
      row = await storageRuntime().runs.getPublishedReport(
        ownerId,
        (req.params as any).id,
      );
      sharedByAccount = row !== undefined;
    }
  }
  if (!row) return reply.code(404).send({ error: "report not found" });
  ```

  It then proves both artifact paths under `ownerId`, which is the correct filesystem authority for a shared row.

- The HTML endpoint repeats an owner-only lookup (`server/src/routes/reports.ts:86-103`):

  ```ts
  const row = await storageRuntime().runs.getPublishedReport(
    getAccountId(req),
    (req.params as any).id,
  );
  if (!row) return reply.code(404).send({ error: "report not found" });
  const artifact = await resolveReportArtifact({
    accountId: getAccountId(req),
    reportId: (req.params as any).id,
    filePath: row.html_path,
    kind: "html",
  });
  ```

  The PDF endpoint has the same owner-only lookup and passes the requester account into path proof at `server/src/routes/reports.ts:107-123`.

- `web/src/pages/ReportsView.tsx:354-410` renders shared cards with Preview and PDF Download actions targeting `/api/reports/:id/html` and `/api/reports/:id/pdf`. The UI is already expressing the documented contract; do not remove or hide those controls.

- `server/src/tests/reportChartRoutes.test.ts:106-140` is the artifact/path-proof exemplar. It writes HTML and `%PDF` bytes inside `createReportResourceDirectory`, asserts headers and magic bytes, and verifies a drifted path remains unreadable.

- `server/src/tests/reportChartRoutes.test.ts:225-286` covers create-share, recipient detail, owner-only mutation, revoke, and post-revoke detail denial. It does not exercise HTML or PDF as the recipient.

- The repository invariant is explicit at `AGENTS.md:231-238`: report shares grant exactly read-only detail/HTML/PDF access, while revoke remains owner-only. Preserve this boundary.

## Commands you will need

| Purpose               | Command                                                                             | Expected on success                                                 |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Focused regression    | `pnpm --filter borealis-server exec vitest run src/tests/reportChartRoutes.test.ts` | all report/chart route tests pass                                   |
| Server typecheck      | `pnpm --filter borealis-server typecheck`                                           | exit 0, no TypeScript errors                                        |
| Server lint           | `pnpm --filter borealis-server lint`                                                | exit 0, no warnings                                                 |
| Server format check   | `pnpm --filter borealis-server format:check`                                        | exit 0                                                              |
| Full server tests     | `pnpm --filter borealis-server test`                                                | all tests pass                                                      |
| Final repository gate | `pnpm verify`                                                                       | exit 0 and prints `ALL GATES GREEN` on a provisioned supported host |

## Scope

**In scope** (the only source/test files to modify):

- `server/src/routes/reports.ts`
- `server/src/tests/reportChartRoutes.test.ts`

**Out of scope** (do not touch):

- `web/src/pages/ReportsView.tsx`; its shared Preview and Download actions are correct.
- `server/src/db/stores/runStore.ts` and SQLite schema. `getReportShareOwner` plus `getPublishedReport` already expose the required fail-closed primitives.
- Share creation, listing, revocation, rename, report deletion, or owner-only share-management semantics.
- `resolveReportArtifact` ownership/path rules, `REPORT_CSP`, response content types, or PDF `Content-Disposition` behavior.
- Public/unauthenticated links or cross-instance sharing. A share connects authenticated sibling accounts of one local instance only.

## Git workflow

- Branch: `codex/010-authorize-shared-report-artifacts`
- Commit after all checks pass with: `fix(server): authorize shared report artifacts`
- Use the repository's conventional commit style.
- Do not push or open a PR without explicit operator instruction.

## Steps

### Step 1: Introduce one readable-report resolver

Inside `server/src/routes/reports.ts`, add a small private helper that accepts requester account ID and report ID and returns either `undefined` or an immutable/read-only object containing:

- the published `row`;
- the true `ownerId` used for filesystem path proof;
- whether access came from an account share.

The resolution order must remain: owner lookup first; only on absence query `getReportShareOwner(requester, reportId)`; then load the published row under the returned owner. Never trust an owner ID from request input. A deleted, pending, unshared, revoked, or missing report must resolve to `undefined` and produce the same 404 envelope as today.

Refactor the detail endpoint to call the helper without changing its response shape. Only shared reads should include `shared_by_account: true`.

**Verify**: `pnpm --filter borealis-server typecheck` → exit 0, and existing detail/share tests compile unchanged.

### Step 2: Reuse the resolver for HTML and PDF reads

Change both artifact endpoints to use the same helper. Pass the returned `ownerId`, never the requester ID, to `resolveReportArtifact`; use the published row's stored path and the requested report ID. Keep all current path-proof failure behavior, HTML CSP/nosniff headers, PDF media type, filename derivation, and missing-artifact 404 envelopes.

Do not call the shared resolver from PATCH, DELETE, share creation/list/revoke, or any other mutation. Those routes must continue to use owner-scoped store methods directly.

**Verify**: `rg -n 'getPublishedReport\(getAccountId\(req\)' server/src/routes/reports.ts` → no output and exit 1 for the artifact handlers; inspect the remaining owner-only mutation calls and confirm they are unchanged.

### Step 3: Extend the share route regression test with real artifacts

In the existing `shares a report snapshot with another account and revokes it` test, create the owner report's exact resource directory and write a small HTML document and a PDF buffer beginning with `%PDF` before inserting the published row. After creating the share, assert as the recipient:

- detail is 200 with `shared_by_account: true`;
- HTML is 200, contains the known title/body, retains `REPORT_CSP`, and has `X-Content-Type-Options: nosniff`;
- PDF is 200, begins with `%PDF`, and retains the attachment filename header.

After revoke, assert detail, HTML, and PDF all return 404 for the recipient while the owner can still read the artifacts. Retain the existing recipient rename/delete denial. Add an unshared/foreign assertion if needed so a route accidentally using only `ownerId` cannot pass.

Keep the separate drifted-path test; it proves that a valid share cannot turn an unsafe stored path into filesystem access.

**Verify**: `pnpm --filter borealis-server exec vitest run src/tests/reportChartRoutes.test.ts` → all tests pass, including recipient HTML/PDF before revoke and 404 after revoke.

### Step 4: Run server and repository gates

Run the typecheck, lint, format, full server test, and final repository commands from the table. Then inspect the diff for accidental changes to mutation authorization or response bodies.

**Verify**: `git diff --check && git status --short` → no whitespace errors; only the two in-scope files plus the permitted `advisor-plans/README.md` status update are modified.

## Test plan

- Extend `server/src/tests/reportChartRoutes.test.ts`; do not create a mock-only authorization test.
- Exercise the complete owner file → share row → authenticated recipient → exact artifact path flow.
- Cover HTML security headers and PDF magic bytes, not only status codes.
- Cover revoke for all three readable surfaces.
- Preserve owner access, recipient mutation denial, pending-report denial, unshared-account denial, and drifted-path denial.
- Run the complete server suite after the focused test because report helpers share the storage-runtime facade used by chart/report cleanup tests.

## Done criteria

- [ ] Owner and valid recipient use one authorization resolver for report detail, HTML, and PDF.
- [ ] Artifact path proof always uses the report owner's account directory.
- [ ] A valid recipient gets 200 for detail/HTML/PDF and the current security/content headers remain intact.
- [ ] An unshared or revoked recipient gets 404 for all three surfaces.
- [ ] Rename, delete, share list/create/revoke, and cleanup remain owner-only.
- [ ] Focused and full server tests, server static checks, and `pnpm verify` pass.
- [ ] No file outside Scope is modified, except the allowed plan-index status update.

## STOP conditions

Stop and report back instead of improvising if:

- The current detail route no longer uses `getReportShareOwner` followed by an owner-scoped published-row lookup.
- `getReportShareOwner` can return an owner without validating the requester/recipient grant, or the store now exposes a different canonical authorization primitive.
- Serving a shared artifact would require bypassing or weakening `resolveReportArtifact` path ownership proof.
- The web client has intentionally changed the shared-report contract away from read-only detail/HTML/PDF.
- The change appears to authorize PATCH, DELETE, share management, pending reports, or unauthenticated access.
- A verification fails twice after a reasonable correction, or a required change falls outside Scope.

## Maintenance notes

- Future read-only report representations must use the same readable-report resolver; future mutations must not.
- Reviewers should trace two identities separately: requester account for authorization and owner account for filesystem proof.
- Preserve 404 rather than 403 for absent/unshared/revoked reports so cross-account existence is not disclosed.
- If report sharing later becomes immutable-copy sharing rather than live artifact sharing, replace this resolver as part of that product change rather than layering a second path here.
