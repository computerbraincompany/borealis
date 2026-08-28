# Plan 016: Make PDF reports contain their charts (and render the report HTML once)

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
> `git diff --stat 567481d..HEAD -- python/app/reports.py python/app/main.py python/tests/test_reports.py`
> On any diff, compare "Current state" excerpts against live code; mismatch → STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED (PDF visual output changes — that is the point; interactive HTML must stay byte-equivalent apart from the data-png change)
- **Depends on**: none (run BEFORE plan 018, which edits `build_html` again)
- **Category**: bug / perf
- **Planned at**: commit `567481d`, 2026-08-23

## Why this matters

Every PDF report Borealis has ever produced contains EMPTY bordered boxes
instead of charts. The module docstring promises "a print-ready PDF built from
the same content (matplotlib chart PNGs)" — the PNGs are rendered, shipped as
a `data-png` attribute… and never used, because only an inline BROWSER script
turns them into images, and WeasyPrint (the PDF engine) does not execute
JavaScript. The flagship deliverable is broken at exactly the moment it
delivers. Fixing it also removes a double build: today `/reports/build` and
`/reports/pdf` each re-render all markdown and ALL chart PNGs for the same
report, roughly doubling create_report latency.

## Current state

Files and their roles:

- `python/app/reports.py` — builds the self-contained HTML (`build_html`) and
  the PDF (`build_pdf`); owns the chart-block markup.
- `python/app/main.py` — `/reports/build` + `/reports/pdf` endpoints; they
  duplicate the same request→dict conversion.
- `python/tests/test_reports.py` — existing escaping tests to keep green.

Current exact code:

`python/app/reports.py:79-88` — charts are empty divs; content comes only
from attributes consumed by JavaScript:
```python
def _render_chart_divs(chart_specs: list[tuple[str, dict[str, Any]]]) -> str:
    out = []
    for cid, spec in chart_specs:
        option = charts.echarts_option(spec)
        png_b64 = charts.render_png_base64(spec)
        out.append(
            f'<div class="chart-block" id="chart-{cid}" data-option="{json.dumps(option).replace(chr(34), "&quot;")}" '
            f'data-png="data:image/png;base64,{png_b64}" style="height:400px"></div>'
        )
    return "".join(out)
```

`python/app/reports.py:175-190` — the ONLY thing that populates the divs
(browser-only; WeasyPrint skips `<script>` entirely):
```html
<script>
document.querySelectorAll('.chart-block').forEach(function(el){
  if (window.echarts) { ...chart.setOption(opt)... }
  else { var img = document.createElement('img'); img.src = el.getAttribute('data-png'); ... }
});
</script>
```

`python/app/reports.py:195-200` — the PDF path renders the INTERACTIVE html:
```python
def build_pdf(report: dict[str, Any]) -> bytes:
    if WeasyHTML is None:
        raise RuntimeError(f"WeasyPrint unavailable: {_WEASY_ERR}")
    html = build_html(report)
    pdf = WeasyHTML(string=html).write_pdf()
    return pdf
```

`python/app/main.py:130-137` and `148-155` — identical dict built twice:
```python
    report = {
        "title": req.title,
        "subtitle": req.subtitle or "",
        "generated_at": req.generated_at or time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sections": req.sections,
        "charts": req.charts,
        "tables": req.tables,
    }
```
(once in `build_report`, once in `report_pdf`).

`reports.py:38` — the vendored echarts bundle flag:
```python
ECHARTS_MIN = (Path(__file__).parent / "assets" / "echarts.min.js").read_text() if (...) else None
```
When present, every interactive chart also carries a ~150-400KB base64 PNG in
`data-png` that is used only if `window.echarts` is missing — which cannot
happen while the script is inlined. Dead weight on every view/download.

Conventions: keep the f-string templating style of `build_html`; tests follow
`python/tests/test_reports.py`'s existing function-per-behavior style.
WeasyPrint import is wrapped in try/except at reports.py:27-33, so unit tests
must not assume it is importable.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Python tests | `cd python && uv run pytest` | all pass |
| Live service restart (for manual PDF check) | `cd python && env DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/uvicorn app.main:app --port 8000` | boots |

## Scope

**In scope**:
- `python/app/reports.py` (`_render_chart_divs`, `build_html`, `build_pdf`)
- `python/app/main.py` (dedupe the report dict)
- `python/tests/test_reports.py` (tests)
- `plans/README.md` (status row)

**Out of scope (do NOT touch)**:
- CSP/meta tags or link handling in section markdown — plan 018 owns those.
- `server/src/tools.ts` call sequence (`buildReport` then `pdf`) — unchanged;
  both endpoints stay, they just share `_report_dict`.
- Chart rendering itself (`python/app/charts.py`).
- The ReportsView preview iframe sandbox issue (known deferred item).

