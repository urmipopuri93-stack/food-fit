
from pathlib import Path
import pandas as pd
import numpy as np
import joblib

from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupShuffleSplit
from sklearn.metrics import mean_absolute_error, r2_score

BASE = Path(__file__).resolve().parent
DATA = BASE / "data" / "processed" / "texas_training.csv"
MODELS = BASE / "models"
OUTPUTS = BASE / "outputs"

MODELS.mkdir(exist_ok=True)
OUTPUTS.mkdir(exist_ok=True)

df = pd.read_csv(DATA, dtype={"GEOID": str})
df["county_fips"] = df["GEOID"].str[:5]

# Predictor features are deliberately separate
# from each model's observed target.
models = {
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
    },
    "grocery": {
        "target": "low_access_pct",
        "features": [
            "Income",
            "Unemployment",
            "Urban",
            "TotalPop",
            "MeanCommute",
            "Transit",
            "Walk",
        ],
    },
}

results = []

for name, config in models.items():
    target = config["target"]
    features = config["features"]

    # Missing labels cannot be used for supervised training.
    subset = df.dropna(subset=[target]).copy()

    X = subset[features]
    y = subset[target]
    groups = subset["county_fips"]

    splitter = GroupShuffleSplit(
        n_splits=1,
        test_size=0.2,
        random_state=42,
    )

    train_idx, test_idx = next(
        splitter.split(X, y, groups=groups)
    )

    X_train = X.iloc[train_idx]
    X_test = X.iloc[test_idx]

    y_train = y.iloc[train_idx]
    y_test = y.iloc[test_idx]

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("regressor", RandomForestRegressor(
            n_estimators=150,
            min_samples_leaf=5,
            random_state=42,
            n_jobs=-1,
        )),
    ])

    pipeline.fit(X_train, y_train)

    predictions = pipeline.predict(X_test)
    baseline = np.full(len(y_test), y_train.mean())

    mae = mean_absolute_error(y_test, predictions)
    baseline_mae = mean_absolute_error(y_test, baseline)
    r2 = r2_score(y_test, predictions)

    print(f"\n{name.upper()} MODEL")
    print(f"Training rows: {len(X_train)}")
    print(f"Testing rows: {len(X_test)}")
    print(f"MAE: {mae:.3f} percentage points")
    print(f"Baseline MAE: {baseline_mae:.3f}")
    print(f"R2: {r2:.3f}")

    results.append({
        "model": name,
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "mae": mae,
        "baseline_mae": baseline_mae,
        "r2": r2,
    })

    # Save this evaluation model.
    # We'll separately refit final deployment models.
    joblib.dump(
        pipeline,
        MODELS / f"{name}_evaluation.joblib",
    )

pd.DataFrame(results).to_csv(
    OUTPUTS / "model_metrics.csv",
    index=False,
)

print("\nTraining and evaluation complete!")
