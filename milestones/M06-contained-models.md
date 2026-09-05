# M06 — Contained-model lifecycle on macOS

**Horizon:** 1 ("the object on the desk") — *Contained-model lifecycle on
macOS as a first-class path beside "paste a cluster origin."* Plus the vision's
model topology: contained mode is a first-class personality — offline-capable,
zero token meter, honest about limits.

**Status:** DONE (2026-09-01). Commits `af49681` (verified downloads and config
storage), `05af22c` (engine lifecycle and endpoint switching), and `7adac79`
(ambient status, shutdown, and desktop data paths) shipped the backend/API and
chrome slices. The 2026-09-01 remediation closed the remainder: Settings →
Local engine now contains the management panel (`ContainedConfig`/`ContainedDownloadState`
client types and a `containedApi` wrapper in `web/src/lib/api.ts`,
`useContained` + `ContainedPanel` with visibility-aware polling starting at
2 seconds and widening on consecutive failures),
`contained.json` uses same-directory atomic replacement preserving mode `0600`
with mode repair, spawn failures reach the child-process `error` listener and
land in the bounded `crashed` state, and missing-path diagnostics are
deterministic (binary before model).

## Problem

Borealis speaks to any OpenAI-compatible endpoint, but the weights themselves
always live outside the product: the operator starts LM Studio (or nothing)
by hand. The vision's "contained" path — the Portable Computer move — is
missing: nothing downloads and verifies weights into the app's own data
directory, nothing starts/stops/watches a local engine as part of the
workspace, and the chrome cannot say "inference is on this Mac" because the
app does not own any local engine.

## Goal

1. **Verified weight download** — model files download into the workspace data
   directory with required SHA-256 verification, resumable byte ranges,
   bounded size, and cancel; partial artifacts never masquerade as complete.
2. **Managed loopback runtime** — a first-class engine lifecycle for the
   llama.cpp `llama-server` contract: Borealis builds the args, spawns the
   process bound to `127.0.0.1` on an OS-assigned port, waits for its
   `/v1/models` health, and stops it on quit. The engine is just another
   OpenAI-compatible endpoint; nothing else in Borealis changes.
3. **First-class switch, not a paste** — when the engine turns healthy and the
   provider endpoint is not environment-managed, Borealis applies the engine's
   loopback origin through the live settings store (restoring the prior origin
   on stop). When the environment manages the endpoint, the state says so
   instead of pretending.
4. **Chrome health/locality integration** — `/api/status` carries the
   contained state and the sidebar strip shows "On this Mac · contained".

## Non-goals

- No bundled weights and no bundled engine binary in v1: the operator supplies
  the `llama-server` binary path and the model file (which the download
  manager can fetch). Bundling is a packaging follow-up.
- No inference code in Borealis: chat/embeddings keep flowing through the one
  OpenAI-compatible contract (`llm.ts`); the engine manager only owns process
  lifecycle and health.
- No multi-engine scheduling, GPU configuration, or quantization tooling.
- No changes to environment precedence: an env-managed `LLM_BASE_URL` always
  wins; contained auto-apply visibly stands down in that case.

## Backend spec

Directories and config (read `config.ts`, `settingsStore.ts`,
`runtimeSettings.ts` first):

- `config.containedDir = canonicalStorageDirectory(process.env.CONTAINED_DIR ||
  <storageDir>/models)` — in desktop this resolves under Electron `userData`
  like every other durable path.
- Contained configuration lives in `<storageDir>/contained.json` with its own
  tiny store `server/src/contained/configStore.ts`: `{ enabled: boolean,
  binary_path: string, model_path: string, extra_args: string[] }`. Paths must
  be absolute without `~`; `extra_args` is bounded (32 items × 200 chars), and
  invalid config fails closed on read. The writer uses same-directory atomic
  replacement with mode `0600`, repairing a pre-existing widened mode.

Download manager (`server/src/contained/downloadManager.ts`):

- `startDownload({url, filename, sha256})` where `filename` matches
  `^[A-Za-z0-9._-]{1,180}$` (no separators, no `..`), `sha256` is 64 hex
  chars, and the URL is HTTPS or loopback HTTP with `redirect: "error"` and a
  bounded total size (default 64 GiB, env `CONTAINED_MAX_DOWNLOAD_BYTES`).
- Bytes stream to `<containedDir>/<filename>.part`; on (re)start with an
  existing `.part`, a `Range: bytes=<n>-` header resumes (a `200` answer
  restarts from zero); completion verifies SHA-256 — mismatch deletes the
  `.part` and records a failed state; success renames atomically to
  `<filename>`. One download per filename at a time; cancel deletes the
  `.part`.
- State per download: `{filename, url_host, state: "downloading"|"verifying"|
  "complete"|"failed"|"canceled", bytes_received, total_bytes|null, error?}`.
  The registry is in memory; the `.part` file is the durable artifact across
  restarts (a fresh `POST` resumes it). URL host is kept for display; the URL
  itself is not persisted in state.

Engine manager (`server/src/contained/engineManager.ts`):

