"""North report service — analysis, charts, and report generation.

Exposed to the Node backend over HTTP. Dataset access is namespaced by
account_id so users can only reach their own tables.
"""

from __future__ import annotations

import base64
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from . import charts, datasets, reports

REPO_ROOT = Path(__file__).resolve().parents[2]
STORAGE_DIR = Path(os.environ.get("NORTH_STORAGE_DIR", REPO_ROOT / "uploads"))
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="North Report Service", version="0.1.0")


# --------------------------------------------------------------------------
# schemas
# --------------------------------------------------------------------------
class DatasetRegister(BaseModel):
    account_id: str
    name: str
    location: str | None = None
    kind: str = "path"  # path | url
    url: str | None = None
    original_name: str | None = None


class QueryRequest(BaseModel):
    account_id: str
    sql: str


class DescribeRequest(BaseModel):
    account_id: str
    table: str


class ChartRequest(BaseModel):
    account_id: str
    spec: dict[str, Any]


class ReportRequest(BaseModel):
    account_id: str
    title: str
    subtitle: str | None = ""
    generated_at: str | None = None
    sections: list[dict[str, str]] = Field(default_factory=list)
    charts: list[dict[str, Any]] = Field(default_factory=list)  # [{id, spec}]
    tables: list[dict[str, Any]] = Field(default_factory=list)


# --------------------------------------------------------------------------
# dataset endpoints
# --------------------------------------------------------------------------
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/datasets/register")
def register(req: DatasetRegister) -> dict[str, Any]:
    if req.kind == "url":
        if not req.url:
            raise HTTPException(400, "url required for url datasets")
        local_path = _fetch_url(req.url, req.account_id, req.name)
        original = req.original_name or Path(req.url).name or f"{req.name}.csv"
        return datasets.register(req.account_id, req.name, str(local_path), "url", original, req.url)
    if not req.location:
        raise HTTPException(400, "location required for path datasets")
    return datasets.register(req.account_id, req.name, req.location, "path", req.original_name or Path(req.location).name, None)


@app.post("/datasets/resync")
def resync(req: DatasetRegister) -> dict[str, Any]:
    return datasets.resync(req.account_id, req.name, fetcher=lambda url: str(_fetch_url(url, req.account_id, req.name)))


@app.get("/datasets")
def all_datasets(account_id: str) -> list[dict[str, Any]]:
    return datasets.list_datasets(account_id)


@app.delete("/datasets/{name}")
def delete_dataset(account_id: str, name: str) -> dict[str, str]:
    datasets.drop(account_id, name)
    return {"status": "deleted"}


@app.post("/query")
def run_query(req: QueryRequest) -> dict[str, Any]:
    return datasets.query(req.account_id, req.sql)


@app.post("/describe")
def run_describe(req: DescribeRequest) -> dict[str, Any]:
    return datasets.describe(req.account_id, req.table)


@app.post("/manifest/restore")
def restore_manifest(account_id: str, names: dict[str, Any]) -> dict[str, str]:
    dataset = names
    datasets.restore_from_manifest(account_id, dataset.get("datasets", []))
    return {"status": "restored", "count": len(datasets.list_datasets(account_id))}


# --------------------------------------------------------------------------
# chart endpoints
# --------------------------------------------------------------------------
@app.post("/chart")
def render_chart(req: ChartRequest) -> dict[str, Any]:
    spec = charts.normalize(req.spec)
    png = charts.render_png_base64(spec)
    option = charts.echarts_option(spec)
    return {"png_base64": png, "echarts": option, "spec": spec}


# --------------------------------------------------------------------------
# report endpoints
# --------------------------------------------------------------------------
@app.post("/reports/build")
def build_report(req: ReportRequest) -> dict[str, Any]:
    report = {
        "title": req.title,
        "subtitle": req.subtitle or "",
        "generated_at": req.generated_at or time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sections": req.sections,
        "charts": req.charts,
        "tables": req.tables,
    }
    try:
        html = reports.build_html(report)
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, f"report build failed: {traceback.format_exc(limit=3)}")
    return {"title": req.title, "html": html}


@app.post("/reports/pdf")
def report_pdf(req: ReportRequest) -> Response:
    report = {
        "title": req.title,
        "subtitle": req.subtitle or "",
        "generated_at": req.generated_at or time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sections": req.sections,
        "charts": req.charts,
        "tables": req.tables,
    }
    try:
        pdf = reports.build_pdf(report)
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, f"pdf build failed: {traceback.format_exc(limit=3)}")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="report.pdf"'},
    )


@app.post("/html-to-pdf")
def html_to_pdf(html: str) -> Response:
    try:
        pdf = reports.build_pdf_from_html(html)
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, f"pdf build failed: {traceback.format_exc(limit=3)}")
    return Response(content=pdf, media_type="application/pdf")


def _fetch_url(url: str, account_id: str, name: str) -> Path:
    path = STORAGE_DIR / f"url_{account_id}_{name}.csv"
    # allow csv/xlsx/json/parquet from plain URLs
    if path.exists():
        return path
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        r = client.get(url)
        r.raise_for_status()
        if "text/html" in r.headers.get("content-type", "") and "<" in (r.text[:200] or ""):
            raise HTTPException(422, "URL returned HTML, not tabular data")
        path.write_bytes(r.content)
    return path
