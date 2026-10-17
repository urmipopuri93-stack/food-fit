"""Read the current community snapshot; no training happens here."""

import csv
from math import isfinite
from pathlib import Path

NEED_FACTORS = {
    "low_income_pct": ("Low income", 0.4),
    "low_food_access_pct": ("Limited food access", 0.4),
    "no_vehicle_pct": ("No vehicle", 0.2),
}
DEFAULT_DATA = Path(__file__).with_name("communities.csv")


def load_communities(path=DEFAULT_DATA):
    communities, seen = [], set()
    with Path(path).open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        required = {"area_id", "name", "population", "latitude", "longitude", *NEED_FACTORS}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Missing community columns: {', '.join(sorted(missing))}")
        for number, row in enumerate(reader, start=2):
            try:
                area_id, name = row["area_id"].strip(), row["name"].strip()
                if not area_id or not name or area_id in seen:
                    raise ValueError("Area ID and name are required; area IDs must be unique")
                population = int(row["population"])
                if population <= 0:
                    raise ValueError("Population must be positive")
                community = {"area_id": area_id, "name": name, "population": population}
                bounds = {"latitude": (-90, 90), "longitude": (-180, 180)}
                bounds.update({key: (0, 100) for key in NEED_FACTORS})
                for key, (lower, upper) in bounds.items():
                    value = float(row[key])
                    if not isfinite(value) or not lower <= value <= upper:
                        raise ValueError(f"{key} must be from {lower} to {upper}")
                    community[key] = value
                communities.append(community)
                seen.add(area_id)
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError(f"Community CSV row {number}: {error}") from None
    if not communities:
        raise ValueError("Community CSV is empty.")
    return communities


def score_community(community):
    factors = [
        {"indicator": key, "label": label, "percentage": community[key],
         "weight": weight, "score_points": community[key] * weight}
        for key, (label, weight) in NEED_FACTORS.items()
    ]
    factors.sort(key=lambda factor: factor["score_points"], reverse=True)
    return sum(factor["score_points"] for factor in factors), factors
