# Plan 037: Add verified portable workspace archives

## Status

- **State**: DONE (2026-09-01)
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
- Server startup and workspace-touching CLI commands share an exact instance
  lock: a persistent private mode-0700 namespace containing atomically published,
  never-reused mode-0600 owner records. They refuse a live workspace;
  archive-only inspection needs no workspace lock. Release and stale recovery
  quarantine only unique records after validating ownership, identity, and
  process liveness without following symlinks.
- The archive contains a deterministic manifest with relative path, kind, size,
  mode class, and SHA-256 for every included file. It includes SQLite WAL state,
  LanceDB, uploads, reports, settings, signing secret, contained config, and
  default model directory. Explicitly relocated core paths use type-checked
  reserved additions that restore to canonical root names, including SQLite
  sidecars and active LanceDB migration staging; generic additions restore below
  `relocated/<name>`.
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
- Backup removal renames the verified inode to a deterministic private
  tombstone derived from the generated backup name. Its provenance marker stays
  authoritative until recursive deletion finishes, so retry resumes an exact
  partial tombstone or clears a marker left after deletion without touching a
  replacement raced into the former backup pathname.
- A post-restore verify mode opens the copied SQLite/Lance/DuckDB stores with the
  configured dimension without starting HTTP, models, ingestion, or egress.
  It accepts a valid dimension-matching receipt-only embedding-index
  publication crash read-only; exact-model startup repairs the matching marker.
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

- [x] One command creates an integrity-verifiable complete stopped-workspace
      archive and one command restores it recoverably.
- [x] Malicious/corrupt archives cannot write outside exact staging.
- [x] No secret, path, member name, or passphrase is logged by default.
- [x] Restored stores open together and preserve retrieval identity.

## Completion record

- The offline CLI implements create/inspect/restore/verify/remove-backup;
  workspace-touching commands share the exact instance lock, while inspection
  validates the archive alone. It uses a deterministic hashed manifest, gzip
  plus default AES-256-GCM/scrypt protection, named relocations, path rebasing,
  and atomic staged restore with recoverable backup provenance.
- Lock publication writes and fsyncs a unique candidate before atomically
  publishing it inside a persistent mode-0700 namespace. Cross-process scans
  make simultaneous candidates fail closed; stale/released mode-0600 records
  move through unique identity-checked reap paths, so no replacement at a
  shared pathname can be unlinked. Dead temporary publications and abandoned
  reapers are recovered conservatively, while live or malformed entries fail
  closed. If recovery itself stops after recreating the exact owner name, the
  next acquisition accepts only the proven two-link same-inode/payload pair and
  finishes that restoration; any unpaired multi-link record remains rejected.
- Server configuration import resolves paths without filesystem access. Startup
  creates/canonicalizes durable directories and creates, reads, or repairs the
  JWT secret only after acquiring the exact lock; normal Electron startup no
  longer pre-creates userData subdirectories. A fresh-process regression proves
  a lock-rejected startup leaves missing paths absent and preserves an existing
  secret byte-for-byte and mode-for-mode.
- Inspection and restore share one monotonic deadline across source reads,
  decryption, gunzip, decompressed-byte accounting, and tar extraction. After
  the manifest arrives, a canonical tar-size ceiling covers declared bodies,
  headers, padding, required PAX path records, and the terminator, so trailing
  or concatenated compression cannot consume unaccounted work.
- The reserved `borealis.sqlite`, `lancedb`, `uploads`, `reports`, `models`,
  `settings.json`, `contained.json`, and `jwt.secret` additions restore at the
  portable root with kind and collision checks. SQLite WAL/SHM/journal files and
  external LanceDB migration staging are captured as one logical store;
  arbitrary additions remain below `relocated/<name>`. Restored directories are
  `0700`, ordinary/secret files `0600`, and owner-executable files `0700`.
- Archive, lock, server-lock, and verifier tests cover encrypted round trips,
  corruption/authentication, traversal/link/collision/bomb rejection, live and
  stale locks, pre/post-publication crashes, a competing process during stale
  recovery, replacement-safe release, abandoned-reaper and interrupted
  two-link restoration, rejection of unpaired hard links, inode-safe backup
  removal, portable external core stores, real SQLite sidecar recovery,
  reserved wrong kinds and canonical collisions, generic addition-name
  collisions, arbitrary additions, concatenated-gzip expansion, valid
  Unicode/PAX paths, and bounded offline SQLite/LanceDB/DuckDB verification. An
  external-LanceDB ready-to-apply fixture proves its sibling migration staging
  restores to `.lancedb-migrations/` and can finish apply, restart, and retrieval
  after the original external paths are removed. A receipt-only embedding-index
  publication crash is archiveable/restorable: offline verification accepts the
  valid dimension-matching receipt without mutating it, then exact-model startup
  repairs the public marker. A populated index with neither marker nor receipt
  fails closed even when its vector dimension matches.
- Backup-removal regressions interrupt recursive deletion and marker unlink,
  then prove the next invocation resumes only the marker-authorized tombstone;
  a replacement at the former backup pathname remains untouched.

## STOP conditions

- A live Lance/SQLite pair cannot be positively excluded.
- Restore would require recursive overwrite or deletion of an unverified path.
- The archive library cannot reject links/traversal before filesystem writes.
