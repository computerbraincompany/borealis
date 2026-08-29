# M07 — Small-team platform: shared snapshots, the egress audit plane, durable automations

**Horizon:** 3 — *Sharing snapshots inside a trust boundary. An administration
and audit plane that fits a desktop-and-cluster deployment. Automations with
human review for work that already has artifacts and evidence.*

**Status:** DONE (implemented in commits `4cb696a` — egress audit plane,
`bc37dbb` — report snapshot shares, `57e011c` — durable automations, and
`f499808` — the workspace surfaces; verification recorded in
milestones/README.md)

**Verification record (2026-08-29):** server 598 tests, web 151 tests,
desktop 13 tests, lint, format, builds, and native smokes green via
`pnpm verify` (recorded before the documentation slice; the final gate run
follows this commit).

## Problem

Borealis is single-player at the edges: reports cannot move between the
accounts of one workspace, nothing durable records *what actually left the
machine* (the M03 consent is a one-time acknowledgment, not an audit), and all
recurring work — connector refresh, review digests — depends on someone
remembering to click.

## Goal

1. **Shared report snapshots** — an account can share an immutable report
   snapshot with another account *of the same workspace* (the local trust
   boundary); recipients get read-only HTML/PDF access and owners can revoke.
2. **Egress audit plane** — every payload-bearing surface that passes the M03
   consent gate while a remote provider is configured writes a content-free
   audit event (`who, what kind, which endpoint host, when`), inspectable by
   the account.
3. **Durable automations with review** — bounded, account-scoped automations
   of two kinds: scheduled connector refresh, and scheduled agent turns into a
   bound chat (reusing the M05 binding and run machinery) whose output lands
   as an ordinary reviewable chat turn — nothing publishes without a human
   reading it. Runs are durable; failures pause the automation.

## Non-goals

- No cross-machine sharing, public links, or external identities: the trust
  boundary is accounts of this Borealis instance.
- No multi-step automation graphs, triggers beyond intervals, or notification
  channels.
- No automatic publication of automation output: an agent-turn automation only
  ever appends a turn to its bound chat, subject to the same one-run-per-chat
  and consent gates as a human turn.
- Audit events never contain prompts, source text, SQL, or model output.

## Backend spec

One migration per slice, following the established `migrations.ts` shape.

### Slice A — egress audit (schema v7)

```sql
CREATE TABLE egress_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('consent_acknowledged','remote_turn','remote_ingest')),
  endpoint_host TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX egress_events_account_idx ON egress_events (account_id, created_at DESC);
```

- `recordEgressEvent` helper in a new `server/src/egressAudit.ts`; writers:
  the consent acknowledge route (`consent_acknowledged` with the endpoint
  host), and the gated routes — after the gate passes and
  `isRemoteProvider(llmBaseUrl)` — record `remote_turn` (messages) or
  `remote_ingest` (upload, reingest, connector create/sync). Failures to
  record never fail the request (best-effort, swallowed).
- `GET /api/audit/egress?limit<=200` → the account's events, newest first:
  `{id,kind,endpoint_host,created_at}` (request_id stays server-side).
- Content-free by construction; nothing here is logged.

### Slice B — report snapshot shares (schema v8)

```sql
CREATE TABLE report_shares (
  report_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  shared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (report_id, recipient_account_id),
  FOREIGN KEY (report_id, owner_account_id) REFERENCES reports(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_account_id) REFERENCES users(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX report_shares_recipient_idx ON report_shares (recipient_account_id, shared_at DESC);
```

Notes: `reports` already has `UNIQUE (id, account_id)` — verify before relying
on the composite FK (add `UNIQUE (id, account_id)` in the migration if
missing). Shares are version-immutable snapshots of the *report row*; a newer
report version is a different row and is not automatically shared.

- New store methods on `runStore.ts`: `shareReport(owner, reportId,
  recipient)`, `listReportShares(owner, reportId)`,
  `listSharedReports(recipient)` (joined report metadata), `revokeReportShare`
  (owner), `getReportShare(recipient, reportId)` for the read path.
