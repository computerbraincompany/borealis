"""HTTP-boundary and connector security regressions for the report service."""

from __future__ import annotations

import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import datasets, main

AUTH_HEADERS = {
    "Authorization": "Bearer borealis-test-service-token-that-is-long-enough",
    "X-Request-ID": "python-test-request",
}


def _client() -> TestClient:
    return TestClient(main.app, headers=AUTH_HEADERS)


def _valid_report_payload() -> dict:
    return {
        "account_id": "acct-report-limits",
        "title": "Bounded report",
        "sections": [{"heading": "Summary", "markdown": "Body"}],
        "charts": [],
        "tables": [{"columns": ["name", "value"], "rows": [["rent", 42.0]]}],
    }


def _owned_upload(storage: Path, filename: str, content: str) -> tuple[str, str, Path]:
    account_id = str(uuid.uuid4())
    source_id = str(uuid.uuid4())
    source_dir = storage / account_id / source_id
    source_dir.mkdir(parents=True)
    path = source_dir / filename
    path.write_text(content)
    return account_id, source_id, path


class _Handler(BaseHTTPRequestHandler):
    body = b"a,b\n1,2\n"
    content_type = "text/csv"
    status = 200
    get_count = 0
    redirect_to: str | None = None

    def do_GET(self):  # noqa: N802
        type(self).get_count += 1
        if type(self).redirect_to is not None:
            self.send_response(302)
            self.send_header("Location", type(self).redirect_to)
            self.end_headers()
            return
        self.send_response(type(self).status)
        self.send_header("Content-Type", type(self).content_type)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *args):  # silence default logging
        pass


@pytest.fixture()
def csv_server(monkeypatch):
    _Handler.body = b"a,b\n1,2\n"
    _Handler.content_type = "text/csv"
    _Handler.status = 200
    _Handler.get_count = 0
    _Handler.redirect_to = None
    srv = HTTPServer(("127.0.0.1", 0), _Handler)
    # Production resolution rejects loopback. Tests explicitly bypass only the
    # validator while retaining the real pinned-socket download implementation.
    monkeypatch.setattr(
        main,
        "_resolve_public_addresses",
        lambda _host, _port, _deadline: [(main.socket.AF_INET, "127.0.0.1")],
    )
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def test_chart_rejects_invalid_spec_with_400():
    response = _client().post(
        "/chart",
        json={"account_id": "acct-chart-test", "spec": {"type": "nope"}},
    )

    assert response.status_code == 400
    assert "unsupported chart type" in response.json()["detail"]


@pytest.mark.parametrize("endpoint", ["/reports/build", "/reports/pdf"])
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "private-marker-" + "x" * 200),
        ("sections", [{"markdown": "x" * 50_001}]),
        ("charts", [{"id": "bad", "spec": {"type": "line", "categories": [], "series": []}}]),
        ("tables", [{"columns": ["value"], "rows": [[{"nested": ["private-marker"]}]]}]),
    ],
)
def test_report_endpoints_reject_adversarial_nested_payloads_opaquely(endpoint, field, value):
    payload = _valid_report_payload()
    payload[field] = value

    response = _client().post(endpoint, json=payload)

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid request"
    assert "private-marker" not in response.text


def test_request_body_content_length_is_rejected_before_json_parsing(monkeypatch):
    monkeypatch.setattr(main, "MAX_REQUEST_BODY_BYTES", 64)

    response = _client().post(
        "/reports/build",
        content=b"{}",
        headers={"Content-Type": "application/json", "Content-Length": "65"},
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "request exceeds service limit"
    assert response.headers["X-Request-ID"] == "python-test-request"


def test_chunked_request_body_is_capped_while_receiving(monkeypatch):
    monkeypatch.setattr(main, "MAX_REQUEST_BODY_BYTES", 128)
    encoded = json.dumps(_valid_report_payload()).encode("utf-8")
    assert len(encoded) > main.MAX_REQUEST_BODY_BYTES

    response = _client().post(
        "/reports/build",
        content=(encoded[index : index + 32] for index in range(0, len(encoded), 32)),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json()["detail"] == "request exceeds service limit"


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/query", {"account_id": "acct-api", "sql": "SELECT 1"}),
        ("/describe", {"account_id": "acct-api", "table": "missing"}),
    ],
)
def test_data_routes_require_allowed_tables(path: str, body: dict[str, str]):
    response = _client().post(path, json=body)

    assert response.status_code == 422
    assert response.json()["detail"] == "invalid request"
    assert response.headers["X-Request-ID"] == "python-test-request"


@pytest.mark.parametrize(
    ("url", "content_type", "expected"),
    [
        ("https://x/y/data.json", "application/octet-stream", ".json"),
        ("https://x/y/data", "application/json", ".json"),
        ("https://x/y/data", "application/octet-stream", ".csv"),
    ],
)
def test_cache_ext(url: str, content_type: str, expected: str):
    assert main._cache_ext(url, content_type) == expected


