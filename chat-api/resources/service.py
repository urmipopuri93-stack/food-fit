"""Food-resource search over a pluggable provider.

Facts returned here come only from provider records. Distance is straight-line
(great-circle) distance, never travel distance. Day status is computed only from
parsed weekly schedules and is deliberately conservative.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from .models import ALL_CATEGORIES, CATEGORY_LABELS, FOOD_CATEGORIES, Resource, SourceInfo

log = logging.getLogger("foodfit.resources")

TZ = ZoneInfo("America/Chicago")
DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
EARTH_RADIUS_MI = 3958.7613
MAX_RADIUS_MI = 25.0
STALE_AFTER_DAYS = 90  # partner food banks commonly re-verify pantry info about every 90 days


class ResourceProviderError(Exception):
    code = "resources_unavailable"


class ResourceProvider(Protocol):
    """Implement this for a real data source (e.g. a food-bank or 211 API)."""

    name: str

    def records(self) -> list[Resource]: ...

    def source(self) -> SourceInfo: ...

    def skipped(self) -> int: ...


@dataclass
class SnapshotProvider:
    """Reads a normalized JSON snapshot built by resources/build_snapshot.py.

    Invalid records are skipped (and counted), never repaired or guessed.
    """

    path: Path
    name: str = "snapshot"

    def __post_init__(self) -> None:
        self._records: list[Resource] = []
        self._source = SourceInfo()
        self._skipped = 0
        self._error: str | None = None
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            self._source = SourceInfo.model_validate(raw.get("source") or {})
            seen: set[str] = set()
            for item in raw.get("records", []):
                try:
                    r = Resource.model_validate(item)
                except ValidationError:
                    self._skipped += 1
                    continue
                if r.id in seen:
                    self._skipped += 1
                    continue
                seen.add(r.id)
                self._records.append(r)
            log.info("resource snapshot loaded records=%d skipped=%d", len(self._records), self._skipped)
        except (OSError, ValueError, ValidationError) as exc:
            self._error = type(exc).__name__
            log.warning("resource snapshot unavailable: %s", self._error)

    def records(self) -> list[Resource]:
        if self._error:
            raise ResourceProviderError()
        return self._records

    def source(self) -> SourceInfo:
        return self._source

    def skipped(self) -> int:
        return self._skipped


def haversine_mi(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(a))


def today_local(now: dt.datetime | None = None) -> dt.date:
    return (now or dt.datetime.now(TZ)).astimezone(TZ).date()


def day_status(r: Resource, day: str, on_date: dt.date | None) -> dict:
    """What the *listed* schedule says about a weekday. Never claims a resource is open now."""
    if on_date is not None and on_date.isoformat() in r.closures:
        return {"status": "listed_closed", "detail": f"Listed as closed on {on_date.isoformat()}."}
    if not r.schedule:
        return {"status": "unknown", "detail": "No parseable schedule in the source; " + (r.hours_text or "no hours listed") + "."}
    entries = [e for e in r.schedule if e.day == day]
    if not entries:
        return {"status": "not_listed", "detail": f"No hours listed for {day}."}
    times = "; ".join(f"{e.opens}–{e.closes}" + (f" ({e.note})" if e.note else "") for e in entries)
    if any(e.recurrence_limited for e in entries):
        return {"status": "some_weeks_only", "detail": f"Listed for {day} only on certain weeks: {times}."}
    basis = "" if r.schedule_basis == "program" else " (organization hours; program times may differ)"
    return {"status": "listed", "detail": f"Listed hours on {day}: {times}{basis}."}


def freshness(source: SourceInfo, today: dt.date) -> dict:
    if not source.captured_at:
        return {"captured_at": None, "age_days": None, "stale": None,
                "message": "The date this list was captured is not recorded. Call before visiting."}
    try:
        captured = dt.date.fromisoformat(source.captured_at)
    except ValueError:
        return {"captured_at": source.captured_at, "age_days": None, "stale": None,
                "message": "Capture date is not a valid date. Call before visiting."}
    age = (today - captured).days
    stale = age > STALE_AFTER_DAYS
    msg = f"Captured {captured.isoformat()} ({age} days ago)." + (" This may be out of date." if stale else "")
    return {"captured_at": captured.isoformat(), "age_days": age, "stale": stale, "message": msg + " Call before visiting."}


def missing_fields(r: Resource) -> list[str]:
    checks = {
        "location": r.location, "phone": r.phone, "website": r.website,
        "hours": r.schedule or None, "appointment requirement": r.appointment,
    }
    return [k for k, v in checks.items() if not v]


class ResourceService:
    def __init__(self, provider: ResourceProvider):
        self.provider = provider

    def _source_payload(self, today: dt.date) -> dict:
        s = self.provider.source()
        return {**s.model_dump(), "freshness": freshness(s, today)}

    def meta(self, now: dt.datetime | None = None) -> dict:
        today = today_local(now)
        records = self.provider.records()
        located = [r for r in records if r.location]
        counts = {c: sum(1 for r in records if r.category == c) for c in ALL_CATEGORIES}
        bounds = None
        if located:
            bounds = {
                "south": min(r.location.lat for r in located), "north": max(r.location.lat for r in located),
                "west": min(r.location.lng for r in located), "east": max(r.location.lng for r in located),
            }
        return {
            "provider": self.provider.name,
            "total": len(records),
            "with_coordinates": len(located),
            "skipped_invalid": self.provider.skipped(),
            "categories": [{"id": c, "label": CATEGORY_LABELS[c], "count": counts[c]} for c in ALL_CATEGORIES],
            "coverage_bounds": bounds,
            "source": self._source_payload(today),
            "today": {"date": today.isoformat(), "weekday": DAYS[today.weekday()], "timezone": "America/Chicago"},
        }

    def _coverage_center(self, records: list[Resource]) -> tuple[float, float, float] | None:
        located = [r.location for r in records if r.location]
        if not located:
            return None
        lat = sum(p.lat for p in located) / len(located)
        lng = sum(p.lng for p in located) / len(located)
        reach = max(haversine_mi(lat, lng, p.lat, p.lng) for p in located)
        return lat, lng, reach

    def summarize(self, r: Resource, origin: tuple[float, float] | None, day: str | None, on_date: dt.date | None) -> dict:
        d = None
        if origin and r.location:
            d = round(haversine_mi(origin[0], origin[1], r.location.lat, r.location.lng), 1)
        out = {
            **r.model_dump(mode="json"),
            "category_label": CATEGORY_LABELS[r.category],
            "distance_miles_straight_line": d,
            "missing_fields": missing_fields(r),
        }
        if day:
            out["day_status"] = day_status(r, day, on_date)
        return out

    def locations(self, now: dt.datetime | None = None) -> dict:
        """Map locations of the food listings (used by the browser's service-gap analysis).

        Only records with a geocoded address are listed; the rest are counted, never placed.
        `coverage` is the centre and reach of the listed locations: analysis outside it would
        be measuring the edge of the list, not real service gaps.
        """
        today = today_local(now)
        records = [r for r in self.provider.records() if r.category in FOOD_CATEGORIES]
        located = [r for r in records if r.location]
        cov = self._coverage_center(located)
        return {
            "locations": [{"id": r.id, "name": r.name, "city": r.city, "category": r.category,
                           "category_label": CATEGORY_LABELS[r.category],
                           "lat": r.location.lat, "lng": r.location.lng} for r in located],
            "unlocated_count": len(records) - len(located),
            "coverage": {"lat": round(cov[0], 5), "lng": round(cov[1], 5), "reach_miles": round(cov[2], 2)} if cov else None,
            "source": self._source_payload(today),
            "distance_note": "Distances are straight-line (as the crow flies), not travel distance or time.",
        }

    def known_cities(self) -> list[str]:
        return sorted({r.city for r in self.provider.records() if r.city})

    def search_city(self, city: str, categories: list[str] | None, day: str | None, limit: int,
                    now: dt.datetime | None = None) -> dict:
        """Listings whose address is in `city` (from the source records). No distances: there is no search point."""
        today = today_local(now)
        on_date = None
        if day == "today":
            day, on_date = DAYS[today.weekday()], today
        cats = set(categories or FOOD_CATEGORIES)
        known = self.known_cities()
        match = next((c for c in known if c.lower() == city.strip().lower()), None)
        records = [r for r in self.provider.records() if match and r.city == match and r.category in cats]
        located = sorted((r for r in records if r.location), key=lambda r: r.name)
        if day:
            matching = [r for r in located if day_status(r, day, on_date)["status"] in ("listed", "some_weeks_only")]
            unknown_hours = [r for r in located if day_status(r, day, on_date)["status"] == "unknown"]
        else:
            matching, unknown_hours = located, []
        return {
            "query": {"lat": None, "lng": None, "radius_miles": None, "city": match or city.strip(),
                      "categories": sorted(cats), "day": day, "date": on_date.isoformat() if on_date else None},
            "total_in_radius": len(matching),
            "results": [self.summarize(r, None, day, on_date) for r in matching[:limit]],
            "hours_unknown_in_radius": [self.summarize(r, None, day, on_date) for r in unknown_hours[:limit]],
            "unlocated": [self.summarize(r, None, day, on_date) for r in records if not r.location][:20],
            "out_of_coverage": False,
            "unknown_city": match is None,
            "known_cities": known,
            "distance_note": "No distances: this is a list of listings whose address is in that city.",
            "hours_note": "Hours are as listed in the source and are not live. Call before visiting.",
            "source": self._source_payload(today),
        }

    def search(self, lat: float, lng: float, radius_mi: float, categories: list[str] | None, day: str | None,
               limit: int, now: dt.datetime | None = None) -> dict:
        today = today_local(now)
        on_date = None
        if day == "today":
            day, on_date = DAYS[today.weekday()], today
        cats = set(categories or FOOD_CATEGORIES)
        records = [r for r in self.provider.records() if r.category in cats]
        coverage = self._coverage_center(self.provider.records())
        out_of_coverage = False
        if coverage:
            c_lat, c_lng, reach = coverage
            out_of_coverage = haversine_mi(lat, lng, c_lat, c_lng) > reach + radius_mi
        in_range = []
        for r in records:
            if not r.location:
                continue
            dist = haversine_mi(lat, lng, r.location.lat, r.location.lng)
            if dist <= radius_mi:
                in_range.append((dist, r))
        in_range.sort(key=lambda t: (t[0], t[1].name))
        if day:
            # Day filter keeps resources whose listed hours mention the day, plus unknowns are reported separately.
            matching = [(d, r) for d, r in in_range if day_status(r, day, on_date)["status"] in ("listed", "some_weeks_only")]
            unknown_hours = [r for _, r in in_range if day_status(r, day, on_date)["status"] == "unknown"]
        else:
            matching, unknown_hours = in_range, []
        origin = (lat, lng)
        results = [self.summarize(r, origin, day, on_date) for _, r in matching[:limit]]
        unlocated = [self.summarize(r, None, day, on_date) for r in records if not r.location][:20]
        return {
            "query": {"lat": round(lat, 5), "lng": round(lng, 5), "radius_miles": radius_mi,
                      "categories": sorted(cats), "day": day, "date": on_date.isoformat() if on_date else None},
            "total_in_radius": len(matching),
            "results": results,
            "hours_unknown_in_radius": [self.summarize(r, origin, day, on_date) for r in unknown_hours[:limit]],
            "unlocated": unlocated,
            "out_of_coverage": out_of_coverage,
            "distance_note": "Distances are straight-line (as the crow flies), not driving or walking distance.",
            "hours_note": "Hours are as listed in the source and are not live. Call before visiting.",
            "source": self._source_payload(today),
        }

    def get(self, resource_id: str, now: dt.datetime | None = None) -> dict | None:
        today = today_local(now)
        for r in self.provider.records():
            if r.id == resource_id:
                return {**self.summarize(r, None, DAYS[today.weekday()], today), "source": self._source_payload(today)}
        return None
