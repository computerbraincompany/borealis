"""Characterization tests for the canonical chart spec (charts.py).

The spec is the contract between the LLM, the Node tools, ECharts and
matplotlib — these tests pin structure so future capability changes are
visible (AGENTS.md: "a single spec drives ECharts ... and matplotlib").
"""

from __future__ import annotations

import base64
import math

import pytest
from matplotlib.axes import Axes

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
    out = charts.normalize({"type": "line", "title": "t", "categories": ["x"], "series": [{"name": "n", "data": [1]}]})
    assert out["subtitle"] == ""
    assert out["categories"] == ["x"]
    assert out["series"][0]["data"] == [1.0]
    assert out["items"] == []
    assert out["x_label"] == ""
    assert out["y_label"] == ""


def test_normalize_assigns_palette_colors():
    out = charts.normalize(
        {
            "type": "bar",
            "categories": ["x"],
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


@pytest.mark.parametrize("value", ["abc", math.inf, -math.inf, math.nan, None, True, -1])
def test_pie_rejects_invalid_values(value):
    with pytest.raises(charts.ChartSpecError):
        charts.normalize({"type": "pie", "items": [{"name": "x", "value": value}]})


@pytest.mark.parametrize(
    "spec",
    [
        {"type": "line", "categories": ["x"], "series": []},
        {"type": "line", "categories": [1], "series": [{"name": "A", "data": [1]}]},
        {"type": "bar", "categories": ["x", "y"], "series": [{"name": "A", "data": [1]}]},
        {"type": "scatter", "categories": ["x"], "series": [{"name": "A", "data": [math.nan]}]},
        {"type": "pie", "items": [{"name": "x", "value": 0}]},
        {"type": "pie", "items": [{"name": "x", "value": 1e308}, {"name": "y", "value": 1e308}]},
    ],
)
def test_normalize_rejects_empty_mismatched_or_nonfinite_shapes(spec):
    with pytest.raises(charts.ChartSpecError):
        charts.normalize(spec)


@pytest.mark.parametrize("ctype", ["line", "bar", "area", "scatter"])
@pytest.mark.parametrize("sign", [-1, 1])
def test_xy_magnitude_bound_renders_at_both_boundaries(ctype: str, sign: int):
    raw = charts.render_png(
        {
            "type": ctype,
            "categories": ["boundary"],
            "series": [
                {
                    "name": "boundary",
                    "data": [sign * charts.MAX_ABSOLUTE_VALUE],
                }
            ],
        }
    )

    assert raw[:4] == b"\x89PNG"


@pytest.mark.parametrize("ctype", ["line", "bar", "area", "scatter"])
@pytest.mark.parametrize("sign", [-1, 1])
def test_xy_magnitude_bound_rejects_values_beyond_both_boundaries(ctype: str, sign: int):
    with pytest.raises(charts.ChartSpecError, match="magnitude at most"):
        charts.normalize(
            {
                "type": ctype,
                "categories": ["extreme"],
                "series": [{"name": "outside", "data": [sign * charts.MAX_ABSOLUTE_VALUE * 2]}],
            }
        )


def test_static_scatter_uses_points_without_plot_lines(monkeypatch):
    scatter_calls = 0
    plot_calls = 0
    original_scatter = Axes.scatter
    original_plot = Axes.plot

    def tracked_scatter(self, *args, **kwargs):
        nonlocal scatter_calls
        scatter_calls += 1
        return original_scatter(self, *args, **kwargs)

    def tracked_plot(self, *args, **kwargs):
        nonlocal plot_calls
        plot_calls += 1
        return original_plot(self, *args, **kwargs)

    monkeypatch.setattr(Axes, "scatter", tracked_scatter)
    monkeypatch.setattr(Axes, "plot", tracked_plot)

    raw = charts.render_png({**VALID_SPEC, "type": "scatter"})

    assert raw[:4] == b"\x89PNG"
    assert scatter_calls == 1
    assert plot_calls == 0


def test_static_bar_groups_multiple_series(monkeypatch):
    positions: list[list[float]] = []
    original_bar = Axes.bar

    def tracked_bar(self, x, *args, **kwargs):
        positions.append(list(x))
        return original_bar(self, x, *args, **kwargs)

    monkeypatch.setattr(Axes, "bar", tracked_bar)
    raw = charts.render_png(
        {
            "type": "bar",
            "categories": ["Jan", "Feb"],
            "series": [{"name": "A", "data": [1, 2]}, {"name": "B", "data": [3, 4]}],
        }
    )

    assert raw[:4] == b"\x89PNG"
    assert len(positions) == 2
    assert positions[0] != positions[1]
