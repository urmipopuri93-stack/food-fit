"""Build the normalized food-resource snapshot from the agency list.

Input  : data/resources/source/LocationListInfo.csv   (34 program rows, 20 organizations)
         data/resources/source/geocode_census.csv     (US Census Geocoder results per address)
Output : chat-api/resources/data/locationlist_snapshot.json

Rules (nothing is invented):
- Every field comes from the source row or the geocoder result; missing stays null.
- Addresses the Census Geocoder could not match get no coordinates (no guessing).
- Hours are kept verbatim; a weekly schedule is parsed only from "Day h:mm AM - h:mm PM" entries,
  and any qualifier text ("1st, 3rd Week of Month", "until all food has been distributed") is kept with it.
- Personal names and personal email addresses are dropped; organisation phones, websites and
  generic mailboxes are kept.

Usage:
  python -m resources.build_snapshot [--captured-at YYYY-MM-DD] [--publisher "North Texas Food Bank"]
  python -m resources.build_snapshot --geocode   # re-run the Census batch geocoder (needs internet)
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "data" / "resources" / "source" / "LocationListInfo.csv"
GEO = ROOT / "data" / "resources" / "source" / "geocode_census.csv"
OUT = Path(__file__).resolve().parent / "data" / "locationlist_snapshot.json"

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
ENTRY = re.compile(
    r"(?P<day>" + "|".join(DAYS) + r")\s+(?P<open>\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(?P<close>\d{1,2}:\d{2}\s*[AP]M)",
    re.I,
)
LIMITED = re.compile(r"\b(1st|2nd|3rd|4th|5th|first \d|every other|week of (the )?month)\b", re.I)
CLOSURE = re.compile(r"([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s+CLOSED")
GENERIC_MAILBOX = {"info", "support", "foodpantry", "snap", "csfpteam", "contact", "office", "help"}
ORG_CONTACT = re.compile(r"(center|team|bank|charities|ministr|association|church|services)", re.I)

CATEGORY_MAP = {
    "Food Distribution": "food_distribution",
    "Public Benefits Assistance": "snap_application_help",
    "CSFP Senior Nutrition": "senior_food_box",
}


def norm_addr(a: str) -> str:
    return " ".join(a.replace(",", " ").split())


def to24(t: str) -> str:
    return dt.datetime.strptime(re.sub(r"\s+", " ", t.strip().upper()), "%I:%M %p").strftime("%H:%M")


def clean(s: str | None) -> str | None:
    s = " ".join((s or "").replace(" | ", " ").split())
    return s or None


def parse_schedule(text: str) -> list[dict]:
    """Parse 'Day h:mm AM - h:mm PM (qualifier)' entries. Returns [] if nothing parseable."""
    matches = list(ENTRY.finditer(text or ""))
    out = []
    for i, m in enumerate(matches):
        tail_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        tail = text[m.end():tail_end]
        note = clean(re.sub(r"[()]", " ", tail).replace("|", " "))
        out.append({
            "day": m.group("day").capitalize(),
            "opens": to24(m.group("open")),
            "closes": to24(m.group("close")),
            "note": note,
            "recurrence_limited": bool(note and LIMITED.search(note)),
        })
    return out


def parse_closures(*texts: str) -> list[str]:
    dates = set()
    for t in texts:
        for mon, day, year in CLOSURE.findall(t or ""):
            dates.add(dt.datetime.strptime(f"{mon} {day} {year}", "%b %d %Y").date().isoformat())
    return sorted(dates)


def phone(s: str) -> str | None:
    digits = re.sub(r"\D", "", s or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return f"{digits[:3]}-{digits[3:6]}-{digits[6:]}" if len(digits) == 10 else None


def website(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    if not re.match(r"^https?://", s, re.I):
        s = "https://" + s
    return s if re.match(r"^https?://[a-z0-9.-]+\.[a-z]{2,}(/[^\s]*)?$", s, re.I) else None


def generic_email(*candidates: str) -> str | None:
    for e in candidates:
        e = (e or "").strip().lower()
        m = re.match(r"^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$", e)
        if m and m.group(1) in GENERIC_MAILBOX and m.group(2) not in {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com"}:
            return e
    return None


def appointment(entries: list[dict], text: str) -> str | None:
    t = text.lower()
    if "walk-ins are" in t and "welcome" in t:
        return "prioritized_walk_ins_welcome"
    notes = [(e["note"] or "").lower() for e in entries]
    if entries and all(("appointment required" in n or "by appointment only" in n) for n in notes):
        return "required"
    return None


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def split_address(a: str) -> tuple[str | None, str | None]:
    """City = the word directly before ', TX' (all cities in this list are one word)."""
    m = re.search(r"([A-Za-z]+),\s*TX\s+(\d{5})", a, re.I)
    return (m.group(1).title(), m.group(2)) if m else (None, None)


def build(captured_at: str | None, publisher: str | None) -> dict:
    geo = {norm_addr(r["input_address"]): r for r in csv.DictReader(GEO.open(encoding="utf-8"))}
    rows = list(csv.DictReader(SRC.open(encoding="utf-8-sig")))
    records, skipped, seen = [], [], set()
    for i, r in enumerate(rows):
        name, program, address = (r.get("Organization") or "").strip(), (r.get("Program") or "").strip(), (r.get("Address") or "").strip()
        if not name or not address:
            skipped.append({"row": i + 2, "reason": "missing organization name or address"})
            continue
        raw_cat = (r.get("Category") or "").strip()
        category = CATEGORY_MAP.get(raw_cat)
        if category is None:
            category = "food_distribution" if re.search(r"food|pantry", program, re.I) and not raw_cat else "other_services"

        program_hours = r.get("Program Hours") or ""
        general_hours = r.get("General Hours") or ""
        prog_sched, gen_sched = parse_schedule(program_hours), parse_schedule(general_hours)
        if prog_sched:
            schedule, schedule_basis = prog_sched, "program"
        elif gen_sched and not clean(program_hours) and "office hours" not in general_hours.lower():
            # Fall back to organization hours only when the program lists no hours at all.
            schedule, schedule_basis = gen_sched, "organization"
        else:
            schedule, schedule_basis = [], None
        hours_notes = []
        if prog_sched and gen_sched and "office hours" not in general_hours.lower():
            if [(e["day"], e["opens"], e["closes"]) for e in prog_sched] != [(e["day"], e["opens"], e["closes"]) for e in gen_sched]:
                hours_notes.append("The organization's general hours differ from this program's hours: " + clean(general_hours))
        if not schedule and clean(program_hours):
            hours_notes.append(clean(program_hours))  # e.g. "Call for Hours"
        if "office hours" in general_hours.lower() or (gen_sched and not schedule):
            hours_notes.append("Organization hours (not this program's service times): " + clean(general_hours))

        g = geo.get(norm_addr(address))
        location = None
        if g and g["status"] == "matched":
            location = {
                "lat": float(g["latitude"]),
                "lng": float(g["longitude"]),
                "matched_address": g["matched_address"],
                "geocoder": "US Census Geocoder (Public_AR_Current)",
                "note": g["note"] or None,
            }
        city, zip_code = split_address(address)
        contact = (r.get("Program Contact") or "").strip()
        site = website(r.get("Website"))
        email = generic_email(r.get("Program Email"), r.get("Organization Email"))
        record_notes = []
        if email and site:
            e_dom = email.split("@")[1]
            w_dom = re.sub(r"^https?://(www\.)?", "", site).split("/")[0]
            if e_dom != w_dom and e_dom[:6] == w_dom[:6]:
                record_notes.append(f"The listed email domain ({e_dom}) does not match the website ({w_dom}) and may be a typo in the source; it is not shown.")
                email = None
        rid = f"{slug(name)}--{slug(program)}"
        if rid in seen:
            rid = f"{rid}-{i}"
        seen.add(rid)
        records.append({
            "id": rid,
            "name": name,
            "program": program or None,
            "category": category,
            "source_category": raw_cat or None,
            "address": address,
            "city": city,
            "zip": zip_code,
            "location": location,
            "phone": phone(r.get("Program Phone")) or phone(r.get("Organization Phone")),
            "phone_label": contact if contact and ORG_CONTACT.search(contact) else None,
            "website": site,
            "email": email,
            "hours_text": clean(program_hours) or clean(general_hours),
            "schedule": schedule,
            "schedule_basis": schedule_basis,
            "hours_notes": hours_notes,
            "closures": parse_closures(r.get("Organization Special Hours"), r.get("Program Special Hours")),
            "appointment": appointment(schedule, program_hours + " " + general_hours),
            "notes": record_notes,
        })

    first = rows[0] if rows else {}
    return {
        "dataset": "locationlist",
        "source": {
            "file": (first.get("Source") or "").strip() or None,
            "search_area": " ".join(filter(None, [(first.get("Search Radius") or "").strip(), "around", (first.get("Search Center") or "").strip()])) or None,
            "publisher": publisher,
            "captured_at": captured_at,
            "added_to_repository": "2026-10-17 (branch manila/data, commit 5c072ba)",
        },
        "geocoding": {"service": "US Census Geocoder, benchmark Public_AR_Current", "run_on": "2026-10-18"},
        "built_at": dt.date.today().isoformat(),
        "records": records,
        "skipped": skipped,
    }


def run_batch_geocode() -> None:  # pragma: no cover - needs internet
    import httpx

    rows = list(csv.DictReader(SRC.open(encoding="utf-8-sig")))
    uniq = sorted({r["Address"] for r in rows})
    buf = io.StringIO()
    w = csv.writer(buf)
    for i, a in enumerate(uniq):
        street = re.sub(r"\b(ste|suite|#)\s*\S+|\bEl Paso Hall, Room \S+", "", a, flags=re.I).split(",")[0]
        city, z = split_address(a)
        w.writerow([i, street.strip(), city or "", "TX", z or ""])
    resp = httpx.post(
        "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
        data={"benchmark": "Public_AR_Current"},
        files={"addressFile": ("a.csv", buf.getvalue(), "text/csv")},
        timeout=120,
    )
    resp.raise_for_status()
    out = {int(r[0]): r for r in csv.reader(io.StringIO(resp.text))}
    with GEO.open("w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["input_address", "status", "matched_address", "latitude", "longitude", "note"])
        for i, a in enumerate(uniq):
            r = out.get(i, [])
            if len(r) >= 6 and r[2] == "Match":
                lng, lat = r[5].split(",")
                wr.writerow([norm_addr(a), "matched", r[4], lat, lng, "" if r[3] == "Exact" else "non-exact match - review"])
            else:
                wr.writerow([norm_addr(a), "unmatched", "", "", "", "no Census match"])


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--captured-at", help="Date the source list was exported (YYYY-MM-DD)")
    p.add_argument("--publisher", help="Organization that published the source list")
    p.add_argument("--geocode", action="store_true", help="Re-geocode addresses with the Census batch API first")
    a = p.parse_args()
    if a.captured_at:
        dt.date.fromisoformat(a.captured_at)
    if a.geocode:
        run_batch_geocode()
    snapshot = build(a.captured_at, a.publisher)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    located = sum(1 for r in snapshot["records"] if r["location"])
    print(f"wrote {OUT} — {len(snapshot['records'])} records, {located} with coordinates, {len(snapshot['skipped'])} skipped")


if __name__ == "__main__":
    main()
