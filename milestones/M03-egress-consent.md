# M03 — Egress consent cards: the app stops and asks before data leaves the Mac

**Horizon:** 1 ("the object on the desk") — *When something would leave the
trust boundary, the app stops and asks, with the exact destination and the
exact payload class, then returns the result to the same task.* Plus Horizon
2's standing rule that a remote provider is "a choice with a badge, not a
default that forgot to speak."

**Status:** DONE (implemented in commits `98e3dee` — migration v4, egress
policy, consent routes, and the fail-closed gates — and `8a88e8b` — the web
consent card with acknowledge-and-resume; verification in milestones/README.md)

## Problem

When a remote provider is configured, ingestion text, retrieval queries,
prompts, chat history, and selected tool context leave the machine under that
provider's policy. Settings and the M01 sidebar strip disclose this, but
nothing ever *stops*. The Portable Computer discipline Borealis claims is
consent before egress — a durable, inspectable acknowledgment, not ambient
text.

## Goal

1. **Fail closed on first remote egress.** While a remote (non-loopback,
   non-private) provider is configured and the account has not acknowledged
   remote egress, the payload-bearing entry points refuse with a stable error
   code instead of silently shipping data off-machine.
2. **Exact destination and payload classes in the card.** The web UI shows a
   consent card naming the configured host and exactly what is sent, with
   acknowledge-and-continue and open-Settings actions.
3. **Durable per-account acknowledgment.** One acknowledgment per account,
   stored in SQLite, survives restarts; the chat turn resumes where it was
   after acknowledging.

## Non-goals

- No per-message consent; the acknowledgment is workspace-wide per account and
  revocable only by changing the provider or a future settings control.
- No consent for loopback/private providers — those never trigger the gate.
- No change to the SSRF-bounded `fetch_url`/connector download policy (those
  surfaces have their own rules; consent covers model-provider egress).
- Desktop bootstrap is unaffected: the default desktop provider is loopback.

## Backend spec

Migration v4 (read `server/src/db/migrations.ts` and the users store first):

- `ALTER TABLE users ADD COLUMN remote_egress_ack_at TEXT` (nullable ISO
  timestamp; null = not acknowledged).

New module `server/src/egressPolicy.ts`:

- `isRemoteProvider(baseUrl: string): boolean` — reuses
  `classifyProviderLocality` from `workspaceStatus.ts`; remote only.
- `RemoteEgressRequiredError`-style result used by routes; the public envelope
  is HTTP 403 with `{error: "...", code: "REMOTE_EGRESS_CONSENT_REQUIRED"}`,
  following the existing public error-code conventions (see
  `ingestionFailures.ts` / `httpErrors.ts`).
- `GET /api/consent/remote-egress` (requireAuth) →
  `{required, acknowledged_at, endpoint_host}` where `required` is true iff a
  remote provider is configured; `endpoint_host` is the configured origin host
  (bare origins only) or null for local/private — a response field only, never
  logged.
- `POST /api/consent/remote-egress` (requireAuth) → records the acknowledgment
  timestamp for the account and returns the same shape.
- Gates (403 with the code above, before any payload processing) when
  `required` and not acknowledged:
  - `POST /api/chats/:id/messages` — chat turns;
  - `POST /api/sources/upload` and reingest — ingestion embedding text;
  - connector create and manual sync — connector ingestion text.
  Each gate reads the effective settings snapshot once per request; a provider
  switched to loopback between requests immediately lifts the gate.

Tests: migration on existing rows; gate refused-then-allowed for each guarded
route (loopback never gates; remote gates until acknowledgment; acknowledgment
unblocks without restart; `endpoint_host` present only for remote; code stable
and sanitized); consent routes tenant-scoped.

## Web spec

- `web/src/lib/api.ts`: `RemoteEgressState` type, `consentApi.get/acknowledge`.
- `web/src/hooks/useEgressConsent.ts`: exposes current state and an
  `acknowledge()`; used by ChatView, SourcesView, ConnectorsView.
- Consent card (shared component `EgressConsentCard`): heading "Some data
  would leave this Mac", the destination host, the exact payload classes
  (upload/ingestion text, prompts, chat history, retrieval queries, selected
  tool context — wording identical to Settings and the sidebar strip), and two
  actions: **Acknowledge and continue** (POST, then automatically retry the
  blocked action) and **Open Settings** (`#/settings`).
- Chat send path: a 403 with `REMOTE_EGRESS_CONSENT_REQUIRED` opens the card;
  after acknowledgment the same turn is re-sent. Upload/connector paths do the
  same for their actions.
- Tests: card renders with host + payload classes; acknowledge retry resumes
  the send; cancel does not retry.

## Documentation tasks

- `docs/API.md`: consent routes, the 403 code contract, and which routes gate.
- `README.md`: consent-card sentence in the privacy section.
- `AGENTS.md`: invariants — the gate is server-side and fail-closed; the ack is
  per account in SQLite; `endpoint_host` never appears in logs; payload-class
  wording stays identical across Settings, sidebar, and consent card.
- `milestones/README.md`: flip M03 status when done.

## Done criteria

- `pnpm verify` green including the new backend/web tests.
- With a remote provider configured and no acknowledgment, a chat send and an
  upload both fail closed with the stable code; after acknowledgment both
  succeed without a restart.
- The card names the host and payload classes; wording matches Settings.
