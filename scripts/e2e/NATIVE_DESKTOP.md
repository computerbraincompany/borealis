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
The four document downloads must land under the provided exports directory:
HTML, PDF, Markdown ZIP and DOCX. ZIP members are decoded with size/CRC checks;
the driver additionally inspects rendered/exported layout.

The final checkpoint requires an actual normal Cmd+Q and disappearance of the
owned app process. The existing packaged shutdown smoke independently checks
the backend's orderly-stop acknowledgment. Driver observations are retained in
`native-checkpoints.json`; evidence export copies only synthetic artifacts,
never the profile, credential files or private driver session metadata.

Focused harness checks:

```sh
node --test scripts/e2e/harness/nativeDesktop.test.mjs
node scripts/e2e/run-product-desktop.mjs --journey=all
# The second command intentionally exits 3: no native driver was supplied.
```
