import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture()
def dist(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><div id=root>APP</div>")
    (tmp_path / "assets" / "app-123.js").write_text("console.log('x')")
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "x.json").write_text('{"a": ' + "1" * 5000 + "}")
    return tmp_path


@pytest.fixture()
def client(dist, monkeypatch):
    monkeypatch.setenv("FRONTEND_DIST", str(dist))
    with TestClient(main.create_app()) as c:
        yield c


def test_serves_index_and_spa_routes(client):
    for path in ["/", "/heatmap", "/dashboard", "/some/unknown/page"]:
        r = client.get(path)
        assert r.status_code == 200 and "APP" in r.text, path
        assert r.headers["cache-control"] == "no-cache"


def test_serves_hashed_assets_with_long_cache_and_gzip(client):
    r = client.get("/assets/app-123.js")
    assert r.status_code == 200 and "console.log" in r.text
    assert "immutable" in r.headers["cache-control"]
    big = client.get("/data/x.json", headers={"Accept-Encoding": "gzip"})
    assert big.headers.get("content-encoding") == "gzip"


def test_api_routes_still_take_precedence(client):
    assert client.get("/api/health").json()["ok"] is True
    assert client.get("/api/resources/meta").status_code == 200
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


@pytest.mark.parametrize("path", ["/../main.py", "/%2e%2e/main.py", "/..%2f..%2fetc/passwd", "/assets/../../main.py"])
def test_no_path_traversal(client, path):
    r = client.get(path)
    assert "import" not in r.text and "root:" not in r.text
    assert r.status_code in (200, 404)


def test_disabled_by_default():
    with TestClient(main.create_app()) as c:
        assert c.get("/heatmap").status_code == 404


def test_missing_build_fails_fast_with_clear_message(tmp_path, monkeypatch):
    monkeypatch.setenv("FRONTEND_DIST", str(tmp_path / "nope"))
    with pytest.raises(SystemExit, match="npm run build"):
        main.create_app()
