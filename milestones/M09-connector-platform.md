# M09 — Connector platform surface: schedules on the connector, sync history, clean teardown

**Horizon:** 2 — *Connectors that are still few, still bounded, and finally feel
like part of a platform rather than a URL form.*

**Status:** PLANNED

## Problem

Connectors work but feel like a form: a URL goes in, a **Sync now** button
comes out. Three platform-shaped gaps remain:

1. **Schedules live in a different surface.** Refresh scheduling exists
   (M07 `connector_sync` automations) but a user must know to leave the
   Connectors view and create an automation. The connector itself does not
   show that it is scheduled.
2. **No sync history.** Only `last_sync` / `sync_status` / `sync_error` exist;
   there is no durable record of past sync runs, triggers, or outcomes.
3. **Dangling schedules on deletion.** Deleting a connector leaves its
   `connector_sync` automation behind; the runner then records five failures
   and self-pauses on a target that no longer exists.

## Goal

Connectors become managed platform objects — still only `url_csv`/`url_json`,
still bounded — that show their refresh schedule, expose a bounded sync
history, and tear down cleanly.

## Non-goals

- No new connector types, no authenticated connectors, no custom headers:
  public HTTP(S) CSV/JSON URLs stay the whole catalog.
- No new scheduler: the M07 automation scheduler remains the only clock. The
  connector schedule is a convenience surface over the same
  `connector_sync` automation rows, which remain authoritative in the
  Automations view.
- Late prepare-worker retries of deferred syncs are not separately recorded
  in history; only the three explicit entry points below are recorded.
- History entries are content-free: no URLs, no row counts, no error bodies.

## Server spec (slice 1)

### Schema v10 — connector sync history

```sql
CREATE TABLE connector_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('create','manual','scheduled')),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed','skipped')),
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  FOREIGN KEY (connector_id, account_id) REFERENCES connectors(id, account_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX connector_syncs_connector_idx ON connector_syncs (connector_id, started_at DESC);
```

(`connectors` already has `UNIQUE (id, account_id)`; verify before relying on
the composite FK, as in M07.)

- History writer helper (best-effort, never fails the sync): called at
  exactly three entry points —
  - connector create auto-sync → `create`;
  - `POST /api/connectors/:id/sync` → `manual`;
  - `automationRunner.executeConnectorSync` → `scheduled` (its existing
    succeeded/failed/skipped outcomes and reasons map directly).
  `detail` carries only the runner's existing safe reason strings (e.g. the
  skip reason); route-level failures record `failed` with null detail.
- `GET /api/connectors/:id/syncs?limit<=50` → the connector's history,
  newest first: `{id,trigger,outcome,detail,started_at,finished_at}`.

### Schedule on the connector

The linkage is derived, not stored: a connector's schedule is its
`connector_sync` automation (`target_id = connector.id`).

- `GET /api/connectors` (and the create/sync responses) gain
  `schedule: {automation_id, schedule_minutes, state, next_run_at,
  last_run_at} | null`.
- `PUT /api/connectors/:id/schedule` with
  `{schedule_minutes: number|null}` behind the same remote-egress consent
  gate as sync (a schedule is a standing promise of egress-capable work):
  - `null` deletes the linked automation (idempotent);
  - a value within the automation range (15–10080) updates the linked
    automation's interval, or creates one if none exists;
  - if multiple `connector_sync` automations already target the connector,
    return `409` and tell the user to clean up in Automations — never guess.
- Connector deletion cascades: after the existing connector teardown
  succeeds, delete its `connector_sync` automations (runs cascade via the
  automation FK) and history rows (FK cascade). Implement as a small
  `deleteConnectorAutomations(accountId, connectorId)` on the automation
  store called from the delete route; best-effort and idempotent.
- `automationStore.create` gains a transactional guard: at most one
  `connector_sync` automation per (account, target). Existing manual creates
  through the Automations view now fail with the standard validation error
  instead of silently duplicating.

## Web spec (slice 2)

- Connector card: a schedule control (Off / 15 min / hourly / 6 hours /
  daily) bound to `PUT /schedule`, showing state and next run when scheduled.
- Connector card: "Sync history" dialog fed by `GET /:id/syncs` — trigger
  badge, outcome, time, safe detail.
- Existing Sync now / Delete / status and error badges unchanged; the create
  dialog is unchanged.

## Documentation tasks

- `docs/API.md`: schedule field, schedule route, syncs route, one-per-connector
  rule.
- `README.md`: connectors paragraph — schedules live on the connector and are
  the same objects as connector_sync automations.
- `AGENTS.md`: invariant — connector schedule is a derived convenience surface
  over `connector_sync` automations; connector deletion cascades its
  automations and sync history; history entries are content-free.
- `milestones/README.md`: flip M09 when done.

## Done criteria

- Server tests: schema migration, history recording at all three entry
  points (including skip), history route bounds, schedule create/update/
  remove/409-multiple, consent gate on schedule, connector deletion
  cascading automations + history, one-connector_sync-automation guard.
- Web tests: schedule control round-trip and history dialog render.
- End-to-end: create a connector, schedule it from the card, see it appear in
  Automations as the same row; delete the connector and the automation
  disappears.
- `pnpm verify` green.
