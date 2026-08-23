"""Characterization tests for the canonical chart spec (charts.py).

The spec is the contract between the LLM, the Node tools, ECharts and
matplotlib — these tests pin structure so future capability changes are
visible (AGENTS.md: "a single spec drives ECharts ... and matplotlib").
"""

from __future__ import annotations

import base64

import pytest

from app import charts

VALID_SPEC = {
    "type": "bar",
    "title": "Monthly spending",
    "subtitle": "CAD",
    "categories": ["Jan", "Feb"],
    "series": [{"name": "Groceries", "data": [320, 410]}],
    "items": [{"name": "Food", "value": 100}],
    "x_label": "Month",
    "y_label": "Amount",
}


def test_normalize_fills_defaults():
    out = charts.normalize({"type": "line", "title": "t"})
    assert out["subtitle"] == ""
    assert out["categories"] == []
    assert out["series"] == []
    assert out["items"] == []
    assert out["x_label"] == ""
    assert out["y_label"] == ""


def test_normalize_assigns_palette_colors():
    out = charts.normalize(
        {
            "type": "bar",
            "series": [{"name": "A", "data": [1]}, {"name": "B", "data": [2]}],
            "items": [{"name": "X", "value": 1}],
        }
    )
    assert out["series"][0]["color"] == charts.PALETTE[0]
    assert out["series"][1]["color"] == charts.PALETTE[1]
    assert out["items"][0]["color"] == charts.PALETTE[0]


def test_normalize_rejects_unsupported_type():
    with pytest.raises(charts.ChartSpecError):
        charts.normalize({"type": "bogus"})


def test_normalize_rejects_non_dict():
    with pytest.raises(charts.ChartSpecError):
        charts.normalize("not a dict")


@pytest.mark.parametrize("ctype", ["line", "bar", "area", "scatter"])
def test_echarts_option_xy(ctype: str):
    spec = charts.normalize({**VALID_SPEC, "type": ctype})
    opt = charts.echarts_option(spec)
    assert opt["xAxis"]["type"] == "category"
    assert opt["yAxis"]["type"] == "value"
    assert [s["type"] for s in opt["series"]] == [
        "scatter" if ctype == "scatter" else ("bar" if ctype == "bar" else "line")
    ]
    if ctype == "scatter":
        assert opt["series"][0]["symbolSize"] == 9
    if ctype == "area":
        assert opt["series"][0]["areaStyle"]["opacity"] == 0.15


@pytest.mark.parametrize("ctype", ["pie", "donut"])
def test_echarts_option_pie(ctype: str):
    spec = charts.normalize({**VALID_SPEC, "type": ctype})
    opt = charts.echarts_option(spec)
    assert opt["series"][0]["type"] == "pie"
    assert [d["name"] for d in opt["series"][0]["data"]] == ["Food"]
    if ctype == "donut":
        assert opt["series"][0]["radius"] == ["45%", "72%"]
    else:
        assert opt["series"][0]["radius"] == "72%"


def test_render_png_base64_returns_valid_png():
    b64 = charts.render_png_base64({**VALID_SPEC, "type": "pie"})
    raw = base64.b64decode(b64)
    assert raw[:4] == b"\x89PNG"


def test_bad_pie_value_is_coerced_and_render_closes_figure():
    spec = {"type": "pie", "items": [{"name": "x", "value": "abc"}]}

    raw = charts.render_png(spec)

    assert raw[:4] == b"\x89PNG"
    assert charts.plt.get_fignums() == []


def test_echarts_bad_pie_value_becomes_zero():
    option = charts.echarts_option({"type": "pie", "items": [{"name": "x", "value": "abc"}]})

    assert option["series"][0]["data"][0]["value"] == 0.0
