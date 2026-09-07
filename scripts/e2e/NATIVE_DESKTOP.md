# Packaged native acceptance driver

The desktop product gate uses the actual hardened Apple Silicon app renderer.
It requires a graphical session and a normal OS UI driver, such as Codex CUA.
It never attaches a debugging port, injects a preload or alters a production
fuse. The previous `--journey=B` implementation opened external Chromium
against the packaged backend; that compatibility check is now explicitly
`--surface=browser --journey=B` and does not satisfy native acceptance.

Build fresh unsigned artifacts, then run from the repository root:

```sh
pnpm test:e2e:product:desktop --native-driver=external \
  --evidence-dir=/tmp/borealis-native-evidence \
  --keep-on-failure
```

The evidence directory must not already exist. `--app=/absolute/Borealis.app`
selects another package. Omitting `--native-driver=external` reports every
requested native journey BLOCKED and exits 3. This is an operator-assisted gate;
an unattended process cannot invent observations or reuse an older green file.
The separately callable no-journey lifecycle smoke remains available through
`node scripts/e2e/run-product-desktop.mjs`.

The runner prints `E2E_NATIVE_DRIVER_READY` followed by a private directory.
If macOS presents a keychain approval before the window appears, a person must
complete that system prompt. CUA cannot inspect or operate the protected
SecurityAgent application. Leave the checkpoint pending; do not change keychain
access rules, bypass custody, or acknowledge bootstrap before the app opens.

For CUA-controlled macOS Open and Save sheets, invoke the sheet's exposed
`Raise` secondary action before selecting files or saving. A background sheet
can report selected file rows while its Open button remains disabled. Raising
the sheet and using `Down` / `shift+Down` enabled ordinary multi-file selection
in the native acceptance run. Refresh the accessibility state before using
element indices; this is a focus step, not a change to file-access policy.
If a sheet still shows a supported file selected with Open disabled after Go To,
cancel and reopen Upload files at the remembered fixture directory, raise the
fresh sheet, then select with Down (and shift+Down for additional files). This
resolved the final native run's stuck selection; verify Open is enabled before
submitting. Changing the file-type filter alone did not resolve that state.

Its mode-0600 `session.json` contains the exact owned PID/profile, package
SHA-256, observed loopback origin, disposable fixture locations and local fixture
connection settings. Read it privately; do not copy credentials or its complete
contents into logs. The profile belongs to this run, never the installed app.
The provider is scripted but real HTTP/SSE, and the application still uses its
actual SQLite/LanceDB/DuckDB stores, OAuth transports and macOS secret custody.

The driver must complete each `request.json` through native UI actions, inspect
the resulting accessible UI or screenshot, then atomically create a private
`response.json` in that same directory. Copy the exact current identity fields:

```json
{
  "nonce": "from-current-request",
  "checkpoint": "from-current-request",
  "pid": 12345,
  "profile": "/private/tmp/exact-owned-profile",
  "package_sha256": "from-current-request",
  "status": "pass",
  "driver": "cua_repl",
  "observations": [
    "A concise, content-free account of actual completed UI actions and observed results."
  ]
}
```

Use status `blocked` or `fail` when the requested interaction cannot be
completed. Never acknowledge a step merely because its screen was opened or
its database rows exist. A response is an explicit driver attestation, not a
cryptographic recording of clicks. Nonces and process/package binding reject
stale or mismatched responses. Each request has a 20-minute deadline;
`--driver-timeout-ms=N` can choose 1 second through 60 minutes for a run.
Timeout/refusal is a failure, not a skip. The runner always stops its owned
app/fixtures and reports cleanup, including on failed observations.

All A–F checkpoints are required by `--journey=all`. Native checks complement
the shared browser failure matrix: the payload-less legacy report case runs
through browser journey C, which seeds genuine historical state while stopped.
The native workflow does not claim to seed or re-prove that legacy case. The driver may install
synthetic response steps through the fixture provider's existing
`POST /fixture/script` endpoint; it must not mutate application stores, mint
application sessions, inject renderer code or use API calls in place of the
requested UI actions. The authenticated setup account is used only to configure
the process-wide local provider. All native journey data belongs to the normal
passwordless bootstrap account.

Independent read-only checks restrict queries to that bootstrap account and
verify meaningful state transitions. Finance runs must match June/May expected
values independently recomputed from the four committed CSV fixtures. Use the
exact `native-finance.sql` supplied in the driver directory with a required
string `month` parameter; first run `2025-06`, then `2025-05`. The harness freezes
saved result/provenance, document revision/publication and review-decision
hashes and verifies they remain unchanged across later checkpoints. Folder
watch must ingest the exact changed fixture digest, not just complete a scan.
Journey D also captures a cited chat answer with only the managed `notes.md`
selected. Its original assistant message and evidence metadata are hashed and
must survive later checkpoints unchanged. During `D.permission`, the harness
temporarily sets only that owned fixture's mode to `000`. Open its native
Preview and observe **Restore read access to the folder and its files, then
retry.** The response observations must include that exact sentence. Read-only
checks require `KNOWLEDGE_FILE_UNREADABLE` in the watched connection and failed
preview; a generic failure or false size-limit error cannot pass. Leave the
fixture unreadable until the checkpoint is acknowledged. The harness restores
mode `0600` for `D.retry`; retry Preview and inspect a successful unchanged-file
scan, cleared permission state, the same source/generation and the old citation.
Do not reselect the folder or replace its source as a recovery shortcut.
The four document downloads must land under the provided exports directory:
HTML, PDF, Markdown ZIP and DOCX. ZIP members are decoded with size/CRC checks;
the driver additionally inspects rendered/exported layout.

