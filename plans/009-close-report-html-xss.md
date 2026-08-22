# Plan 009: Close the report HTML XSS bypass — escape raw HTML in markdown + add CSP on report routes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d16a44c..HEAD -- python/app/reports.py server/src/routes.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (do not run concurrently with plan 008 — both touch `python/app/reports.py`)
- **Category**: security
- **Planned at**: commit `d16a44c`, 2026-08-22

## Why this matters

The product's core deliverable is a standalone HTML report whose body is
LLM-authored markdown (`create_report` → `python/app/reports.py:build_html`).
Today that markdown is rendered to HTML and passed through `_sanitize_html`, a
regex **blocklist** (`reports.py:54-64`) that strips `<script>` blocks,
event-handler attributes, and the literal substring `javascript:`. Blocklists
leak: an entity-encoded scheme like `<a href="jav&#x61;script:alert(1)">` survives
(uniquote of `&#x61;` happens in the browser, after the regex sees `jav`), `<style>`
is not in the removed-tag list at all, and `data:`/`vbscript:` schemes are
untouched. The report is served from `/api/reports/:id/html`
(`server/src/routes.ts:247-253`) as `text/html` with no `Content-Security-Policy`
and no `X-Content-Type-Options: nosniff`, and the same HTML is also opened from
disk after the user downloads it — so a successfully injected payload runs with
the app's origin (it can read the JWT in `localStorage`) or wherever the file is
viewed. Because the report body is LLM-authored and the LLM can be steered by
content it retrieved (uploaded docs, fetched URLs), this is a real — currently
open — XSS path in the app's most-trusted artifact.

The fix removes the attack surface rather than playing whack-a-mole with regex:
LLM-authored section markdown NEVER needs to emit raw HTML (charts and tables are
rendered separately, after the markdown, by trusted code), so the correct behavior
is to escape `<` and `>` in the markdown so any attempted HTML renders as literal
text. A CSP on the HTML route adds depth for whatever else arrives in the file.

## Current state

Files and their roles:

- `python/app/reports.py` — report builder. Section markdown is the injection
  surface; the report template inlines all assets.
- `server/src/routes.ts` — `GET /api/reports/:id/html` serves the HTML.

Current exact code (excerpts):

`python/app/reports.py:54-64` (the regex blocklist, being replaced):
```python
def _sanitize_html(fragment: str) -> str:
    """Neutralize script/iframe/object/embed and event-handler attributes
    in the rendered report fragment (stdlib-only scrub)."""
    fragment = re.sub(r"(?is)<script\b[^>]*>.*?</script\s*>", "&lt;script&gt;", fragment)
    for tag in ("iframe", "object", "embed", "link", "meta", "base", "form", "img", "svg",
                "picture", "video", "audio", "source", "canvas", "template"):
        fragment = re.sub(rf"(?is)<{tag}\b[^>]*>.*?</{tag}\s*>", f"&lt;{tag}&gt;", fragment)
        fragment = re.sub(rf"(?i)<{tag}\b[^>]*/?>", "", fragment)
    fragment = re.sub(r'(?i)\bon\w+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)', "", fragment)
    fragment = re.sub(r"(?i)\bjavascript\s*:", "", fragment)
    return fragment
```

`python/app/reports.py:67-68` (the markdown entry point used per section):
```python
def _render_section_markdown(md: str) -> str:
    return _render_markdown(_clean_markdown(md))
```

`python/app/reports.py:109-116` (how sections are emitted — `_sanitize_html` is
applied to the rendered fragment):
```python
    for sec in report.get("sections", []):
        h = html.escape(sec.get("heading") or "")
        md = sec.get("markdown") or ""
        if h:
            sections_html += f'<div class="section"><h2>{h}</h2>{_sanitize_html(_render_section_markdown(md))}</div>'
        else:
            sections_html += f'<div class="section">{_sanitize_html(_render_section_markdown(md))}</div>'
```

`python/app/reports.py:41-42` (markdown renderer — raw HTML passes through by
default, which is why the blocklist existed):
```python
def _render_markdown(md: str) -> str:
    return markdown.markdown(md, extensions=["tables", "fenced_code", "nl2br"])
```

`server/src/routes.ts:247-253` (the serving route with no security headers):
```ts
  app.get("/api/reports/:id/html", { preHandler: requireAuth }, async (req, reply) => {
    const [row] = await q(`SELECT html_path FROM reports WHERE id=$1 AND account_id=$2`, [(req.params as any).id, getAccountId(req)]);
    if (!row) return reply.code(404).send({ error: "report not found" });
    if (!row.html_path || !(await fs.access(row.html_path).then(() => true).catch(() => false)))
      return reply.code(404).send({ error: "html not available" });
    return reply.type("text/html").send(await fs.readFile(row.html_path, "utf8"));
  });
```

