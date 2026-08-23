"""Characterization + security tests for the report builder (reports.py).

Pins table rendering, markdown rendering, and the escaping contract: section
markdown is LLM-authored and must never emit raw HTML into the standalone
report (plan 009).
"""

from __future__ import annotations

import json
from html.parser import HTMLParser

import pytest
from pydantic import ValidationError

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


def test_section_markdown_strips_markdown_images():
    out = reports._render_section_markdown(
        "before ![remote](https://example.invalid/image.png) ![inline](data:image/png;base64,iVBORw0KGgo=) after"
    )

    assert "<img" not in out
    assert "example.invalid" not in out
    assert "data:image" not in out


def test_section_markdown_neutralizes_disallowed_link_schemes():
    out = reports._render_section_markdown(
        "[bad](javascript:alert(1)) [good](https://example.com) [mail](mailto:a@b.c) [relative](docs/x)"
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
            "sections": [{"heading": "H", "markdown": "<img src=x onerror=alert(1)>"}],
            "charts": [],
            "tables": [],
        }
    )
    # the payload survives only as escaped literal text
    assert "&lt;img src=x onerror=alert(1)&gt;" in html
    assert "<img src=x" not in html


class _ChartDivParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.chart_attributes: dict[str, str | None] | None = None

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "div" and "chart-block" in (attributes.get("class") or ""):
            self.chart_attributes = attributes


def test_chart_option_and_metadata_are_html_attribute_escaped_and_round_trip():
    dangerous = 'Revenue "quoted" & <script>boom</script>'
    chart_id = 'id" autofocus onfocus="boom'
    spec = {
        "type": "bar",
        "title": dangerous,
        "categories": [dangerous],
        "series": [{"name": dangerous, "data": [1]}],
    }
    report = {
        "title": "Safe report",
        "subtitle": "",
        "generated_at": '<img src=x onerror="boom"> & now',
        "sections": [],
        "charts": [{"id": chart_id, "spec": spec}],
        "tables": [],
    }

    output = reports.build_html(report)
    parser = _ChartDivParser()
    parser.feed(output)

    assert parser.chart_attributes is not None
    assert set(parser.chart_attributes) == {"class", "id", "data-option", "style"}
    assert parser.chart_attributes["id"] == f"chart-{chart_id}"
    option = json.loads(parser.chart_attributes["data-option"] or "")
    assert option["title"]["text"] == dangerous
    assert option["xAxis"]["data"] == [dangerous]
    assert '<img src=x onerror="boom">' not in output
    assert "&lt;img src=x onerror=&quot;boom&quot;&gt; &amp; now" in output


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

    assert result["sections"] == [{"heading": "Summary", "markdown": "Body"}]
    assert result["charts"] == []
    assert result["tables"] == []


def _valid_report_request() -> dict:
    return {
        "account_id": "account-1",
        "title": "Report",
        "subtitle": "Subtitle",
        "sections": [{"heading": "Summary", "markdown": "Body"}],
        "charts": [{"id": "chart-1", "spec": CHART_SPEC}],
        "tables": [{"columns": ["name", "value"], "rows": [["rent", 1.5], ["active", True]]}],
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "x" * 201),
        ("subtitle", "x" * 501),
        ("sections", [{"markdown": "x"}] * 21),
        ("sections", [{"heading": "x" * 201, "markdown": "body"}]),
        ("sections", [{"markdown": "x" * 50_001}]),
        ("charts", [{"id": f"chart-{index}", "spec": CHART_SPEC} for index in range(21)]),
        ("tables", [{"columns": ["x"], "rows": [[1]]}] * 9),
        ("tables", [{"columns": ["x"] * 33, "rows": []}]),
        ("tables", [{"columns": ["x" * 201], "rows": []}]),
        ("tables", [{"columns": ["x"], "rows": [[1]] * 61}]),
        ("tables", [{"columns": ["x"], "rows": [["x" * 501]]}]),
        ("tables", [{"columns": ["x"], "rows": [[10**500]]}]),
        ("tables", [{"columns": ["x"], "rows": [[{"nested": "value"}]]}]),
        ("tables", [{"columns": ["x"], "rows": [[float("nan")]]}]),
        ("tables", [{"columns": ["x", "y"], "rows": [[1]]}]),
    ],
)
def test_report_request_rejects_every_nested_limit_and_unsafe_cell(field, value):
    payload = _valid_report_request()
    payload[field] = value

    with pytest.raises(ValidationError):
        ReportRequest.model_validate(payload)