Journey E uses the committed supplier corpus through a native folder preview.
Import the nine supported numbered documents; inspect the unsupported RTF and
leave `manifest.json` unselected. Create a comparison with these columns in order:
Price (number, USD), Effective date (date), Renewal (boolean), Tier (enum with
Basic/Pro/Premium/Standard/Enterprise), and Exceptions (text). Keep a selected-empty
draft to inspect its disabled Start guard, then attach the supplier library.

The tracked response helper uses only the local fixture provider and the owned
ledger opened read-only. It never creates application data or sessions. Supply
the absolute run root printed by the desktop entry (the parent of `native-driver`):

```sh
node scripts/e2e/native-research-fixture.mjs /tmp/owned-native-run plan
# In the native UI: Generate plan proposal; move step 3 up, edit its objective,
# then save the three-step plan before starting.
node scripts/e2e/native-research-fixture.mjs /tmp/owned-native-run arm
# While the helper waits: press native Start, navigate away, return and reload.
```

The helper waits for both a new run's real captured evidence and its first
in-flight model request, then installs typed responses referencing those actual
evidence UUIDs. It has a three-minute polling deadline and five-second transport
deadlines. The `E.research` guard independently verifies all 45 machine cells:
40 fixture values, five explicit scanned-invoice gaps, and the deliberately
off-type Everline price preserved as invalid. Proof is content-free in
`native-research-facts.json`.

Review the Everline price as numeric 15000/supported and the Acme renewal price
as an explicit supersession conflict. Export the table CSV/evidence manifest,
reload and reopen the result, then select only the Everline row and Price column.
Start `arm-rerun` instead of `arm` before pressing **Rerun selected rows/columns**;
inspect the carried corrections and revision diff. The `cancel` action installs
a silent fixture response: press native Start and Cancel to verify retained
partial captures and publication refusal. For a separate nine-source memo,
use `plan-memo`, Generate/save its one-step plan, then start `arm-memo` before
native Start. Accept the supported claim, reject the unsupported claim, note
the price conflict, and create/export a reviewed draft with conflict/gap
disclosures and the rejected fabrication excluded. Helper commands do not
acknowledge any checkpoint; all review, execution and export actions remain native.

Immediately before the final checkpoint, the runner explicitly holds fixture
embedding responses and edits the owned watched `notes.md` file.
Normal runs and earlier journeys keep the fixture's default immediate embedding
responses. The hold remains pending until explicit release or client cancellation;
its thirty-second deadline returns a failure, never vectors. Any expired hold
invalidates the quit proof, including an SDK retry after that expiry. Production
request and shutdown deadlines are unchanged. Do not release the hold during
this check; normal native Cmd+Q must cancel the actual request. The production
desktop folder watch must discover and ingest that changed file; the harness verifies an outstanding embedding response alongside
the exact scheduled active folder refresh. WebDAV watch is unsupported and is
never used as a substitute.
The final checkpoint requires an actual normal Cmd+Q during that scheduled
refresh and disappearance of the owned app process. The harness polls the
native account's active scheduled row, then verifies that same row cancelled
and no refresh remains active in the stopped ledger. A cancelled row allows
up to 30 seconds for orderly process drain. A naturally completed row cannot
prove active-work cancellation. Missing, manual, old, or unfinished
work cannot pass. Content-free proof is retained in `native-watch-quit.json`.
The native history can lag a background refresh. A fresh read-only observation
of the exact scheduled active row together with `embedding_held > 0` and no
expired hold is valid active-work evidence immediately before the real CUA Cmd+Q; do not wait for a
delayed history repaint and then claim a naturally completed scan was interrupted.
Diagnostic journey subsets that exclude D retain ordinary quit verification
and explicitly report `active_watched_quit: "not_selected"`; the full A–F gate
always requires the active watched-refresh proof.
The existing packaged shutdown smoke independently checks
the backend's orderly-stop acknowledgment. Driver observations are retained in
`native-checkpoints.json`; evidence export copies only synthetic artifacts,
never the profile, credential files or private driver session metadata.

Focused harness checks:

```sh
node --test scripts/e2e/harness/nativeDesktop.test.mjs
node scripts/e2e/run-product-desktop.mjs --journey=all
# The second command intentionally exits 3: no native driver was supplied.
```
