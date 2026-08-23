"""Borealis report service — analysis, charts, and report generation.

Exposed to the Node backend over HTTP. Dataset access is namespaced by
account_id so users can only reach their own tables.
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import logging
import math
import os
import queue
import re
import secrets
import socket
import ssl
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Self
from urllib.parse import urljoin, urlparse, urlunsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import charts, datasets, reports

REPO_ROOT = Path(__file__).resolve().parents[2]


def _configured_storage_dir(environment: Mapping[str, str] | None = None) -> Path:
    """Resolve the shared upload root using the canonical Node override too."""
    values = os.environ if environment is None else environment
    configured = values.get("BOREALIS_STORAGE_DIR") or values.get("UPLOAD_DIR") or values.get("NORTH_STORAGE_DIR")
    return Path(configured) if configured else REPO_ROOT / "uploads"


STORAGE_DIR = _configured_storage_dir()
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

_EXT_BY_CT = {"application/json": ".json", "text/csv": ".csv"}
MAX_CONNECTOR_DOWNLOAD_BYTES = 50 * 1024 * 1024
CONNECTOR_TIMEOUT_SECONDS = 60.0
MAX_CONNECTOR_REDIRECTS = 3
CONNECTOR_CHUNK_BYTES = 64 * 1024
# `IPv[46]Address.is_global` is not an SSRF policy by itself. In particular,
# Python 3.12 considers the standardized NAT64 prefixes global even when their
# embedded IPv4 destination is loopback or private. Reject every IPv4
# translation/tunnelling class that could make a validated IPv6 peer reach a
# different IPv4 trust boundary.
UNSAFE_IPV6_TRANSLATION_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in (
        "::/96",  # deprecated IPv4-compatible form
        "::ffff:0:0/96",  # IPv4-mapped form
        "64:ff9b::/96",  # well-known NAT64 prefix
        "64:ff9b:1::/48",  # local-use NAT64 prefix
        "2002::/16",  # 6to4 embeds an IPv4 destination
    )
)
# Bounded reports can contain ~8M table-cell characters plus canonical chart
# labels. 128 MiB leaves room for worst-case JSON escaping while still bounding
# memory before Starlette/Pydantic parse or materialize nested values.
MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
ACCOUNT_ID_RE = r"^[A-Za-z0-9][A-Za-z0-9_-]*$"
CACHE_VERSION_RE = re.compile(r"^[0-9a-f]{32}\.(?:csv|json)$")
LOGGER = logging.getLogger(__name__)

app = FastAPI(title="Borealis Report Service", version="0.1.0")


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "unknown")


def _error_response(status_code: int, message: str, request_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"detail": message, "request_id": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.middleware("http")
async def authenticate_and_trace(request: Request, call_next):
    supplied_request_id = request.headers.get("X-Request-ID", "")
    request_id = supplied_request_id if REQUEST_ID_RE.fullmatch(supplied_request_id) else uuid.uuid4().hex
    request.state.request_id = request_id
    started = time.monotonic()

    content_length = request.headers.get("Content-Length")
    if content_length is not None:
        try:
            declared_bytes = int(content_length)
        except ValueError:
            return _error_response(400, "invalid request", request_id)
        if declared_bytes < 0:
            return _error_response(400, "invalid request", request_id)
        if declared_bytes > MAX_REQUEST_BODY_BYTES:
            return _error_response(413, "request exceeds service limit", request_id)

    if request.url.path != "/health":
        expected = os.environ.get("BOREALIS_SERVICE_TOKEN", "")
        authorization = request.headers.get("Authorization", "")
        provided = authorization[7:] if authorization.startswith("Bearer ") else ""
        if len(expected) < 32:
            LOGGER.error("service_auth_unconfigured request_id=%s", request_id)
            return _error_response(503, "service authentication is unavailable", request_id)
        if not provided or not secrets.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
            LOGGER.warning("service_auth_rejected request_id=%s path=%s", request_id, request.url.path)
            return _error_response(401, "unauthorized", request_id)

    # Buffer at most the authenticated service ceiling before Starlette or
    # Pydantic can parse/materialize nested JSON. Replaying the original ASGI
    # messages preserves chunked requests without relying on Content-Length.
    received_bytes = 0
    buffered_messages: list[dict[str, Any]] = []
    while True:
        message = await request._receive()
        if message["type"] == "http.disconnect":
            return _error_response(400, "invalid request", request_id)
        if message["type"] != "http.request":
            continue
        received_bytes += len(message.get("body", b""))
        if received_bytes > MAX_REQUEST_BODY_BYTES:
            return _error_response(413, "request exceeds service limit", request_id)
        buffered_messages.append(message)
        if not message.get("more_body", False):
            break

    async def replay_receive():
        if buffered_messages:
            return buffered_messages.pop(0)
        return {"type": "http.request", "body": b"", "more_body": False}

    request._receive = replay_receive
    response = await call_next(request)
    if response.status_code == 404:
        response = _error_response(404, "resource not found", request_id)
    response.headers["X-Request-ID"] = request_id
    LOGGER.info(
        "request_complete request_id=%s method=%s path=%s status=%s duration_ms=%.1f",
        request_id,
        request.method,
        request.url.path,
        response.status_code,
        (time.monotonic() - started) * 1000,
    )
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, _exc: RequestValidationError) -> JSONResponse:
    request_id = _request_id(request)
    LOGGER.warning("request_validation_failed request_id=%s path=%s", request_id, request.url.path)
    return _error_response(422, "invalid request", request_id)


@app.exception_handler(HTTPException)
async def handled_error(request: Request, exc: HTTPException) -> Response:
    request_id = _request_id(request)
    LOGGER.warning(
        "request_rejected request_id=%s path=%s status=%s",
        request_id,
        request.url.path,
        exc.status_code,
    )
    if exc.status_code == 400 and isinstance(exc.detail, str):
        message = exc.detail
    else:
        message = {
            401: "unauthorized",
            404: "resource not found",
            409: "resource changed; retry the request",
            413: "request exceeds service limit",
            422: "request could not be processed",
            502: "upstream data source failed",
            503: "service unavailable",
            504: "upstream data source timed out",
        }.get(exc.status_code, "request failed")
    return _error_response(exc.status_code, message, request_id)


@app.exception_handler(Exception)
async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    request_id = _request_id(request)
    # Do not log exception strings: HTTP client errors can contain signed URLs,
    # and parser errors can contain private values or filesystem paths.
    LOGGER.error(
        "request_failed request_id=%s path=%s error_type=%s",
        request_id,
        request.url.path,
        type(exc).__name__,
    )
    return _error_response(500, "internal service error", request_id)


# --------------------------------------------------------------------------
# schemas
# --------------------------------------------------------------------------
class DatasetRegister(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    source_id: str | None = Field(default=None, min_length=1, max_length=36, strict=True)
    name: str = Field(min_length=1, max_length=63, pattern=r"^[a-z][a-z0-9_]*$")
    location: str | None = Field(default=None, max_length=4096)
    kind: Literal["path", "url"] = "path"
    url: str | None = Field(default=None, max_length=8192)
    original_name: str | None = Field(default=None, max_length=1024)
    expected_format: Literal["csv", "json"] | None = None


class DatasetCacheCleanup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    name: str = Field(min_length=1, max_length=63, pattern=r"^[a-z][a-z0-9_]*$")
    location: str = Field(min_length=1, max_length=4096, strict=True)


class DatasetCatalogRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    allowed_tables: list[str] = Field(max_length=100)


class DatasetRefreshVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    name: str = Field(min_length=1, max_length=63, pattern=r"^[a-z][a-z0-9_]*$")
    version: str = Field(min_length=36, max_length=36, strict=True)
    expected_format: Literal["csv", "json"]


class DatasetRefreshPrepare(DatasetRefreshVersion):
    url: str = Field(min_length=1, max_length=8192, strict=True)
    original_name: str | None = Field(default=None, max_length=1024, strict=True)


class DatasetRefreshExtract(DatasetRefreshVersion):
    max_rows: int = Field(default=500, ge=1, le=datasets.MAX_EXTRACT_ROWS)


class DatasetRefreshActivate(DatasetRefreshPrepare):
    previous_location: str | None = Field(max_length=4096, strict=True)


class QueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    sql: str = Field(min_length=1, max_length=100_000)
    allowed_tables: list[str] = Field(max_length=100)


class DescribeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    table: str = Field(min_length=1, max_length=63, pattern=r"^[a-z][a-z0-9_]*$")
    allowed_tables: list[str] = Field(max_length=100)


class ExtractRequest(DescribeRequest):
    max_rows: int = Field(default=500, ge=1, le=datasets.MAX_EXTRACT_ROWS)


class ChartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    spec: dict[str, Any]


class ReportSection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    heading: str = Field(default="", max_length=200, strict=True)
    markdown: str = Field(max_length=50_000, strict=True)


class ReportChart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=200, strict=True)
    spec: dict[str, Any]

    @field_validator("spec", mode="before")
    @classmethod
    def canonicalize_spec(cls, value: Any) -> dict[str, Any]:
        try:
            return charts.normalize(value)
        except charts.ChartSpecError as exc:
            raise ValueError("invalid canonical chart spec") from exc


class ReportTable(BaseModel):
    model_config = ConfigDict(extra="forbid")

    columns: list[str] = Field(default_factory=list, max_length=32)
    rows: list[list[Any]] = Field(default_factory=list, max_length=60)

    @field_validator("columns", mode="before")
    @classmethod
    def validate_columns(cls, value: Any) -> list[str]:
        if not isinstance(value, list) or len(value) > 32:
            raise ValueError("invalid report table columns")
        if any(not isinstance(column, str) or len(column) > 200 for column in value):
            raise ValueError("invalid report table column")
        return value

    @field_validator("rows", mode="before")
    @classmethod
    def validate_rows(cls, value: Any) -> list[list[Any]]:
        if not isinstance(value, list) or len(value) > 60:
            raise ValueError("invalid report table rows")
        for row in value:
            if not isinstance(row, list) or len(row) > 32:
                raise ValueError("invalid report table row")
            for cell in row:
                if isinstance(cell, str):
                    if len(cell) > 500:
                        raise ValueError("invalid report table cell")
                elif cell is None or isinstance(cell, bool):
                    continue
                elif isinstance(cell, int):
                    if len(str(cell)) > 500:
                        raise ValueError("invalid report table cell")
                elif isinstance(cell, float):
                    if not math.isfinite(cell):
                        raise ValueError("invalid report table cell")
                else:
                    raise ValueError("invalid report table cell")
        return value

    @model_validator(mode="after")
    def validate_rectangular_rows(self) -> Self:
        if any(len(row) != len(self.columns) for row in self.rows):
            raise ValueError("report table rows must match its columns")
        return self


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str = Field(min_length=1, max_length=128, pattern=ACCOUNT_ID_RE)
    title: str = Field(min_length=1, max_length=200, strict=True)
    subtitle: str | None = Field(default="", max_length=500, strict=True)
    generated_at: str | None = Field(default=None, max_length=200, strict=True)
    sections: list[ReportSection] = Field(default_factory=list, max_length=20)
    charts: list[ReportChart] = Field(default_factory=list, max_length=20)
    tables: list[ReportTable] = Field(default_factory=list, max_length=8)


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
        if req.expected_format is None:
            raise HTTPException(400, "expected_format required for url datasets")
        if not req.location:
            raise HTTPException(400, "prepared location required for url datasets")
        # This path is reserved for restart reconciliation of durable database
        # truth. Network refreshes must use prepare/extract/activate so a caller
        # timeout can never leave an ambiguous late registry mutation.
        local_path = _connector_cache_file(req.location, req.account_id, req.name)
        original = req.original_name or Path(urlparse(req.url).path).name or f"{req.name}.{req.expected_format}"
        return datasets.register(
            req.account_id,
            req.name,
            str(local_path),
            "url",
            original,
            req.url,
            req.expected_format,
        )
    if not req.location:
        raise HTTPException(400, "location required for path datasets")
    if not req.source_id:
        raise HTTPException(400, "source_id required for path datasets")
    local_path = _owned_upload_file(req.location, req.account_id, req.source_id)
    return datasets.register(
        req.account_id,
        req.name,
        str(local_path),
        "path",
        req.original_name or local_path.name,
        None,
        req.expected_format,
    )


@app.post("/datasets/resync")
def resync(_req: DatasetRegister) -> dict[str, Any]:
    raise HTTPException(400, "staged refresh protocol required")


@app.post("/datasets/refresh/prepare")
def prepare_dataset_refresh(req: DatasetRefreshPrepare) -> dict[str, Any]:
    candidate = _connector_version_path(
        req.account_id,
        req.name,
        req.version,
        req.expected_format,
    )
    datasets.begin_preparation(req.account_id, req.name, str(candidate))
    try:
        _claim_connector_version(candidate, req.url, req.expected_format)
        path = _fetch_url(
            req.url,
            req.account_id,
            req.name,
            req.expected_format,
            _connector_version_key(req.version),
        )
        original_name = req.original_name or Path(urlparse(req.url).path).name or candidate.name
        meta = datasets.inspect_dataset(req.name, str(path), original_name, req.expected_format)
        return {
            "version": req.version,
            "location": str(path),
            "previous_location": datasets.current_location(req.account_id, req.name),
            "rows": meta["rows"],
            "columns": meta["columns"],
            "preview": meta["preview"],
            "preview_truncated": meta["preview_truncated"],
            "size_bytes": meta["size_bytes"],
        }
    finally:
        datasets.end_preparation(req.account_id, req.name, str(candidate))


@app.post("/datasets/refresh/extract")
def extract_prepared_dataset(req: DatasetRefreshExtract) -> dict[str, Any]:
    candidate = _connector_version_path(req.account_id, req.name, req.version, req.expected_format)
    if not candidate.is_file():
        raise HTTPException(404, "dataset candidate not found")
    return datasets.extract_candidate(req.name, str(candidate), req.expected_format, req.max_rows)


@app.post("/datasets/refresh/activate")
def activate_dataset_refresh(req: DatasetRefreshActivate) -> dict[str, Any]:
    candidate = _connector_version_path(req.account_id, req.name, req.version, req.expected_format)
    _claim_connector_version(candidate, req.url, req.expected_format)
    if not candidate.is_file():
        raise HTTPException(404, "dataset candidate not found")
    previous_location = (
        str(_cache_version_path(req.account_id, req.name, req.previous_location))
        if req.previous_location is not None
        else None
    )
    original_name = req.original_name or Path(urlparse(req.url).path).name or candidate.name
    result = datasets.activate_prepared(
        req.account_id,
        req.name,
        str(candidate),
        original_name,
        req.url,
        req.expected_format,
        previous_location,
    )
    return result | {"version": req.version}


@app.post("/datasets/refresh/abort")
def abort_dataset_refresh(req: DatasetRefreshVersion) -> dict[str, str]:
    candidate = _connector_version_path(req.account_id, req.name, req.version, req.expected_format)
    deleted = datasets.cleanup_inactive_location(
        req.account_id,
        req.name,
        str(candidate),
        lambda location: _cleanup_cache_version(req.account_id, req.name, location),
    )
    return {"status": "deleted" if deleted else "missing"}


@app.post("/datasets/catalog")
def dataset_catalog(req: DatasetCatalogRequest) -> dict[str, Any]:
    return datasets.catalog(req.account_id, req.allowed_tables)


@app.get("/datasets")
def all_datasets(
    account_id: str,
    view: Literal["registry", "detail", "summary"] = "registry",
    allowed_tables: str | None = None,
) -> list[dict[str, Any]] | dict[str, Any]:
    if view == "detail":
        if allowed_tables is None:
            raise HTTPException(400, "allowed_tables required for detail view")
        if len(allowed_tables) > 6_400:
            raise HTTPException(400, "invalid allowed_tables")
        scoped_tables = [] if not allowed_tables else allowed_tables.split(",")
        if len(scoped_tables) > 100 or any(not datasets.TABLE_RE.fullmatch(name) for name in scoped_tables):
            raise HTTPException(400, "invalid allowed_tables")
        return datasets.catalog(account_id, scoped_tables)
    return datasets.list_datasets(account_id, summary=view == "summary")


@app.post("/datasets/cache/cleanup")
def cleanup_dataset_cache(req: DatasetCacheCleanup) -> dict[str, str]:
    candidate = _cache_version_path(req.account_id, req.name, req.location)
    deleted = datasets.cleanup_inactive_location(
        req.account_id,
        req.name,
        str(candidate),
        lambda location: _cleanup_cache_version(req.account_id, req.name, location),
    )
    return {"status": "deleted" if deleted else "missing"}


@app.post("/datasets/deactivate")
def deactivate_dataset(req: DatasetCacheCleanup) -> dict[str, str]:
    candidate = _cache_version_path(req.account_id, req.name, req.location)
    dropped = datasets.deactivate_if_location(req.account_id, req.name, str(candidate))
    return {"status": "dropped" if dropped else "unchanged"}


@app.post("/query")
def run_query(req: QueryRequest) -> dict[str, Any]:
    return datasets.query(req.account_id, req.sql, req.allowed_tables)


@app.post("/describe")
def run_describe(req: DescribeRequest) -> dict[str, Any]:
    return datasets.describe(req.account_id, req.table, req.allowed_tables)


@app.post("/datasets/extract")
def extract_dataset(req: ExtractRequest) -> dict[str, Any]:
    return datasets.extract(req.account_id, req.table, req.allowed_tables, req.max_rows)


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
        "sections": [section.model_dump() for section in req.sections],
        "charts": [chart.model_dump() for chart in req.charts],
        "tables": [table.model_dump() for table in req.tables],
    }


@app.post("/reports/build")
def build_report(req: ReportRequest) -> dict[str, Any]:
    try:
        html = reports.build_html(_report_dict(req))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, "report could not be built") from exc
    return {"title": req.title, "html": html}


@app.post("/reports/pdf")
def report_pdf(req: ReportRequest) -> Response:
    try:
        pdf = reports.build_pdf(_report_dict(req))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, "report PDF could not be built") from exc
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="report.pdf"'},
    )


def _cache_ext(url: str, content_type: str, expected_format: str | None = None) -> str:
    if expected_format in {"csv", "json"}:
        return f".{expected_format}"
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in {".csv", ".json"}:
        return suffix
    return _EXT_BY_CT.get(content_type.split(";")[0].strip().lower(), ".csv")


def _storage_root() -> Path:
    root = STORAGE_DIR.resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _canonical_uuid(value: str) -> str:
    try:
        canonical = str(uuid.UUID(value))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(400, "invalid dataset ownership") from exc
    if value != canonical:
        raise HTTPException(400, "invalid dataset ownership")
    return canonical


def _owned_upload_file(location: str, account_id: str, source_id: str) -> Path:
    root = _storage_root()
    account_key = _canonical_uuid(account_id)
    source_key = _canonical_uuid(source_id)
    try:
        account_directory = _exact_child_directory(root, account_key, create=False)
        expected_directory = _exact_child_directory(account_directory, source_key, create=False)
        lexical_candidate = Path(os.path.abspath(location))
        if lexical_candidate.is_symlink() or lexical_candidate.parent != expected_directory:
            raise HTTPException(400, "dataset location is not owned by this account and source")
        candidate = lexical_candidate.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(404, "dataset file not found") from exc
    if candidate.parent != expected_directory or not candidate.is_file():
        raise HTTPException(400, "dataset location is not owned by this account and source")
    return candidate


def _connector_cache_file(location: str, account_id: str, name: str) -> Path:
    candidate = _cache_version_path(account_id, name, location)
    if not candidate.is_file():
        raise HTTPException(404, "dataset file not found")
    return candidate


def _connector_version_key(version: str) -> str:
    try:
        parsed = uuid.UUID(version)
    except (ValueError, AttributeError) as exc:
        raise HTTPException(400, "invalid connector version") from exc
    if str(parsed) != version:
        raise HTTPException(400, "invalid connector version")
    return parsed.hex


def _connector_version_path(
    account_id: str,
    name: str,
    version: str,
    expected_format: Literal["csv", "json"],
) -> Path:
    candidate = _cache_dir(account_id, name) / f"{_connector_version_key(version)}.{expected_format}"
    if candidate.is_symlink():
        raise HTTPException(400, "invalid dataset cache version")
    if candidate.exists():
        return _cache_version_path(account_id, name, candidate)
    return candidate


def _version_manifest_path(candidate: Path) -> Path:
    return candidate.with_suffix(".meta")


def _claim_connector_version(candidate: Path, url: str, expected_format: str) -> None:
    digest = hashlib.sha256(
        json.dumps(
            {"url": url, "expected_format": expected_format},
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    manifest = _version_manifest_path(candidate)
    if manifest.is_symlink():
        raise HTTPException(400, "invalid dataset cache manifest")
    temporary_manifest: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="ascii",
            dir=manifest.parent,
            prefix=f".{manifest.name}.staged-",
            delete=False,
        ) as output:
            temporary_manifest = Path(output.name)
            output.write(digest)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary_manifest, manifest)
        except FileExistsError:
            if manifest.is_symlink() or not manifest.is_file():
                raise HTTPException(400, "invalid dataset cache manifest") from None
            try:
                existing = manifest.read_text(encoding="ascii")
            except OSError as exc:
                raise HTTPException(409, "connector version is unavailable") from exc
            if not secrets.compare_digest(existing, digest):
                raise HTTPException(409, "connector version is already bound to another request") from None
    finally:
        if temporary_manifest is not None:
            temporary_manifest.unlink(missing_ok=True)


def _cache_dir(account_id: str, name: str, *, create: bool = True) -> Path:
    if not re.fullmatch(ACCOUNT_ID_RE, account_id) or not datasets.TABLE_RE.fullmatch(name):
        raise HTTPException(400, "invalid dataset identity")
    account_key = hashlib.sha256(account_id.encode("utf-8")).hexdigest()[:24]
    cache_root = _exact_child_directory(_storage_root(), "url_cache", create=create)
    account_directory = _exact_child_directory(cache_root, account_key, create=create)
    return _exact_child_directory(account_directory, name, create=create)


def _exact_child_directory(parent: Path, name: str, *, create: bool) -> Path:
    """Return one lexical child, rejecting every symlinked namespace component."""
    child = parent / name
    if child.is_symlink():
        raise HTTPException(400, "invalid storage namespace")
    if create:
        try:
            child.mkdir(exist_ok=True)
        except OSError as exc:
            raise HTTPException(400, "storage namespace is unavailable") from exc
    if child.exists() and (not child.is_dir() or child.resolve() != child):
        raise HTTPException(400, "invalid storage namespace")
    return child


@dataclass(frozen=True)
class _StagedDownload:
    path: Path
    target: Path


Address = tuple[int, str]


def _remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise HTTPException(504, "connector download timed out")
    return remaining


def _public_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise HTTPException(502, "connector hostname could not be resolved") from exc
    translated_ipv4 = isinstance(address, ipaddress.IPv6Address) and any(
        address in network for network in UNSAFE_IPV6_TRANSLATION_NETWORKS
    )
    if not address.is_global or translated_ipv4:
        raise HTTPException(400, "connector URL must resolve only to public IP addresses")
    return address


def _resolve_public_addresses(host: str, port: int, deadline: float) -> list[Address]:
    """Resolve once, reject every non-public answer, and return pinned endpoints."""
    normalized = host.rstrip(".").lower()
    if not normalized or normalized == "localhost" or normalized.endswith((".localhost", ".local")):
        raise HTTPException(400, "connector URL must resolve only to public IP addresses")

    try:
        literal = ipaddress.ip_address(normalized)
    except ValueError:
        literal = None
    if literal is not None:
        checked = _public_ip(normalized)
        family = socket.AF_INET6 if checked.version == 6 else socket.AF_INET
        return [(family, str(checked))]

    results: queue.Queue[list[tuple[Any, ...]] | BaseException] = queue.Queue(maxsize=1)

    def resolve() -> None:
        try:
            records = socket.getaddrinfo(normalized, port, type=socket.SOCK_STREAM)
            results.put(records)
        except BaseException as exc:  # noqa: BLE001 - transfer resolver failure to caller
            results.put(exc)

    # getaddrinfo has no portable timeout. A daemon worker lets the request's
    # single deadline remain authoritative even if the platform resolver stalls.
    threading.Thread(target=resolve, name="connector-dns", daemon=True).start()
    try:
        resolved = results.get(timeout=_remaining_seconds(deadline))
    except queue.Empty as exc:
        raise HTTPException(504, "connector download timed out") from exc
    if isinstance(resolved, BaseException):
        raise HTTPException(502, "connector hostname could not be resolved") from resolved

    addresses: list[Address] = []
    for family, _socktype, _proto, _canonname, sockaddr in resolved:
        if family not in {socket.AF_INET, socket.AF_INET6}:
            continue
        checked = _public_ip(str(sockaddr[0]).split("%", 1)[0])
        entry = (family, str(checked))
        if entry not in addresses:
            addresses.append(entry)
    if not addresses:
        raise HTTPException(502, "connector hostname could not be resolved")
    return addresses


def _open_pinned_socket(addresses: list[Address], port: int, deadline: float) -> socket.socket:
    last_error: OSError | None = None
    for family, address in addresses:
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(_remaining_seconds(deadline))
            endpoint = (address, port, 0, 0) if family == socket.AF_INET6 else (address, port)
            sock.connect(endpoint)
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    if time.monotonic() >= deadline or isinstance(last_error, (TimeoutError, socket.timeout)):
        raise HTTPException(504, "connector download timed out") from last_error
    raise HTTPException(502, "connector download failed") from last_error


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, addresses: list[Address], deadline: float) -> None:
        super().__init__(host, port, timeout=_remaining_seconds(deadline))
        self._pinned_addresses = addresses
        self._deadline = deadline

    def connect(self) -> None:
        self.sock = _open_pinned_socket(self._pinned_addresses, self.port, self._deadline)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, addresses: list[Address], deadline: float) -> None:
        super().__init__(host, port, timeout=_remaining_seconds(deadline), context=ssl.create_default_context())
        self._pinned_addresses = addresses
        self._deadline = deadline

    def connect(self) -> None:
        raw = _open_pinned_socket(self._pinned_addresses, self.port, self._deadline)
        try:
            raw.settimeout(_remaining_seconds(self._deadline))
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def _connector_endpoint(url: str, deadline: float) -> tuple[Any, str, int, list[Address]]:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "connector URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise HTTPException(400, "connector URL must not contain credentials")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise HTTPException(400, "connector URL has an invalid port") from exc
    return parsed, parsed.hostname, port, _resolve_public_addresses(parsed.hostname, port, deadline)


def _validate_download_format(prefix: bytes, content_type: str, expected_format: str) -> None:
    sniff = prefix.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type in {"text/html", "application/xhtml+xml"} or sniff.startswith((b"<!doctype html", b"<html")):
        raise HTTPException(422, "URL returned HTML, not tabular data")
    looks_json = sniff.startswith((b"{", b"["))
    content_is_json = media_type == "application/json" or media_type.endswith("+json")
    content_is_csv = media_type in {"text/csv", "application/csv", "text/tab-separated-values"}
    if expected_format == "json" and (content_is_csv or not looks_json):
        raise HTTPException(422, "URL response does not match expected JSON format")
    if expected_format == "csv" and (content_is_json or looks_json):
        raise HTTPException(422, "URL response does not match expected CSV format")


def _download_url(
    url: str,
    account_id: str,
    name: str,
    expected_format: Literal["csv", "json"],
    version: str | None = None,
) -> _StagedDownload:
    if expected_format not in {"csv", "json"}:
        raise HTTPException(400, "expected_format must be csv or json")
    cache_dir = _cache_dir(account_id, name)
    deadline = time.monotonic() + CONNECTOR_TIMEOUT_SECONDS
    temp_path: Path | None = None
    completed = False
    try:
        current_url = url
        for redirect_count in range(MAX_CONNECTOR_REDIRECTS + 1):
            parsed, host, port, addresses = _connector_endpoint(current_url, deadline)
            connection_type = _PinnedHTTPSConnection if parsed.scheme.lower() == "https" else _PinnedHTTPConnection
            connection = connection_type(host, port, addresses, deadline)
            try:
                target_path = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
                connection.request(
                    "GET",
                    target_path,
                    headers={"Accept-Encoding": "identity", "User-Agent": "Borealis-Connector/1"},
                )
                response = connection.getresponse()
                if response.status in {301, 302, 303, 307, 308}:
                    location = response.getheader("Location")
                    if not location or redirect_count >= MAX_CONNECTOR_REDIRECTS:
                        raise HTTPException(502, "connector redirect limit exceeded")
                    redirected = urljoin(current_url, location)
                    redirected_scheme = urlparse(redirected).scheme.lower()
                    if parsed.scheme.lower() == "https" and redirected_scheme == "http":
                        raise HTTPException(400, "connector redirects must not downgrade HTTPS")
                    current_url = redirected
                    continue
                if response.status < 200 or response.status >= 300:
                    raise HTTPException(502, "connector download failed")

                content_type = response.getheader("Content-Type", "")
                content_length = response.getheader("Content-Length")
                if content_length is not None:
                    try:
                        if int(content_length) > MAX_CONNECTOR_DOWNLOAD_BYTES:
                            raise HTTPException(413, "connector response is too large")
                    except ValueError:
                        pass
                suffix = _cache_ext(current_url, content_type, expected_format)
                version_key = version or uuid.uuid4().hex
                if not re.fullmatch(r"[0-9a-f]{32}", version_key):
                    raise HTTPException(400, "invalid connector version")
                target = cache_dir / f"{version_key}{suffix}"
                with tempfile.NamedTemporaryFile(
                    dir=target.parent,
                    prefix=f".{version_key}.staged-",
                    suffix=target.suffix,
                    delete=False,
                ) as temp_file:
                    temp_path = Path(temp_file.name)
                    total = 0
                    prefix = bytearray()
                    while True:
                        if connection.sock is not None:
                            connection.sock.settimeout(_remaining_seconds(deadline))
                        chunk = response.read(CONNECTOR_CHUNK_BYTES)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_CONNECTOR_DOWNLOAD_BYTES:
                            raise HTTPException(413, "connector response is too large")
                        if len(prefix) < 512:
                            prefix.extend(chunk[: 512 - len(prefix)])
                        temp_file.write(chunk)
                if total == 0:
                    raise HTTPException(422, "URL returned an empty response")
                _validate_download_format(bytes(prefix), content_type, expected_format)
                completed = True
                return _StagedDownload(path=temp_path, target=target)
            finally:
                connection.close()
        raise HTTPException(502, "connector redirect limit exceeded")
    except HTTPException:
        raise
    except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
        if time.monotonic() >= deadline or isinstance(exc, (TimeoutError, socket.timeout)):
            raise HTTPException(504, "connector download timed out") from exc
        raise HTTPException(502, "connector download failed") from exc
    finally:
        # Ownership transfers to the caller only when a staged object returns.
        if temp_path is not None and not completed:
            temp_path.unlink(missing_ok=True)


def _promote_download(staged: _StagedDownload) -> Path:
    try:
        # The hard-link publication is atomic and never overwrites a candidate
        # already prepared for the same caller-supplied version UUID.
        os.link(staged.path, staged.target)
    except FileExistsError:
        pass
    return staged.target


def _fetch_url(
    url: str,
    account_id: str,
    name: str,
    expected_format: Literal["csv", "json"],
    version: str | None = None,
) -> Path:
    """Download and validate a new immutable connector-cache version."""
    if expected_format not in {"csv", "json"}:
        raise HTTPException(400, "expected_format must be csv or json")
    if version is not None:
        existing = _cache_dir(account_id, name) / f"{version}.{expected_format}"
        if existing.is_file():
            existing = _cache_version_path(account_id, name, existing)
            datasets.inspect_dataset(name, str(existing), existing.name, expected_format)
            return existing
    staged = _download_url(url, account_id, name, expected_format, version)
    try:
        datasets.inspect_dataset(name, str(staged.path), staged.target.name, expected_format)
        promoted = _cache_version_path(account_id, name, _promote_download(staged))
        # A concurrent winner may have published different remote bytes. Always
        # validate the exact immutable path returned to the caller.
        datasets.inspect_dataset(name, str(promoted), promoted.name, expected_format)
        return promoted
    finally:
        staged.path.unlink(missing_ok=True)


def _cache_version_path(account_id: str, name: str, location: str | Path) -> Path:
    cache_dir = _cache_dir(account_id, name, create=False).resolve()
    raw_candidate = Path(location)
    if raw_candidate.is_symlink():
        raise HTTPException(400, "invalid dataset cache version")
    candidate = raw_candidate.resolve()
    if candidate.parent != cache_dir or not CACHE_VERSION_RE.fullmatch(candidate.name):
        raise HTTPException(400, "invalid dataset cache version")
    return candidate


def _cleanup_cache_version(account_id: str, name: str, location: str | Path) -> bool:
    """Delete exactly one proven immutable cache version; never recurse."""
    candidate = _cache_version_path(account_id, name, location)
    manifest = _version_manifest_path(candidate)
    existed = candidate.exists() or manifest.exists()
    candidate.unlink(missing_ok=True)
    manifest.unlink(missing_ok=True)
    try:
        candidate.parent.rmdir()
    except OSError:
        pass
    return existed
