# Plan 032: Harden Electron production fuses and code-loading policy

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none; coordinate with plans 002 and 019
- **Category**: security / desktop
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

The packaged binary deliberately honors `ELECTRON_RUN_AS_NODE`, accepts Node
environment/inspector capabilities through default fuses, and does not require
validated ASAR-only application loading. Existing native verification depends
on that production capability. The hardened runtime also carries broad code-
loading entitlements whose necessity has not been proven with the current
native addon set.

## Target contract

- Production fuses disable RunAsNode, `NODE_OPTIONS`/extra-CA environment
  handling, CLI inspector arguments, and file-protocol extra privileges.
- Embedded ASAR integrity validation and only-load-from-ASAR are enabled; cookie
  encryption is enabled for new profiles.
- A packaged verification path launches the normal app/utility-process path and
  proves SQLite, LanceDB, and DuckDB native loading without re-enabling a fuse,
  debug IPC, Node integration, or arbitrary output.
- Packaged application launch uses an allowlisted environment that strips Node,
  Electron debug, and `DYLD_*` injection variables.
- `disable-library-validation` and unsigned-executable-memory are removed only
  individually after signed/ad-hoc packaged tests prove V8 and every addon work.
  If proof is unavailable, retain the minimum unproven entitlement with a
  documented release-gate follow-up rather than breaking the app or claiming it
  was removed.

## Scope

- Electron-builder fuse configuration and packaging scripts
- packaged native/lifecycle probe and desktop main/utility code needed for a
  fixed content-free acceptance mode
- entitlement plists, CI, desktop tests, README and desktop README

## Implementation steps

1. Configure explicit Electron FuseV1 values in the tracked build config and
   add a read-only fuse inspection command that fails packaging verification on
   drift.
2. Replace `package:native:smoke` with a normal packaged launch mode that uses a
   mode-0700 temporary profile, fixed markers, bounded output/time, and exact
   process-group cleanup. Exercise all three native engines in the utility
   process without content or paths in output.
3. Sanitize the child environment and prove RunAsNode, Node options, and inspect
   flags are inert in the packaged binary.
4. Package and run with each broad entitlement removed separately. Keep only
   those required by reproducible native/JIT failures and record that evidence.
5. Run normal first-launch, renderer, rendering, native isolation, shutdown,
   unsigned package, and (when credentials exist) signed/notarized checks.

## Verification

- Desktop verify, unsigned packaging, fuse inspection, packaged lifecycle/native
  smokes, `codesign` entitlement inspection, policy, and `pnpm verify`.

## Done criteria

- [ ] Dangerous production fuses have explicit hardened values.
- [ ] Verification no longer relies on RunAsNode.
- [ ] ASAR integrity/only-load policy is tested from the packaged app.
- [ ] Every retained entitlement has recorded reproducible necessity.

## STOP conditions

- Native verification can pass only by exposing a general production execution
  surface or weakening renderer/utility isolation.
- ASAR integrity cannot cover the copied runtime and unpacked native assets;
  resolve package layout instead of disabling validation.