Note on what stays: chart/table content is NOT authored as section markdown —
charts are rendered by `_render_chart_divs` (`reports.py:89-98`) and tables by
`_render_tables` (`reports.py:71-86`), both trusted code paths that already escape
their own inputs (`html.escape` on cells/headers, `json.dumps`+`&quot;` for
`data-option`). The only untrusted-HTML surface is section markdown.

## Commands you will need

| Purpose   | Command                                         | Expected on success |
|-----------|-------------------------------------------------|---------------------|
| Python tests | `cd python && uv run pytest python/tests/ -v` (if plan 008 landed) — or a one-off check below | all pass |
| One-off behavior check | `cd python && uv run python -c "from app import reports; print('<b>x</b>' in reports._render_section_markdown('**hi** <b>x</b> <a href=\"jav&#x61;script:alert(1)\">y</a>'))"` | prints `False` (no raw tag survived; escaped text remains) |
| Server typecheck | `cd server && npm run typecheck`                | exit 0, no errors |
| HTML route header check | start server + register a report, or a static grep gate (see Step 4) | header present |

## Scope

**In scope**:
- `python/app/reports.py`
- `server/src/routes.ts` (report HTML route only — add 2 response headers)
- `python/tests/test_reports.py` (if plan 008 landed — extend with the new
  escaping contract; otherwise create `python/tests/test_reports.py`)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch):
- `server/src/tools.ts` (the agent creates reports through a different path; no
  change needed there).
- The PDF path (`build_pdf` uses `build_html` internally — it inherits the fix
  automatically; do not touch WeasyPrint).
- `_render_tables` / `_render_chart_divs` / the HTML `<style>`/`<script>` template
  (they stay as-is).
- Plan 008's other test files (`test_charts.py`, `test_datasets.py`, server
  tests) — if 008 hasn't landed, leave them alone entirely.

## Git workflow

- Branch: `advisor/009-report-html-csp`
- One commit: `fix: escape raw HTML in report markdown, add CSP on report route`
  (imperative, matches repo history style)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Escape raw HTML in section markdown

Change `_render_section_markdown` in `python/app/reports.py` (lines 67-68) to
escape `<` and `>` BEFORE markdown rendering, so any attempted HTML is rendered
as literal text instead of markup:

```python
def _render_section_markdown(md: str) -> str:
    # LLM-authored markdown must never emit raw HTML into the standalone report:
    # escape angle brackets so attempted markup renders as literal text. Charts
    # and tables are added by trusted code after this, never via section markdown.
    return _render_markdown(_clean_markdown(md).replace("<", "&lt;").replace(">", "&gt;"))
```

Escape only `<` and `>` (NOT `&`) — escaping `&` too would double-escape
entities the model may already have written (e.g. `AT&amp;T` → `AT&amp;amp;T`).
Escaping just the angle brackets is sufficient to prevent tag construction.

Then remove the now-dead `_sanitize_html` function (lines 54-64) and its two call
sites in `build_html` (lines 114 and 116 — change
`_sanitize_html(_render_section_markdown(md))` to just
`_render_section_markdown(md)` in both branches).

Verify nothing else references `_sanitize_html`:
**Verify**: `cd python && grep -rn "_sanitize_html" app/` → no matches.

### Step 2: Sanity-check the markdown behavior

**Verify**:
```bash
cd python && uv run python -c "
from app import reports
out = reports._render_section_markdown('**bold** <b>tag</b> <a href=\"jav&#x61;script:x\">l</a>')
print(out)
"
```
Expected output: contains `<strong>bold</strong>` (real formatting preserved),
and the things that were HTML tags now appear as escaped literal text — the
output must NOT contain `<b>` or `<a ` as markup; look for `&lt;b&gt;tag&lt;/b&gt;`
and `&lt;a href=...`. In particular the string `<a` must not appear in `out`
(raw tag), only `&lt;a`.

Also verify fenced code + tables still render: run the same one-liner with
`'| a | b |\n|---|---|\n| 1 | 2 |'` and with '```\nconst x = a < b;\n```' —
assert a `<table>` exists and the code block shows `&lt;` inside `<code>`.

### Step 3: Add CSP + nosniff on the HTML route

In `server/src/routes.ts`, the `GET /api/reports/:id/html` handler (lines 247-253),
add the two response headers before `.send(...)`:

```ts
    return reply
      .header("Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; "
        + "style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; "
        + "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
      .header("X-Content-Type-Options", "nosniff")
      .type("text/html")
      .send(await fs.readFile(row.html_path, "utf8"));
```

