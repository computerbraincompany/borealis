# Borealis desktop

The desktop package builds the Apple Silicon macOS 13+ Electron application. It
embeds the compiled Node server and React UI while storing the SQLite ledger,
LanceDB index, uploads, reports, model settings, and generated JWT secret under
`~/Library/Application Support/Borealis/`.

## Develop

Run the commands below from the repository root on an Apple Silicon Mac. Use
Node.js 22.13 or newer 22.x (`.nvmrc` pins 22.22.3) and npm 10.9.x. Native-addon
compilation also needs Python 3 and Xcode Command Line Tools. The packaged app
includes its own Electron runtime; users do not need a separate Node install.

```bash
npm ci --prefix server
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run dev
```

The desktop install runs `native:rebuild` for Electron's ABI. `dev` builds the
server and web UI, copies them into `desktop/runtime/`, builds the shell, and
launches Electron. It does not start Vite or watch for changes; quit and rerun it
after editing. No Playwright browser download is needed for desktop rendering.

Development and installed builds use the same default data directory. To keep
development data separate, pass an absolute Electron `--user-data-dir` path:

```bash
npm --prefix desktop run dev -- --user-data-dir="$HOME/Library/Application Support/Borealis Dev"
```

Quit the existing Borealis instance before switching profiles. The shell takes
a single-instance lock and focuses the running window on a second launch with
the same profile.

## Verify

```bash
npm --prefix desktop run verify
```

`verify` runs typecheck, a clean shell build and policy/contract/runtime tests,
formatting, Electron native-addon smoke, and the hidden-renderer PNG/PDF smoke.
The native smoke opens SQLite, performs a LanceDB vector search, and queries
DuckDB using Electron's runtime. The renderer smoke checks PNG/PDF signatures,
zero HTTP requests reaching its test server, and rejection of observed unsafe
resource requests. The renderer smoke requires a graphical macOS session.

Focused commands are available as `typecheck`, `test`, `format:check`,
`native:smoke`, and `render:smoke`. `test` and `render:smoke` each rebuild the
shell; `build` cleans and compiles only the shell. `runtime:prepare` builds the
server and web UI and copies their outputs, while `runtime:copy` requires those
outputs to exist already.