- Routes: `POST /api/reports/:id/shares {recipient_account_id}`,
  `GET /api/reports/:id/shares` (owner), `DELETE
  /api/reports/:id/shares/:recipient` (owner), `GET /api/reports/shared` (the
  recipient's read-only list), and recipient access to the existing
  `/api/reports/:id/html` and `/pdf` when a share row exists. Self-shares and
  unknown recipients → 400/404 per existing conventions.
- Recipient detail reads return the same DTOs with
  `shared_by_account: true` marker; rename/delete remain owner-only.

### Slice C — automations (schema v9)

```sql
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connector_sync','agent_turn')),
  target_id TEXT NOT NULL,
  prompt TEXT CHECK (prompt IS NULL OR (length(prompt) >= 1 AND length(prompt) <= 8_000)),
  schedule_minutes INTEGER NOT NULL CHECK (schedule_minutes BETWEEN 15 AND 10080),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (account_id, name)
) STRICT;

CREATE TABLE automation_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT
) STRICT;
```

- `server/src/automationStore.ts`: CRUD (`name` 1–80 chars unique per account;
  kind `connector_sync` requires an owned connector in `target_id`, kind
  `agent_turn` requires an owned chat; `agent_turn.prompt` required for
  agent_turn, forbidden for connector_sync), pause/resume, delete (cascade
  runs), and `claimDue(accountId?)` — atomically due rows whose
  `next_run_at <= now`, rescheduling `next_run_at` inside the claim
  transaction (at-least-once; crash between claim and execution records a
  `failed` run only if the worker marks it, otherwise the next interval runs).
- Scheduler: a bounded in-process loop (60 s tick, `setInterval` unref'd)
  started with the server and stopped on shutdown, claiming due automations
  per account sequentially. `connector_sync` invokes the existing sync
  service; a 409 "already syncing" records `skipped`. `agent_turn` calls
  `acceptChatTurn` + `runAgent` with the automation prompt through the same
  path as a human turn (consent gate included; an unbound chat keeps its
  chat-model); one active run per chat → `skipped`. Any failure increments
  `consecutive_failures`; at 5 the automation pauses itself and the run row
  records why.
- Routes `server/src/routes/automations.ts` (requireAuth): `GET /api/automations`
  (with last runs), `POST /api/automations`, `PATCH /api/automations/:id`
  (`{name?,state?,schedule_minutes?}`), `DELETE /api/automations/:id`,
  `GET /api/automations/:id/runs?limit<=50`.

### Web spec

- Slice A: Settings → System gains an "Egress audit" list (kind badge,
  endpoint host, time; bounded 50) below readiness.
- Slice B: Reports view — per-report "Share" action (choose local account from
  a dialog listing workspace accounts via `GET /api/accounts`), listed shares
  with revoke; a "Shared with me" section rendering read-only snapshot cards
  (Preview/Download only).
- Slice C: an **Automations** nav view: create dialog (name, kind, target,
  interval, prompt for agent turns), pause/resume, delete, and per-automation
  run history with outcomes.

## Documentation tasks

- `docs/API.md`: audit, shares, and automations routes with their contracts.
- `README.md`: small-team paragraph (shares inside the workspace, the audit
  view, automations with review).
- `AGENTS.md`: invariants — shares are same-instance and read-only; audit
  events are content-free and best-effort; automations reuse turn/consent
  gates and pause after five consecutive failures; schedulers unref and stop
  on shutdown.
- `milestones/README.md`: flip M07 when done.

## Done criteria

- `pnpm verify` green including the new suites.
- A remote-provider turn and upload each produce a durable, content-free
  egress event visible in the audit list; acknowledging consent records its
  event with the endpoint host.
- A report shared with a second local account appears in that account's
  "Shared with me" with working Preview/Download and disappears on revoke.
- A connector-sync automation with a 15-minute schedule claims and runs on
  tick (test clock), records runs, and pauses itself after five failures; an
  agent-turn automation appends a reviewable turn to its bound chat through
  the standard run path.
