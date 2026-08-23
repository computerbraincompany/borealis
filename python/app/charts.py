"""Chart rendering.

A single canonical chart spec is produced by the agent, and is consumed by:
  - the web UI / HTML report via ECharts (interactive), and
  - the PDF report via matplotlib (static PNG).

Canonical spec:
{
  "type": "line" | "bar" | "area" | "pie" | "donut" | "scatter",
  "title": str,
  "subtitle": str,
  "categories": [str],              # x-axis labels (line/bar/area/scatter)
  "series": [{ "name": str, "data": [number] }],   # finite values, abs <= 1e15
  "items": [{ "name": str, "value": number }],     # pie/donut; values 0..1e15
  "x_label": str,
  "y_label": str,
}
"""

from __future__ import annotations

import base64
import io
import math
import re
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

BRAND = {
    "indigo": "#6366F1",
    "teal": "#14B8A6",
    "amber": "#F59E0B",
    "rose": "#F43F5E",
    "sky": "#0EA5E9",
    "violet": "#8B5CF6",
    "slate": "#64748B",
    "emerald": "#10B981",
}
PALETTE = [BRAND[k] for k in ("indigo", "teal", "amber", "rose", "sky", "violet", "emerald", "slate")]

plt.rcParams.update(
    {
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica Neue", "Arial", "Helvetica"],
        "axes.edgecolor": "#E2E8F0",
        "axes.labelcolor": "#475569",
        "axes.titlecolor": "#0F172A",
        "xtick.color": "#64748B",
        "ytick.color": "#64748B",
        "text.color": "#1E293B",
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.grid": True,
        "grid.color": "#EEF2F7",
        "grid.linewidth": 0.9,
    }
)

SUPPORTED = {"line", "bar", "area", "pie", "donut", "scatter"}
MAX_CATEGORIES = 500
MAX_SERIES = 20
MAX_PIE_ITEMS = 100
MAX_LABEL_LENGTH = 500
# Matplotlib's automatic axis locators can overflow even for individually
# finite IEEE-754 values. Keep the canonical format within a range rendered
# consistently by both ECharts and matplotlib.
MAX_ABSOLUTE_VALUE = 1e15
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class ChartSpecError(ValueError):
    pass


def _text(value: Any, field: str, *, allow_empty: bool = True) -> str:
    if not isinstance(value, str):
        raise ChartSpecError(f"{field} must be a string")
    if len(value) > MAX_LABEL_LENGTH:
        raise ChartSpecError(f"{field} is too long")
    if not allow_empty and not value.strip():
        raise ChartSpecError(f"{field} must not be empty")
    return value


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise ChartSpecError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ChartSpecError(f"{field} must be a finite number") from exc
    if not math.isfinite(number) or abs(number) > MAX_ABSOLUTE_VALUE:
        raise ChartSpecError(f"{field} must be a finite number with magnitude at most {MAX_ABSOLUTE_VALUE:g}")
    return number


def _safe_color(value: Any, fallback: str) -> str:
    return value if isinstance(value, str) and HEX_COLOR_RE.fullmatch(value) else fallback


