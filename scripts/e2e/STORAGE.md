# Storage acceptance

Run from the repository root with Node 22.x and pnpm 10.x:

```bash
pnpm --filter borealis-server exec tsx ../scripts/e2e/run-product-storage.mjs \
  --evidence-dir=/absolute/path/to/synthetic-evidence
```

This standalone gate creates only disposable synthetic workspaces. It does not
start the browser or touch the installed app profile. It removes both original
and restored profiles on success or failure; the optional evidence directory
receives `storage-summary.json` with counts, outcomes, and timestamps. It never
retains fixture document contents, credentials, or archive passphrases there.

The gate performs these operations against actual SQLite, LanceDB, and DuckDB:

1. Assemble the committed schema-v13 installation fixture, add historical agents,
   skills, a chat, a report share and report bytes, and open it through the actual
   migration runner. Compare every original column across twelve historical
   tables after upgrading through v14–v28.
2. Populate every product table introduced in v17 onward, including connection
   discovery, saved analysis results, document publications and interrupted
   publication intents, templates, rewrites, knowledge refresh staging, research
   evidence and reviewed cell corrections, brief recipes/runs/review history and
   dismissed notifications. The inventory check fails if any product table is
   unpopulated. Research evidence intentionally references a retired generation.
3. Run same-dimension and changed-dimension live embedding migrations against a
   bounded local HTTP embedding fixture while SQLite stays open. Verify the
   ledger handle, every ledger row, pre-existing artifact bytes, source-scoped
   retrieval and selected-empty retrieval after each swap.
4. Invoke the documented **`pnpm workspace:archive -- ...`** command in separate
   processes for encrypted `create`, `inspect`, `restore`, and `verify`. A held
   workspace lock must first make archive creation fail. The offline verifier
   checks the restored SQLite/Lance pair and reopens the ready CSV with DuckDB.
5. Compare every archived file hash and every ledger column, allowing only the
   specified absolute-path rebase and connection reconnect transitions. Assert
   machine-bound custody is absent, ready MCP/WebDAV connections require
   reconnect, native folders require reselect, and WebDAV credentials are cleared.
   Open the restored runtime and retrieve the preserved passage.

The synthetic publication PDFs used for byte-preservation checks are not export
layout acceptance. Browser/live export checks and visual PDF/DOCX inspection
remain separate required gates. This runner exercises migrations through the
real live coordinator and vector lifecycle; provider qualification and UI
migration admission have their own route/integration checks.
