# Plan 018: Make report-HTML protection travel with the artifact (link schemes + embedded CSP)

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 567481d..HEAD -- python/app/reports.py server/src/routes.ts web/src/lib/api.ts python/tests/test_reports.py`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.
> Run AFTER plan 016 (it also edits `build_html`).

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: MED (a too-tight embedded CSP breaks interactive charts; verify E2E)
- **Depends on**: plans/016-pdf-report-charts.md (same function); conceptually extends plan 009's XSS work
- **Category**: security
- **Planned at**: commit `567481d`, 2026-08-23

## Why this matters

Plan 009 added a CSP header to `GET /api/reports/:id/html` and escaped raw
HTML in section markdown. Two gaps remain:

1. **Markdown links are not scheme-filtered.** Escaping `<`/`>` does nothing
   to `[click here](javascript:...)` — python-markdown renders that verbatim
   as an anchor. Report sections routinely quote content fetched from URL
   connectors / `fetch_url`, so an injected executable link can reach a
   report. The route CSP (`script-src 'unsafe-inline'`) does not block
   navigation.
2. **The header protects no surface users actually open.** The UI's "View
   HTML" fetches the report body as TEXT and opens it from a Blob URL
   (`openProtected`) — response headers are dropped, so the blob document has
   NO CSP while sharing the SPA's origin (where the bearer token lives in
   localStorage). Reports opened straight from `reports_storage/` have no
   headers at all. A policy EMBEDDED in the document is the only one that
   travels with the artifact.

Also: the HTML template silently falls back to loading echarts from an
UNPINNED third-party CDN when the vendored asset is missing — unpinned remote
JS inside generated reports must go.

## Current state

Files and their roles:

- `python/app/reports.py` — report rendering; owns markdown → HTML and the template.
- `server/src/routes.ts` — serves report files with the plan-009 header.
- `web/src/lib/api.ts` — `openProtected` blob flow (read-only context; NOT modified).
- `python/tests/test_reports.py` — escaping tests to keep green.

Current exact code:

`reports.py:54-58` — angle-bracket escaping only:
```python
def _render_section_markdown(md: str) -> str:
    # LLM-authored markdown must never emit raw HTML into the standalone report:
    # escape angle brackets so attempted markup renders as literal text. Charts
    # and tables are added by trusted code after this, never via section markdown.
    return _render_markdown(_clean_markdown(md).replace("<", "&lt;").replace(">", "&gt;"))
```
A `[x](javascript:alert(1))` link contains no angle brackets and survives
into the rendered `<a href>`.

`reports.py:110` — floating CDN fallback:
```python
    echarts = ECHARTS_MIN or '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>'
```

`server/src/routes.ts:257-266` — the only place the policy exists today:
```ts
    return reply
      .header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; "
          + "style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; "
          + "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
      )
      .header("X-Content-Type-Options", "nosniff")
```

`web/src/lib/api.ts:75-79` — why the header doesn't matter for the main path:
```ts
  const html = await apiText(path);
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
```

Conventions: reports are fully self-contained (inline CSS, inline echarts,
data: PNGs) — any new markup must keep them self-contained.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Python tests | `cd python && uv run pytest` | all pass |
| Server typecheck | `cd server && npm run typecheck` | exit 0 |
| Header probe (live) | `curl -sI localhost:3000/api/reports/<id>/html -H "Authorization: Bearer <token>" | grep -i content-security` | policy line present |

## Scope

**In scope**:
- `python/app/reports.py` (scheme filter, meta CSP constant + injection, CDN fallback removal)
- `server/src/routes.ts` (header string alignment ONLY)
- `python/tests/test_reports.py` (tests)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- `web/src/lib/api.ts` `openProtected` (works as-is once the policy is embedded).
- PDF-only layout (plan 016's static mode) beyond the shared template head.
- Auth/token storage (localStorage tradeoff is recorded as accepted).
- The chart initializer script itself.

## Git workflow

- Branch: `advisor/018-report-csp-hardening`
- Commits per step, conventional style.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Neutralize non-allowlisted link schemes

Add after `_render_section_markdown`:

```python
_ALLOWED_HREF = re.compile(r"^(https?:|mailto:|#|$)", re.IGNORECASE)

