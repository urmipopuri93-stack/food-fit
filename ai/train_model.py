"""Train a candidate demand model on real weekly community records.

Run: python train_model.py historical_demand.csv
"""

import argparse
import csv
from datetime import date
import json
import math
from pathlib import Path


FEATURES = ["population", "low_income_pct", "low_food_access_pct", "no_vehicle_pct"]
TARGET = "meal_kits_requested"


def load_history(path):
    records = []
    seen = set()
    with Path(path).open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        required = {"area_id", "week_start", TARGET, *FEATURES}
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Missing columns: {', '.join(sorted(missing))}")
        for number, row in enumerate(reader, start=2):
            try:
                area = row["area_id"].strip()
                week = date.fromisoformat(row["week_start"])
                values = [float(row[key]) for key in FEATURES]
                target = float(row[TARGET])
                if not area or not all(math.isfinite(v) for v in [*values, target]):
                    raise ValueError("Missing ID or non-finite number")
                if values[0] <= 0 or not values[0].is_integer():
                    raise ValueError("Population must be a positive whole number")
                if any(not 0 <= v <= 100 for v in values[1:]):
                    raise ValueError("Percentages must be from 0 to 100")
                if target < 0 or not target.is_integer():
                    raise ValueError("Requested kits must be a nonnegative whole number")
                if (area, week) in seen:
                    raise ValueError("Duplicate area and week")
                seen.add((area, week))
                records.append({"area": area, "week": week, "features": values, "target": target})
            except (ValueError, TypeError, AttributeError) as error:
                raise ValueError(f"Row {number}: {error}") from None
    if not records:
        raise ValueError("No historical records found. Add real observations first.")
    if len({row["week"].weekday() for row in records}) != 1:
        raise ValueError("All week_start dates must use the same day of the week.")
    return records


def split_history(records):
    weeks = sorted({row["week"] for row in records})
    if len(weeks) < 5:
        raise ValueError("Provide at least five distinct weeks to make a time-based holdout. More history is preferable.")
    # Keep every area from the same week on the same side of the split.
    cutoff = weeks[max(1, int(len(weeks) * 0.8))]
    train = [row for row in records if row["week"] < cutoff]
    test = [row for row in records if row["week"] >= cutoff]
    return train, test, cutoff


def train_candidate(path, output):
    # Validate data before importing the optional training dependencies.
    records = load_history(path)
    train, test, cutoff = split_history(records)
    from sklearn.ensemble import RandomForestRegressor
    from sklearn.metrics import mean_absolute_error
    import joblib

    model = RandomForestRegressor(n_estimators=200, min_samples_leaf=2, random_state=42, n_jobs=-1)
    model.fit([row["features"] for row in train], [row["target"] for row in train])
    actual = [row["target"] for row in test]
    predicted = model.predict([row["features"] for row in test])

    # Baseline: each area's last observed weekly requests, or overall training mean.
    last_by_area = {}
    for row in sorted(train, key=lambda row: row["week"]):
        last_by_area[row["area"]] = row["target"]
    overall_mean = sum(row["target"] for row in train) / len(train)
    baseline = [last_by_area.get(row["area"], overall_mean) for row in test]
    model_error = float(mean_absolute_error(actual, predicted))
    baseline_error = float(mean_absolute_error(actual, baseline))
    report = {
        "target": TARGET,
        "period": "one week",
        "features": FEATURES,
        "training_rows": len(train),
        "test_rows": len(test),
        "test_start": cutoff.isoformat(),
        "model_mae_kits_per_area_week": model_error,
        "last_observed_baseline_mae": baseline_error,
        "beats_baseline": model_error < baseline_error,
        "status": "candidate_requires_explicit_model_mode",
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Save the exact evaluated model; do not silently retrain on the test data.
    joblib.dump({"model": model, "features": FEATURES, "report": report}, output)
    output.with_suffix(".metrics.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("models") / "demand_candidate.joblib")
    args = parser.parse_args()
    try:
        report = train_candidate(args.data, args.output)
    except (ValueError, OSError, ImportError) as error:
        parser.exit(1, f"Training could not run: {error}\n")
    print(json.dumps(report, indent=2))
    print(f"Candidate saved to {args.output}")
    print("MAE is average absolute error in requested kits per area per week; lower is better.")
    print("Review real-data performance before connecting predictions to allocation.")


if __name__ == "__main__":
    main()
