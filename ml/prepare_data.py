
from pathlib import Path
import numpy as np
import pandas as pd

BASE = Path(__file__).resolve().parent
RAW = BASE / "data" / "raw"
PROCESSED = BASE / "data" / "processed"

PROCESSED.mkdir(parents=True, exist_ok=True)

print("Loading Census dataset...")

census = pd.read_csv(
    RAW / "acs2015_census_tract_data.csv",
    dtype={"CensusTract": str},
    low_memory=False,
)

print("Loading USDA dataset...")

usda = pd.read_csv(
    RAW / "Food Access Research Atlas.csv",
    dtype={"CensusTract": str},
    low_memory=False,
)

# ----------------------------------
# 1. STANDARDIZE GEOGRAPHIC IDS
# ----------------------------------

for df in (census, usda):
    df["GEOID"] = (
        df["CensusTract"]
        .astype("string")
        .str.strip()
        .str.replace(r"\.0$", "", regex=True)
        .str.zfill(11)
    )

# ----------------------------------
# 2. FILTER TO TEXAS
# ----------------------------------

census = census[
    census["GEOID"].str.startswith("48", na=False)
].copy()

usda = usda[
    usda["GEOID"].str.startswith("48", na=False)
].copy()

print(f"Texas Census records: {len(census)}")
print(f"Texas USDA records: {len(usda)}")

# ----------------------------------
# 3. PREVENT DUPLICATE MATCHES
# ----------------------------------

for name, df in (("Census", census), ("USDA", usda)):
    duplicates = df["GEOID"].duplicated().sum()
    if duplicates:
        raise ValueError(
            f"{name} contains {duplicates} duplicate GEOIDs."
        )

# ----------------------------------
# 4. SELECT COLUMNS
# ----------------------------------

census_columns = [
    "GEOID",
    "County",
    "TotalPop",
    "Income",
    "IncomePerCap",
    "Poverty",
    "ChildPoverty",
    "Unemployment",
    "Professional",
    "Service",
    "Office",
    "Construction",
    "Production",
    "Drive",
    "Carpool",
    "Transit",
    "Walk",
    "OtherTransp",
    "WorkAtHome",
    "MeanCommute",
    "Employed",
    "PrivateWork",
    "PublicWork",
    "SelfEmployed",
]

usda_columns = [
    "GEOID",
    "Urban",
    "Pop2010",
    "OHU2010",
    "TractHUNV",
    "LAPOP1_10",
]

census = census[census_columns]
usda = usda[usda_columns]

# ----------------------------------
# 5. MERGE BY CENSUS TRACT
# ----------------------------------

merged = census.merge(
    usda,
    on="GEOID",
    how="inner",
    validate="one_to_one",
)

print(f"Matched Texas tracts: {len(merged)}")

if merged.empty:
    raise ValueError("No matching census tracts were found.")

print(
    "Unmatched Census tracts:",
    len(census) - len(merged),
)

print(
    "Unmatched USDA tracts:",
    len(usda) - len(merged),
)

# ----------------------------------
# 6. CONVERT DATA TO NUMERIC
# ----------------------------------

numeric_cols = [
    col for col in merged.columns
    if col not in ("GEOID", "County")
]

for col in numeric_cols:
    merged[col] = pd.to_numeric(
        merged[col],
        errors="coerce",
    )

# ----------------------------------
# 7. CREATE MODEL TARGETS
# ----------------------------------

# Model 1: economic disadvantage
# Census Poverty is already a percentage.

merged["poverty_rate"] = merged["Poverty"]

# Model 2: households without vehicles
# Percentage = no-vehicle households / occupied units.

merged["no_vehicle_pct"] = np.where(
    merged["OHU2010"] > 0,
    100 * merged["TractHUNV"] / merged["OHU2010"],
    np.nan,
)

# Model 3: population with low grocery access
# USDA 1-mile urban / 10-mile rural measure.

merged["low_access_pct"] = np.where(
    merged["Pop2010"] > 0,
    100 * merged["LAPOP1_10"] / merged["Pop2010"],
    np.nan,
)

# Values outside 0–100 indicate invalid or incompatible
# measurements, so mark them missing.

targets = [
    "poverty_rate",
    "no_vehicle_pct",
    "low_access_pct",
]

for col in targets:
    merged.loc[
        ~merged[col].between(0, 100),
        col,
    ] = np.nan

# ----------------------------------
# 8. CREATE USEFUL FEATURES
# ----------------------------------

merged["population_density_proxy"] = merged["TotalPop"]

# Placeholder population-size feature.
# True density requires area from the shapefile.
# We keep the actual feature name accurate.

merged["urban_indicator"] = merged["Urban"]

# ----------------------------------
# 9. REMOVE DIRECT TARGET COLUMNS
# FROM SHARED FEATURE EXPORT
# ----------------------------------

# We retain observed raw data for inspection,
# but train.py will explicitly choose feature
# columns and avoid target leakage.

merged["county_fips"] = merged["GEOID"].str[:5]

# ----------------------------------
# 10. SAVE THE CLEAN DATA
# ----------------------------------

output = PROCESSED / "texas_training.csv"

merged.to_csv(output, index=False)

print("\nDATA PREPARATION COMPLETE")
print("--------------------------")

print("Final rows:", len(merged))
print("Final columns:", len(merged.columns))

print("\nTarget availability:")
print(merged[targets].notna().sum())

print("\nTarget statistics:")
print(merged[targets].describe().round(2))

print("\nSample:")
print(
    merged[
        ["GEOID", "County"] + targets
    ].head(5).to_string(index=False)
)

print(f"\nSaved to: {output}")
