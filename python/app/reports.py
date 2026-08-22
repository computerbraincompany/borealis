"""Report builder.

Turns a report specification (heading sections of markdown, embedded chart
specs and data tables) into two artifacts:

  1. a self-contained interactive HTML report (ECharts inlined), and
  2. a print-ready PDF built from the same content (matplotlib chart PNGs).

Both come from one canonical spec, so the PKG is guaranteed consistent.
"""

from __future__ import annotations

import base64
import io
import json
import re
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import markdown

try:
    from weasyprint import HTML as WeasyHTML
except Exception as e:  # pragma: no cover
    WeasyHTML = None
    _WEASY_ERR = e
else:
    _WEASY_ERR = None

from . import charts

# ECharts v5 minified, inlined into the HTML report for offline interactive charts.
ECHARTS_MIN = (Path(__file__).parent / "assets" / "echarts.min.js").read_text() if (Path(__file__).parent / "assets" / "echarts.min.js").exists() else None


def _render_markdown(md: str) -> str:
    return markdown.markdown(md, extensions=["tables", "fenced_code", "nl2br"])


def _render_tables(tables: list[dict[str, Any]]) -> str:
    out = []
    for t in tables:
        cols = t.get("columns", [])
        rows = t.get("rows", [])
        if not cols or not rows or len(cols) != len(rows[0]):
            continue
        head = "".join(f"<th>{c}</th>" for c in cols)
        body = ""
        for row in rows[:60]:
            body += "<tr>" + "".join(f"<td>{v if v is not None else ''}</td>" for v in row) + "</tr>"
        out.append(
            f'<div class="data-table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody>'
            f"<tfoot><tr><td colspan='{len(cols)}'>{len(tables[0]['rows'])} rows</td></tr></tfoot></table></div>"
        )
    return "".join(out)


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


def build_html(report: dict[str, Any]) -> str:
    """Build a fully self-contained interactive HTML document.

    report: { title, subtitle, generated_at, sections: [{heading, markdown}],
              charts: [{id, spec}], tables: [{columns, rows}] }
    """
    title = report.get("title") or "North Report"
    subtitle = report.get("subtitle") or ""
    sections_html = ""
    for sec in report.get("sections", []):
        h = sec.get("heading") or ""
        md = sec.get("markdown") or ""
        if h:
            sections_html += f'<div class="section"><h2>{h}</h2>{_render_markdown(md)}</div>'
        else:
            sections_html += f'<div class="section">{_render_markdown(md)}</div>'

    charts_html = _render_chart_divs([(c["id"], c["spec"]) for c in report.get("charts", [])])
    tables_html = _render_tables(report.get("tables", []))
    echarts = ECHARTS_MIN or '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>'

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
:root {{
  --bg:#F8FAFC; --card:#FFFFFF; --ink:#0F172A; --muted:#64748B; --line:#E2E8F0;
  --brand:#6366F1; --brand-soft:#EEF2FF; --teal:#14B8A6; --radius:14px;
}}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased; }}
.page {{ max-width:960px; margin:0 auto; padding:40px 24px 80px; }}
.masthead {{ background:linear-gradient(135deg,#312E81 0%,#6366F1 55%,#14B8A6 140%);
  border-radius:calc(var(--radius) + 6px); padding:36px 40px; color:#fff; margin-bottom:28px;
  box-shadow:0 18px 40px -18px rgba(49,46,129,.55); }}
.masthead h1 {{ margin:0; font-size:30px; letter-spacing:-.02em; }}
.masthead .sub {{ margin-top:8px; opacity:.85; font-size:15px; }}
.meta {{ margin-top:18px; display:flex; gap:12px; flex-wrap:wrap; }}
.pill {{ background:rgba(255,255,255,.16); border:1px solid rgba(255,255,255,.28);
  padding:4px 12px; border-radius:999px; font-size:12px; font-weight:600; }}
.section {{ background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
  padding:28px 32px; margin-bottom:20px; box-shadow:0 1px 2px rgba(15,23,42,.04); }}
.section h2 {{ margin:0 0 14px; font-size:20px; letter-spacing:-.01em; color:var(--ink);
  border-bottom:2px solid var(--brand-soft); padding-bottom:10px; }}
.section p {{ line-height:1.7; color:#334155; margin:10px 0; font-size:15px; }}
.section ul, .section ol {{ color:#334155; line-height:1.7; font-size:15px; }}
.section h3 {{ margin:18px 0 6px; font-size:16px; color:#1E293B; }}
.section strong {{ color:#0F172A; }}
.chart-block {{ margin:18px 0; border:1px solid var(--line); border-radius:12px; overflow:hidden;
  background:#fff; }}
.data-table {{ overflow-x:auto; margin:14px 0; }}
.data-table table {{ border-collapse:collapse; width:100%; font-size:13.5px; }}
.data-table th {{ background:var(--brand-soft); color:#312E81; text-align:left; padding:8px 10px;
  font-weight:600; border:1px solid var(--line); }}
.data-table td {{ padding:7px 10px; border:1px solid var(--line); color:#334155; }}
.data-table tfoot td {{ font-size:11px; color:var(--muted); background:#F8FAFC; }}
pre, code {{ background:#F1F5F9; border-radius:6px; }}
pre {{ padding:12px; overflow-x:auto; }}
code {{ padding:2px 5px; }}
blockquote {{ margin:10px 0; padding:2px 16px; border-left:3px solid var(--brand); color:#475569; }}
</style>
<script>{echarts}</script>
</head>
<body>
<div class="page">
  <div class="masthead">
    <h1>{title}</h1>
    {f'<div class="sub">{subtitle}</div>' if subtitle else ""}
    <div class="meta">
      <span class="pill">Generated by North</span>
      <span class="pill">{report.get("generated_at", "")}</span>
      {f'<span class="pill">{len(report.get("charts", []))} charts</span>' if report.get("charts") else ""}
      {f'<span class="pill">{len(report.get("tables", []))} tables</span>' if report.get("tables") else ""}
    </div>
  </div>
  {sections_html}
  {charts_html}
  {tables_html}
</div>
<script>
document.querySelectorAll('.chart-block').forEach(function(el){{
  if (window.echarts) {{
    var opt = JSON.parse(el.getAttribute('data-option'));
    var chart = echarts.init(el);
    chart.setOption(opt);
    window.addEventListener('resize', function(){{ chart.resize(); }});
  }} else {{
    var img = document.createElement('img');
    img.src = el.getAttribute('data-png');
    img.style.width = '100%';
    el.innerHTML = '';
    el.appendChild(img);
  }}
}});
</script>
</body>
</html>"""


def build_pdf(report: dict[str, Any]) -> bytes:
    if WeasyHTML is None:
        raise RuntimeError(f"WeasyPrint unavailable: {_WEASY_ERR}")
    html = build_html(report)
    pdf = WeasyHTML(string=html).write_pdf()
    return pdf


def build_pdf_from_html(html: str) -> bytes:
    if WeasyHTML is None:
        raise RuntimeError(f"WeasyPrint unavailable: {_WEASY_ERR}")
    return WeasyHTML(string=html).write_pdf()