def test_report_request_canonicalizes_chart_specs_and_drops_arbitrary_nested_extras():
    payload = _valid_report_request()
    payload["charts"][0]["spec"] = CHART_SPEC | {"ignored": {"deep": [{"secret": "x" * 10_000}]}}

    request = ReportRequest.model_validate(payload)

    assert "ignored" not in request.charts[0].spec
    assert request.charts[0].spec["type"] == "line"


def test_report_request_rejects_noncanonical_chart_spec():
    payload = _valid_report_request()
    payload["charts"][0]["spec"] = {"type": "line", "categories": ["x"], "series": [{"name": "n", "data": [[]]}]}

    with pytest.raises(ValidationError):
        ReportRequest.model_validate(payload)


@pytest.mark.parametrize("static", [False, True])
def test_build_html_embeds_csp_without_remote_script_fallback(static: bool):
    out = reports.build_html(_report_with_chart(), static=static)

    assert out.count('http-equiv="Content-Security-Policy"') == 1
    assert reports.CSP in out
    assert "jsdelivr" not in out


@pytest.mark.skipif(reports.WeasyHTML is None, reason="WeasyPrint is unavailable")
def test_build_pdf_is_a_real_pdf_smoke_test():
    pdf = reports.build_pdf(
        {
            "title": "PDF smoke",
            "subtitle": "",
            "generated_at": "2026-08-23 00:00:00 UTC",
            "sections": [{"heading": "Summary", "markdown": "A **rendered** report."}],
            "charts": [],
            "tables": [{"columns": ["value"], "rows": [["safe"]]}],
        }
    )

    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 1_000


@pytest.mark.skipif(reports.WeasyHTML is None, reason="WeasyPrint is unavailable")
def test_build_pdf_embeds_a_static_chart_without_external_resources(monkeypatch):
    fetched: list[str] = []
    original_fetcher = reports._INLINE_URL_FETCHER

    def tracked_fetch(url: str, *args, **kwargs):
        fetched.append(url)
        assert original_fetcher is not None
        return original_fetcher(url)

    monkeypatch.setattr(reports, "_INLINE_URL_FETCHER", tracked_fetch)
    pdf = reports.build_pdf(_report_with_chart())

    assert pdf.startswith(b"%PDF-")
    assert len(pdf) > 10_000
    assert len(fetched) == 1
    assert fetched[0].startswith("data:image/png;base64,")


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "https://example.invalid/private.png",
        "http://169.254.169.254/latest/meta-data/",
        "ftp://example.invalid/file",
        "data:text/plain;base64,SGVsbG8=",
    ],
)
def test_pdf_url_fetcher_denies_every_non_chart_resource(url: str, monkeypatch):
    called = False

    def unexpected_fetch(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("the default fetcher must not see untrusted resources")

    monkeypatch.setattr(reports, "_INLINE_URL_FETCHER", unexpected_fetch)

    with pytest.raises(ValueError, match="external report resources are disabled"):
        reports._safe_url_fetcher(url)
    assert called is False


@pytest.mark.skipif(reports.WeasyHTML is None, reason="WeasyPrint is unavailable")
def test_pdf_render_does_not_fetch_markdown_images(monkeypatch):
    fetched: list[str] = []
    original_fetcher = reports._INLINE_URL_FETCHER

    def tracked_fetch(url: str, *args, **kwargs):
        fetched.append(url)
        assert original_fetcher is not None
        return original_fetcher(url)

    monkeypatch.setattr(reports, "_INLINE_URL_FETCHER", tracked_fetch)
    report = {
        "title": "No egress",
        "subtitle": "",
        "generated_at": "2026-08-23 00:00:00 UTC",
        "sections": [
            {
                "heading": "Untrusted",
                "markdown": (
                    "![local](file:///etc/passwd) "
                    "![remote](http://169.254.169.254/latest/meta-data/) "
                    "![inline](data:image/png;base64,iVBORw0KGgo=)"
                ),
            }
        ],
        "charts": [],
        "tables": [],
    }

    pdf = reports.build_pdf(report)

    assert pdf.startswith(b"%PDF-")
    assert fetched == []