def normalize(spec: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(spec, dict):
        raise ChartSpecError("chart spec must be an object")
    ctype = spec.get("type")
    if ctype not in SUPPORTED:
        raise ChartSpecError(f"unsupported chart type {ctype!r}; use one of {sorted(SUPPORTED)}")
    title = _text(spec.get("title", ""), "title")
    subtitle = _text(spec.get("subtitle", ""), "subtitle")
    x_label = _text(spec.get("x_label", ""), "x_label")
    y_label = _text(spec.get("y_label", ""), "y_label")
    categories_raw = spec.get("categories", [])
    series_raw = spec.get("series", [])
    items_raw = spec.get("items", [])
    if not isinstance(categories_raw, list):
        raise ChartSpecError("categories must be an array")
    if not isinstance(series_raw, list):
        raise ChartSpecError("series must be an array")
    if not isinstance(items_raw, list):
        raise ChartSpecError("items must be an array")
    if len(categories_raw) > MAX_CATEGORIES:
        raise ChartSpecError(f"charts support at most {MAX_CATEGORIES} categories")
    if len(series_raw) > MAX_SERIES:
        raise ChartSpecError(f"charts support at most {MAX_SERIES} series")
    if len(items_raw) > MAX_PIE_ITEMS:
        raise ChartSpecError(f"charts support at most {MAX_PIE_ITEMS} pie items")

    categories = [_text(value, f"categories[{index}]") for index, value in enumerate(categories_raw)]
    series: list[dict[str, Any]] = []
    for index, candidate in enumerate(series_raw):
        if not isinstance(candidate, dict):
            raise ChartSpecError(f"series[{index}] must be an object")
        name = _text(candidate.get("name", ""), f"series[{index}].name", allow_empty=False)
        data = candidate.get("data")
        if not isinstance(data, list):
            raise ChartSpecError(f"series[{index}].data must be an array")
        if len(data) != len(categories):
            raise ChartSpecError(f"series[{index}].data must match categories length")
        series.append(
            {
                "name": name,
                "data": [_finite_number(value, f"series[{index}].data[{j}]") for j, value in enumerate(data)],
                "color": _safe_color(candidate.get("color"), PALETTE[index % len(PALETTE)]),
            }
        )

    items: list[dict[str, Any]] = []
    for index, candidate in enumerate(items_raw):
        if not isinstance(candidate, dict):
            raise ChartSpecError(f"items[{index}] must be an object")
        value = _finite_number(candidate.get("value"), f"items[{index}].value")
        if value < 0:
            raise ChartSpecError(f"items[{index}].value must not be negative")
        items.append(
            {
                "name": _text(candidate.get("name", ""), f"items[{index}].name", allow_empty=False),
                "value": value,
                "color": _safe_color(candidate.get("color"), PALETTE[index % len(PALETTE)]),
            }
        )

    if ctype in ("pie", "donut"):
        try:
            pie_total = math.fsum(item["value"] for item in items)
        except OverflowError:
            pie_total = math.inf
        if not items or not math.isfinite(pie_total) or pie_total <= 0:
            raise ChartSpecError("pie and donut charts require at least one positive item")
    elif not categories or not series:
        raise ChartSpecError(f"{ctype} charts require categories and series")

    return {
        "type": ctype,
        "title": title,
        "subtitle": subtitle,
        "categories": categories,
        "series": series,
        "items": items,
        "x_label": x_label,
        "y_label": y_label,
    }


def _num(value: Any) -> float | None:
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------
# ECharts option generation (interactive web / html reports)
# --------------------------------------------------------------------------
def echarts_option(spec: dict[str, Any]) -> dict[str, Any]:
    spec = normalize(spec)
    ctype = spec["type"]
    title = {
        "text": spec["title"],
        "subtext": spec["subtitle"] or None,
        "left": "center",
        "textStyle": {"color": "#0F172A", "fontSize": 15, "fontWeight": 600},
        "subtextStyle": {"color": "#64748B", "fontSize": 11},
    }

    if ctype in ("pie", "donut"):
        series_data = [
            {"name": it["name"], "value": it["value"], "itemStyle": {"color": it.get("color")}} for it in spec["items"]
        ]
        option = {
            "title": title,
            "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
            "legend": {"bottom": 0, "textStyle": {"color": "#64748B"}},
            "series": [
                {
                    "name": spec["y_label"] or spec["title"] or "values",
                    "type": "pie",
                    "radius": ["45%", "72%"] if ctype == "donut" else "72%",
                    "center": ["50%", "50%"],
                    "label": {"show": True, "formatter": "{b}\n{d}%", "color": "#334155"},
                    "data": series_data,
                }
            ],
        }
        return option

    cats = [str(c) for c in spec["categories"]]
    series = []
    colors = []
    for i, s in enumerate(spec["series"]):
        values = s["data"]
        series.append(
            {
                "name": s["name"],
                "type": "bar" if ctype == "bar" else "line",
                **({"areaStyle": {"opacity": 0.15}} if ctype == "area" else {}),
                "data": values,
                "smooth": ctype in ("line", "area"),
            }
        )
        colors.append(s.get("color", PALETTE[i % len(PALETTE)]))
    option = {
        "title": title,
        "tooltip": {"trigger": "axis", "valueFormatter": "(x) => x"},
        "legend": {"top": 0, "textStyle": {"color": "#64748B"}},
        "grid": {"left": 60, "right": 24, "top": 56, "bottom": 56, "containLabel": True},
        "xAxis": {
            "type": "category",
            "data": cats,
            "axisLine": {"lineStyle": {"color": "#CBD5E1"}},
            "axisLabel": {"color": "#64748B"},
            "name": spec["x_label"] or None,
        },
        "yAxis": {
            "type": "value",
            "splitLine": {"lineStyle": {"color": "#EEF2F7"}},
            "axisLabel": {"color": "#64748B"},
            "name": spec["y_label"] or None,
        },
        "series": series,
        "color": colors,
    }
    if ctype == "scatter":
        option["series"] = [{**s, "type": "scatter", "symbolSize": 9, "symbol": "circle"} for s in series]
    return option


# --------------------------------------------------------------------------
# matplotlib rendering (static PNG for PDF / downloads)
# --------------------------------------------------------------------------
def render_png(spec: dict[str, Any], width: int = 9.5, height: int = 5.2) -> bytes:
    """Render the canonical spec to a PNG byte string (no axes for pie)."""
    spec = normalize(spec)
    ctype = spec["type"]
    fig, ax = plt.subplots(figsize=(width, height), dpi=140)
    try:
        fig.subplots_adjust(
            top=0.86 if (spec["title"] or spec["subtitle"]) else 0.9, bottom=0.16, left=0.09, right=0.97
        )
        if spec["title"] or spec["subtitle"]:
            fig.suptitle(spec["title"] or "", fontsize=15, fontweight=600, color="#0F172A", y=0.96)
            if spec["subtitle"]:
                fig.text(0.5, 0.93, spec["subtitle"], ha="center", va="bottom", fontsize=10.5, color="#64748B")

        cats = [str(c) for c in spec["categories"]]
        if ctype in ("pie", "donut"):
            ax.axis("off")
            values = [it["value"] for it in spec["items"]]
            labels = [it["name"] for it in spec["items"]]
            colors = [it.get("color") or PALETTE[i % len(PALETTE)] for i, it in enumerate(spec["items"])]
            _, _, autotexts = ax.pie(
                values,
                labels=None,
                colors=colors,
                autopct="%.1f%%",
                startangle=90,
                counterclock=False,
                wedgeprops={"width": 0.28 if ctype == "donut" else 1.0, "edgecolor": "white"},
            )
            for at in autotexts:
                at.set_color("white")
                at.set_fontsize(9.5)
                at.set_fontweight(600)
            ax.legend(
                labels,
                loc="lower center",
                bbox_to_anchor=(0.5, -0.18),
                ncol=min(4, max(len(labels), 1)),
                frameon=False,
                fontsize=9,
            )
            fig.canvas.draw()
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            return buf.getvalue()

        # Numeric series use explicit x positions so bars can be grouped and
        # scatter points remain points instead of being connected by lines.
        x_positions = list(range(len(cats)))
        bar_width = 0.8 / len(spec["series"]) if ctype == "bar" else 0.8
        for i, s in enumerate(spec["series"]):
            data = s["data"]
            color = s.get("color") or PALETTE[i % len(PALETTE)]
            label = s["name"] or f"Series {i + 1}"
            if ctype == "bar":
                offsets = [x + (i - (len(spec["series"]) - 1) / 2) * bar_width for x in x_positions]
                ax.bar(
                    offsets,
                    data,
                    width=bar_width,
                    color=color,
                    alpha=0.92,
                    label=label,
                    edgecolor="white",
                    linewidth=0.6,
                )
            elif ctype == "scatter":
                ax.scatter(x_positions, data, color=color, s=34, label=label, alpha=0.95)
            else:
                ax.plot(
                    x_positions,
                    data,
                    color=color,
                    marker="o" if len(data) <= 14 else "None",
                    linewidth=2.2,
                    label=label,
                    markersize=4,
                    alpha=0.95,
                )
                if ctype == "area":
                    ax.fill_between(x_positions, data, color=color, alpha=0.12)
        tick_step = max(1, math.ceil(len(cats) / 12))
        tick_positions = x_positions[::tick_step]
        tick_labels = cats[::tick_step]
        if tick_positions[-1] != x_positions[-1]:
            tick_positions.append(x_positions[-1])
            tick_labels.append(cats[-1])
        ax.set_xticks(tick_positions, tick_labels)
        ax.margins(x=0.02)
        if spec["x_label"]:
            ax.set_xlabel(spec["x_label"], fontsize=10, labelpad=6)
        if spec["y_label"]:
            ax.set_ylabel(spec["y_label"], fontsize=10, labelpad=6)
        leg = ax.legend(frameon=False, fontsize=9)
        if leg:
            leg.get_frame().set_facecolor("white")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        return buf.getvalue()
    finally:
        plt.close(fig)


def render_png_base64(spec: dict[str, Any]) -> str:
    return base64.b64encode(render_png(spec)).decode("ascii")


def _slugify(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9]+", "-", text.lower()).strip("-")
