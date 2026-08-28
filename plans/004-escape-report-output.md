# Plan 004: HTML-escape interpolated content in generated reports

> **Completed historical plan.** The [ledger](README.md) records this plan as
> DONE. The original instructions, code excerpts, paths, and checklists below
> describe its implementation-era tree; do not execute them against the current
> checkout. For supported behavior and commands, use the [project README](../README.md),
> [API reference](../docs/API.md), and [desktop guide](../desktop/README.md).

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 86400ce..HEAD -- python/app/reports.py`
> If this file changed since the plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (escaping only; no rendering behavior change for benign content)
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `86400ce`, 2026-08-22

## Why this matters

The report HTML builder interpolates untrusted strings straight into its markup
with f-string substitution and no escaping. The untrusted data paths are real:
(1) table **cell values and column names** come from uploaded/connected
datasets — including `url_csv`/`url_json` connectors whose remote CSV/JSON an
attacker controls, so a cell like `<img src=x onerror=alert(1)>` reaches the
report verbatim; (2) report **title/subtitle/headings** are written by the
LLM, which is prompt-influenced by the same data. The generated report is
served as `text/html` (`GET /api/reports/:id/html`) and opened by users in a
browser tab (the Reports "View HTML" button uses a Blob URL that executes
scripts); the chat UI and the sandboxed preview iframe mask the issue, but a
downloaded/served report runs the injected script. The PDF path (WeasyPrint)
does not execute JS but will still embed the raw markup.

## Current state

`python/app/reports.py`:

- `_render_tables` (lines 57–72) interpolates raw column names and cells:

  ```python
  head = "".join(f"<th>{c}</th>" for c in cols)
  ...
  body += "<tr>" + "".join(f"<td>{v if v is not None else ''}</td>" for v in row) + "</tr>"
  ```

- `_render_section_markdown` (lines 49–55) → `markdown.markdown(md, extensions=["tables", "fenced_code", "nl2br"])`.
  python-markdown does **not** escape raw HTML in the input by default; raw
  `<script>`/`<img onerror>` in a section body passes through to the HTML.

- `build_html` (lines 93–163) interpolates `title` into `<title>` (line 113)
  and `<h1>` (line 158), `subtitle` (line 159), and each `heading` into
  `<h2>` (lines 100, 102) without escaping:

  ```python
  title = report.get("title") or "North Report"
  ...
  if h:
      sections_html += f'<div class="section"><h2>{h}</h2>{_render_section_markdown(md)}</div>'
  ...
  return f"""...
  <title>{title}</title>
  ...
  <h1>{title}</h1>
  ...
  ````

## Commands you will need

| Purpose   | Command (from repo root)                                    | Expected on success |
|-----------|-------------------------------------------------------------|---------------------|
| Escaping proof | `cd python && .venv/bin/python - <<'PY' ... PY` (Step 2) | prints `REPORT SAFE OK` |
| Import check | `cd python && .venv/bin/python -c "import app.reports"` | exit 0, no output  |

## Scope

**In scope** (the only files you should modify):
- `python/app/reports.py` — add `import html` support and escaping

**Out of scope** (do NOT touch, even though they look related):
- `python/app/charts.py` — the chart spec `data-option` attribute already
  escapes `"` and is consumed as JSON by ECharts, not raw HTML; leave it.
- `python/app/main.py` — no report-level HTML is built there.
- Server/web code — the chat UI is safe (react-markdown escapes HTML); don't
  change it.
- No new dependencies (do not add `bleach` or `nh3` — keep it stdlib).

## Git workflow

- Branch: `advisor/004-escape-report-output`
- Commit message style (conventional): `fix(python): escape untrusted content in report HTML`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Escape title, subtitle, headings, and table cells

In `python/app/reports.py`:

1. Add `import html` at the top (alphabetical, near the other stdlib imports:
   it currently imports `base64`, `io`, `json`, `re`, `Path` — insert `html`
   after `base64`... stdlib convention here is alphabetical: `base64, io,
   json, re, pathlib, typing`).

2. In `build_html`, compute `escaped_title = html.escape(title)` and
   `escaped_subtitle = html.escape(subtitle)` once, and use them for the
   `<title>`, `<h1>`, and `.sub` interpolations. Use `html.escape(h)` when
   emitting each `<h2>` heading.

3. In `_render_tables`, escape both column names and cell values:

   ```python
   head = "".join(f"<th>{html.escape(c)}</th>" for c in cols)
   ...
   body += "<tr>" + "".join(
       f"<td>{html.escape(str(v)) if v is not None else ''}</td>" for v in row
   ) + "</tr>"
   ```

4. Add a post-render scrub for the markdown-passed sections. Simplest
   stdlib-only approach that preserves markdown rendering: keep
   `_render_section_markdown` as-is, then sanitize the *output* of each
   section with a small blocklist scrubber before placing it in the HTML.
   The generated HTML from this repo's own markdown/tables doesn't use the
   elements we block, so it's safe to neutralize them:

   ```python
   def _sanitize_html(fragment: str) -> str:
       """Neutralize script/iframe/object/embed and event-handler attributes
       in the rendered report fragment (stdlib-only scrub).
       """
       import re as _re
       fragment = _re.sub(r"(?is)<script\b[^>]*>.*?</script\s*>", "&lt;script&gt;", fragment)
       for tag in ("iframe", "object", "embed", "link", "meta", "base", "form"):
           fragment = _re.sub(rf"(?is)<{tag}\b[^>]*>.*?</{tag}\s*>", f"&lt;{tag}&gt;", fragment)
           fragment = _re.sub(rf"(?i)<{tag}\b[^>]*/?>", "", fragment)
       fragment = _re.sub(r'(?i)\bon\w+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)', "", fragment)
       fragment = _re.sub(r"(?i)\bjavascript\s*:", "", fragment)
       return fragment
   ```

   Easiest wiring that does not disturb the table/chart blocks: in
   `build_html`, wrap the section body — i.e. change the two places that
   append `_render_section_markdown(md)` inside
   `<div class="section">...</div>` to instead call
   `_sanitize_html(_render_section_markdown(md))`.

Keep the chart-block and data-table builders untouched: cells are escaped (step
3) and chart options are JSON-attribute-escaped already.

**Verify**: `cd python && .venv/bin/python -c "import app.reports"` exit 0.

### Step 2: Prove a malicious payload cannot inject

Run this from the repo root and expect it to print `REPORT SAFE OK`:

```bash
cd python && .venv/bin/python - <<'PY'
from app.reports import build_html

payload = {
    "title": "<script>window.__pwned=1</script>T",
    "subtitle": "x",
    "generated_at": "2026-08-22",
    "sections": [
        {"heading": "<img src=x onerror=window.__pwned=1>", "markdown": "hello **world**"},
        {"heading": "L2", "markdown": "<iframe src=https://evil>hi</iframe> and <img src=x onerror=alert(1)>"},
    ],
    "charts": [],
    "tables": [
        {"columns": ["<b>col</b>"], "rows": [["<script>alert(1)</script>"], ["plain"]]},
    ],
}
out = build_html(payload)
# Structurally verify the generated document. NOTE: the inlined ECharts
# library (echarts.min.js) legitimately contains "<img", "onerror" and
# "<script" strings inside its own minified source, so assertions must parse
# the document, not grep substrings.
from html.parser import HTMLParser

class Inspector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.scripts = 0
        self.on_attrs = 0
    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        if tag == "script":
            self.scripts += 1
        for k, _ in attrs:
            if k.lower().startswith("on"):
                self.on_attrs += 1

insp = Inspector()
insp.feed(out)
bad = [t for t in insp.tags if t.lower() in ("img", "iframe", "object", "embed", "svg")]
assert insp.scripts == 2, f"expected exactly the 2 template script blocks, got {insp.scripts}"
assert not bad, f"unexpected tags in output: {bad}"
assert insp.on_attrs == 0, f"on* attributes survived: {insp.on_attrs}"
assert "&lt;script" in out.lower(), "script payload not escaped"
print("REPORT SAFE OK")
PY
```

If any assert fires, the sanitizer/escape is incomplete — fix and re-run.

**Verify**: the snippet prints `REPORT SAFE OK` and exits 0.

### Step 3: Confirm benign reports still render

Re-derive a normal self-contained report (no malicious input) and confirm the
escaped output still contains expected markup (tables render as `<table>`,
markdown bold as `<strong>`). Quick check:

```bash
cd python && .venv/bin/python - <<'PY'
from app.reports import build_html
out = build_html({"title": "A & B", "subtitle": "", "generated_at": "g",
  "sections": [{"heading": "H", "markdown": "**bold** and [link](https://x)"}],
  "charts": [], "tables": [{"columns": ["x"], "rows": [["1"]]}]})
assert "<table>" in out and "<strong>bold</strong>" in out
assert "&amp;" in out.lower()  # 'A & B' title escaped
print("BENIGN OK")
PY
```

**Verify**: prints `BENIGN OK`.

## Test plan

- New behavioral assertions live as a runnable snippet in Step 2/3 above.
  Since there is no test framework in `python/` yet, keep those snippets in the
  PR description and (when a pytest baseline lands) port them into
  `python/tests/test_reports.py`. Do not add pytest as a dependency in this
  plan.

## Done criteria

ALL must hold:

- [ ] Step 2 snippet prints `REPORT SAFE OK` and exits 0
- [ ] Step 3 snippet prints `BENIGN OK` and exits 0
- [ ] `cd python && .venv/bin/python -c "import app.reports"` exit 0
- [ ] `.venv/bin/python -m pytest` is NOT invoked (no test framework added)
- [ ] Only `python/app/reports.py` is modified (`git status --porcelain`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at "Current state" doesn't match the live file (drift).
- The Step 2 probe reveals additional injection surfaces beyond the planned
  ones (e.g. the ECharts `data-option` JSON attribute) — report, don't extend
  scope silently.
- Escaping breaks the existing E2E PDF flow (HTML/PDF report from a real
  chat). The escaping must not change output for benign content.

## Maintenance notes

- Any future code path that interpolates report content into HTML must use
  `html.escape`. The sanitizer is a backstop for the markdown path; prefer
  escaping at the source.
- If WeasyPrint/HTML reports ever support raw HTML blocks deliberately
  (embedded video etc.), revisit — today nothing needs it.
- A reviewer should diff the rendered HTML of a normal report
  (`reports_storage/`) before/after this change to confirm only escaping
  changed.
