# Plan 027: Merge streamed tool names without dropping valid fragments

## Status

- **State**: DONE (2026-09-01)
- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: none; land before plan 004
- **Category**: correctness / compatibility
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

The stream merger discards an incoming function-name fragment whenever it is a
substring of the accumulated name. Valid repeated-character boundaries can
therefore corrupt a supported tool name.

## Target contract

- Empty current name accepts the incoming chunk.
- An exact repeated full name is idempotent.
- A cumulative chunk beginning with the current name replaces it.
- Every other non-empty chunk is a delta and appends, even when its characters
  already occur elsewhere in the name.
- Existing call-count, name-length, argument, and total stream budgets remain.

## Scope

- the tool-call name merger in `server/src/llm.ts`
- streaming merger tests
- provider-compatibility documentation only if behavior is described publicly

## Implementation steps

1. Extract a small pure name-merge helper implementing the target contract.
2. Replace substring suppression with exact/cumulative detection.
3. For every `TOOL_DEFS` name, test all possible delta split points and a
   character-at-a-time stream.
4. Retain repeated-full-name coverage and add cumulative-prefix provider cases,
   sparse indices, oversize names, and mixed simultaneous tool calls.

## Verification

- Focused LLM/agent/tool tests, server checks, and `pnpm verify`.

## Done criteria

- [x] Standard arbitrary deltas reconstruct every supported tool name.
- [x] Repeated full and cumulative provider chunks do not duplicate names.
- [x] Unknown or oversized names still fail through bounded safe behavior.

## Completion record

- Tool calls now merge function names by stream index for delta, cumulative,
  and repeated-full-name provider conventions while retaining all stream caps.
- Focused LLM tests cover arbitrary fragments, duplicate/cumulative chunks,
  missing identities, invalid indexes/types, and oversized names/arguments.

## STOP conditions

- A provider requires an ambiguous repeated-delta convention that cannot be
  distinguished from a legitimate delta; document the exact protocol and add a
  provider-specific adapter rather than another substring heuristic.
