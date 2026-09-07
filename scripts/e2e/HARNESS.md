# Product-acceptance harness

The common harness for [docs/END_TO_END_ACCEPTANCE.md](../../docs/END_TO_END_ACCEPTANCE.md).
It builds the actual production web/backend, boots the real server against
the committed scripted fixtures under `scripts/e2e/fixtures/`, drives real
Chromium through the product UI, runs journeys sequentially, and cleans up.
Browser journeys A–F are implemented. Native packaged acceptance uses a separate
external UI driver and per-run checkpoints; browser-on-packaged-backend coverage
is explicitly a compatibility check. A green full product run means every
selected scenario actually executed, never that a stub was skipped. Current
results and remaining checks live in [EXECUTION.md](../../milestones/EXECUTION.md).

Fixtures and their ready-line protocol are documented in
[README.md](README.md).

## Layout

- `run-product.mjs` — `pnpm test:e2e:product` entry (server + fixtures + browser).
- `run-product-desktop.mjs` — packaged-desktop entry (lifecycle default;
  `--journey=all --native-driver=external` requires the normal native UI driver).
- `harness/` — `workspace`, `server`, `browser`, `providers`, `desktop`
  (lifecycle), `desktopApp` (journey target), `util`.
- `journeys/` — `registry.mjs`, the six required modules `A.mjs`…`F.mjs`
  (all implemented), and the `smoke.mjs`
  self-test.

## How to run

From the repository root (Node 22.x, pnpm 10.x, Playwright Chromium installed
via `pnpm --filter borealis-server exec playwright install chromium`):

```bash
# Harness self-test (assumes `pnpm --filter borealis-server build` and
# `pnpm --filter borealis-web build` were run; without --skip-build the
# entry builds them first):
node scripts/e2e/run-product.mjs --journey=smoke --skip-build

# All required browser journeys:
node scripts/e2e/run-product.mjs --journey=all

# Packaged desktop lifecycle (requires `pnpm package:unsigned` first;
# exits 3 BLOCKED when the app is absent — never a silent pass):
node scripts/e2e/run-product-desktop.mjs

# Required native A–F checkpoints (external driver must act on the real UI):
node scripts/e2e/run-product-desktop.mjs --journey=all --native-driver=external

# Real interruption, active-work shutdown and scheduled catch-up:
pnpm test:e2e:product:lifecycle --evidence-dir=/absolute/new/lifecycle-evidence

# Configured real local model pair, using disposable finance/research data:
pnpm test:e2e:product:live
```

Flags for `run-product.mjs`:

| Flag | Meaning |
| ---- | ------- |
| `--journey=A\|B\|C\|D\|E\|F\|smoke\|all` | Selection; `all` means exactly A–F; comma-separated ids allowed. Selecting nothing is a usage error (never zero tests). |
| `--skip-build` | Assume `server/dist` and `web/dist` exist (fails with `PREBUILT_MISSING` otherwise). |
| `--workspace=DIR` | Adopt an explicit absolute, empty run root instead of a fresh `os.tmpdir()` tree. |
| `--keep-on-failure` | Keep the run tree on failure and print its absolute path. |
| `--inject-failure` | `smoke`-only tripwire: proves a red run exits non-zero while cleanup still verifies. |

`run-product-desktop.mjs` accepts `--journey=ID`, `--workspace=DIR`,
`--keep-on-failure`, and an absolute `--app=PATH`. Native journeys require
`--native-driver=external`: the private checkpoint bridge binds each request to
a fresh nonce, exact app PID/profile, and bundle hash. The external driver must
perform the requested real UI action; independent read-only checks verify durable
state and exported bytes. Missing native driver is BLOCKED, not a pass.
`--surface=browser --journey=B` retains the older browser-on-packaged-backend
compatibility path and never counts as native-renderer acceptance.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Every selected journey passed and cleanup verified lock/pid release. |
| 1 | Any journey failed or is a NOT-IMPLEMENTED stub, or cleanup found a leak. |
| 2 | Usage/build/workspace error before any journey ran. |
| 3 | Desktop BLOCKED — the packaged arm64 app or required external native UI driver is unavailable. Distinct from failure by contract. |

