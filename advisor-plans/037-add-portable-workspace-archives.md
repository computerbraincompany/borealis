# Plan 037: Add verified portable workspace archives

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: product / operations / security
- **Planned at**: `14ab08f`, 2026-08-31

## Why this matters

The documented backup procedure is a manual copy of a stopped application-data
directory. It is easy to omit WAL state, relocated model files, settings, or
the matching vector index, and there is no integrity or restore verification.

## Target contract

- A supported Node CLI creates, inspects, and restores one versioned
  `.borealis-workspace` archive from explicit absolute paths. It never infers a
  home directory, repository root, or broad deletion target.
- Server startup and the CLI share an exact mode-0600 instance lock. Archive
  operations refuse a live workspace; stale-lock recovery validates regular
  file ownership and process liveness without following symlinks.
- The archive contains a deterministic manifest with relative path, kind, size,
  mode class, and SHA-256 for every included file. It includes SQLite WAL state,
  LanceDB, uploads, reports, settings, signing secret, contained config, and
  default model directory; explicitly relocated paths require named additions.
- Paths, member counts, individual bytes, total bytes, compression ratio, and
  extraction time are bounded before/during extraction. Absolute, `..`, NUL,
  duplicate, case-colliding, symlink, device, socket, and hard-link members are
  rejected.
- Archives are encrypted and authenticated by default using streaming
  AES-256-GCM with scrypt-derived keys and a versioned header. Passphrases come
  from an interactive TTY or a dedicated environment/file descriptor, never an
  argv value or log. Plaintext export requires an explicit unsafe flag.
- Restore decrypts/extracts to a mode-0700 sibling staging directory, verifies
  every manifest hash and SQLite/Lance presence, then atomically renames the
  existing exact target to a recoverable backup and installs the staged tree.
  It never recursively overwrites a live target; rollback restores the backup.
- A post-restore verify mode opens the copied SQLite/Lance/DuckDB stores with the
  configured dimension without starting HTTP, models, ingestion, or egress.
- Whole-workspace export remains an offline operator CLI, not an authenticated
  account route, because it contains sibling accounts and instance secrets.

## Scope

- workspace lock lifecycle, archive codec/CLI, package scripts/dependencies
- isolated store verification, tests, policy, README/API/desktop documentation
- no cloud upload, scheduled backup, or ordinary-account endpoint

## Implementation steps

1. Add the exact workspace lock to browser/desktop server ownership and prove
   acquire, stale recovery, concurrent refusal, crash, and orderly release.
2. Implement a streaming archive container over a maintained tar library with a
   strict preflight/member filter, manifest, hashes, compression, encryption,
   atomic `.part` publication, and mode repair.
3. Implement inspect/verify without extraction and restore through exact sibling
   staging plus recoverable target rename. Add a separate explicit command to
   remove an old backup after verification; never auto-delete it.
4. Add isolated storage-open verification and cross-check embedding dimension,
   settings/config, SQLite schema, Lance rows, and required directory layout.
5. Test round-trip, corruption, wrong passphrase, truncation, archive bombs,
   traversal/link/collision attacks, live lock, crash at every rename, relocated
   additions, and secret-free output.
6. Document passphrase recovery limits, archive sensitivity, free-space needs,
   supported versions, and forward-version refusal.

## Verification

- Focused archive/lock/storage tests, fixture round-trip, policy, server/desktop
  builds, packaged CLI/runtime smoke where shipped, and `pnpm verify`.

## Done criteria

- [ ] One command creates an integrity-verifiable complete stopped-workspace
  archive and one command restores it recoverably.
- [ ] Malicious/corrupt archives cannot write outside exact staging.
- [ ] No secret, path, member name, or passphrase is logged by default.
- [ ] Restored stores open together and preserve retrieval identity.

## STOP conditions

- A live Lance/SQLite pair cannot be positively excluded.
- Restore would require recursive overwrite or deletion of an unverified path.
- The archive library cannot reject links/traversal before filesystem writes.
