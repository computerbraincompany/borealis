# Borealis desktop

The desktop package builds the Apple Silicon macOS 13+ Electron application. It
embeds the compiled Node server and React UI while storing the SQLite ledger,
LanceDB index, uploads, reports, model settings, and generated JWT secret under
`~/Library/Application Support/Borealis/`.

## Develop and verify

Use Node.js 22.13 or newer 22.x and npm 10.9.x:

```bash
npm ci --prefix server
npm ci --prefix web
npm ci --prefix desktop
npm --prefix desktop run verify
npm --prefix desktop run dev
```

`verify` runs the desktop typecheck, policy/contract tests, formatting check,
Electron native-addon ABI smoke, and the hidden-renderer PNG/PDF smoke. The
renderer smoke must report valid PNG/PDF bytes, zero network hits, and blocked
unsafe requests.

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
`Borealis-<version>-macOS-arm64.dmg` and `.zip`. The packaged-native smoke loads
`better-sqlite3`, `@lancedb/lancedb`, and `@duckdb/node-api` from the generated
application archive. `desktop/runtime/`, `desktop/release/`, compiled output,
and dependencies are generated and intentionally ignored; the entitlement
plists under `desktop/build/` are source inputs and must remain tracked.

The unsigned package currently uses Electron's default application icon and is
not suitable for distribution. To build the signed/notarized release path, make
a Developer ID Application identity available through the keychain or `CSC_*`
variables, supply notarization credentials, and run:

```bash
npm --prefix desktop run package:mac
```

Notarization accepts either Apple API-key variables (`APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or Apple-ID variables (`APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Never place certificates or
credentials in this repository.

## Runtime boundary

The app starts Fastify in an Electron utility process on an OS-assigned
`127.0.0.1` port and serves the UI from that same origin. Main and preview
windows are sandboxed, context-isolated, and have Node integration disabled.
The hidden report renderer denies network and local-file loads. Playwright's
Chromium download is not copied into the app; Electron produces desktop PNG and
PDF artifacts.

Signed distribution builds use Apple's hardened runtime but deliberately do not
enable the Mac App Store application sandbox. The unsigned local-test artifacts
are neither signed nor notarized. The embedded native SQLite, LanceDB, and
DuckDB addons and direct `userData` storage need a separately designed sandbox
migration before a store build is possible.

The application does not contain model weights. Install LM Studio or configure
an HTTPS OpenAI-compatible provider in Borealis Settings. The passwordless local
profile does not expose a sign-out action. Its bootstrap JWT is held only in
Chromium session storage; if the session expires while Borealis remains open,
quit and reopen the app to mint a fresh session for the same local account.