## Isolation and security contract

- The server's `BOREALIS_DATA_DIR` is an exact absolute directory inside a
  fresh `mkdtemp` tree (or an explicit empty `--workspace` override). The
  harness refuses any run root that overlaps `<repo>/.borealis`,
  `~/.borealis`, the installed-app support directory, or the repository, and
  its cleanup refuses to delete any path outside its own run root.
- The server runs `server/dist/index.js` with a harness-owned minimal
  environment: `LLM_BASE_URL` = launched scripted provider origin,
  `LLM_CHAT_MODEL=fixture-chat-v1`, `LLM_EMBED_MODEL=fixture-embed-v1`,
  `EMBEDDING_DIM=64` (operator-precedence identity, no Settings migration
  path), `STATIC_WEB_DIR=web/dist`, `PORT=0`, `HOST=127.0.0.1`. No
  `JWT_SECRET` (generated inside the isolated tree), no `LITELLM_*` aliases,
  no `.env` discovery (neutral cwd). The listen port comes from the server's
  own `Borealis server listening` log line, never guessed.
- Cleanup always runs (try/finally): browser, then the server via SIGTERM
  (production orderly shutdown, bounded wait, SIGKILL escalation only
  against the owned pid), then fixtures; afterwards it verifies the
  workspace instance-lock namespace holds no owner records and that every
  owned pid is gone, and records `lock_released`/`pids_gone` in the summary.
- **Historical product defect (mitigation kept deliberately):** a SIGTERM
  within a few seconds of ledger/data-plane traffic used to abort the server
  in `duckdb.node` `AsyncWorker::OnWorkComplete` during Node environment
  cleanup, skipping the lock release and leaking the workspace lock owner
  record. The product now drains the DuckDB dataset worker before exit (the
  raw-SIGTERM regression test `server/src/tests/shutdownDrain.test.ts` proves
  the clean exit without any harness gate). The harness still gates shutdown
  on the product's own authenticated readiness surface:
  `server.quiesceWorkers({ token })` polls `GET /api/health` until every
  service (including the data service worker) reports `operational`, then
  sends SIGTERM. This is a bounded poll on a real signal, not a sleep, and it
  settles the browser journey's readiness transitions. It does not prove
  active-work shutdown. The [process lifecycle companion](LIFECYCLE.md)
  deliberately bypasses that gate and checks interruption, drain, recovery,
  and closed-app catch-up. Any unexpected abort remains a failure.

## Output and artifact policy (content-free)

- stdout carries `journey <id>: <status>` lines plus exactly one
  `E2E_SUMMARY {json}` line: per-journey id, status
  (`pass|fail|not_implemented`), duration, failure code, and artifact
  **filenames** only. The same JSON is written to `summary.json` in the run
  directory (a pre-cleanup copy, plus the final copy when kept).
- Screenshots are `shot-001.png`, `shot-002.png`, … under
  `artifacts/<journey>/`; server/fixture logs use fixed names under `logs/`
  and exist only inside the disposable run tree (removed unless
  `--keep-on-failure`). Never commit artifact content; record only
  filenames/counts in verification evidence.
- Nothing logs prompt text, bodies, tokens, provider errors, or account
  data. Fixture stderr is retained as a bounded, truncated tail only.

## Journey author guide

- Drop `journeys/<id>.mjs` exporting `IMPLEMENTED = true` and
  `async function run(ctx)`; register it in `journeys/registry.mjs`. Until
  its feature ships, keep the loud `notImplementedStub` — never convert a
  spec into a claimed pass.
- `ctx` provides: `journeyId`, `repoRoot`, `workspace` (artifact dirs,
  pid tracking, containment-protected paths), `server` (`origin`,
  `fetchJson`, `waitBaseline`, `quiesceWorkers`, `stop`,
  `restart({ token })` — quiesce, orderly stop, and re-boot on the exact same
  isolated data directory and loopback port so browser sessions/JWT survive
  the restart for durability proofs), `provider` (`origin`, `models`,
  `state()` — content-free call counters, `setScript({ steps, onExhausted })`
  — install a deterministic step script at runtime and reset the pointer, so
  journeys drive scripted tool-call roundtrips on the one launched provider),
  `browser` (`newSession`), `fixtures` (fixture-name → ready-line config, e.g.
  WebDAV origins, OAuth issuer origin, MCP endpoints — inject real endpoints
  from `ready` payloads, never assume ports), `artifactsDir`, `injectFailure`.