## Git workflow

- Branch: `advisor/016-pdf-report-charts`
- Commits per step, conventional style (e.g. `fix: embed static chart PNGs in PDF reports`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a static render mode to build_html

Change the signature to `build_html(report: dict[str, Any], static: bool = False)`.

In `_render_chart_divs(chart_specs, static=...)`:
- `static=True`: emit
  `<div class="chart-block" style="height:auto"><img src="data:image/png;base64,{png_b64}" style="width:100%" alt="{html.escape(title)}"/></div>`
  (no `data-option`, no id needed; use the chart title from the spec for alt).
- `static=False`: current markup, EXCEPT emit the `data-png` attribute only
  when `ECHARTS_MIN is None` (true fallback mode). With the vendored bundle
  present the attribute is dead weight.

In the template body:
- Skip BOTH script blocks when `static` (the `{echarts}` inline `<script>` at
  the end of `<head>` AND the initializer `<script>` before `</body>`).

**Verify**: `cd python && uv run pytest` → existing tests pass.

### Step 2: Build the PDF from the static variant

```python
def build_pdf(report: dict[str, Any]) -> bytes:
    if WeasyHTML is None:
        raise RuntimeError(f"WeasyPrint unavailable: {_WEASY_ERR}")
    pdf = WeasyHTML(string=build_html(report, static=True)).write_pdf()
    return pdf
```

**Verify**: pytest still green (PDF itself needs system libs; unit tests below
assert on the HTML string instead).

### Step 3: Dedupe the report dict in main.py

Extract one helper and use it in both endpoints:

```python
def _report_dict(req: ReportRequest) -> dict[str, Any]:
    return {
        "title": req.title,
        "subtitle": req.subtitle or "",
        "generated_at": req.generated_at or time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sections": req.sections,
        "charts": req.charts,
        "tables": req.tables,
    }
```

**Verify**: `grep -c '"generated_at"' python/app/main.py` → 2 (helper + nothing else? adjust: exactly ONE occurrence inside `_report_dict`; grep for `time.strftime` → 1 match).

### Step 4: Tests

Add to `python/tests/test_reports.py` (reuse its existing minimal report
fixture style):

1. `test_build_html_static_embeds_imgs`: `build_html(report, static=True)`
   contains `data:image/png;base64,` inside an `<img` tag, contains NO
   `data-option`, and contains no literal `<script>` tag.
2. `test_build_html_interactive_has_options_no_png`: with the vendored asset
   present (guard: `skipif reports.ECHARTS_MIN is None`), `build_html(report)`
   contains `data-option=` and does NOT contain `data-png=`.
3. `test_report_dict_shared`: POST-shaped assertion — call the FastAPI route
   functions directly (`from app.main import _report_dict`) with two
   `ReportRequest`s differing only in `generated_at=None` and assert identical
   timestamps are generated once per call (or simpler: assert
   `_report_dict(req)["sections"] is req.sections` — same object passed through).

Verification: `cd python && uv run pytest` → all pass, 3 new tests.

Optional live check (only if the service runs with WeasyPrint libs): restart
uvicorn, `curl -s -X POST localhost:8000/reports/pdf -H 'Content-Type: application/json' -d '{"account_id":"x","title":"t","sections":[{"markdown":"hi"}],"charts":[{"id":"c1","spec":{"type":"line","title":"T","categories":["a","b"],"series":[{"name":"s","data":[1,2]}]}}]}' -o /tmp/r.pdf`
→ file starts with `%PDF` and is >30KB (a real embedded PNG inflates it);
open it and confirm the chart is visible.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `build_html(report, static=True)` output has `<img src="data:image/png;base64,` and zero `<script>` occurrences (pytest)
- [ ] Interactive output has `data-option` and no `data-png` when ECHARTS_MIN present (pytest)
- [ ] `grep -n "build_html(report)" python/app/reports.py` → no matches (PDF path passes `static=True`)
- [ ] `grep -c "time.strftime" python/app/main.py` → 1
- [ ] `cd python && uv run pytest` exit 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Existing escaping tests fail after the refactor — do not weaken them; report.
- The interactive HTML changes in any way beyond the removed `data-png`
  attribute (diff against pre-change output for the fixture report).
- WeasyPrint IS available and the live PDF still shows empty boxes after Step 2.

## Maintenance notes

- `create_report` latency should drop noticeably (one markdown+PNG pass instead
  of two). If someone later adds per-chart caching (persisting `png_base64` at
  render_chart time), `_render_chart_divs` is the single choke point to use.
- The static mode's `height:auto` replaces the fixed 400px box; check one long
  report for layout sanity in review.
- Plan 018 will edit `build_html` again (CSP meta) — land this first.
