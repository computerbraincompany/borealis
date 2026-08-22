# Plan 012: Wire the report→chat link and fix the dead chat auto-title

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d16a44c..HEAD -- server/src/tools.ts server/src/agent.ts server/src/routes.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d16a44c`, 2026-08-22

## Why this matters

Two small, certain gaps in the chat/report lifecycle:

1. **The report→chat link is dead.** The schema (`server/src/db.ts:75`) has
   `reports.chat_id UUID REFERENCES chats(id) ON DELETE SET NULL`, the list query
   LEFT JOINs it (`routes.ts:220-224`), and the UI renders a "source chat" link
   whenever `chat_id` is set (`web/src/pages/ReportsView.tsx:93-101`). But
   `create_report` (`server/src/tools.ts:215-219`) never sets `chat_id`, so the
   column is always NULL and the link never appears. The agent already knows the
   chat id throughout the run — one line of plumbing makes the whole chain live.

2. **The chat auto-title logic never fires.** `server/src/agent.ts:94-96` tries to
   title a new chat from the first user message, but by the time `runAgent`
   loads the conversation the user message has already been persisted by the
   route (`routes.ts:67`), so `messages` is never empty and the branch is dead
   code. Every auto-created chat stays "New chat" in the sidebar forever.

Both are pure-write, zero-risk fixes with a clean verification story.

## Current state

Files and their roles:

- `server/src/tools.ts` — `create_report` tool executor; builds the report and
  inserts the `reports` row.
- `server/src/agent.ts` — `runAgent`; owns the `context` object and the dead
  title branch.
- `server/src/routes.ts` — `POST /api/chats/:id/messages` persisting the user
  message; `POST /api/chats` creating chats with title "New chat".
- (read-only reference: `web/src/pages/ReportsView.tsx:93-101` renders the link;
  `server/src/db.ts:75` defines the column.)

Current exact code (excerpts):

`server/src/agent.ts:100` (the context object that already flows everywhere):
```ts
  const context: { chartIds: string[]; reportId?: string } = { chartIds: [] };
```

`server/src/tools.ts:215-219` (the INSERT that omits `chat_id`):
```ts
      const [rep] = await q(
        `INSERT INTO reports (id, account_id, title, subtitle, html_path, pdf_path, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6, now(), now()) RETURNING id`,
        [uuid(), accountId, reportPayload.title, reportPayload.subtitle || "", htmlPath, pdfPath]
      );
      context.reportId = rep.id;
