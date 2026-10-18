
from pathlib import Path

import geopandas as gpd
import joblib
import numpy as np
import pandas as pd

from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import mean_absolute_error, r2_score

BASE = Path(__file__).resolve().parent
DATA = BASE / "data" / "processed" / "texas_training.csv"
SHAPEFILE = BASE / "data" / "raw" / "tl_2019_48_tract.zip"
MODELS = BASE / "models"
OUTPUTS = BASE / "outputs"

MODELS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

# --------------------------------
# 1. LOAD TRAINING DATA
# --------------------------------

df = pd.read_csv(DATA, dtype={"GEOID": str})
df["GEOID"] = df["GEOID"].str.zfill(11)

print("Loading Texas tract geography...")

geo = gpd.read_file("zip://" + SHAPEFILE.as_posix())
geo["GEOID"] = geo["GEOID"].astype(str).str.zfill(11)

# Use a projected coordinate system with meter units.
geo = geo.to_crs("EPSG:5070")

geo["area_km2"] = geo.geometry.area / 1_000_000

# Projected centroid coordinates act as spatial features.
centroids = geo.geometry.centroid
geo["center_x"] = centroids.x
geo["center_y"] = centroids.y

geo = geo[
    ["GEOID", "area_km2", "center_x", "center_y"]
].drop_duplicates(subset=["GEOID"])

df = df.merge(
    geo,
    on="GEOID",
    how="left",
    validate="one_to_one",
)

df["population_density"] = np.where(
    df["area_km2"] > 0,
    df["TotalPop"] / df["area_km2"],
    np.nan,
)

df["county_fips"] = df["GEOID"].str[:5]

print("Rows:", len(df))
print("Tracts with geometry:", df["area_km2"].notna().sum())

# --------------------------------
# 2. FEATURES
# --------------------------------

original_features = [
    "Income",
    "Unemployment",
    "Urban",
    "TotalPop",
    "MeanCommute",
    "Transit",
    "Walk",
]

enhanced_features = [
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
]

# Do NOT use LAPOP1_10 or any grocery-access
# measures as predictors of low_access_pct.
# That would leak the target.

target = "low_access_pct"
subset = df.dropna(subset=[target]).copy()

groups = subset["county_fips"]

splitter = GroupShuffleSplit(
    n_splits=1,
    test_size=0.2,
    random_state=42,
)

train_idx, test_idx = next(
    splitter.split(subset, groups=groups)
)

train = subset.iloc[train_idx]
test = subset.iloc[test_idx]

print("Training rows:", len(train))
print("Testing rows:", len(test))

# --------------------------------
# 3. COMPARE MODELS
# --------------------------------

candidates = {
    "original_random_forest": (
        original_features,
        RandomForestRegressor(
            n_estimators=150,
            min_samples_leaf=5,
            random_state=42,
            n_jobs=-1,
        ),
    ),
    "enhanced_random_forest": (
        enhanced_features,
        RandomForestRegressor(
            n_estimators=300,
            min_samples_leaf=3,
            max_features=0.8,
            random_state=42,
            n_jobs=-1,
        ),
    ),
    "enhanced_extra_trees": (
        enhanced_features,
        ExtraTreesRegressor(
            n_estimators=300,
            min_samples_leaf=3,
            max_features=0.8,
            random_state=42,
            n_jobs=-1,
        ),
    ),
}

results = []
trained = {}

for name, (features, estimator) in candidates.items():

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("regressor", estimator),
    ])

    pipeline.fit(
        train[features],
        train[target],
    )

    predictions = np.clip(
        pipeline.predict(test[features]),
        0,
        100,
    )

    mae = mean_absolute_error(test[target], predictions)
    r2 = r2_score(test[target], predictions)

    results.append({
        "model": name,
        "mae": mae,
        "r2": r2,
    })

    trained[name] = (pipeline, features)

    print(f"\n{name}")
    print(f"MAE: {mae:.3f}")
    print(f"R2: {r2:.3f}")

# --------------------------------
# 4. SAVE EVALUATION RESULTS
# --------------------------------

results_df = pd.DataFrame(results)
results_df = results_df.sort_values("mae")

results_df.to_csv(
    OUTPUTS / "grocery_comparison.csv",
    index=False,
)

best_name = results_df.iloc[0]["model"]
best_mae = results_df.iloc[0]["mae"]

print("\nBEST CANDIDATE:", best_name)
print(f"BEST MAE: {best_mae:.3f}")

# Save best pipeline with its feature list.
# This model is fitted on training counties only.
best_pipeline, best_features = trained[best_name]

joblib.dump(
    {
        "pipeline": best_pipeline,
        "features": best_features,
    },
    MODELS / "grocery_best_evaluation.joblib",
)

# Preserve the new geographic features for later
# statewide prediction and GeoJSON export.
df.to_csv(
    BASE / "data" / "processed" / "texas_with_geo.csv",
    index=False,
)

print("\nSaved comparison and geographic training data.")
