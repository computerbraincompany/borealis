"""Characterization + security tests for the report builder (reports.py).

Pins table rendering, markdown rendering, and the escaping contract: section
markdown is LLM-authored and must never emit raw HTML into the standalone
report (plan 009).
"""

from __future__ import annotations

import pytest

from app import reports
from app.main import ReportRequest, _report_dict


CHART_SPEC = {
    "type": "line",
    "title": "Revenue <forecast>",
    "categories": ["Jan", "Feb"],
    "series": [{"name": "Revenue", "data": [1, 2]}],
}


def _report_with_chart() -> dict:
    return {
        "title": "Report",
        "subtitle": "",
        "generated_at": "2026-08-23 00:00:00 UTC",
        "sections": [{"heading": "Summary", "markdown": "Body"}],
        "charts": [{"id": "chart-1", "spec": CHART_SPEC}],
        "tables": [],
    }


# ---------------------------------------------------------------------------
# Section markdown escaping (security)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "payload",
    [
        "<script>alert(1)</script>",
        '<a href="jav&#x61;script:alert(1)">x</a>',
        "<img src=x onerror=alert(1)>",
        "<style>@import url(evil)</style>",
        "<svg onload=alert(1)>",
        '<a href="javascript:x">y</a>',
        "<iframe src=https://evil></iframe>",
    ],
)
def test_section_markdown_escapes_raw_html(payload: str):
    out = reports._render_section_markdown(payload)
    # the whole payload is rendered as literal text — no raw tag markup may survive
    assert "&lt;" in out
    assert "<script" not in out
    assert "<iframe" not in out
    assert "<img" not in out
    assert "<style" not in out
    assert "<svg" not in out
    assert "<a" not in out
    assert " <b" not in out


def test_section_markdown_still_renders_markdown():
    out = reports._render_section_markdown("**bold**\n\n# head")
    assert "<strong>bold</strong>" in out
    assert "<h1>head</h1>" in out


def test_section_markdown_neutralizes_disallowed_link_schemes():
    out = reports._render_section_markdown(
        "[bad](javascript:alert(1)) [good](https://example.com) "
        "[mail](mailto:a@b.c) [relative](docs/x)"
    )

    assert '<a href="#">bad</a>' in out
    assert '<a href="https://example.com">good</a>' in out
    assert '<a href="mailto:a@b.c">mail</a>' in out
    assert '<a href="docs/x">relative</a>' in out


@pytest.mark.parametrize(
    "href",
    [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,x",
        "vbscript:msgbox(1)",
        "java&#x09;script:alert(1)",
    ],
)
def test_section_markdown_neutralizes_obfuscated_link_schemes(href: str):
    out = reports._render_section_markdown(f"[bad]({href})")

    assert '<a href="#">bad</a>' in out


def test_section_markdown_renders_table():
    out = reports._render_section_markdown("| a | b |\n|---|---|\n| 1 | 2 |")
    assert "<table>" in out


def test_section_markdown_renders_fenced_code():
    out = reports._render_section_markdown("```\nconst x = a < b;\n```")
    assert "<pre><code>" in out
    assert "a < b" not in out  # bracket escaped (may show as &amp;lt; inside code)


def test_build_html_blocks_payload_in_sections():
    html = reports.build_html(
        {
            "title": "R",
            "subtitle": "",
            "generated_at": "2026-08-22 00:00:00 UTC",
            "sections": [{"heading": "H", "markdown": '<img src=x onerror=alert(1)>'}],
            "charts": [],
            "tables": [],
        }
    )
    # the payload survives only as escaped literal text
    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "<img src=x" not in html


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


def test_table_skips_malformed():
    out = reports._render_tables([{"columns": ["a"], "rows": [["x", "y"]]}])
    assert out == ""


def test_table_renders_escaped_header_and_footer():
    out = reports._render_tables([{"columns": ["a<b", "c"], "rows": [["1", "2"], ["3", "4"]]}])
    assert "<th>a&lt;b</th>" in out
    assert "<th>c</th>" in out
    # 1 thead row + 2 body rows + 1 footer row
    assert out.count("<tr>") == 4
    assert "2 rows" in out


def test_table_value_none_renders_empty():
    out = reports._render_tables([{"columns": ["a"], "rows": [[None]]}])
    assert "<td></td>" in out


def test_table_caps_at_60_rows():
    rows = [[str(i)] for i in range(61)]
    out = reports._render_tables([{"columns": ["a"], "rows": rows}])
    # 1 thead row + 60 body rows + 1 footer row
    assert out.count("<tr>") == 62
    assert "61 rows" in out


def test_markdown_bold_and_table():
    out = reports._render_markdown("**bold** text")
    assert "<strong>bold</strong>" in out
    out_t = reports._render_markdown("| a | b |\n|---|---|\n| 1 | 2 |")
    assert "<table>" in out_t


def test_build_html_smoke():
    html = reports.build_html(
        {
            "title": "My <Report>",
            "subtitle": "",
            "generated_at": "2026-08-22 00:00:00 UTC",
            "sections": [{"heading": "H", "markdown": "body"}],
            "charts": [],
            "tables": [],
        }
    )
    assert "My &lt;Report&gt;" in html
    assert "echarts" in html
    assert "<table>" not in html  # no data tables in this report


def test_build_html_static_embeds_imgs():
    out = reports.build_html(_report_with_chart(), static=True)

    assert '<img src="data:image/png;base64,' in out
    assert 'alt="Revenue &lt;forecast&gt;"' in out
    assert "data-option" not in out
    assert "<script>" not in out


@pytest.mark.skipif(reports.ECHARTS_MIN is None, reason="vendored ECharts asset is missing")
def test_build_html_interactive_has_options_no_png():
    out = reports.build_html(_report_with_chart())

    assert "data-option=" in out
    assert "data-png=" not in out


def test_report_dict_shared():
    req = ReportRequest(
        account_id="account-1",
        title="Report",
        sections=[{"heading": "Summary", "markdown": "Body"}],
    )

    result = _report_dict(req)

    assert result["sections"] is req.sections
    assert result["charts"] is req.charts
    assert result["tables"] is req.tables


@pytest.mark.parametrize("static", [False, True])
def test_build_html_embeds_csp_without_remote_script_fallback(static: bool):
    out = reports.build_html(_report_with_chart(), static=static)

    assert out.count('http-equiv="Content-Security-Policy"') == 1
    assert reports.CSP in out
    assert "jsdelivr" not in out
