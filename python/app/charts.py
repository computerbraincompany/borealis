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
  "series": [{ "name": str, "data": [number] }],   # multiple numeric series
  "items": [{ "name": str, "value": number }],     # pie/donut
  "x_label": str,
  "y_label": str,
}
"""

from __future__ import annotations

import base64
import io
import re
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

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


class ChartSpecError(ValueError):
    pass


def normalize(spec: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(spec, dict):
        raise ChartSpecError("chart spec must be an object")
    ctype = spec.get("type")
    if ctype not in SUPPORTED:
        raise ChartSpecError(f"unsupported chart type {ctype!r}; use one of {sorted(SUPPORTED)}")
    out = {**spec, "type": ctype}
    out.setdefault("title", "")
    out.setdefault("subtitle", "")
    out.setdefault("categories", [])
    out.setdefault("series", [])
    out.setdefault("items", [])
    out.setdefault("x_label", "")
    out.setdefault("y_label", "")
    # sanitize colors via palette index
    for i, s in enumerate(out["series"]):
        s = dict(s)
        if "color" not in s:
            s["color"] = PALETTE[i % len(PALETTE)]
        out["series"][i] = s
    for i, it in enumerate(out["items"]):
        it = dict(it)
        if "color" not in it:
            it["color"] = PALETTE[i % len(PALETTE)]
        out["items"][i] = it
    return out


def _num(value: Any) -> float | None:
    try:
        return float(value)
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
        series_data = [{"name": it["name"], "value": _num(it["value"]) or 0.0, "itemStyle": {"color": it.get("color")}} for it in spec["items"]]
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
        values = [_num(v) for v in s["data"]]
        series.append({"name": s["name"], "type": "bar" if ctype == "bar" else "line", **(
            {"areaStyle": {"opacity": 0.15}} if ctype == "area" else {}
        ), "data": values, "smooth": ctype in ("line", "area")})
        colors.append(s.get("color", PALETTE[i % len(PALETTE)]))
    option = {
        "title": title,
        "tooltip": {"trigger": "axis", "valueFormatter": "(x) => x"}, 
        "legend": {"top": 0, "textStyle": {"color": "#64748B"}},
        "grid": {"left": 60, "right": 24, "top": 56, "bottom": 56, "containLabel": True},
        "xAxis": {"type": "category", "data": cats, "axisLine": {"lineStyle": {"color": "#CBD5E1"}}, "axisLabel": {"color": "#64748B"}, "name": spec["x_label"] or None},
        "yAxis": {"type": "value", "splitLine": {"lineStyle": {"color": "#EEF2F7"}}, "axisLabel": {"color": "#64748B"}, "name": spec["y_label"] or None},
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
        fig.subplots_adjust(top=0.86 if (spec["title"] or spec["subtitle"]) else 0.9, bottom=0.16, left=0.09, right=0.97)
        if spec["title"] or spec["subtitle"]:
            fig.suptitle(spec["title"] or "", fontsize=15, fontweight=600, color="#0F172A", y=0.96)
            if spec["subtitle"]:
                fig.text(0.5, 0.93, spec["subtitle"], ha="center", va="bottom", fontsize=10.5, color="#64748B")

        cats = [str(c) for c in spec["categories"]]
        if ctype in ("pie", "donut"):
            ax.axis("off")
            values = [_num(it["value"]) or 0.0 for it in spec["items"]]
            labels = [it["name"] for it in spec["items"]]
            colors = [it.get("color") or PALETTE[i % len(PALETTE)] for i, it in enumerate(spec["items"])]
            if any(value != 0.0 for value in values):
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
                ax.legend(labels, loc="lower center", bbox_to_anchor=(0.5, -0.18), ncol=min(4, max(len(labels), 1)), frameon=False, fontsize=9)
            else:
                ax.text(0.5, 0.5, "No numeric data", ha="center", va="center", color="#64748B", fontsize=11)
            fig.canvas.draw()
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            return buf.getvalue()

        # numeric series
        for i, s in enumerate(spec["series"]):
            data = [_num(v) or 0.0 for v in s["data"]]
            color = s.get("color") or PALETTE[i % len(PALETTE)]
            label = s["name"] or f"Series {i + 1}"
            if ctype == "bar":
                ax.bar(cats, data, color=color, alpha=0.92, label=label, edgecolor="white", linewidth=0.6)
            else:
                ax.plot(cats, data, color=color, marker="o" if len(data) <= 14 else "None", linewidth=2.2,
                        label=label, markersize=4, alpha=0.95)
                if ctype == "area":
                    ax.fill_between(range(len(data)), data, color=color, alpha=0.12)
        ax.margins(x=0.02)
        ax.xaxis.set_major_locator(MaxNLocator(12))
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
