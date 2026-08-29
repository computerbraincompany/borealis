# M10 — The composer as one instrument: libraries in the scope picker, answer typography

**Horizon:** 1 — *A composer that treats library, model, and scope as one
instrument.* Plus the visual register line: *typography that can carry a
financial narrative.*

**Status:** DONE (implemented in commits `6239be9` — library attach in the
composer scope picker, and `89679d2` — answer typography; documentation in the
commit that closes this milestone)

**Verification record (2026-08-29):** web 180 tests, and the complete
`pnpm verify` gate green. Visual composition check: the picker renders the
"Attach a library" group in new-chat and existing-chat rows; answer typography
changes are token-based and theme-consistent by construction.

## Problem

The composer offers model, agent, and raw source scope in one row — but
**libraries cannot be attached from the composer**. The only attach path lives
in the Libraries view ("Attach to new chat", which navigates away and discards
the composer's draft). Attaching governed collections is the composer's most
common grounding act, and it is the one the composer cannot do.

Separately, answer typography is functional but generic; the vision calls for
"typography that can carry a financial narrative" in a register closer to a
high-end workstation than an admin console.

## Goal

1. **Libraries in the scope picker** — the chat source picker gains an
   "Attach a library" section; attaching expands the library's ready members
   into the explicit `selected` scope through the normal scope-update
   contract, in both new and existing chats.
2. **Answer typography** — a bounded refinement of the markdown answer
   surface (headings, tables, rhythm) in both themes. Presentation only.

## Non-goals

- No server changes at all: expansion stays client-side via
  `GET /api/libraries/:id` + the normal chat creation/scope-update contracts.
  The AGENTS.md invariant against server-side dynamic chat↔library resolution
  stands.
- No redesign of tokens, fonts, layout, or navigation; the existing Inter /
  JetBrains Mono token system stays. This milestone refines the answer
  surface only.
- No new chat-creation flows or first-screen artifacts; the empty-state
  behavior is unchanged.
- No attach-by-reference semantics: attaching copies the ready member IDs
  into the chat's `selected` scope at attach time, exactly like the
  Libraries view does today. Later library edits never reach an attached chat
  automatically.

## Web spec (slice 1 — picker)

- `ChatView` loads the library catalog (`librariesApi.list()`) alongside the
  sources refresh and passes `libraries` / loading / error into
  `ChatSourcePicker` for both the new-chat and existing-chat composer rows.
- `ChatSourcePicker` gains a "Attach a library" group between the mode items
  and the individual source list, rendered when the catalog is non-empty:
  - each item: library name + member count; a bound library is marked when
    the current `selected` scope exactly equals its ready members (best-
    effort hint only);
  - clicking attaches: fetch `librariesApi.get(id)`, filter
    `status === "ready"` members, then —
    - 0 ready members → inline error "this library has no ready members";
    - more than 100 ready members → inline error naming the scope cap;
      **fail, never silently truncate** (scope-cap semantics);
    - otherwise `commit({source_mode:"selected", source_ids: readyIds})` —
      attach replaces the current selection (the same semantics as the
      Libraries view);
  - attach shows a busy state and the dropdown stays open until the commit
    resolves; errors render in the existing footer error area;
  - libraries fetch errors surface like `sourcesError` (bounded banner with
    retry).
- Existing-chat picker rows keep the "Changes affect future answers" note;
  attach on an existing chat goes through the same `onApply` path.

## Web spec (slice 2 — answer typography)

`.markdown-body` refinement in `web/src/index.css`, both themes:

- Heading hierarchy: stronger h2/h3 distinction, tightened margins, tabular
  feel for numeric headings (font-variant-numeric where sensible).
- Paragraph and list rhythm: consistent spacing scale, tighter list leading.
- Tables: hairline row rules, semibold header, cell padding, horizontal
  scroll behavior for wide tables preserved.
- Blockquotes and `hr`: quiet, structural (accent rule, not decorative).
- Inline code and code blocks stay on the existing token palette.

No component or behavior changes; no new dependencies; the existing light and
dark token values are the only color sources.

## Documentation tasks

- `README.md`: the workspace paragraph mentions attaching libraries directly
  from the chat composer.
- `milestones/README.md`: flip M10 when done.

## Done criteria

- Web tests: attach replaces the scope with ready members; no-ready and
  over-cap errors; section hidden when the catalog is empty; existing-chat
  attach path covered.
- `pnpm verify` green.
- Visual check recorded in the closing commit message: composer shows the
  library group in a new chat and an existing chat; answers render the
  refined typography in both themes.
