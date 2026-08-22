"""Characterization tests for the report builder (reports.py).

Pins table rendering, markdown rendering, and the current escaping posture.
NOTE: raw-HTML-in-markdown behavior is deliberately NOT asserted on payloads
here — plan 009 replaces the blocklist scrub with input escaping and adds the
adversarial matrix.
"""

from __future__ import annotations

from app import reports


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
