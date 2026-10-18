import csv
import datetime as dt
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from resources.build_snapshot import SRC, parse_closures, parse_schedule
from resources.models import Resource
from resources.service import (DAYS, ResourceService, SnapshotProvider, day_status, freshness, haversine_mi,
                               today_local)
from resources.models import SourceInfo

SNAP = Path(__file__).parent / "resources" / "data" / "locationlist_snapshot.json"
RICHARDSON = (32.95, -96.73)
CHICAGO_SAT = dt.datetime(2026, 10, 18, 3, 0, tzinfo=dt.timezone.utc)  # = Sat 17 Oct 2026, 22:00 in Chicago


@pytest.fixture(scope="module")
def service():
    return ResourceService(SnapshotProvider(SNAP))


def write_snapshot(tmp_path, records, source=None):
    p = tmp_path / "snap.json"
    p.write_text(json.dumps({"source": source or {}, "records": records}))
    return p


# SYNTHETIC test record (not a real resource)
BASE = {
    "id": "test-pantry--food", "name": "TEST Synthetic Pantry", "program": "Food Pantry", "category": "food_distribution",
    "address": "1 Test St, Richardson, TX 75080", "location": {"lat": 32.95, "lng": -96.73, "geocoder": "test"},
}


# ---------- source integrity: nothing invented ----------

def test_snapshot_values_come_from_the_source_file():
    rows = list(csv.DictReader(SRC.open(encoding="utf-8-sig")))
    snap = json.loads(SNAP.read_text())
    assert len(snap["records"]) == len(rows) == 34
    for rec, row in zip(snap["records"], rows):
        assert rec["name"] == row["Organization"].strip()
        assert rec["address"] == row["Address"].strip()
        source_digits = re.sub(r"\D", "", row["Program Phone"] + row["Organization Phone"])
        if rec["phone"]:
            assert rec["phone"].replace("-", "") in source_digits
        if rec["website"]:
            assert re.sub(r"^https://", "", rec["website"]).lower() in row["Website"].lower()
        for e in rec["schedule"]:
            assert e["day"] in row["Program Hours"] + row["General Hours"]
        if rec["location"] is None:
            continue
        assert rec["location"]["geocoder"].startswith("US Census Geocoder")


def test_snapshot_drops_personal_contact_details():
    text = SNAP.read_text().lower()
    for personal in ["tracy parlin", "jason grisham", "zoya jackson", "misty.dodge", "gmail.com", "andrew adeniji"]:
        assert personal not in text
    minnies = [r for r in json.loads(SNAP.read_text())["records"] if r["id"].startswith("minnies-food-pantry--food")][0]
    assert minnies["email"] is None and "may be a typo" in minnies["notes"][0]


def test_unmatched_addresses_have_no_coordinates():
    snap = json.loads(SNAP.read_text())
    geo = {r["status"] for r in csv.DictReader((SRC.parent / "geocode_census.csv").open())}
    assert geo == {"matched", "unmatched"}
    fb = [r for r in snap["records"] if r["name"] == "First Baptist Richardson"][0]
    assert fb["location"] is None


def test_snap_help_does_not_inherit_organization_hours():
    snap = json.loads(SNAP.read_text())
    ncm = [r for r in snap["records"] if r["id"] == "network-of-community-ministries--snap-application-assistance"][0]
    assert ncm["schedule"] == [] and ncm["hours_text"] == "Call for Information"


# ---------- parsing ----------

def test_parse_schedule_keeps_qualifiers():
    s = parse_schedule("Monday 10:00 AM - 1:00 PM (Appointments prioritized) | (1st, 3rd Week of Month) | Tuesday 9:00 AM - 1:00 PM")
    assert [(e["day"], e["opens"], e["closes"], e["recurrence_limited"]) for e in s] == [
        ("Monday", "10:00", "13:00", True), ("Tuesday", "09:00", "13:00", False)]
    assert "1st, 3rd Week of Month" in s[0]["note"]
    assert parse_schedule("Call for Hours") == []
    assert parse_schedule("") == []


def test_parse_closures():
    assert parse_closures("Nov 26, 2026     CLOSED | Dec 25, 2026 CLOSED", "Nov 26, 2026 CLOSED") == ["2026-11-26", "2026-12-25"]


