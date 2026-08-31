# Plan 030: Give secondary dialogs exact asynchronous request ownership

## Status

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
5. Make the focused test suite fail on unexpected React `act` warnings.

## Verification

- Focused view/hook tests, all web tests, typecheck/lint/format/build, then
  `pnpm verify`.

## Done criteria

- [ ] Stale requests cannot alter the visible target or its actions.
- [ ] Loading/error state is owned by the active request.
- [ ] Deferred-response tests and warning-free web tests pass.

## STOP conditions

- Fixing the race would require storing authorization state only in the client;
  server-side ownership remains authoritative and must not be weakened.
