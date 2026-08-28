# Plan 028 — Deep-audit remediation (P1/P2/P3)

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

Status: **DONE** (implementation recorded at `b7a4fe8`, 2026-08-23)

This pass implemented the complete engineering finding ledger requested after the
deep audit: P1-01 through P1-11, P1-I1, P2-01 through P2-12 including the two
conditional exposure flags, and P3-01 through P3-03. Product-direction options
D1–D3 are intentionally outside this implementation pass.

## Completion ledger

The middle column records the concrete implemented scope rather than shortening
the original finding to a new title.

| Finding | Implemented scope | Status |
| --- | --- | --- |
| P1-01 | Deny-by-default WeasyPrint resource loading; PDF input and artifact boundaries | DONE |
| P1-02 | Report HTML/attribute escaping, CSP, and untrusted-markdown handling | DONE |
| P1-03 | Account-scoped dataset identity and explicit connector format propagation | DONE |
| P1-04 | Immutable connector cache versions, compare-and-swap refresh, and visible lifecycle states | DONE |
| P1-05 | Lossless JSON-safe numeric normalization across DuckDB, Node, and the web UI | DONE |
| P1-06 | Strict bounded canonical chart validation and renderer parity | DONE |
| P1-07 | Bounded report payloads, owned artifact paths, and safe report reads/deletes | DONE |
| P1-08 | Row/cell/column/header/character-bounded tabular extraction with honest counts | DONE |
| P1-09 | Lowest-boundary upload, message, history, extraction, chunk, tool, and response budgets | DONE |
| P1-10 | Idempotent signature-aware registration plus durable ingestion/reconciliation | DONE |
| P1-11 | Durable single-run state, server cancellation, reload rehydration, and terminal events | DONE |
| P1-I1 | Public-only, DNS-pinned, redirect-validated, deadline- and size-bounded outbound fetches | DONE |
| P2-01 | Cursor-paged chat history with stale-response ownership guards | DONE |
| P2-02 | Per-account dataset locking and bounded scoped-catalog concurrency | DONE |
| P2-03 | Opaque public errors and safe UI rendering of validated request references | DONE |
| P2-04 | Structured request/operation correlation across Fastify, workers, and FastAPI | DONE |
| P2-05 | Fail-closed runtime configuration, service credentials, and action-state gates | DONE |
| P2-06 | Critical server/Python/web regression and mounted orchestration coverage | DONE |
| P2-F1 | Exact credentialed-CORS allowlist for deployments beyond the default loopback UI | DONE |
| P2-F2 | Authenticated loopback Python service and canonical shared storage configuration | DONE |
| P2-07 | Script-capable opaque-sandbox report preview with abort/stale-request ownership | DONE |
| P2-08 | Explicit `.doc`/`.xls` rejection and aligned upload affordances | DONE |
| P2-09 | Single-flight New Chat creation with mounted/navigation ownership | DONE |
| P2-10 | Transition-only source/connector polling and compact source summaries | DONE |
| P2-11 | Persisted canonical chart PNG reuse instead of duplicate rendering | DONE |
| P2-12 | Resource Fastify plugins and extracted chat/catalog state-machine hooks | DONE |
| P3-01 | Checked ESLint, Prettier, Ruff, EditorConfig, build, and CI contracts | DONE |
| P3-02 | One resolved upload root across Node, Python, scripts, and documentation | DONE |
| P3-03 | Remove Node SheetJS/Pandas; keep bounded offline XLSX via actively used OpenPyXL | DONE |

## Implementation contracts at completion

These contracts describe the Plan 028 boundary. Plans 029 and 030 later moved
the data service into Node and replaced the relational/vector engines with
SQLite and LanceDB. They retained the security and lifecycle requirements;
the Python/Postgres mechanisms below are historical.

- Postgres owns durable source jobs and chat-run state. Ingestion claims use
  `FOR UPDATE SKIP LOCKED`, generation checks, bounded retry/backoff, staging,
  and atomic chunk promotion. Python registry reconciliation is differential
  and safe to repeat after either service restarts.
- Every stored-data call carries the immutable account/source snapshot down to
  DuckDB. Per-account locks and bounded account/allowlist catalogs prevent
  cross-tenant table visibility while avoiding one global data lock.
- URL connector refresh downloads to a new immutable cache version, validates
  its declared CSV/JSON format, then changes registry ownership with a CAS. A
  failed or superseded refresh cleans only its candidate and preserves the last
  known-good version.
- Both web-fetch surfaces resolve and validate every destination and redirect,
  reject any non-public DNS answer, pin the validated address for the socket,
  and enforce one total deadline plus byte and redirect limits.
- A chat turn and its durable run are accepted transactionally. The controller
  exists before `run-started` is published; cancellation is idempotent; chat
  detail exposes `active_run`; `run-ended` is the authoritative terminal event.
- Browser async work is revision-owned by the mounted chat/navigation. Pending
  uploads survive only pre-upload list responses, transitional resources alone
  poll, and local abort never precedes an accepted server cancellation.
- Generated report files and uploads live under UUID-scoped account/resource
  directories. Reads and deletes prove exact ownership after canonical/realpath
  resolution and never infer a broad recursive target from database text.

## Dependency decision

The original dependency sketch could remove OpenPyXL only while XLSX parsing was
delegated to DuckDB's dynamically installed extension. Offline XLSX support and
no runtime extension download are stronger requirements. This implementation
therefore removes unused Pandas and vulnerable Node `xlsx`, then makes OpenPyXL
an intentionally used, pinned runtime dependency behind ZIP expansion/member,
worksheet row/column/cell, and converted-output limits. Legacy `.xls` is dropped.

## Verification contract at completion

At this boundary, `scripts/verify.sh` ran server typecheck/lint/format/unit
tests/build, web typecheck/tests/lint/format/build, Python Ruff/format/pytest,
and the guarded real-pgvector integration suite when `TEST_DATABASE_URL` named
an explicitly disposable database ending in `_test`. CI provisioned that
database and ran the complete matrix with ephemeral credentials.

The current [verification guide](../README.md) and
[`scripts/verify.sh`](../scripts/verify.sh) supersede those commands. Current
integration tests use disposable SQLite and LanceDB stores without an external
database URL.