```

`server/src/tools.ts:168-169` (`executeTool` signature carrying `context`):
```ts
export async function executeTool(accountId: string, name: string, args: any, context: { chartIds: string[]; reportId?: string }): Promise<any> {
```

`server/src/agent.ts:94-96` (dead title branch — `prior` always contains the
just-saved user message, so `messages.length` is never 0):
```ts
  if (messages.length === 0) {
    await q(`UPDATE chats SET title=$2 WHERE id=$1`, [chatId, content.slice(0, 80)]);
  }
```

`server/src/routes.ts:57-67` (user message persisted BEFORE `runAgent`; also the
`type` of the context must gain `chatId`):
```ts
    const [userMsg] = await q(`INSERT INTO messages (chat_id, role, content) VALUES ($1,'user',$2) RETURNING id`, [chatId, content]);
    ...
    await runAgent({ accountId: account, chatId, content, emit });
```

Conventions: ESM with `.js` import extensions; parameterized `q` queries; the
`context` object is the established plumbing between `runAgent`,
`runToolRound` (agent.ts:154-186), and `executeTool`. Keep that pattern; do not
introduce a new global or module-level state (the agent loop runs per-request and
must stay that way).

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Server typecheck | `cd server && npm run typecheck` | exit 0, no errors |
| Server tests | `cd server && npm test` (if plan 008 landed) | all pass |
| Live probe (optional) | run the dev stack per AGENTS.md, upload + ask for a report, then `curl /api/reports` | `chat_id` non-null on the new report |

## Scope

**In scope**:
- `server/src/agent.ts`
- `server/src/tools.ts`
- `server/src/routes.ts` (title fix only)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `web/` — the UI already renders the link when `chat_id` is set; no frontend
  change needed. (Deleting a chat with reports: `chat_id` is `ON DELETE SET
  NULL`, so reports survive — that's the intended behaviour; do not add cascade
  deletes.)
- `server/src/db.ts` — schema already supports the link.
- The `meta.report` field the agent stores on the assistant message (already
  correct).

## Git workflow

- Branch: `advisor/012-report-chat-link`
- Commits (two logical units):
  1. `fix: persist chat_id on create_report so the report→chat link renders`
  2. `fix: title new chats from the first user message`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Thread `chatId` through the tool context

In `server/src/agent.ts:100`, extend the context type and value:

```ts
  const context: { chartIds: string[]; reportId?: string; chatId?: string } = { chartIds: [], chatId };
```

**Verify**: `cd server && npm run typecheck` → exit 0 (this alone typechecks; the
widened type accepts the extra field everywhere `context` is used — `runToolRound`
and `executeTool` read it structurally).

### Step 2: Set `chat_id` on the report INSERT

In `server/src/tools.ts`, update the `context` type in `executeTool`'s signature
(line 168) to include `chatId?: string`:

```ts
export async function executeTool(accountId: string, name: string, args: any, context: { chartIds: string[]; reportId?: string; chatId?: string }): Promise<any> {
```

And update `makeReportPayload`'s context param type the same way (line 240), then
in the `create_report` branch (lines 215-219) add `chat_id` to the INSERT:

```ts
      const [rep] = await q(
        `INSERT INTO reports (id, account_id, chat_id, title, subtitle, html_path, pdf_path, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now()) RETURNING id`,
        [uuid(), accountId, context.chatId || null, reportPayload.title, reportPayload.subtitle || "", htmlPath, pdfPath]
      );
```

(Passing `null` when absent keeps the column's existing always-NULL behaviour for
any non-chat report-creation path.)

**Verify**: `cd server && npm run typecheck` → exit 0, and
`grep -n "chat_id" server/src/tools.ts` → shows it in the INSERT + VALUES.

### Step 3: Fix the chat auto-title at the route

The `N messages === 0` test belongs where the message count is actually known: in
`server/src/routes.ts` `POST /api/chats/:id/messages`. Before inserting the user
message (line 67), count existing messages and set the title when this is the
first:

```ts
    const [countRow] = await q(`SELECT count(*)::int AS n FROM messages WHERE chat_id=$1`, [chatId]);
    const isFirst = countRow?.n === 0;
    const [userMsg] = await q(`INSERT INTO messages (chat_id, role, content) VALUES ($1,'user',$2) RETURNING id`, [chatId, content]);
    if (isFirst) await q(`UPDATE chats SET title=$2 WHERE id=$1`, [chatId, content.slice(0, 80)]);
```

Then delete the dead branch in `server/src/agent.ts:94-96`.

**Verify**: `grep -n "UPDATE chats SET title" server/src/routes.ts server/src/agent.ts` →
exactly one match, in `routes.ts`. And `cd server && npm run typecheck` → exit 0.

Order matters: make Step 3's route change in the same commit as removing the
agent branch (Step 3 shows both together); do Steps 1-2 first so there's no
window where `chat_id` is half-wired.

### Step 4: Behavioral verification

If the dev stack is up (per AGENTS.md), run one chat that produces a report and
confirm:
- `curl` the report list → the new report row has a non-null `chat_id`
- `GET /api/reports` returns `chat_id`/`chat_title` for it, and the Reports page
  shows the "source chat" link
- A freshly auto-created chat shows the first message's text (truncated to 80
  chars) as its title in the sidebar

If the full stack isn't running, the static gates (typecheck + greps) plus the
below tests are the done criteria.

## Test plan

If plan 008 landed and there's a `server/src/tests/` harness, add targeted unit
tests by extracting the pure decision into a tiny helper is NOT required; instead
test the two observable contracts directly with a stubbed `q`:

- In `server/src/tests/` (create if absent per plan 008's layout), a small test
  file `server/src/tests/reportPayload.test.ts` — but note `makeReportPayload`
  and the INSERT live inside `executeTool`, requiring `py`/`q` stubs. As a weaker
  but machine-checkable gate, assert with `grep`/typecheck (Steps 1-3) and, if a
  live stack exists, Step 4. Do not introduce a mocking framework in this plan —
  that's the agent-seam refactor's job.
- Document in the plan's verification: if plan 008's `cleanFinal`/`ingest` tests
  exist, they must still pass (`cd server && npm test`).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd server && npm run typecheck` exits 0
- [ ] `grep -n "chat_id" server/src/tools.ts` shows the INSERT column + `$3` param
- [ ] `grep -n "UPDATE chats SET title" server/src/routes.ts` returns one match; `grep -n "UPDATE chats SET title" server/src/agent.ts` returns none
- [ ] `grep -n "chatId" server/src/agent.ts` shows `context = { chartIds: [], chatId }`
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the "Current state" locations doesn't match the excerpts (drifted —
  e.g. if a previous plan already started threading `chatId`).
- `npm run typecheck` fails in a way that indicates the widened `context` type
  breaks a caller you didn't touch (e.g. a test or another call site passes a
  different shape) — report the exact error.
- You find a second place that creates `reports` rows outside `create_report`
  (there shouldn't be one — verify with `grep -rn "INSERT INTO reports" server/src/`)
  and it would now behave inconsistently.

## Maintenance notes

- `reports.chat_id` is `ON DELETE SET NULL` by design: deleting a chat keeps its
  reports but drops the link. If a future plan adds "delete all reports for this
  chat" UX, that behaviour change belongs in the chat-delete route, not here.
- The auto-title now lives in the route (the only place the pre-insert message
  count is known). If message insertion is ever moved/batched, move the title
  logic with it — it must run exactly once per chat, on the first message.
- `context.chatId` is optional because `executeTool` is the general tool seam;
  any future HTML-report-only path can omit it and reports stay unlinked (same as
  today).
