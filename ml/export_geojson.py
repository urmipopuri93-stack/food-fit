
from pathlib import Path
import json

import geopandas as gpd
import pandas as pd

BASE = Path(__file__).resolve().parent
ROOT = BASE.parent

SHAPEFILE = BASE / "data" / "raw" / "tl_2019_48_tract.zip"
PREDICTIONS = BASE / "outputs" / "texas_predictions.csv"

OUTPUT = BASE / "outputs" / "texas_heatmap.geojson"
FRONTEND_OUTPUT = (
    ROOT / "frontend" / "public" / "data" / "texas_heatmap.geojson"
)

# ----------------------------------
# 1. LOAD TEXAS GEOGRAPHY
# ----------------------------------

print("Loading Texas census tract boundaries...")

geo = gpd.read_file("zip://" + SHAPEFILE.as_posix())

geo["GEOID"] = geo["GEOID"].astype(str).str.zfill(11)

print("Total geographic tracts:", len(geo))

# ----------------------------------
# 2. LOAD ML PREDICTIONS
# ----------------------------------

print("Loading FoodFit predictions...")

predictions = pd.read_csv(
    PREDICTIONS,
    dtype={"GEOID": str},
)

predictions["GEOID"] = predictions["GEOID"].str.zfill(11)

# Keep only the columns the frontend needs.
columns = [
    "GEOID",
    "County",
    "TotalPop",
    "Urban",
    "poverty_rate",
    "no_vehicle_pct",
    "low_access_pct",
    "income_predicted_pct",
    "transportation_predicted_pct",
    "grocery_predicted_pct",
    "income_observed",
    "transportation_observed",
    "grocery_observed",
    "income_score",
    "transportation_score",
    "grocery_score",
    "overall_need_score",
]

predictions = predictions[columns]

# ----------------------------------
# 3. JOIN SCORES TO MAP POLYGONS
# ----------------------------------

mapped = geo.merge(
    predictions,
    on="GEOID",
    how="inner",
    validate="one_to_one",
)

print("Matched geographic tracts:", len(mapped))

if mapped.empty:
    raise ValueError("No matching tract geometries found.")

# ----------------------------------
# 4. PREPARE MAP GEOMETRY
# ----------------------------------

# Project to meters so simplification is meaningful.
mapped = mapped.to_crs("EPSG:5070")

# Reduce polygon complexity for faster browser rendering.
# Approximately 75-meter simplification tolerance.
mapped["geometry"] = mapped.geometry.simplify(
    tolerance=75,
    preserve_topology=True,
)

# GeoJSON coordinates should use longitude/latitude.
mapped = mapped.to_crs("EPSG:4326")

# Round numerical values for smaller output.
score_cols = [
    "income_score",
    "transportation_score",
    "grocery_score",
    "overall_need_score",
    "income_predicted_pct",
    "transportation_predicted_pct",
    "grocery_predicted_pct",
]

for col in score_cols:
    mapped[col] = mapped[col].round(2)

# Keep only the useful frontend properties.
mapped = mapped[
    columns + ["geometry"]
]

# ----------------------------------
# 5. EXPORT GEOJSON
# ----------------------------------

print("Exporting GeoJSON...")

geojson = json.loads(
    mapped.to_json(
        drop_id=True,
        na="null",
        to_wgs84=True,
    )
)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
FRONTEND_OUTPUT.parent.mkdir(parents=True, exist_ok=True)

compact_json = json.dumps(
    geojson,
    separators=(",", ":"),
    allow_nan=False,
)

OUTPUT.write_text(compact_json, encoding="utf-8")
FRONTEND_OUTPUT.write_text(compact_json, encoding="utf-8")

print("\nGEOJSON EXPORT COMPLETE")
print("----------------------")
print("Features:", len(geojson["features"]))
print("ML output:", OUTPUT)
print("Frontend output:", FRONTEND_OUTPUT)

print("\nReady for React heatmap!")
