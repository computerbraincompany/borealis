# Plan 005: Remove dead code (playwright pdf.ts, ejs, restoreManifest chain)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- server/src/pdf.ts server/src/pythonClient.ts server/package.json python/app/main.py python/app/datasets.py`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (all removed code is unreferenced — verified by grep)
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

Four pieces of dead weight confuse future readers and waste install size:

1. `server/src/pdf.ts` — a Playwright-based HTML→PDF helper (`htmlToPdf`).
   It is **imported by nothing** (verified with grep; reports are built by the
   Python service via `py.pdf`, not this file). It pulls the heavyweight
   `playwright` dependency into `server/package.json` — a package that
   downloads a Chromium browser on `npm install` and is entirely unused.
2. `ejs` in `server/package.json` — no `ejs`/`EJS` reference anywhere in
   `server/src` (leftover from an earlier template approach).
3. `@types/pdf-parse` in server devDependencies — the app never imports
   `pdf-parse` (it uses `pdfjs-dist`).
4. The `restoreManifest` chain — `server/src/pythonClient.ts:60-62` exposes
   `restoreManifest()`, `python/app/main.py:114-118` defines
   `POST /manifest/restore`, and `python/app/datasets.py:137-146` implements
   `restore_from_manifest`. The server boot restore path (AGENTS.md:
   `restoreDatasets()` in `server/src/ingest.ts`) registers each dataset by
   calling `py.registerDataset` individually — the manifest endpoint is never
   called anywhere.

Removing all of it shrinks the dependency graph, removes a browser binary from
`npm install`, and eliminates the confusion of having two PDF builders (the
Playwright one is dead; the live one is Python/WeasyPrint).

## Current state

`server/src/pdf.ts` — entire file (lines 1–44) exports `htmlToPdf` and
`closeBrowser`; no other file imports it. `server/src/index.ts` never imports
it (verified: only `fastify`, `cors`, `config`, `db`, `ingest`, `auth`,
`routes`).

`server/package.json` dependencies (lines 13–27): `ejs: "^3.1.10"`
(line 18) and `playwright: "^1.55.0"` (line 26);
devDependencies include `"@types/pdf-parse": "^1.1.5"` (line 35).

`server/src/pythonClient.ts` lines 60–62:

```ts
  restoreManifest(accountId: string, datasets: any[]) {
    return post("/manifest/restore", { account_id: accountId, datasets });
  },
```

`python/app/main.py` lines 114–118:

```python
@app.post("/manifest/restore")
def restore_manifest(account_id: str, names: dict[str, Any]) -> dict[str, str]:
    dataset = names
    datasets.restore_from_manifest(account_id, dataset.get("datasets", []))
    return {"status": "restored", "count": len(datasets.list_datasets(account_id))}
```

`python/app/datasets.py` lines 137–146:

```python
def restore_from_manifest(account_id: str, manifest: list[dict[str, Any]]) -> None:
    with LOCK:
        _REGISTRY[account_id] = {}
        for item in manifest:
            loc = item.get("location")
            if loc and Path(loc).exists():
                try:
                    register(account_id, item["name"], loc, item.get("kind", "path"), item.get("original_name", item["name"]), item.get("url"))
                except Exception:
                    continue
```

## Commands you will need

| Purpose   | Command                                    | Expected on success |
|-----------|--------------------------------------------|---------------------|
| Typecheck | `cd server && npm run typecheck`           | exit 0              |
| Reinstall | `cd server && npm install`                 | exit 0              |
| Grep dead (server) | `cd server && grep -rn "htmlToPdf\|closeBrowser\|playwright\|ejs\|restoreManifest" src/` | no output |
| Grep dead (python) | `cd python && grep -rn "manifest/restore\|restore_from_manifest" app/` | no output |
| Py import  | `cd python && .venv/bin/python -c "import app.main, app.datasets, app.reports"` | exit 0   |
| Lockfile   | `cd server && grep -n "playwright\|ejs" package-lock.json` | no matches |

## Scope