def test_extensionless_json_fetch_creates_immutable_versions(csv_server, tmp_path, monkeypatch):
    _Handler.body = b'[{"value":1}]'
    _Handler.content_type = "application/json; charset=utf-8"
    url = f"http://127.0.0.1:{csv_server.server_port}/data"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    first = main._fetch_url(url, "acct-json-cache", "events", "json")
    second = main._fetch_url(url, "acct-json-cache", "events", "json")

    assert first != second
    assert first.suffix == ".json"
    assert first.read_bytes() == _Handler.body
    assert second.read_bytes() == _Handler.body
    assert _Handler.get_count == 2


def test_url_registration_can_reuse_a_fetched_path_without_losing_provenance(tmp_path, monkeypatch):
    account = "acct-cached-url-registration"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    local_path = main._cache_dir(account, "ledger") / f"{'a' * 32}.csv"
    local_path.write_text("amount\n42\n")

    def unexpected_fetch(*_args, **_kwargs):
        raise AssertionError("an existing connector cache must not be downloaded again")

    monkeypatch.setattr(main, "_fetch_url", unexpected_fetch)
    response = _client().post(
        "/datasets/register",
        json={
            "account_id": account,
            "name": "ledger",
            "location": str(local_path),
            "kind": "url",
            "url": "https://example.invalid/private.csv?signature=secret",
            "original_name": "Finance ledger",
            "expected_format": "csv",
        },
    )

    try:
        assert response.status_code == 200
        result = response.json()
        assert result["kind"] == "url"
        assert result["url"] == "https://example.invalid/private.csv?signature=secret"
        assert result["original_name"] == "Finance ledger"
        assert result["location"] == str(local_path)
    finally:
        if "ledger" in datasets._REGISTRY.get(account, {}):
            datasets.drop(account, "ledger")