def _neutralize_links(rendered: str) -> str:
    def _sub(m: re.Match) -> str:
        return m.group(0) if _ALLOWED_HREF.match(m.group(2)) else m.group(1) + '#' + m.group(3)
    return re.sub(r'(<a\b[^>]*\bhref=")([^"]*)(")', _sub, rendered)
```

Apply it INSIDE `_render_section_markdown`, to the output of
`_render_markdown(...)` (sections only — tables/charts are trusted code).
Relative/bare hrefs pass; `javascript:`, `data:`, `vbscript:` etc. become `#`
with the link text preserved.

**Verify**: pytest (tests below); `grep -c "_neutralize_links" python/app/reports.py` → 2 (definition + call).

### Step 2: Remove the CDN fallback

Replace `reports.py:110` with a hard requirement on the vendored bundle:

```python
    if not ECHARTS_MIN:
        raise RuntimeError(
            "python/app/assets/echarts.min.js is missing; reports require the vendored echarts bundle"
        )
    echarts = ECHARTS_MIN
```

(The asset is committed; a missing asset is a broken checkout, not a runtime
condition. This also lets Step 3 drop the CDN from the allowlist.)

### Step 3: Embed the policy in the document

Define once near the top of reports.py:

```python
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
       "img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; "
       "base-uri 'none'; form-action 'none'")
```

Inject `<meta http-equiv="Content-Security-Policy" content="{CSP}">` into the
template's `<head>` (right after the charset meta), for BOTH static and
interactive modes (harmless for WeasyPrint, load-bearing for browsers).

Update `server/src/routes.ts` header to the IDENTICAL string (drop
`https://cdn.jsdelivr.net` and `'self'`/`blob:` from img-src — the document
no longer references either; keep `data:`). Add a comment in both files
pointing at the other: "// keep in sync with python/app/reports.py CSP".

**Verify**: `cd server && npm run typecheck` → 0; string-compare gate below.

### Step 4: Tests

Add to `python/tests/test_reports.py`:
- Section `[bad](javascript:alert(1))` renders an anchor whose href is `#`;
  `[good](https://example.com)` keeps its href; `[mail](mailto:a@b.c)` kept;
  relative `docs/x` kept.
- Built HTML contains exactly one `http-equiv="Content-Security-Policy"` meta
  and zero occurrences of `jsdelivr`.

Verification: `cd python && uv run pytest` → all pass incl. ≥5 new assertions.

Manual E2E (required before done): serve a freshly built report via the API,
use "View HTML" from the chat UI, confirm charts still render interactively
(meta CSP did not break inline echarts), and confirm
`curl -sI .../api/reports/<id>/html` shows the updated header.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c "jsdelivr" python/app/reports.py server/src/routes.ts` → 0 total
- [ ] pytest: javascript-link neutralized; https/mailto/relative preserved
- [ ] Meta CSP present in both static and interactive build outputs (pytest)
- [ ] Routes header string equals reports.py CSP constant (compare via the two grep commands below returning identical text):
      `grep -o "default-src[^']*" python/app/reports.py | head -1` vs the literal in routes.ts
- [ ] `cd python && uv run pytest` and `cd server && npm run typecheck` exit 0
- [ ] Manual E2E: charts render in the blob-opened tab (record what you saw)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 016 has not landed (both edit `build_html`; merge blind = clobbered work).
- Interactive charts FAIL to render under the embedded meta CSP in the manual
  E2E — report the console error; do not weaken the policy unilaterally.
- Any legitimate report content requires more than `img-src data:` (e.g.
  future remote images) — describe the actual need.
- The vendored echarts asset is missing from the working tree.

## Maintenance notes

- The policy now exists in TWO places by necessity (header for direct
  navigation, meta for the artifact). Reviewers must diff both when changing
  either — the sync comments are load-bearing.
- If report content ever needs external resources (fonts, images), widen BOTH
  copies deliberately and re-run the E2E.
- The localStorage-token exposure that made blob-opened reports sensitive is
  recorded as accepted in plans/README.md; revisit together with auth storage,
  not piecemeal.
