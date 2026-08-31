# M01 — Ambient locality: the chrome shows where intelligence lives

**Horizon:** 1 ("the object on the desk") — *Locality and provider topology as
UI, not only a Settings form. Health, model presence, and egress state in the
chrome.*

**Status:** DONE (implemented in commits `41d0a1c`, `6210c96`; see
milestones/README.md for the recorded verification)

**Verification record (2026-08-29):** server 551 tests, web 128 tests, lint,
format, builds, and desktop native smoke green via `pnpm verify`. A live
browser-development session (registered account, no model runtime running)
showed the sidebar strip with locality "On this Mac", "Endpoint unreachable",
and the configured chat model `qwen-chat` with the embed identity on hover —
without opening Settings.

## Problem

Borealis knows where inference runs and whether the model endpoint is
answering, but that knowledge is buried: `GET /api/health` and the readiness
panel only render inside the Settings view. The vision requires the workspace
chrome itself to show whether inference is on this Mac, on the office cluster,
or on a remote provider — "hardware and model health are ambient, like a good
DAW shows buffer and sample rate."

## Goal

Without opening Settings, the shell always shows:

1. **Locality** — where model calls go: this Mac (loopback), a private-network
   cluster, or a remote provider.
2. **Reachability** — whether the configured model endpoint is answering, with
   the last probe latency.
3. **Model presence** — the configured chat and embed model identities.
4. **Egress state** — when the provider is remote, a standing, visible
   disclosure that ingestion text, prompts, retrieval queries, and selected
   tool context leave the machine under that provider's policy.

## Non-goals

- No per-operation consent cards in M01; the fail-closed remote-provider
  consent card arrived in M03.
- No change to the `GET /api/health` contract; the Settings readiness matrix
  stays as it is.
- No new outbound policy: the probe reuses the existing body-free
  `GET /v1/models` shape already used by `systemHealth.ts` and Settings tests.
- No desktop-only behavior; browser development gets the same strip.

## Backend spec

New module `server/src/workspaceStatus.ts`:

- `type ProviderLocality = "local" | "private" | "remote"`.
- `classifyProviderLocality(baseUrl: string): ProviderLocality` — pure,
  table-tested classification of the configured bare origin's host:
  - loopback IPv4/IPv6 literals and `localhost` → `local` ("On this Mac");
  - private ranges (RFC 1918, CGNAT 100.64/10, link-local 169.254/16 and
    `fe80::/10`, unique-local `fc00::/7`), `.local`/`.lan`/`.home`/`.internal`
    suffixes, and single-label hostnames → `private` ("Private network");
  - everything else → `remote` ("Remote provider").
- `WorkspaceStatus` payload:
  `{ locality, endpoint_reachable, lm_studio_reachable, chat_model,
  embed_model, checked_at, latency_ms }`. No endpoint URL, no API key, no
  provider error bodies, no model lists. Model IDs are already shown to the
  authenticated user in Settings and are not secrets.
- Cached probe with a short TTL (20 s) and single-flight refresh: concurrent
  callers share one in-flight probe. The probe is the same body-free
  `GET ${llmBaseUrl}/v1/models` with a 2 s timeout and `redirect: "error"`.
  A shared fetch helper is extracted from `systemHealth.ts` rather than
  duplicated. A failed or timed-out probe returns `endpoint_reachable: false`
  with HTTP 200 — an unreachable model is a status, not a server error.
  `lm_studio_reachable` is `null` when no LM Studio health endpoint is set.
- `latency_ms` clamps to `0..2000` like the health checks.

New route in `server/src/routes/system.ts`: `GET /api/status` behind
`requireAuth`, OpenAPI-tagged, returning the cached snapshot. The snapshot
never contains credentials or URLs, so nothing new can leak into logs.

### Backend tasks

- A1 Extract the shared body-free probe helper; `workspaceStatus.ts` with
  locality classification + TTL/single-flight cache. Table-driven unit tests
  for classification and cache behavior (fake `now`/`fetch`).
- A2 `GET /api/status` route + focused route tests: 401 unauthenticated, shape
  and sanitization (no origin, no key anywhere in the body), reachability
  false on probe failure, `lm_studio_reachable` null when unset.

## Web spec

- `web/src/lib/api.ts`: `WorkspaceStatusResponse` type and
  `workspaceStatus()` API function for `GET /api/status`.
- New `web/src/components/WorkspaceStatus.tsx`, rendered in the `Shell`
  sidebar above `AccountMenu`:
  - Locality row: colored dot + label — "On this Mac" / "Private network" /
    "Remote provider". Remote uses the warning color; local uses success.
  - Reachability row: status dot (checking / reachable / unreachable) with
    probe latency in milliseconds when available.
  - Model row: chat model identity, truncated; embed model in the title
    attribute.
  - When locality is `remote`, one amber line: "Some data leaves this Mac —
    see Settings." linking to `#/settings`; the hover title names the payload
    classes (ingestion text, prompts, retrieval queries, tool context).
  - Polls every 30 s, refreshes on mount and on tab focus, aborts in-flight
    requests on unmount, and renders a neutral "Checking…" state first.
- The strip is informational, not an authorization surface; it must render
  even when `/api/status` errors (show unreachable/checking, never crash the
  shell).

### Web tasks

- B1 `api.ts` types + function; `WorkspaceStatus` component + `Shell` wiring.
- B2 Component tests: local, private, remote, unreachable, and error states;
  remote state shows the disclosure and the Settings link; no state leaks
  between polls.

## Documentation tasks

- C1 `docs/API.md`: document `GET /api/status` next to `/api/health`,
  including the sanitization contract.
- C2 `README.md`: one line noting the ambient locality/model status in the
  shell.
- C3 `AGENTS.md`: add the strip invariants under conventions (body-free
  bounded probe only; payload excludes URLs and credentials; the strip is not
  a security boundary; provider-egress wording must match the Settings text).

## Done criteria

- `pnpm --filter borealis-server typecheck lint test` and the web equivalents
  pass, plus the full `pnpm verify` gate before the final M01 commit.
- A fresh browser-development session shows the strip with a locality label
  and model identity without opening Settings.
- `GET /api/status` response never includes the endpoint origin, API key,
  provider errors, or model lists (asserted by test).
- When a remote provider is configured, the chrome shows the egress
  disclosure without any user action.