Rationale for each part: the report is fully self-contained (inline `<style>`,
inline `<script>` echarts bundle, PNGs as `data:` URIs) so `script-src
'unsafe-inline'` + `style-src 'unsafe-inline'` + `img-src data:` keep it working;
`script-src` additionally allows `https://cdn.jsdelivr.net` so the documented
fallback in `build_html` (line 120) keeps working when `ECHARTS_MIN` is absent;
`connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `base-uri 'none'`,
`form-action 'none'` block the exfiltration/embedding primitives a payload would
use even if one ever slips through the markdown escaping.

**Verify**: `cd server && npm run typecheck` → exit 0.

### Step 4: Functional verification of the header

Boot a minimal check without a full DB: the header code is only exercised on a
real request, so do a static confirmation plus, if the dev stack is available,
a live check:

- Static: `grep -n "Content-Security-Policy" server/src/routes.ts` → returns the
  line.
- Live (only if Postgres + server are already running per `AGENTS.md`; otherwise
  skip this sub-step and rely on the static gate): register a report or use an
  existing one, then
  `curl -sI -H "Authorization: Bearer <token>" http://localhost:3000/api/reports/<id>/html | grep -iE "content-security-policy|x-content-type"` → both headers present.

### Step 5: Tests (only if plan 008 landed; otherwise create the file)

In `python/tests/test_reports.py` (create if missing — model it on plan 008's
`test_reports.py` structure, `from app import reports`):

- Adversarial cases asserting NO raw tag markup survives in
  `_render_section_markdown` output:
  - `"<script>alert(1)</script>"` → output contains no `<script`
  - `'<a href="jav&#x61;script:alert(1)">x</a>'` → contains `&lt;a`, no `<a `
  - `'<img src=x onerror=alert(1)>'` → no `<img`, no `onerror`
  - `"<style>@import url(evil)</style>"` → no `<style` markup
  - `"<svg onload=alert(1)>"` → no `<svg`
- Positive cases: `**bold**` → `<strong>`, pipe table → `<table`, fenced code with
  `a < b` → `&lt;` inside the code block, `# H` → `<h1`.
- `build_html` end-to-end: a report dict with a section containing
  `'<img src=x onerror=alert(1)>'` → the returned HTML string contains
  `&lt;img` and does NOT contain `<img ` or `onerror`.

**Verify**: `cd python && uv run pytest python/tests/ -v` → all pass (existing
009-era tests for the old escaping, if any were written against the blocklist by
plan 008, must be updated to the new contract — see dependency note).

## Test plan

- New/updated tests: the adversarial + positive markdown matrix in
  `python/tests/test_reports.py` (above), plus a `build_html` end-to-end XSS
  probe.
- Verification: `cd python && uv run pytest python/tests/ -v` → all pass.
- The CSP header itself is gate-checked by the `grep` in Done criteria (header
  behavior needs a live stack to curl).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -rn "_sanitize_html" python/app/` returns no matches
- [ ] `grep -n "test_reports" python/tests/test_reports.py` (if created) shows pytest functions; `cd python && uv run pytest python/tests/ -v` exits 0
- [ ] `cd server && npm run typecheck` exits 0
- [ ] `grep -n "Content-Security-Policy" server/src/routes.ts` returns the report-route header line
- [ ] The Step 2 one-liner output contains `&lt;b&gt;`/`&lt;a` and does not contain a raw `<a ` or `<b>` from the input HTML (i.e. escaping works, markdown still renders)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts
  (drifted — e.g. plan 008 changed `reports.py` in the meantime; reconcile by
  keeping the escaping change and updating 008's escaping assertions).
- The Step 2 one-liner shows that escaping `<`/`>` breaks a legitimately-rendered
  markdown feature you depend on (e.g. tables stop rendering) — report the exact
  output rather than switching to a sanitizer library or a different approach.
- `build_html`'s chart `data-option` re-render or the CDN fallback breaks under
  the new CSP (verify by reading `reports.py:118-120` that the only external
  script is `cdn.jsdelivr.net`, which is allow-listed).
- Tests from plan 008 fail in a way that suggests the escaping ignored a
  legitimate HTML feature the product relies on (e.g. model-authored `<br>`
  breaking formatting). Report it; the plan author will decide.

## Maintenance notes

- If `reports.py` ever needs to support raw HTML in sections again (e.g. a
  "paste-HTML section" feature), the safe approach is a real allowlist sanitizer
  (bleach/nh3), not a blocklist — re-open this plan's tradeoff before doing so.
- The ECharts asset lives at `python/app/assets/echarts.min.js`; if it is ever
  removed, the CDN fallback (`https://cdn.jsdelivr.net`) is the only network
  source allowed by the new CSP — keep the CSP's script-src allowlist in sync
  with that fallback.
- A future feature that serves report HTML in a `<iframe>` with `sandbox` grants
  (plan 008/audit flagged the ReportsView preview iframe uses an empty
  `sandbox=""`, which blanks charts) should coordinate with this CSP — both are
  layers protecting the same artifact.