# ---------- validation of incoming records ----------

@pytest.mark.parametrize("bad", [
    {**BASE, "location": {"lat": 200, "lng": 0, "geocoder": "x"}},
    {**BASE, "phone": "12345"},
    {**BASE, "name": ""},
    {**BASE, "category": "groceries"},
    {**BASE, "id": "Bad ID!"},
    {**BASE, "website": "javascript:alert(1)"},
    {**BASE, "schedule": [{"day": "Funday", "opens": "09:00", "closes": "10:00"}]},
    {**BASE, "extra_field": 1},
])
def test_invalid_records_are_skipped_not_repaired(tmp_path, bad):
    p = write_snapshot(tmp_path, [BASE, bad])
    prov = SnapshotProvider(p)
    assert [r.id for r in prov.records()] == ["test-pantry--food"]
    assert prov.skipped() == 1


def test_duplicate_ids_skipped(tmp_path):
    prov = SnapshotProvider(write_snapshot(tmp_path, [BASE, BASE]))
    assert len(prov.records()) == 1 and prov.skipped() == 1


# ---------- distance & search ----------

def test_haversine():
    assert haversine_mi(32.0, -96.0, 33.0, -96.0) == pytest.approx(69.09, abs=0.05)
    assert haversine_mi(32.95, -96.73, 32.95, -96.73) == 0


def test_search_is_sorted_within_radius_and_labels_straight_line(service):
    r = service.search(*RICHARDSON, 3, None, None, 25)
    d = [x["distance_miles_straight_line"] for x in r["results"]]
    assert d and d == sorted(d) and all(v <= 3 for v in d)
    assert "straight-line" in r["distance_note"]
    for x in r["results"]:
        manual = haversine_mi(*RICHARDSON, x["location"]["lat"], x["location"]["lng"])
        assert x["distance_miles_straight_line"] == round(manual, 1)


def test_default_categories_exclude_non_food(service):
    r = service.search(33.02, -96.75, 25, None, None, 25)
    assert all(x["category"] != "other_services" for x in r["results"])
    other = service.search(33.02, -96.75, 25, ["other_services"], None, 25)
    assert other["results"] and all(x["category"] == "other_services" for x in other["results"])


def test_unlocated_records_reported_separately_never_with_distance(service):
    r = service.search(*RICHARDSON, 25, None, None, 25)
    assert r["unlocated"]
    assert all(x["location"] is None and x["distance_miles_straight_line"] is None for x in r["unlocated"])
    assert all(x["location"] for x in r["results"])


def test_out_of_coverage(service):
    r = service.search(29.76, -95.37, 10, None, None, 10)  # Houston
    assert r["out_of_coverage"] is True and r["results"] == []
    assert service.search(*RICHARDSON, 5, None, None, 10)["out_of_coverage"] is False


def test_empty_results_inside_coverage(service):
    r = service.search(32.95, -96.73, 0.05, None, None, 10)
    assert r["results"] == [] and r["out_of_coverage"] is False


def test_limit(service):
    assert len(service.search(*RICHARDSON, 25, None, None, 2)["results"]) == 2


# ---------- hours: conservative, never "open now" ----------

def res(**kw):
    return Resource.model_validate({**BASE, **kw})


def test_day_status_variants():
    r = res(schedule=[{"day": "Tuesday", "opens": "08:00", "closes": "12:00"},
                      {"day": "Monday", "opens": "10:00", "closes": "13:00", "note": "1st, 3rd Week of Month", "recurrence_limited": True}],
            schedule_basis="program", closures=["2026-10-20"])
    assert day_status(r, "Tuesday", None)["status"] == "listed"
    assert day_status(r, "Monday", None)["status"] == "some_weeks_only"
    assert day_status(r, "Friday", None)["status"] == "not_listed"
    assert day_status(r, "Tuesday", dt.date(2026, 10, 20))["status"] == "listed_closed"
    assert day_status(res(hours_text="Call for Hours"), "Tuesday", None)["status"] == "unknown"
    for d in DAYS:
        assert "open now" not in day_status(r, d, None)["detail"].lower()


