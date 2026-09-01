# Borealis desktop

The desktop package builds the Apple Silicon macOS 13+ Electron application. It
embeds the compiled Node server and React UI while storing the SQLite ledger,
LanceDB index, uploads, reports, provider and contained-model configuration,
downloaded model files, and generated JWT secret under
`~/Library/Application Support/Borealis/`.

## Develop

Run the commands below from the repository root on an Apple Silicon Mac. Use
Node.js 22.13 or newer 22.x (`.nvmrc` pins 22.22.3) and pnpm 10.x. Enable
Corepack once with `corepack enable`. Native-addon compilation also needs
Python 3 and Xcode Command Line Tools. The packaged app includes its own
Electron runtime; users do not need a separate Node install.

```bash
pnpm install
pnpm dev:desktop
```

The desktop install runs `desktop/scripts/isolate-native-addons.mjs`: it copies
native addons out of the pnpm store and nests each copy's production
dependencies (so Electron's utility process can resolve modules such as
LanceDB's `reflect-metadata`), then rebuilds those copies for Electron's ABI so
the rebuild cannot overwrite the server Node bindings. Do not workspace-link
`borealis-server` into this package. `dev` builds the server and web UI, copies
them into `desktop/runtime/`, builds the shell, and launches Electron. It does
not start Vite or watch for changes; quit and rerun it after editing. No
Playwright browser download is needed for desktop rendering.

Development and installed builds use the same default data directory. To keep
development data separate, pass an absolute Electron `--user-data-dir` path:

```bash
pnpm dev:desktop -- --user-data-dir="$HOME/Library/Application Support/Borealis Dev"
```

Quit the existing Borealis instance before switching profiles. The shell takes
a single-instance lock and focuses the running window on a second launch with
the same profile.

## Verify

```bash
pnpm --filter borealis-desktop verify
```

`verify` runs typecheck, a clean shell build and policy/contract/runtime tests,
formatting, Electron native-addon smoke, and the hidden-renderer PNG/PDF smoke.
The native smoke first checks that isolated addon copies can resolve their
production dependencies under Node, then opens SQLite, performs a LanceDB
vector search, and queries DuckDB using `ELECTRON_RUN_AS_NODE`, then loads the
same addons from an Electron utility process (the path `dev` and the packaged
app actually use). `ELECTRON_RUN_AS_NODE` alone can still see the pnpm virtual
store and is not sufficient; the packaged acceptance path below never depends
on it. The renderer smoke checks PNG/PDF signatures,
zero HTTP requests reaching its test server, and rejection of observed unsafe
resource requests. The renderer smoke requires a graphical macOS session.

Focused commands are available as `typecheck`, `test`, `format:check`,
`native:smoke`, and `render:smoke`. Turborepo runs `build` before `test` and
`render:smoke`. `build` cleans and compiles only the shell. `runtime:copy`
requires server and web `dist/` outputs; `pnpm dev:desktop` and
`pnpm package:unsigned` build those first via Turborepo.

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
pnpm package:unsigned
pnpm --filter borealis-desktop package:native:smoke
pnpm --filter borealis-desktop package:entitlements:smoke
```

`package:unsigned` uses a dedicated builder configuration with signing identity
and notarization disabled, even if release credentials are present in the
environment.

The artifacts are written under `desktop/release/` as
`Borealis-<version>-macOS-arm64.dmg` and `.zip`, with the application at
`desktop/release/mac-arm64/Borealis.app`. Before launch, the packaged-native
smoke inspects the built fuse wire, requires SHA-256 ASAR-integrity metadata and
an ASAR-only application, then starts the real app executable with hostile
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, and inspector
arguments. The hardened app must ignore those production execution surfaces and
load `better-sqlite3`, `@lancedb/lancedb`, and `@duckdb/node-api` from an actual
Electron utility process through `app.asar`; native assets remain in
`app.asar.unpacked`. That same utility smoke generates a one-page PDF and runs
the physically unpacked JXA helper through real PDFKit/Vision recognition,
without a network fallback. The smoke requires a completed package build and
does not launch the normal UI or check signing/notarization.

`package:dir` builds the application directory without DMG/ZIP installers. It
uses the normal builder configuration and may sign or notarize when credentials
are available; use `package:unsigned` when signing must be disabled. On a clean
checkout, invoke the directory target through Turborepo so it builds and copies
the server and web runtime first:

```bash
pnpm exec turbo run package:dir --filter=borealis-desktop
```

`desktop/runtime/`, `desktop/release/`, compiled output, and dependencies are
generated and intentionally ignored. The entitlement plists under
`desktop/build/` are source inputs and must remain tracked. Runtime copying
checks that every server runtime dependency exists in the desktop package and
that installed dependency versions match the server installation. Shared
runtime versions are pinned in the root `pnpm.overrides`; do not bypass the
version check. It also verifies the Vite manifest and copies every content-hashed
lazy route/chart chunk. The web production build enforces a 240 KiB gzip initial
JavaScript budget, a 130 KiB maximum lazy chunk, separate route entries, and an
ECharts-free initial graph.

### Signed distribution

The app currently uses Electron's default application icon; local unsigned
artifacts are not suitable for distribution. For the release path, make a
Developer ID Application certificate and private key available in the keychain
(optionally select it with `CSC_NAME`), or supply `CSC_LINK` and
`CSC_KEY_PASSWORD`. Supply one complete notarization credential set and run:

```bash
pnpm exec turbo run package:mac --filter=borealis-desktop
```

The Turborepo invocation builds the shell, server, and web UI and refreshes
`desktop/runtime/` before Electron Builder runs. Calling the filtered
`package:mac` package script directly assumes those generated inputs are already
current.

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

Production fuses disable `RunAsNode`, `NODE_OPTIONS`, Node inspector arguments,
browser-process V8 snapshots, and extra `file:` privileges; they enable cookie
encryption, embedded-ASAR integrity validation, ASAR-only application loading,
and WebAssembly trap handlers. The packaged fuse inspector fails closed if the
Electron fuse wire gains an unreviewed option. The utility process receives a
positive environment allowlist plus exact shell-owned storage, bind, UI, and
renderer values; arbitrary inherited `NODE_*`, `ELECTRON_*`, and storage-path
variables do not cross into the backend.

The hidden report renderer accepts only `about:blank` and bounded PNG data
URLs, denying HTTP(S), WebSocket, and local-file loads. Both sides of its IPC
boundary validate PNG/PDF signatures. Playwright's Chromium download is not
copied into the app; Electron produces desktop PNG and PDF artifacts.

Signed distribution builds use Apple's hardened runtime but deliberately do not
enable the Mac App Store application sandbox. The unsigned local-test artifacts
are neither signed nor notarized. The embedded native SQLite, LanceDB, and
DuckDB addons and direct `userData` storage need a separately designed sandbox
migration before a store build is possible.

The retained hardened-runtime entitlements are intentionally narrow and shared
by the app/inherit profiles: `com.apple.security.cs.allow-jit` supports
Electron/V8 JIT execution, `com.apple.security.cs.disable-library-validation`
allows the separately rebuilt unpacked native addons to load. There is no broad
filesystem, network-client, server-listener, unsigned-executable-memory, or App
Sandbox entitlement; because version 1 is not sandboxed, ordinary client
networking does not require the App Sandbox network entitlement.

The 2026-09-01 ad-hoc hardened-runtime matrix signed one identical packaged app
with each tracked variant and ran the real-executable utility/native smoke.
The exact retained pair passed; removing either `allow-jit` or
`disable-library-validation` failed, while removing `network.client` passed and
therefore removed that entitlement from both tracked profiles. `codesign`
inspection confirmed runtime flags and the exact variant entitlements; repeat
the tracked matrix with
`pnpm --filter borealis-desktop package:entitlements:smoke` after packaging.
The command makes copy-on-write disposable app bundles, ad-hoc signs each with
the hardened runtime, inspects its entitlements, requires the retained pair to
pass the real packaged native/OCR smoke, and requires each retained-key removal
to fail. Repeat the same inspection for a Developer ID release candidate before
distribution.

The application does not bundle model weights or a model-server binary. In
contained mode, Borealis streams a requested model into a resumable `.part`
file below `models/` and promotes it to a complete model only after mandatory
SHA-256 verification. It can start a user-supplied `llama-server` binary on an
OS-assigned loopback port, health-check the process, switch the live provider
origin to it unless `LLM_BASE_URL` is environment-managed, restore the previous
origin on stop, and stop the process during orderly app shutdown. See the
[contained-model API contract](../docs/API.md#contained-models) for setup,
download, and lifecycle details. Contained configuration alone does not start
the engine.

Alternatively, start LM Studio separately or configure an HTTPS
OpenAI-compatible provider in Borealis Settings. The default endpoint is
`http://127.0.0.1:1234`. With a remote provider, source text sent for ingestion
embeddings, retrieval queries, prompts, chat history, and selected source/tool
context leave the machine under that provider's data policy. Ingestion can send
source text before it is attached to a chat; parsing, analytical SQL, storage,
and report rendering remain local.

For PDFs, embedded text is extracted first. Empty pages can use the fixed local
PDFKit/Vision OCR helper copied into the server runtime; it is invoked directly
through `/usr/bin/osascript`, has page/raster/time/output limits, and never uses
the network or renderer privileges. Managed embedding migrations build a
separate verified index while the old index remains live; selecting apply makes
restart mandatory so startup can perform and verify the journaled swap.

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

| Path                       | Contents                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `borealis.sqlite`          | Relational ledger and chunk text; SQLite may also create WAL/SHM files.                                              |
| `lancedb/`                 | Embedding vectors plus the mode-`0600` resolved-model/dimension marker and first-binding receipt paired with SQLite. |
| `uploads/`                 | Account/source-scoped uploads and connector caches.                                                                  |
| `reports/`                 | Generated HTML and PDF files.                                                                                        |
| `models/`                  | Checksum-verified contained-model downloads and resumable `.part` files.                                             |
| `.lancedb-migrations/`     | Private staged/backup indexes for an active managed embedding migration.                                             |
| `embedding-migration.json` | Mode-`0600` aggregate migration state; absent when no operation remains.                                             |
| `contained.json`           | Contained-engine paths/arguments; created mode `0600`, currently updated by direct write.                            |
| `settings.json`            | Provider settings, written atomically with mode `0600`.                                                              |
| `jwt.secret`               | Generated signing secret, created once with mode `0600` unless `JWT_SECRET` is supplied.                             |

Electron also stores its browser profile/cache under this directory. The
desktop host does not load `.env` files. Inherited provider environment
overrides still take precedence over Settings, and an explicit `JWT_SECRET`
still wins. The shell overrides bind, storage-path, static-UI, and render-backend
environment variables; use `--user-data-dir` to relocate the desktop store.
See [server/.env.example](../server/.env.example) for supported operator values.

Quit Borealis before using the supported workspace archive CLI. SQLite and
LanceDB are one logical store and stay together in its encrypted, hashed
`.borealis-workspace` container, along with SQLite WAL state, uploads, reports,
downloaded models, contained configuration, provider settings, and the signing
secret. The CLI uses the same instance lock as desktop startup: a persistent
private mode-`0700` namespace with atomically published, never-reused
mode-`0600` owner records. Normal Electron startup does not pre-create userData
or its durable subdirectories; the backend acquires that exact lock before it
creates/canonicalizes paths or creates, reads, or repairs `jwt.secret`, so a
rejected competing launch cannot mutate the live workspace. It restores through
a sibling stage, verifies the
stores offline, and retains an existing target as an explicitly removable
backup. Removal renames that exact verified inode to a deterministic hidden
`backup-remove` tombstone and retains provenance until recursive deletion and
marker cleanup finish, so the same command safely resumes after a crash without
touching a replacement at the former backup pathname. The offline verifier
requires an existing Lance table. It validates the public identity marker when
present; a valid dimension-matching first-binding receipt without that marker is
accepted read-only as the recoverable publication-crash state, and exact-model
startup recreates the marker. An existing index with neither identity file is
rejected.
See
[Storage and workspace archives](../docs/API.md#storage-and-workspace-archives)
for commands, passphrase sources, reserved portable paths, generic relocated
additions, limits, and recovery.
Closing the last window also quits
the app. Shutdown aborts active runs, stops ingestion and the automation
scheduler, stops any contained engine, and closes DuckDB, LanceDB, and SQLite
before acknowledging completion; the shell allows eight seconds before killing
an unresponsive backend.

Preserve environment-managed configuration separately when archiving or restoring
a profile, especially `EMBEDDING_DIM` and an explicit `JWT_SECRET`; the data
directory does not record those operator overrides.

## Troubleshooting

| Symptom                                                                                              | Check                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native-module ABI or architecture error                                                              | Use an arm64 terminal and the supported Node/pnpm versions. Run `pnpm --filter borealis-desktop native:rebuild`, then `pnpm --filter borealis-desktop native:smoke`. Desktop copies native addons out of the pnpm store so Electron's ABI rebuild cannot overwrite the server Node bindings; do not hoist the workspace. |
| `Cannot find module` from `@lancedb/lancedb` (for example `reflect-metadata`) in the utility process | Isolation copied the addon without its production dependencies. Re-run `pnpm --filter borealis-desktop native:rebuild` so `isolate-native-addons.mjs` nests those deps, then `pnpm --filter borealis-desktop native:smoke`.                                                                                              |
| Runtime-copy dependency mismatch                                                                     | Run `pnpm install` from the repository root so `pnpm-lock.yaml` and root `pnpm.overrides` apply to both server and desktop, then retry. Do not bypass the version check.                                                                                                                                                 |
| Missing runtime or stale UI                                                                          | Quit and rerun `pnpm dev:desktop`; `build` alone does not copy the backend or web UI.                                                                                                                                                                                                                                    |
| Settings field is disabled or an edit has no effect                                                  | Check inherited provider environment overrides. Editing `server/.env` does not configure the desktop host.                                                                                                                                                                                                               |
| Login page after session expiry or clearing storage                                                  | Quit and reopen the app to renew the local account session.                                                                                                                                                                                                                                                              |
| Packaged-native smoke cannot find the app                                                            | Run `package:unsigned` first; the smoke expects the generated `release/mac-arm64/Borealis.app`.                                                                                                                                                                                                                          |
