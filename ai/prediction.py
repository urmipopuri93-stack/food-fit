"""Load an explicitly selected local candidate and predict weekly requests."""

from math import isfinite
from train_model import FEATURES, TARGET


def predict_demand(communities, model_path):
    import joblib

    artifact = joblib.load(model_path)
    if artifact.get("features") != FEATURES:
        raise ValueError("Model feature schema does not match this engine.")
    report = artifact.get("report", {})
    if report.get("target") != TARGET or report.get("period") != "one week":
        raise ValueError("Model must predict meal-kit requests per area per week.")
    features = [[community[key] for key in FEATURES] for community in communities]
    predictions = [float(value) for value in artifact["model"].predict(features)]
    if len(predictions) != len(communities) or any(not isfinite(v) or v < 0 for v in predictions):
        raise ValueError("Model returned invalid demand predictions.")
    return predictions, report