def test_legacy_resync_endpoint_fails_closed_in_favor_of_staged_protocol():
    account = "acct-resync-recovery"
    response = _client().post(
        "/datasets/resync",
        json={
            "account_id": account,
            "name": "events",
            "kind": "url",
            "url": "https://example.invalid/events.json",
            "original_name": "Events feed",
            "expected_format": "json",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "staged refresh protocol required"
    assert "events" not in datasets._REGISTRY.get(account, {})


def test_refresh_versions_do_not_replace_previous_cache_on_failure(csv_server, tmp_path, monkeypatch):
    account = "acct-refresh-cache"
    name = "events"
    url = f"http://127.0.0.1:{csv_server.server_port}/data"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    _Handler.body = b'[{"value":1}]'
    _Handler.content_type = "application/json"
    json_path = main._fetch_url(url, account, name, "json")
    assert json_path.suffix == ".json"

    _Handler.body = b"value\n2\n"
    _Handler.content_type = "text/csv"
    csv_path = main._fetch_url(url, account, name, "csv")
    assert csv_path.suffix == ".csv"
    assert csv_path.read_bytes() == b"value\n2\n"
    assert json_path.read_bytes() == b'[{"value":1}]'

    _Handler.status = 500
    _Handler.body = b"failed"
    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(url, account, name, "csv")
    assert error.value.status_code == 502
    assert csv_path.read_bytes() == b"value\n2\n"
    assert json_path.read_bytes() == b'[{"value":1}]'


def test_resync_refetches_after_remote_change(csv_server, tmp_path, monkeypatch):
    _Handler.body = b"a,b\n1,2\n"
    account = "acct-sync-test"
    name = "tickers"
    url = f"http://127.0.0.1:{csv_server.server_port}/d.csv"
    # keep the fetcher's cache inside the test tmp dir so nothing leaks to uploads/
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    path = main._fetch_url(url, account, name, "csv")
    datasets.register(account, name, str(path), "url", "tickers.csv", url, "csv")
    first = datasets.query(account, "SELECT count(*) AS n FROM tickers", ["tickers"])["rows"][0][0]
    assert first == 1

    # remote data changes
    _Handler.body = b"a,b\n1,2\n3,4\n"

    # Resync fetches and atomically switches to a new immutable cache version.
    refreshed = datasets.resync(
        account,
        name,
        fetcher=lambda u: str(main._fetch_url(u, account, name, "csv")),
        expected_format="csv",
        cleanup=lambda location: main._cleanup_cache_version(account, name, location),
    )
    second = datasets.query(account, "SELECT count(*) AS n FROM tickers", ["tickers"])["rows"][0][0]
    assert second == 2
    assert refreshed["previous_location"] == str(path)
    assert path.exists()

    cleanup = _client().post(
        "/datasets/cache/cleanup",
        json={"account_id": account, "name": name, "location": str(path)},
    )
    assert cleanup.status_code == 200
    assert cleanup.json() == {"status": "deleted"}
    assert not path.exists()


def test_url_registration_requires_a_prepared_immutable_location():
    payload = {
        "account_id": "acct-register-version",
        "name": "feed",
        "kind": "url",
        "url": "https://example.test/feed.csv",
        "expected_format": "csv",
    }
    response = _client().post("/datasets/register", json=payload)

    assert response.status_code == 400
    assert response.json()["detail"] == "prepared location required for url datasets"


def test_health_is_public_but_other_routes_require_service_token():
    client = TestClient(main.app)

    assert client.get("/health").status_code == 200
    denied = client.post(
        "/chart",
        json={"account_id": "acct-auth", "spec": {"type": "pie", "items": [{"name": "x", "value": 1}]}},
    )
    assert denied.status_code == 401
    assert denied.json()["detail"] == "unauthorized"
    assert "X-Request-ID" in denied.headers


def test_invalid_service_token_is_rejected():
    response = TestClient(
        main.app,
        headers={"Authorization": "Bearer definitely-not-the-service-token"},
    ).get("/datasets", params={"account_id": "acct-auth"})

    assert response.status_code == 401


def test_missing_or_weak_service_token_fails_closed(monkeypatch):
    monkeypatch.setenv("BOREALIS_SERVICE_TOKEN", "too-short")

    response = _client().get("/datasets", params={"account_id": "acct-auth"})

    assert response.status_code == 503
    assert response.json()["detail"] == "service authentication is unavailable"


def test_register_rejects_paths_outside_storage_root(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    outside = tmp_path / "outside.csv"
    outside.write_text("x\n1\n")
    monkeypatch.setattr(main, "STORAGE_DIR", storage)
    account = str(uuid.uuid4())
    source_id = str(uuid.uuid4())

    response = _client().post(
        "/datasets/register",
        json={
            "account_id": account,
            "source_id": source_id,
            "name": "outside",
            "location": str(outside),
            "kind": "path",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "dataset location is not owned by this account and source"


def test_register_rejects_cross_account_upload_path(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    owner_account, source_id, source = _owned_upload(tmp_path, "private.csv", "value\n7\n")
    other_account = str(uuid.uuid4())

    response = _client().post(
        "/datasets/register",
        json={
            "account_id": other_account,
            "source_id": source_id,
            "name": "private",
            "location": str(source),
            "kind": "path",
        },
    )

    assert owner_account != other_account
    assert response.status_code == 400
    assert response.json()["detail"] == "dataset location is not owned by this account and source"


def test_register_rejects_within_root_cross_account_directory_symlink(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    owner_account, source_id, source = _owned_upload(tmp_path, "private.csv", "value\n7\n")
    requesting_account = str(uuid.uuid4())
    (tmp_path / requesting_account).symlink_to(tmp_path / owner_account, target_is_directory=True)
    disguised = tmp_path / requesting_account / source_id / source.name

    response = _client().post(
        "/datasets/register",
        json={
            "account_id": requesting_account,
            "source_id": source_id,
            "name": "private",
            "location": str(disguised),
            "kind": "path",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid storage namespace"


def test_register_rejects_legacy_unscoped_path_without_source_id(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account, _source_id, source = _owned_upload(tmp_path, "legacy.csv", "value\n1\n")

    response = _client().post(
        "/datasets/register",
        json={"account_id": account, "name": "legacy", "location": str(source), "kind": "path"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "source_id required for path datasets"


def test_malformed_refresh_preserves_last_known_good(csv_server, tmp_path, monkeypatch):
    account = "acct-last-known-good"
    url = f"http://127.0.0.1:{csv_server.server_port}/events.json"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    _Handler.body = b'[{"value":1}]'
    _Handler.content_type = "application/json"
    cached = main._fetch_url(url, account, "events", "json")
    original = cached.read_bytes()

    _Handler.body = b"{"
    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(url, account, "events", "json")

    assert error.value.status_code == 422
    assert cached.read_bytes() == original
    assert not list(cached.parent.glob(".*.staged-*"))


def test_cleanup_cache_version_removes_only_exact_owned_version(tmp_path, monkeypatch):
    account = "acct-cleanup"
    name = "events"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    cache_dir = main._cache_dir(account, name)
    old = cache_dir / f"{'a' * 32}.json"
    current = cache_dir / f"{'b' * 32}.json"
    outside = tmp_path / "outside.json"
    for path in (old, current, outside):
        path.write_text("[]")

    assert main._cleanup_cache_version(account, name, old) is True
    assert main._cleanup_cache_version(account, name, old) is False
    with pytest.raises(main.HTTPException) as error:
        main._cleanup_cache_version(account, name, outside)

    assert error.value.status_code == 400
    assert not old.exists()
    assert current.exists()
    assert outside.exists()


def test_connector_cache_rejects_within_root_cross_account_directory_symlink(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account_a = "acct-cache-a"
    account_b = "acct-cache-b"
    name = "events"
    owned = main._cache_dir(account_b, name) / f"{'e' * 32}.json"
    owned.write_text("[]")
    cache_root = tmp_path / "url_cache"
    account_a_key = main.hashlib.sha256(account_a.encode()).hexdigest()[:24]
    account_a_dir = cache_root / account_a_key
    account_a_dir.mkdir()
    (account_a_dir / name).symlink_to(owned.parent, target_is_directory=True)
    disguised = account_a_dir / name / owned.name

    with pytest.raises(main.HTTPException) as error:
        main._connector_cache_file(str(disguised), account_a, name)

    assert error.value.status_code == 400
    assert owned.exists()


def test_cache_cleanup_endpoint_refuses_active_version_and_is_idempotent(tmp_path, monkeypatch):
    account = "acct-active-cache"
    name = "active"
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    cache_dir = main._cache_dir(account, name)
    active = cache_dir / f"{'c' * 32}.csv"
    retired = cache_dir / f"{'d' * 32}.csv"
    active.write_text("value\n1\n")
    retired.write_text("value\n0\n")
    datasets.register(account, name, str(active), "url", "Active", "https://example.test/active", "csv")

    try:
        denied = _client().post(
            "/datasets/cache/cleanup",
            json={"account_id": account, "name": name, "location": str(active)},
        )
        first = _client().post(
            "/datasets/cache/cleanup",
            json={"account_id": account, "name": name, "location": str(retired)},
        )
        second = _client().post(
            "/datasets/cache/cleanup",
            json={"account_id": account, "name": name, "location": str(retired)},
        )

        assert denied.status_code == 409
        assert active.exists()
        assert first.json() == {"status": "deleted"}
        assert second.json() == {"status": "missing"}
    finally:
        datasets.drop(account, name)
        main._cleanup_cache_version(account, name, active)


def test_versioned_refresh_prepare_extract_activate_abort_protocol(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account = "acct-staged-refresh"
    name = "feed"
    version = str(uuid.uuid4())
    url = "https://example.test/feed.csv"

    def prepared_fetch(_url, account_id, table, expected_format, version_key=None):
        assert (_url, account_id, table, expected_format, version_key) == (
            url,
            account,
            name,
            "csv",
            uuid.UUID(version).hex,
        )
        candidate = main._cache_dir(account_id, table) / f"{version_key}.csv"
        if not candidate.exists():
            candidate.write_text("value\n7\n8\n")
        return candidate

    monkeypatch.setattr(main, "_fetch_url", prepared_fetch)
    prepare_payload = {
        "account_id": account,
        "name": name,
        "version": version,
        "url": url,
        "expected_format": "csv",
        "original_name": "Feed",
    }

    first = _client().post("/datasets/refresh/prepare", json=prepare_payload)
    retry = _client().post("/datasets/refresh/prepare", json=prepare_payload)
    assert first.status_code == retry.status_code == 200
    assert first.json()["location"] == retry.json()["location"]
    assert first.json()["previous_location"] is None
    assert name not in datasets._REGISTRY.get(account, {})

    extracted = _client().post(
        "/datasets/refresh/extract",
        json={
            "account_id": account,
            "name": name,
            "version": version,
            "expected_format": "csv",
            "max_rows": 1,
        },
    )
    assert extracted.status_code == 200
    assert extracted.json()["rows"] == [[7]]
    assert name not in datasets._REGISTRY.get(account, {})

    activate_payload = prepare_payload | {"previous_location": None}
    activated = _client().post("/datasets/refresh/activate", json=activate_payload)
    activated_retry = _client().post("/datasets/refresh/activate", json=activate_payload)
    assert activated.status_code == activated_retry.status_code == 200
    assert activated.json()["version"] == version
    assert datasets.query(account, "SELECT value FROM feed ORDER BY value", [name])["rows"] == [[7], [8]]

    denied_abort = _client().post(
        "/datasets/refresh/abort",
        json={"account_id": account, "name": name, "version": version, "expected_format": "csv"},
    )
    assert denied_abort.status_code == 409

    second_version = str(uuid.uuid4())
    second_payload = prepare_payload | {"version": second_version}

    # The fake asserts the first version, so bind a generic deterministic fetch
    # for the inactive abort/idempotency branch.
    def second_fetch(_url, account_id, table, expected_format, version_key=None):
        candidate = main._cache_dir(account_id, table) / f"{version_key}.{expected_format}"
        candidate.write_text("value\n9\n")
        return candidate

    monkeypatch.setattr(main, "_fetch_url", second_fetch)
    assert _client().post("/datasets/refresh/prepare", json=second_payload).status_code == 200
    abort_payload = {
        "account_id": account,
        "name": name,
        "version": second_version,
        "expected_format": "csv",
    }
    assert _client().post("/datasets/refresh/abort", json=abort_payload).json() == {"status": "deleted"}
    assert _client().post("/datasets/refresh/abort", json=abort_payload).json() == {"status": "missing"}

    datasets.drop(account, name)
    main._cleanup_cache_version(account, name, Path(activated.json()["location"]))


def test_refresh_version_is_bound_to_its_original_url_and_format(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    version = str(uuid.uuid4())
    account = "acct-version-binding"

    def fake_fetch(_url, account_id, table, expected_format, version_key=None):
        candidate = main._cache_dir(account_id, table) / f"{version_key}.{expected_format}"
        candidate.write_text("value\n1\n")
        return candidate

    monkeypatch.setattr(main, "_fetch_url", fake_fetch)
    payload = {
        "account_id": account,
        "name": "bound",
        "version": version,
        "url": "https://example.test/one.csv",
        "expected_format": "csv",
    }
    assert _client().post("/datasets/refresh/prepare", json=payload).status_code == 200

    conflict = _client().post(
        "/datasets/refresh/prepare",
        json=payload | {"url": "https://example.test/two.csv"},
    )

    assert conflict.status_code == 409
    abort = _client().post(
        "/datasets/refresh/abort",
        json={
            "account_id": account,
            "name": "bound",
            "version": version,
            "expected_format": "csv",
        },
    )
    assert abort.json() == {"status": "deleted"}


def test_abort_cannot_race_an_in_progress_preparation(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account = "acct-pending-prepare"
    name = "pending"
    version = str(uuid.uuid4())
    started = threading.Event()
    release = threading.Event()

    def blocking_fetch(_url, account_id, table, expected_format, version_key=None):
        started.set()
        assert release.wait(timeout=2)
        candidate = main._cache_dir(account_id, table) / f"{version_key}.{expected_format}"
        candidate.write_text("value\n1\n")
        return candidate

    monkeypatch.setattr(main, "_fetch_url", blocking_fetch)
    prepare_payload = {
        "account_id": account,
        "name": name,
        "version": version,
        "url": "https://example.test/pending.csv",
        "expected_format": "csv",
    }
    result: list[int] = []
    worker = threading.Thread(
        target=lambda: result.append(_client().post("/datasets/refresh/prepare", json=prepare_payload).status_code),
        daemon=True,
    )
    worker.start()
    assert started.wait(timeout=2)

    abort_payload = {
        "account_id": account,
        "name": name,
        "version": version,
        "expected_format": "csv",
    }
    denied = _client().post("/datasets/refresh/abort", json=abort_payload)
    release.set()
    worker.join(timeout=2)

    assert denied.status_code == 409
    assert result == [200]
    assert _client().post("/datasets/refresh/abort", json=abort_payload).json() == {"status": "deleted"}


def test_activate_rejects_stale_previous_location_without_replacing_current(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account = "acct-stale-activation"
    name = "feed"
    cache_dir = main._cache_dir(account, name)
    old = cache_dir / f"{'3' * 32}.csv"
    current = cache_dir / f"{'4' * 32}.csv"
    old.write_text("value\n1\n")
    current.write_text("value\n2\n")
    url = "https://example.test/feed.csv"
    datasets.register(account, name, str(old), "url", "Feed", url, "csv")
    version = str(uuid.uuid4())

    def candidate_fetch(_url, account_id, table, expected_format, version_key=None):
        candidate = main._cache_dir(account_id, table) / f"{version_key}.{expected_format}"
        candidate.write_text("value\n3\n")
        return candidate

    monkeypatch.setattr(main, "_fetch_url", candidate_fetch)
    prepare_payload = {
        "account_id": account,
        "name": name,
        "version": version,
        "url": url,
        "expected_format": "csv",
    }
    prepared = _client().post("/datasets/refresh/prepare", json=prepare_payload)
    assert prepared.status_code == 200
    assert prepared.json()["previous_location"] == str(old)
    datasets.register(account, name, str(current), "url", "Feed", url, "csv")

    activation = _client().post(
        "/datasets/refresh/activate",
        json=prepare_payload | {"previous_location": str(old)},
    )

    assert activation.status_code == 409
    assert datasets.query(account, "SELECT value FROM feed", [name])["rows"] == [[2]]
    abort_payload = {
        "account_id": account,
        "name": name,
        "version": version,
        "expected_format": "csv",
    }
    assert _client().post("/datasets/refresh/abort", json=abort_payload).json() == {"status": "deleted"}
    datasets.drop(account, name)


def test_deactivate_endpoint_is_location_cas_and_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account = "acct-deactivate-cas"
    cache_dir = main._cache_dir(account, "feed")
    old = cache_dir / f"{'1' * 32}.csv"
    current = cache_dir / f"{'2' * 32}.csv"
    old.write_text("value\n1\n")
    current.write_text("value\n2\n")
    disguised = cache_dir / f"{'3' * 32}.csv"
    disguised.symlink_to(current)
    datasets.register(account, "feed", str(old), "url", "Feed", "https://example.test/feed", "csv")
    datasets.register(account, "feed", str(current), "url", "Feed", "https://example.test/feed", "csv")

    symlinked = _client().post(
        "/datasets/deactivate",
        json={"account_id": account, "name": "feed", "location": str(disguised)},
    )
    stale = _client().post(
        "/datasets/deactivate",
        json={"account_id": account, "name": "feed", "location": str(old)},
    )
    exact = _client().post(
        "/datasets/deactivate",
        json={"account_id": account, "name": "feed", "location": str(current)},
    )
    repeated = _client().post(
        "/datasets/deactivate",
        json={"account_id": account, "name": "feed", "location": str(current)},
    )

    assert symlinked.status_code == 400
    assert stale.json() == {"status": "unchanged"}
    assert exact.json() == {"status": "dropped"}
    assert repeated.json() == {"status": "unchanged"}


def test_connector_download_is_size_bounded(csv_server, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    monkeypatch.setattr(main, "MAX_CONNECTOR_DOWNLOAD_BYTES", 8)
    _Handler.body = b"value\n12345\n"

    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(
            f"http://127.0.0.1:{csv_server.server_port}/data.csv",
            "acct-size-limit",
            "limited",
            "csv",
        )

    assert error.value.status_code == 413


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/data.csv",
        "http://10.0.0.1/data.csv",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/data.csv",
        "http://[64:ff9b::7f00:1]/data.csv",
        "http://[64:ff9b:1::7f00:1]/data.csv",
        "http://[2002:7f00:1::]/data.csv",
        "http://localhost/data.csv",
        "http://service.local/data.csv",
    ],
)
def test_connector_rejects_private_and_local_targets(url, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    with pytest.raises(main.HTTPException) as error:
        main._download_url(url, "acct-ssrf", "blocked", "csv")

    assert error.value.status_code == 400


def test_connector_rejects_dns_answers_if_any_address_is_not_public(monkeypatch):
    def mixed_answers(*_args, **_kwargs):
        return [
            (main.socket.AF_INET, main.socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
            (main.socket.AF_INET, main.socket.SOCK_STREAM, 6, "", ("192.168.1.10", 80)),
        ]

    monkeypatch.setattr(main.socket, "getaddrinfo", mixed_answers)

    with pytest.raises(main.HTTPException) as error:
        main._resolve_public_addresses("mixed.example", 80, time.monotonic() + 1)

    assert error.value.status_code == 400


@pytest.mark.parametrize("address", ["64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:7f00:1::"])
def test_connector_rejects_ipv4_translation_dns_answers(monkeypatch, address):
    def translated_answer(*_args, **_kwargs):
        return [
            (main.socket.AF_INET6, main.socket.SOCK_STREAM, 6, "", (address, 443, 0, 0)),
        ]

    monkeypatch.setattr(main.socket, "getaddrinfo", translated_answer)

    with pytest.raises(main.HTTPException) as error:
        main._resolve_public_addresses("translated.example", 443, time.monotonic() + 1)

    assert error.value.status_code == 400


def test_connector_version_claim_rejects_manifest_symlink(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    candidate = main._connector_version_path(
        "account-manifest-symlink",
        "ledger",
        "11111111-1111-4111-8111-111111111111",
        "csv",
    )
    outside = tmp_path / "outside.meta"
    outside.write_text("untrusted")
    main._version_manifest_path(candidate).symlink_to(outside)

    with pytest.raises(main.HTTPException) as error:
        main._claim_connector_version(candidate, "https://example.invalid/ledger.csv", "csv")

    assert error.value.status_code == 400
    assert outside.read_text() == "untrusted"


def test_connector_dns_resolution_obeys_total_deadline(monkeypatch):
    release = threading.Event()

    def stalled_resolver(*_args, **_kwargs):
        release.wait(1)
        return []

    monkeypatch.setattr(main.socket, "getaddrinfo", stalled_resolver)
    try:
        with pytest.raises(main.HTTPException) as error:
            main._resolve_public_addresses("slow.example", 80, time.monotonic() + 0.01)
    finally:
        release.set()

    assert error.value.status_code == 504


def test_pinned_socket_connects_to_validated_ip_without_resolving(monkeypatch):
    connected: list[tuple[str, int]] = []

    class FakeSocket:
        def settimeout(self, _timeout):
            pass

        def connect(self, endpoint):
            connected.append(endpoint)

        def close(self):
            pass

    monkeypatch.setattr(main.socket, "socket", lambda _family, _kind: FakeSocket())
    monkeypatch.setattr(
        main.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("pinned connect must not resolve again")),
    )

    main._open_pinned_socket([(main.socket.AF_INET, "203.0.113.8")], 8080, time.monotonic() + 1)

    assert connected == [("203.0.113.8", 8080)]


def test_pinned_connection_timeout_maps_to_gateway_timeout(monkeypatch):
    class TimedOutSocket:
        def settimeout(self, _timeout):
            pass

        def connect(self, _endpoint):
            raise main.socket.timeout("timed out")

        def close(self):
            pass

    monkeypatch.setattr(main.socket, "socket", lambda _family, _kind: TimedOutSocket())

    with pytest.raises(main.HTTPException) as error:
        main._open_pinned_socket([(main.socket.AF_INET, "203.0.113.8")], 80, time.monotonic() + 1)

    assert error.value.status_code == 504


def test_redirect_target_is_revalidated_before_following(csv_server, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    _Handler.redirect_to = "http://169.254.169.254/latest/meta-data/"

    def controlled_resolver(host, _port, _deadline):
        if host == "public.example":
            return [(main.socket.AF_INET, "127.0.0.1")]
        raise main.HTTPException(400, "connector URL must resolve only to public IP addresses")

    monkeypatch.setattr(main, "_resolve_public_addresses", controlled_resolver)

    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(
            f"http://public.example:{csv_server.server_port}/redirect",
            "acct-redirect",
            "redirected",
            "csv",
        )

    assert error.value.status_code == 400
    assert _Handler.get_count == 1


def test_connector_rejects_https_to_http_redirect_downgrade(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    monkeypatch.setattr(
        main,
        "_resolve_public_addresses",
        lambda _host, _port, _deadline: [(main.socket.AF_INET, "203.0.113.10")],
    )

    class RedirectResponse:
        status = 302

        @staticmethod
        def getheader(name, default=None):
            return "http://public.example/data.csv" if name == "Location" else default

    class FakeHTTPSConnection:
        def __init__(self, *_args, **_kwargs):
            pass

        def request(self, *_args, **_kwargs):
            pass

        @staticmethod
        def getresponse():
            return RedirectResponse()

        def close(self):
            pass

    monkeypatch.setattr(main, "_PinnedHTTPSConnection", FakeHTTPSConnection)

    with pytest.raises(main.HTTPException) as error:
        main._download_url("https://public.example/start", "acct-downgrade", "feed", "csv")

    assert error.value.status_code == 400


def test_connector_redirects_are_manually_bounded(csv_server, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    url = f"http://127.0.0.1:{csv_server.server_port}/loop"
    _Handler.redirect_to = url

    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(url, "acct-redirect-limit", "loop", "csv")

    assert error.value.status_code == 502
    assert _Handler.get_count == main.MAX_CONNECTOR_REDIRECTS + 1


@pytest.mark.parametrize(
    ("body", "content_type", "expected_format"),
    [
        (b'[{"value":1}]', "application/json", "csv"),
        (b"value\n1\n", "text/csv", "json"),
    ],
)
def test_connector_enforces_expected_format(
    csv_server,
    tmp_path,
    monkeypatch,
    body,
    content_type,
    expected_format,
):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    _Handler.body = body
    _Handler.content_type = content_type

    with pytest.raises(main.HTTPException) as error:
        main._fetch_url(
            f"http://127.0.0.1:{csv_server.server_port}/data",
            "acct-format",
            "mismatch",
            expected_format,
        )

    assert error.value.status_code == 422


def test_url_registration_requires_expected_format(tmp_path, monkeypatch):
    source = tmp_path / "data.csv"
    source.write_text("value\n1\n")
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)

    response = _client().post(
        "/datasets/register",
        json={
            "account_id": "acct-explicit-format",
            "name": "data",
            "location": str(source),
            "kind": "url",
            "url": "https://example.invalid/data.csv",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "expected_format required for url datasets"


def test_dataset_summary_view_omits_heavy_and_sensitive_metadata(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account, source_id, source = _owned_upload(tmp_path, "summary.csv", "value\n1\n")
    assert (
        _client()
        .post(
            "/datasets/register",
            json={
                "account_id": account,
                "source_id": source_id,
                "name": "summary",
                "location": str(source),
                "kind": "path",
            },
        )
        .status_code
        == 200
    )
    try:
        response = _client().get("/datasets", params={"account_id": account, "view": "summary"})

        assert response.status_code == 200
        assert response.json() == [{"table": "summary", "original_name": "summary.csv", "rows": 1, "exists": True}]
    finally:
        datasets.drop(account, "summary")


def test_dataset_catalog_endpoint_requires_and_returns_exact_scope(tmp_path):
    account = "acct-catalog-endpoint"
    alpha = tmp_path / "alpha.csv"
    secret = tmp_path / "secret.csv"
    alpha.write_text("visible\n1\n")
    secret.write_text("private\n2\n")
    datasets.register(account, "alpha", str(alpha), "path", "Alpha")
    datasets.register(account, "secret", str(secret), "path", "Secret")
    try:
        response = _client().post(
            "/datasets/catalog",
            json={"account_id": account, "allowed_tables": ["alpha"]},
        )
        registry = _client().get("/datasets", params={"account_id": account})
        missing_scope = _client().get(
            "/datasets",
            params={"account_id": account, "view": "detail"},
        )

        assert response.status_code == 200
        assert response.json()["datasets"][0]["table"] == "alpha"
        assert "secret" not in response.text
        assert "preview" not in response.text
        assert registry.status_code == 200
        assert "columns" not in registry.text
        assert "preview" not in registry.text
        assert missing_scope.status_code == 400
    finally:
        datasets.drop(account, "alpha")
        datasets.drop(account, "secret")


def test_storage_configuration_accepts_node_override_with_documented_precedence():
    assert main._configured_storage_dir({"UPLOAD_DIR": "/node/uploads"}) == Path("/node/uploads")
    assert main._configured_storage_dir(
        {
            "BOREALIS_STORAGE_DIR": "/borealis/uploads",
            "UPLOAD_DIR": "/node/uploads",
            "NORTH_STORAGE_DIR": "/legacy/uploads",
        }
    ) == Path("/borealis/uploads")


def test_request_id_grammar_exactly_matches_node_boundary():
    valid = "a" * 128
    accepted = TestClient(
        main.app,
        headers={"Authorization": AUTH_HEADERS["Authorization"], "X-Request-ID": valid},
    ).get("/datasets", params={"account_id": "acct-request-id"})
    rejected = TestClient(
        main.app,
        headers={"Authorization": AUTH_HEADERS["Authorization"], "X-Request-ID": "has:colon"},
    ).get("/datasets", params={"account_id": "acct-request-id"})

    assert accepted.headers["X-Request-ID"] == valid
    assert rejected.headers["X-Request-ID"] != "has:colon"
    assert main.REQUEST_ID_RE.fullmatch(rejected.headers["X-Request-ID"])


def test_extract_endpoint_returns_bounded_registered_rows(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account, source_id, source = _owned_upload(tmp_path, "extract.csv", "x\n1\n2\n3\n")
    registered = _client().post(
        "/datasets/register",
        json={
            "account_id": account,
            "source_id": source_id,
            "name": "extract",
            "location": str(source),
            "kind": "path",
        },
    )
    assert registered.status_code == 200

    try:
        response = _client().post(
            "/datasets/extract",
            json={"account_id": account, "table": "extract", "allowed_tables": ["extract"], "max_rows": 2},
        )
        assert response.status_code == 200
        assert response.json() == {
            "columns": ["x"],
            "rows": [[1], [2]],
            "row_count": 3,
            "total_row_count": 3,
            "returned_row_count": 2,
            "columns_truncated": False,
            "truncated": True,
        }
    finally:
        datasets.drop(account, "extract")


def test_extract_endpoint_caps_large_cells(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "STORAGE_DIR", tmp_path)
    account, source_id, source = _owned_upload(
        tmp_path,
        "large-cell.csv",
        'text\n"' + ("x" * (datasets.MAX_EXTRACT_CELL_CHARS + 100)) + '"\n',
    )
    assert (
        _client()
        .post(
            "/datasets/register",
            json={
                "account_id": account,
                "source_id": source_id,
                "name": "large_cell",
                "location": str(source),
                "kind": "path",
            },
        )
        .status_code
        == 200
    )

    try:
        response = _client().post(
            "/datasets/extract",
            json={"account_id": account, "table": "large_cell", "allowed_tables": ["large_cell"], "max_rows": 1},
        )
        assert response.status_code == 200
        payload = response.json()
        assert payload["truncated"] is True
        assert len(payload["rows"][0][0]) == datasets.MAX_EXTRACT_CELL_CHARS
        assert payload["rows"][0][0].endswith("…")
    finally:
        datasets.drop(account, "large_cell")


def test_raw_html_to_pdf_endpoint_is_removed():
    response = _client().post("/html-to-pdf", params={"html": "<p>unsafe</p>"})

    assert response.status_code == 404
    assert response.json()["detail"] == "resource not found"
    assert response.headers["X-Request-ID"] == "python-test-request"


def test_unversioned_dataset_delete_endpoint_is_removed():
    response = _client().delete("/datasets/ledger", params={"account_id": "account-delete-race"})

    assert response.status_code == 404
    assert response.json()["detail"] == "resource not found"
    assert response.headers["X-Request-ID"] == "python-test-request"
