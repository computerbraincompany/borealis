# Plan 030: Give secondary dialogs exact asynchronous request ownership

## Status

- **State**: DONE (2026-09-01)
- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none; coordinate with plan 031
- **Category**: correctness / web
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

Automation history, report sharing, and library detail/member mutations write
shared dialog state after awaits without proving that the same target is still
open. A late request for resource A can overwrite resource B or reopen a closed
dialog. Report sharing can show A's state while buttons operate on B.

## Target contract

- Every open/load/mutation owns a monotonically increasing request token and,
  where supported, an `AbortController`.
- Closing or changing the target invalidates all prior result, error, loading,
  and `finally` updates.
- Rows and actions are rendered only for the target that produced them.
- Mutations capture their target ID at invocation and may not consult a newer
  React state value after awaiting.
- Unmount aborts requests and produces no state-update warnings.

## Scope

- `web/src/pages/AutomationsView.tsx`
- `web/src/pages/ReportsView.tsx`
- `web/src/pages/LibrariesView.tsx`
- corresponding API signal parameters and focused web tests
- Settings async test cleanup when the shared helper pattern applies

## Implementation steps

1. Add a small reusable `useOwnedRequest` hook or apply the established
   ChatView request-ID pattern consistently to each dialog.
2. Clear target-specific rows immediately when opening a new target; retain a
   distinct loading state instead of showing the prior target's empty/history.
3. Capture report/library/automation IDs in every mutation and guard each
   completion/finalizer by exact ownership.
4. Add deferred-promise tests for close-before-response, A→B with A last,
   overlapping mutations, failure after target change, and unmount.
5. Make the web test harness fail on unexpected React `act` warnings while
   allowing focused tests to suppress only their expected error-boundary
   diagnostics.

## Verification

- Focused view/hook tests, all web tests, typecheck/lint/format/build, then
  `pnpm verify`.

## Done criteria

- [x] Stale requests cannot alter the visible target or its actions.
- [x] Loading/error state is owned by the active request.
- [x] Deferred-response tests and warning-free web tests pass.

## Completion record

- The scoped automation-history, report-sharing, and library-detail/member
  dialogs own every load and mutation by an exact target plus abort/sequence
  token. Closing, switching, overlapping, or unmounting invalidates stale
  success, error, loading, and navigation effects.
- Related chart, audit, provider-settings, chat, and catalog helpers use the
  same ownership pattern where they share these surfaces. Deferred tests cover
  the three scoped dialogs and those shared helpers. Successful report,
  automation, and library mutations invalidate older catalog generations so a
  deferred refresh cannot resurrect deleted rows or overwrite a rename/toggle;
  automation target pagination is separately aborted and invalidated on kind
  changes and dialog close. Source/connector CRUD ownership remains outside this
  plan's declared scope.
- The shared web test console policy turns unwrapped asynchronous React updates
  into deterministic failures; tests that intentionally exercise rejected lazy
  imports or safe error handling still pass those messages through the same act-
  warning check before suppressing expected diagnostics.

## STOP conditions

- Fixing the race would require storing authorization state only in the client;
  server-side ownership remains authoritative and must not be weakened.

## Implementation note (2026-09-04 audit follow-up)

- A UI/UX audit follow-up found that the ownership guards left a user-reachable
  silent-failure path for create/rename mutation dialogs: dismissing the dialog
  mid-flight discarded a settling response whose error slot lived inside the
  dialog, and a committed create row could stay invisible until the next
  manual refresh. Agent, connector, automation, and library create/rename
  dialogs now block dismissal while their request is in flight, matching the
  `ConfirmDialog` busy contract, while keeping the original abort/sequence-token
  guards for unmount and programmatic close. The close/switch-while-pending
  ownership tests for those dialogs were rewritten to assert the stricter
  "stays open until settle, then owns the result" contract. Report sharing and
  library-detail/member dialogs intentionally keep close-while-pending because
  both re-fetch authoritative state on open, so a dropped mutation cannot hide
  committed server state.