**In scope** (the only files you should modify):
- `server/src/pdf.ts` — delete the file
- `server/package.json` — remove the three dependencies
- `server/package-lock.json` — updated by `npm install`
- `server/src/pythonClient.ts` — remove the `restoreManifest` method
- `python/app/main.py` — remove the `/manifest/restore` endpoint
- `python/app/datasets.py` — remove `restore_from_manifest`

**Out of scope** (do NOT touch, even though they look related):
- `server/src/ingest.ts` `restoreDatasets()` — keep; it is the live restore path.
- `python/app/datasets.py` `register`, `resync`, `_connection` — keep.
- Any other dependency changes. Do not bump `openai`, `fastapi`, etc.
- `AGENTS.md`/`README.md` — they don't mention these symbols; no doc edit needed.

## Git workflow

- Branch: `advisor/005-remove-dead-code`
- Commit style (conventional): `chore(server,python): remove dead pdf/ejs/manifest code`
  — one commit is fine, or two (`chore(server)` + `chore(python)`); match repo
  history's single-purpose commits per subsystem.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Delete server/src/pdf.ts

**Verify**: `cd server && test ! -f src/pdf.ts && echo deleted`

### Step 2: Remove the three server dependencies

Remove from `server/package.json`: `ejs`, `playwright`, `@types/pdf-parse`.
Run `cd server && npm install` to sync the lockfile.

**Verify**:
- `cd server && grep -n "playwright\|ejs\|pdf-parse" package.json package-lock.json` → no matches
- `cd server && npm run typecheck` → exit 0

### Step 3: Remove restoreManifest on the server

In `server/src/pythonClient.ts`, delete lines 60–62 (the `restoreManifest`
entry and its trailing comma on the `py` object).

**Verify**: `cd server && grep -rn "restoreManifest" src/` → no output;
`cd server && npm run typecheck` → exit 0.

### Step 4: Remove the python manifest path

- `python/app/main.py`: delete the `/manifest/restore` endpoint (lines 114–118).
- `python/app/datasets.py`: delete `restore_from_manifest` (lines 137–146) and
  the now-unused `json` import **only if** no other code in `datasets.py` uses
  `json` (check first with `grep -n "json" python/app/datasets.py` — the
  `_read_sql`/register paths don't use it; if it is used elsewhere keep it).

**Verify**:
- `cd python && grep -rn "manifest/restore\|restore_from_manifest" app/` → no output
- `cd python && .venv/bin/python -c "import app.main, app.datasets, app.reports"` → exit 0

## Test plan

No test framework exists. The verification is structural (grep) plus
import/typecheck. When a test baseline lands, add a boot/route smoke asserting
`/manifest/restore` returns 404 (not planned here).

## Done criteria

ALL must hold:

- [ ] `test ! -f server/src/pdf.ts`
- [ ] `grep -rn "htmlToPdf\|closeBrowser\|playwright\|ejs\|restoreManifest" server/src/` → no matches
- [ ] `grep -rn "manifest/restore\|restore_from_manifest" python/app/` → no matches
- [ ] `cd server && npm run typecheck` exit 0; `npm install` exit 0
- [ ] `cd python && .venv/bin/python -c "import app.main, app.datasets, app.reports"` exit 0
- [ ] `git status --porcelain` lists only the 6 files above plus `plans/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" doesn't match the live files.
- A grep finds any real consumer of the removed symbols outside the listed
  files (e.g. a test, a script, a config referencing `htmlToPdf` or
  `restoreManifest`).
- Removing `ejs`/`playwright` breaks `npm install` or `typecheck`.
- You discover `pdf-parse` is actually imported somewhere (then keep
  `@types/pdf-parse` and report).

## Maintenance notes

- The live PDF builder is Python/WeasyPrint (`python/app/reports.py` → server
  `py.pdf` in `tools.ts`). If a Node-side PDF renderer is ever wanted, add it
  fresh with a named dependency then.
- If Playwright is later needed for E2E browser tests, it should live in a
  separate dev-dependency set (e.g. the already-present `.playwright-mcp/`
  and `web` tooling), not the server runtime.
- The server dependency list is now: cors, multipart, bcryptjs, dotenv,
  fastify, jsonwebtoken, mammoth, openai, pdfjs-dist, pg, tsx, uuid, xlsx.
  xlsx is a follow-up candidate (see plans/README "considered and rejected").
