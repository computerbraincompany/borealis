# Plan 025: Record truthful automation terminal outcomes

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none; land before plan 013
- **Category**: correctness
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

`completeRunWithAssistant` can correctly report that cancellation won the
persistence race, but the automation runner ignores that result, records
success, and resets consecutive failures. Durable chat state and automation
history can therefore disagree.

## Target contract

- The terminal status returned by chat persistence is authoritative.
- `completed` records `succeeded`; cancellation records the existing `skipped`
  outcome with the fixed, content-free detail `the run was cancelled`.
- A cancelled run does not reset or increment `consecutive_failures`.
- Abort-before-completion and cancel-wins-at-completion use the same history
  semantics and never create two automation history rows.

## Scope

- `server/src/automationRunner.ts`
- `server/src/tests/automations.test.ts` and focused chat-run test seams
- automation API documentation if outcome wording changes

Do not add a new database outcome or migration; the existing `skipped` state is
the backward-compatible representation for operator cancellation.

## Implementation steps

1. Capture the result of `completeRunWithAssistant` and branch on its status.
2. Share one content-free cancellation recorder between the returned-cancelled
   and `AbortError` paths while preserving durable terminalization.
3. Add a deterministic race test that requests cancellation immediately before
   assistant persistence and asserts chat status, history, and failure count.
4. Retain existing success, busy-chat skip, provider-failure, and pause tests.

## Verification

- Focused automation/chat-run tests.
- Server typecheck, lint, format, full tests, and `pnpm verify`.

## Done criteria

- [ ] No cancelled chat run is recorded as automation success.
- [ ] Cancellation never resets failure accounting.
- [ ] Exactly one bounded history record is written per claimed execution.

## STOP conditions

- Correctness would require weakening cancellation's absorbing durable state.
- The live schema already contains a distinct cancelled outcome; update the plan
  to use it consistently rather than creating a competing representation.