def test_today_uses_america_chicago(service):
    assert today_local(CHICAGO_SAT) == dt.date(2026, 10, 17)
    r = service.search(33.02, -96.75, 25, None, "today", 25, now=CHICAGO_SAT)
    assert r["query"]["day"] == "Saturday" and r["query"]["date"] == "2026-10-17"
    assert all(x["day_status"]["status"] in ("listed", "some_weeks_only") for x in r["results"])


def test_listed_closure_excludes_resource_on_that_date(service):
    thanksgiving = dt.datetime(2026, 11, 26, 18, 0, tzinfo=dt.timezone.utc)  # Thursday in Chicago
    r = service.search(33.02, -96.70, 10, ["food_distribution"], "today", 25, now=thanksgiving)
    assert all(x["name"] != "SALVATION ARMY PLANO CORPS" for x in r["results"])
    normal_thu = dt.datetime(2026, 11, 19, 18, 0, tzinfo=dt.timezone.utc)
    r2 = service.search(33.02, -96.70, 10, ["food_distribution"], "today", 25, now=normal_thu)
    assert any(x["name"] == "SALVATION ARMY PLANO CORPS" for x in r2["results"])


@pytest.mark.parametrize("captured,stale", [(None, None), ("2026-01-01", True), ("2026-10-01", False), ("not-a-date", None)])
def test_freshness(captured, stale):
    f = freshness(SourceInfo(captured_at=captured), dt.date(2026, 10, 18))
    assert f["stale"] is stale
    assert "Call before visiting" in f["message"]


# ---------- HTTP API ----------

@pytest.fixture()
def client():
    with TestClient(main.create_app()) as c:
        yield c


def test_api_search_and_get(client):
    r = client.get("/api/resources/search", params={"lat": 32.95, "lng": -96.73, "radius_miles": 3})
    assert r.status_code == 200
    first = r.json()["results"][0]
    d = client.get(f"/api/resources/{first['id']}")
    assert d.status_code == 200 and d.json()["name"] == first["name"]
    assert d.json()["source"]["freshness"]["captured_at"] is None


def test_api_meta(client):
    m = client.get("/api/resources/meta").json()
    assert m["total"] == 34 and m["with_coordinates"] == 24 and m["skipped_invalid"] == 0
    assert {c["id"] for c in m["categories"]} == {"food_distribution", "snap_application_help", "senior_food_box", "other_services"}


@pytest.mark.parametrize("params", [
    {"lat": "abc", "lng": -96},
    {"lat": 33, "lng": -96, "radius_miles": 0},
    {"lat": 33, "lng": -96, "radius_miles": 26},
    {"lat": 33, "lng": -96, "radius_miles": "nan"},
    {"lat": 95, "lng": -96},
    {"lat": 33, "lng": -96, "category": "groceries"},
    {"lat": 33, "lng": -96, "day": "Funday"},
    {"lat": 33, "lng": -96, "limit": 500},
    {"lng": -96},
])
def test_api_rejects_invalid_search(client, params):
    r = client.get("/api/resources/search", params=params)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "invalid_request"
    assert "groceries" not in r.text and "Funday" not in r.text


def test_api_not_found_and_bad_id(client):
    assert client.get("/api/resources/made-up-pantry").status_code == 404
    assert client.get("/api/resources/BAD_ID!!").status_code == 422


def test_api_unavailable_data_source(tmp_path):
    svc = ResourceService(SnapshotProvider(tmp_path / "missing.json"))
    with TestClient(main.create_app(resources=svc)) as c:
        for url in ["/api/resources/meta", "/api/resources/search?lat=33&lng=-96", "/api/resources/abc-def"]:
            r = c.get(url)
            assert r.status_code == 503 and r.json()["error"]["code"] == "resources_unavailable"
            assert "missing.json" not in r.text and "Traceback" not in r.text


def test_api_rate_limit(monkeypatch):
    monkeypatch.setenv("RESOURCE_RATE_LIMIT_PER_MIN", "3")
    with TestClient(main.create_app()) as c:
        codes = [c.get("/api/resources/meta").status_code for _ in range(5)]
    assert codes == [200, 200, 200, 429, 429]