- `start()` reads the config, requires `enabled`, checks the binary and model
  files exist, picks a free loopback port, and spawns
  `binary_path -m <model_path> --host 127.0.0.1 --port <port>
  [...extra_args]`. Health = body-free `GET /v1/models` (the shared
  `endpointProbe`) polled every 500 ms up to 180 s; states: `off` → `starting`
  → `healthy` | `crashed` (process exit) | `stopped`. One engine at a time;
  `stop()` sends SIGTERM with a bounded kill timeout. Early exits are captured
  and never logged with contents. A child-process `error` listener sends spawn
  failures into the bounded `crashed` state. Existence checks run in order:
  binary first, then model, so missing-path diagnostics are deterministic.
- **Auto-apply**: on first `healthy`, if the effective `llm_base_url` is not
  environment-managed, the manager records the previous origin and patches
  `llmBaseUrl` to `http://127.0.0.1:<port>` via `runtimeSettingsStore().patch`
  (live, no restart). On stop, if the current origin is the engine's, the
  prior origin is restored. `SettingsEnvironmentOverrideError` → the state
  reports `endpoint_managed_by_env: true` and no patch is attempted again
  until restart. Patch failures are contained; the engine keeps running.
- Server shutdown (the same orderly-shutdown path that closes DuckDB/LanceDB)
  stops the engine first.

Routes (`server/src/routes/contained.ts`, requireAuth, plain `{error}`
envelope):

- `GET /api/contained` → `{config: {enabled, binary_path, model_path,
  extra_args} | null, engine: <state>, downloads: [...]}`.
- `PUT /api/contained/config` → validated body; writing does not start or stop
  a running engine.
- `POST /api/contained/downloads`, `DELETE /api/contained/downloads/:filename`.
- `POST /api/contained/engine/start` (202 with state; health continues in the
  background), `POST /api/contained/engine/stop`.
- `GET /api/status` gains an injectable `contained` section:
  `{state, model: <filename>|null, endpoint_host: "127.0.0.1:<port>"|null,
  endpoint_managed_by_env}` or `null` while the engine state is `off` —
  loopback-local facts only, still no credentials or provider URLs.

Tests:

- Config store: round-trip, mode 0600, absolute-path validation, malformed
  file fails closed.
- Download manager against a local HTTP server: full download + checksum
  match; checksum mismatch deletes the `.part`; resume honors `Range` and
  survives a mid-download abort; oversize bound fails; disallowed URL
  (private/public mismatch, redirects) fails; filename validation.
- Engine manager with a stub engine (a Node script serving `/v1/models` after
  a short delay and honoring SIGTERM): start → healthy with the built args;
  auto-apply patches settings and restores the prior origin on stop;
  env-managed settings report `endpoint_managed_by_env` without patching;
  process crash → `crashed`; stop is idempotent.
- Routes: auth required; validation errors; state reads.
- `/api/status`: contained section present/absent; no secrets in payload.

## Desktop wiring

- `desktop/src/main.ts` resolves `CONTAINED_DIR` under `userData` like the
  other durable paths (a one-line env addition to the existing utility-process
  environment block).
- Orderly shutdown already runs through the backend; the engine stop hook
  lives server-side, so no desktop code changes beyond the env value.

## Web spec — shipped

- **Shipped:** `WorkspaceStatusResponse.contained` and the `WorkspaceStatus`
  strip. When `contained.state === "healthy"`, the locality
  row reads **"On this Mac · contained"** with the model filename in the
  tooltip; `endpoint_managed_by_env` appends "endpoint managed by environment"
  to the hint.
- **Shipped:** `ContainedConfig`/`ContainedDownloadState` client types and a
  `containedApi` wrapper for get/config/download/cancel/start/stop.
- **Shipped:** contained management under Settings → Local engine as a bounded panel:
  enable toggle, binary/model paths, download form (URL, filename, SHA-256)
  with per-download state, start/stop buttons with live state. Out of scope:
  download progress percentages in the sidebar.
- **Tests:** the strip's healthy/managed states and panel configuration,
  download, start, and stop flows are covered by the contained UI suites.

## Documentation tasks

- `docs/API.md`: contained routes, download contract (checksums, resume,
  bounds), engine states, auto-apply/restore semantics, and the env-override
  stand-down.
- `README.md`: contained-mode paragraph in "Model setup and privacy boundary"
  — what ships, what the operator supplies, offline promise.
- `desktop/README.md`: `CONTAINED_DIR` under userData.
- `AGENTS.md`: invariants — engine binds loopback only; auto-apply never
  overrides environment-managed endpoints and always restores; `.part`
  artifacts never count as models; checksums mandatory; instructions/URLs not
  logged; engine stop is part of orderly shutdown.
- `milestones/README.md`: flip M06 when done.

## Done criteria

- Completed: the Settings control surface ships, configuration replacement
  preserves mode `0600`, engine spawn errors enter a bounded state, and path
  diagnostics are deterministic. See the ledger's dated verification record.
- `pnpm verify` green including the new suites.
- Live check: download a fixture model file with checksum verification into
  the data directory, start the stub engine, see `/api/status` report
  `contained.state = "healthy"` with the provider switched to the engine's
  loopback origin, stop it, and see the prior origin restored and the strip
  return to the previous locality.
