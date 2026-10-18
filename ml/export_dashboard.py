
from pathlib import Path
import json
import pandas as pd

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent

INPUT = BASE / "outputs" / "texas_predictions.csv"

OUTPUT = (
    ROOT
    / "frontend"
    / "public"
    / "data"
    / "texas_dashboard.json"
)

df = pd.read_csv(INPUT, dtype={"GEOID": str})

# Filter out invalid records.
df = df[
    (df["TotalPop"] > 0)
    & df["overall_need_score"].notna()
].copy()

# High score = higher relative estimated barrier.
df = df.sort_values(
    "overall_need_score",
    ascending=False,
)

# Explicitly identify census tracts.
# County name alone is not a unique location.
df["location"] = (
    df["County"].astype(str)
    + " County · Tract "
    + df["GEOID"].str[-6:]
)

columns = [
    "GEOID",
    "County",
    "location",
    "TotalPop",
    "income_score",
    "transportation_score",
    "grocery_score",
    "overall_need_score",
    "grocery_observed",
]

records = df[columns].to_dict(orient="records")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)

OUTPUT.write_text(
    json.dumps(records, indent=2, allow_nan=False),
    encoding="utf-8",
)

print("Dashboard dataset exported!")
print("Total available tracts:", len(records))
print("Saved to:", OUTPUT)
print("\nTop 3 tracts:")
print(
    df[
        ["location", "overall_need_score", "TotalPop"]
    ].head(3).to_string(index=False)
)