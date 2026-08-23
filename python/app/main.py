"""Borealis report service — analysis, charts, and report generation.

Exposed to the Node backend over HTTP. Dataset access is namespaced by
account_id so users can only reach their own tables.
"""

from __future__ import annotations

import base64
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

from . import charts, datasets, reports

REPO_ROOT = Path(__file__).resolve().parents[2]
STORAGE_DIR = Path(
    os.environ.get("BOREALIS_STORAGE_DIR")
    or os.environ.get("NORTH_STORAGE_DIR")
    or REPO_ROOT / "uploads"
)
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

_CACHE_SUFFIXES = (".csv", ".tsv", ".json", ".jsonl", ".xlsx", ".parquet")
_EXT_BY_CT = {"application/json": ".json", "text/csv": ".csv"}

app = FastAPI(title="Borealis Report Service", version="0.1.0")


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
    allowed_tables: list[str]


class DescribeRequest(BaseModel):
    account_id: str
    table: str
    allowed_tables: list[str]


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
        # The Node service may provide its already fetched cache path while
        # rebuilding RAG chunks or restoring the registry after a restart.
        # Keep URL provenance without downloading the same connector twice.
        local_path = Path(req.location) if req.location else _fetch_url(req.url, req.account_id, req.name)
        original = req.original_name or Path(req.url).name or f"{req.name}.csv"
        return datasets.register(req.account_id, req.name, str(local_path), "url", original, req.url)
    if not req.location:
        raise HTTPException(400, "location required for path datasets")
    return datasets.register(req.account_id, req.name, req.location, "path", req.original_name or Path(req.location).name, None)


@app.post("/datasets/resync")
def resync(req: DatasetRegister) -> dict[str, Any]:
    fetcher = lambda url: str(_fetch_url(url, req.account_id, req.name, force=True))
    try:
        return datasets.resync(req.account_id, req.name, fetcher=fetcher, url=req.url)
    except HTTPException as exc:
        if exc.status_code != 404 or not req.url:
            raise
        local_path = _fetch_url(req.url, req.account_id, req.name, force=True)
        original = req.original_name or Path(req.url).name or f"{req.name}.csv"
        return datasets.register(req.account_id, req.name, str(local_path), "url", original, req.url)


@app.get("/datasets")
def all_datasets(account_id: str) -> list[dict[str, Any]]:
    return datasets.list_datasets(account_id)


@app.delete("/datasets/{name}")
def delete_dataset(account_id: str, name: str) -> dict[str, str]:
    datasets.drop(account_id, name)
    return {"status": "deleted"}


@app.post("/query")
def run_query(req: QueryRequest) -> dict[str, Any]:
    return datasets.query(req.account_id, req.sql, req.allowed_tables)


@app.post("/describe")
def run_describe(req: DescribeRequest) -> dict[str, Any]:
    return datasets.describe(req.account_id, req.table, req.allowed_tables)


# --------------------------------------------------------------------------
# chart endpoints
# --------------------------------------------------------------------------
@app.post("/chart")
def render_chart(req: ChartRequest) -> dict[str, Any]:
    try:
        spec = charts.normalize(req.spec)
    except charts.ChartSpecError as e:
        raise HTTPException(400, str(e)) from e
    png = charts.render_png_base64(spec)
    option = charts.echarts_option(spec)
    return {"png_base64": png, "echarts": option, "spec": spec}


# --------------------------------------------------------------------------
# report endpoints
# --------------------------------------------------------------------------
def _report_dict(req: ReportRequest) -> dict[str, Any]:
    return {
        "title": req.title,
        "subtitle": req.subtitle or "",
        "generated_at": req.generated_at or time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "sections": req.sections,
        "charts": req.charts,
        "tables": req.tables,
    }


@app.post("/reports/build")
def build_report(req: ReportRequest) -> dict[str, Any]:
    try:
        html = reports.build_html(_report_dict(req))
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(422, f"report build failed: {traceback.format_exc(limit=3)}")
    return {"title": req.title, "html": html}


@app.post("/reports/pdf")
def report_pdf(req: ReportRequest) -> Response:
    try:
        pdf = reports.build_pdf(_report_dict(req))
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


def _cache_ext(url: str, content_type: str) -> str:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in _CACHE_SUFFIXES:
        return suffix
    return _EXT_BY_CT.get(content_type.split(";")[0].strip().lower(), ".csv")


def _fetch_url(url: str, account_id: str, name: str, force: bool = False) -> Path:
    stem = STORAGE_DIR / f"url_{account_id}_{name}"
    preferred_suffix = _cache_ext(url, "")
    candidate_suffixes = dict.fromkeys((preferred_suffix, ".csv", *_CACHE_SUFFIXES))
    if not force:
        for suffix in candidate_suffixes:
            candidate = Path(f"{stem}{suffix}")
            if candidate.exists():
                return candidate

    with httpx.Client(timeout=60, follow_redirects=True) as client:
        r = client.get(url)
        r.raise_for_status()
        content_type = r.headers.get("content-type", "")
        if "text/html" in content_type.lower() and "<" in (r.text[:200] or ""):
            raise HTTPException(422, "URL returned HTML, not tabular data")

    target = Path(f"{stem}{_cache_ext(url, content_type)}")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=target.parent,
            prefix=f".{target.name}.",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
            temp_file.write(r.content)
        temp_path.replace(target)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)

    for suffix in _CACHE_SUFFIXES:
        sibling = Path(f"{stem}{suffix}")
        if sibling != target:
            sibling.unlink(missing_ok=True)
    return target
