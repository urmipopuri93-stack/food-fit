
from pathlib import Path
import json

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import (
    RandomForestRegressor,
    ExtraTreesRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline

BASE = Path(__file__).resolve().parent
DATA = BASE / "data" / "processed" / "texas_with_geo.csv"
MODELS = BASE / "models"
OUTPUTS = BASE / "outputs"

MODELS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

df = pd.read_csv(DATA, dtype={"GEOID": str})
df["GEOID"] = df["GEOID"].str.zfill(11)

# Features must match the ones used in evaluation.
configs = {
    "income": {
        "target": "poverty_rate",
        "features": [
            "Unemployment",
            "Professional",
            "Service",
            "Employed",
            "TotalPop",
            "Urban",
        ],
        "estimator": RandomForestRegressor(
            n_estimators=150,
            min_samples_leaf=5,
            random_state=42,
            n_jobs=-1,
        ),
    },
    "transportation": {
        "target": "no_vehicle_pct",
        "features": [
            "Income",
            "Unemployment",
            "Transit",
            "Walk",
            "WorkAtHome",
            "MeanCommute",
            "Urban",
            "TotalPop",
        ],
        "estimator": RandomForestRegressor(
            n_estimators=150,
            min_samples_leaf=5,
            random_state=42,
            n_jobs=-1,
        ),
    },
    "grocery": {
        "target": "low_access_pct",
        "features": [
            "Income",
            "IncomePerCap",
            "Poverty",
            "ChildPoverty",
            "Unemployment",
            "Urban",
            "TotalPop",
            "MeanCommute",
            "Transit",
            "Walk",
            "Drive",
            "Carpool",
            "WorkAtHome",
            "Professional",
            "Service",
            "area_km2",
            "population_density",
            "center_x",
            "center_y",
        ],
        "estimator": ExtraTreesRegressor(
            n_estimators=300,
            min_samples_leaf=3,
            max_features=0.8,
            random_state=42,
            n_jobs=-1,
        ),
    },
}

# ---------------------------------------
# 1. TRAIN FINAL MODELS
# ---------------------------------------

for name, config in configs.items():
    target = config["target"]
    features = config["features"]

    labeled = df.dropna(subset=[target]).copy()

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("regressor", config["estimator"]),
    ])

    print(f"\nTraining final {name} model...")
    print(f"Labeled tracts: {len(labeled)}")

    pipeline.fit(
        labeled[features],
        labeled[target],
    )

    # Estimate each tract's historical barrier.
    predictions = pipeline.predict(df[features])

    df[f"{name}_predicted_pct"] = np.clip(
        predictions, 0, 100
    )

    # Preserve whether the source target exists.
    df[f"{name}_observed"] = (
        df[target].notna()
    )

    joblib.dump(
        {
            "pipeline": pipeline,
            "features": features,
            "target": target,
        },
        MODELS / f"{name}_final.joblib",
    )

# ---------------------------------------
# 2. CREATE COMPARABLE BARRIER SCORES
# ---------------------------------------

# Rank each model's predictions across Texas.
# High score = higher estimated barrier.
#
# This is relative percentile ranking,
# NOT the literal percentage of people affected.

for name in configs:
    df[f"{name}_score"] = (
        df[f"{name}_predicted_pct"]
        .rank(method="average", pct=True)
        * 100
    ).round(2)

# ---------------------------------------
# 3. OVERALL NEED SCORE
# ---------------------------------------

# Prototype policy weights, not learned weights.
df["overall_need_score"] = (
    0.4 * df["income_score"]
    + 0.3 * df["transportation_score"]
    + 0.3 * df["grocery_score"]
).round(2)

# ---------------------------------------
# 4. EXPORT FOR THE REACT HEATMAP
# ---------------------------------------

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

result = df[columns].copy()

output_path = OUTPUTS / "texas_predictions.csv"

result.to_csv(output_path, index=False)

# Metadata documents what the scores represent.
metadata = {
    "scope": "Texas census tracts",
    "source_years": {
        "census": 2015,
        "food_access_atlas": 2019,
        "tract_boundaries": 2019,
    },
    "score_interpretation":
        "Texas-relative percentile ranks of model-estimated historical barriers",
    "weights": {
        "income": 0.4,
        "transportation": 0.3,
        "grocery": 0.3,
    },
    "warning":
        "Experimental estimates, not current food insecurity measurements or validated allocation recommendations.",
}

with open(
    OUTPUTS / "prediction_metadata.json",
    "w",
    encoding="utf-8",
) as f:
    json.dump(metadata, f, indent=2)

print("\nPREDICTIONS COMPLETE")
print("--------------------")
print("Total tracts:", len(result))

print("\nSample:")
print(
    result[
        [
            "GEOID",
            "income_score",
            "transportation_score",
            "grocery_score",
            "overall_need_score",
        ]
    ].head().to_string(index=False)
)

print(f"\nSaved to: {output_path}")