These checks do not perform a complete first-launch or model-backed chat flow.
Use [the repository verification instructions](../README.md#verify-end-to-end)
for the full gate and fixture workflow. Before shipping, also launch the app
with a fresh profile and verify registration-free bootstrap, chart/report
creation, reopening the same local account, and clean backend shutdown. The
repository gate runs the native smoke but leaves the GUI renderer and packaging
checks to the focused desktop/macOS gate.

## Package

Build unsigned arm64 DMG and ZIP artifacts for local testing:

```bash
npm --prefix desktop run package:unsigned
npm --prefix desktop run package:native:smoke
```

`package:unsigned` uses a dedicated builder configuration with signing identity
and notarization disabled, even if release credentials are present in the
environment.

The artifacts are written under `desktop/release/` as
`Borealis-<version>-macOS-arm64.dmg` and `.zip`, with the application at
`desktop/release/mac-arm64/Borealis.app`. The packaged-native smoke uses that
app's executable and loads `better-sqlite3`, `@lancedb/lancedb`, and
`@duckdb/node-api` through its `app.asar`; their native assets remain in
`app.asar.unpacked`. It requires a completed package build and does not launch
the UI or check signing.

`package:dir` builds the application directory without DMG/ZIP installers. It
uses the normal builder configuration and may sign or notarize when credentials
are available; use `package:unsigned` when signing must be disabled.

`desktop/runtime/`, `desktop/release/`, compiled output, and dependencies are
generated and intentionally ignored. The entitlement plists under
`desktop/build/` are source inputs and must remain tracked. Runtime copying
checks that every server runtime dependency exists in the desktop package and
that installed dependency versions match the server installation. Update and
install both lockfiles together when changing shared dependencies.

### Signed distribution

The app currently uses Electron's default application icon; local unsigned
artifacts are not suitable for distribution. For the release path, make a
Developer ID Application certificate and private key available in the keychain
(optionally select it with `CSC_NAME`), or supply `CSC_LINK` and
`CSC_KEY_PASSWORD`. Supply one complete notarization credential set and run:

```bash
npm --prefix desktop run package:mac
```

The pinned builder accepts:

- Apple API key: `APPLE_API_KEY` (the `.p8` file path), `APPLE_API_KEY_ID`, and
  `APPLE_API_ISSUER`.
- Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- A stored notarytool profile: `APPLE_KEYCHAIN_PROFILE`, optionally with
  `APPLE_KEYCHAIN` to select its keychain.

Missing credentials can cause the builder to skip signing or notarization;
`package:mac` does not enforce their presence. Check the signing/notarization
output and verify the generated app before distribution. Never place
certificates, private keys, passwords, or notarization credentials in this
repository. CI currently produces unsigned artifacts only.

## Runtime boundary

The app starts Fastify in an Electron utility process on an OS-assigned
`127.0.0.1` port and serves the UI from that exact origin, without CORS grants.
Main and preview windows are sandboxed, context-isolated, and have Node
integration and permission grants disabled. Main-window navigation stays on the
application origin. Only a controlled `about:blank` preview popup is allowed;
it has an empty preload and displays report HTML in an opaque-origin sandbox.

The hidden report renderer accepts only `about:blank` and bounded PNG data
URLs, denying HTTP(S), WebSocket, and local-file loads. Both sides of its IPC
boundary validate PNG/PDF signatures. Playwright's Chromium download is not
copied into the app; Electron produces desktop PNG and PDF artifacts.

Signed distribution builds use Apple's hardened runtime but deliberately do not
enable the Mac App Store application sandbox. The unsigned local-test artifacts
are neither signed nor notarized. The embedded native SQLite, LanceDB, and
DuckDB addons and direct `userData` storage need a separately designed sandbox
migration before a store build is possible.

The application does not contain model weights or start a model server. Start
LM Studio separately, or configure an HTTPS OpenAI-compatible provider in
Borealis Settings. The default endpoint is `http://127.0.0.1:1234`. With a remote
provider, source text sent for ingestion embeddings, retrieval queries, prompts,
chat history, and selected source/tool context leave the machine under that
provider's data policy. Ingestion can send source text before it is attached to
a chat; parsing, analytical SQL, storage, and report rendering remain local.

## Local profile and storage

First launch creates the passwordless `local@borealis.app` account. Every launch
mints a seven-day JWT for that same account and hands it exactly once to the
trusted main-window preload. The main process holds the pending handoff in
memory encrypted through Electron `safeStorage`; the UI keeps the session in
Chromium session storage, not local storage. No sign-out action is exposed for
this profile. If the session expires or is cleared, quit and reopen Borealis;
there is no local-profile password to enter in the browser login form.

Durable data is stored beneath `~/Library/Application Support/Borealis/` (or the
absolute `--user-data-dir` override):

| Path              | Contents                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `borealis.sqlite` | Relational ledger and chunk text; SQLite may also create WAL/SHM files.                  |
| `lancedb/`        | Embedding vectors paired with the SQLite ledger.                                         |
| `uploads/`        | Account/source-scoped uploads and connector caches.                                      |
| `reports/`        | Generated HTML and PDF files.                                                            |
| `settings.json`   | Provider settings, written atomically with mode `0600`.                                  |
| `jwt.secret`      | Generated signing secret, created once with mode `0600` unless `JWT_SECRET` is supplied. |

Electron also stores its browser profile/cache under this directory. The
desktop host does not load `.env` files. Inherited provider environment
overrides still take precedence over Settings, and an explicit `JWT_SECRET`
still wins. The shell overrides bind, storage-path, static-UI, and render-backend
environment variables; use `--user-data-dir` to relocate the desktop store.
See [server/.env.example](../server/.env.example) for supported operator values.

Quit Borealis before backing up or restoring the entire data directory. SQLite
and LanceDB are one logical store and must stay together, along with any SQLite
WAL state, uploads, reports, settings, and the signing secret. Closing the last
window also quits the app. Shutdown aborts active runs, stops ingestion, and
closes DuckDB, LanceDB, and SQLite before acknowledging completion; the shell
allows eight seconds before killing an unresponsive backend.

Preserve environment-managed configuration separately when moving or restoring
a profile, especially `EMBEDDING_DIM` and an explicit `JWT_SECRET`; the data
directory does not record those operator overrides.

## Troubleshooting

| Symptom                                             | Check                                                                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native-module ABI or architecture error             | Use an arm64 terminal and the supported Node/npm versions. Run `npm --prefix desktop run native:rebuild`, then `npm --prefix desktop run native:smoke`. Keep server and desktop `node_modules` separate. |
| Runtime-copy dependency mismatch                    | Install the matching server and desktop lockfiles with `npm ci --prefix server` and `npm ci --prefix desktop`, then retry. Do not bypass the version check.                                              |
| Missing runtime or stale UI                         | Quit and rerun `npm --prefix desktop run dev`; `build` alone does not copy the backend or web UI.                                                                                                        |
| Settings field is disabled or an edit has no effect | Check inherited provider environment overrides. Editing `server/.env` does not configure the desktop host.                                                                                               |
| Login page after session expiry or clearing storage | Quit and reopen the app to renew the local account session.                                                                                                                                              |
| Packaged-native smoke cannot find the app           | Run `package:unsigned` first; the smoke expects the generated `release/mac-arm64/Borealis.app`.                                                                                                          |