- Sessions come from `browser.newSession({ origin })`:
  `register()`/`login()` drive the real rendered auth forms;
  `apiFetch(route)` reuses the UI's stored token so API assertions test the
  same authenticated account (GET, or `{ method, body }` for JSON mutations);
  `apiFetchText(route)` returns raw response text plus content type,
  disposition, and byte-level BOM presence for export-byte assertions;
  `screenshot()` returns content-free names; `assertClean()` **fails the
  journey** on any unexpected console error or React `act(...)` warning (the
  only default allowlist is `401` resource failures while the auth bootstrap
  flag is active — keep that window as narrow as possible). Deliberate
  negative-path probes (foreign-account `404`, stale-CAS `409`, etc.) call
  `allowStatuses([404])` to admit exactly those codes — never a blanket
  wildcard.
- Journeys that need protocol fixtures beyond the entry-launched provider
  start them themselves with `launchFixture({ workspace, name, env })` from
  `harness/providers.mjs` and register cleanup with
  `workspace.onCleanup(() => handle.stop())` (pids stay tracked; shutdown
  order is still fixtures-last). Journeys A/D do this for the OAuth issuer,
  the two Streamable HTTP MCP instances, and the WebDAV collection; the
  stdio MCP fixture is not launched by the harness at all — the PRODUCT
  spawns it from the connection config (repository Node + fixture script
  path), which is part of what journey A exercises.
- End every journey that touched persisted state or the data plane with
  `await server.quiesceWorkers({ token })` before returning, so the entry's
  final readiness state is checked. Active-work shutdown has its own ungated
  [lifecycle proof](LIFECYCLE.md).
- Journeys that drive MULTI-CALL durable runs (research synthesis, tool
  loops) can use a provider `slow` step as a deterministic scripting window:
  the fixture picks the script step when the request arrives but only streams
  its content after `delay_ms`, so polling `provider.state()` proves the call
  is in flight and `provider.setScript()` then governs the run's remaining
  calls exactly. Use this to install responses that must embed
  mid-run-generated ids (captured evidence, run-scoped UUIDs) fetched from
  the product's own read APIs while the provider still holds the call —
  bounded polling on provider counters, never sleeps or network-idle races.
- Assertions must verify persisted state and exported bytes, not screenshots
  alone; keep waits bounded with explicit deadlines — no arbitrary sleeps,
  and never `wait: 'networkidle'`-style races.
- Real browser downloads: click the UI control while awaiting
  `page.waitForEvent('download')`, then `download.saveAs()` under a
  `workspace.assertOwnedPath()` directory and parse the saved bytes in Node
  (journey C's ZIP/OOXML readers are the reference). Chromium gates automatic
  downloads per DOCUMENT: the 11th automatic download on one document never
  fires without a user prompt, so a journey that exports more than ~10 files
  must navigate with a real document reload (hash route + `page.reload()`),
  which resets the per-document allowance — journey C does this between its
  two document-export phases.
- React surfaces that mirror DOM selection (the workbench rewrite panel) do
  not update from programmatically dispatched `select` events; drive real
  keyboard selection (`End`/`Shift+ArrowLeft`, `Home`/`Shift+End`) like a
  user, and assert the mirrored badge before using the selection.

## Root commands

The root scripts are implemented:

```bash
pnpm test:e2e:product
pnpm test:e2e:product:desktop
pnpm test:e2e:product:live
```

The browser command runs A–F. Desktop requires fresh unsigned packaging and
an external normal-UI driver; use the native-driver option above when operating
its checkpoints. The live entry requires a compatible configured local chat and
embedding pair, and checks fixture finance/research facts; an unavailable model
or unusable result is an explicit failure/blockage, never an automatic pass.
These commands complement root verification, GUI rendering, packaged native and
entitlement smokes, and the populated stopped-workspace archive/restore proof.
