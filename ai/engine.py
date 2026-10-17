"""The same decision engine is used by the terminal and FastAPI."""

from datetime import date
from math import ceil

from allocation import allocate_kits
from community_data import load_communities, score_community
from prediction import predict_demand


def recommend(communities, inventory, mode="baseline", model_path=None, week_start=None, data_label="fictional sample data"):
    if type(inventory) is not int or inventory <= 0:
        raise ValueError("Inventory must be a positive whole number.")
    if mode not in ("baseline", "model"):
        raise ValueError("Mode must be baseline or model.")
    predictions, report = None, None
    warnings = []
    if mode == "model":
        if not model_path or not week_start:
            raise ValueError("Model mode requires a model path and week_start (YYYY-MM-DD). Inventory is for that one week.")
        date.fromisoformat(week_start)
        predictions, report = predict_demand(communities, model_path)
        warnings.append("Candidate predictions estimate weekly requested kits, not all unmet food need or people served.")
        warnings.append("Need-score factors explain the manual score, not the learned model's predictions.")
        if not report.get("beats_baseline"):
            warnings.append("This candidate did not beat the historical baseline on its holdout.")
    else:
        warnings.append("Manual scoring baseline; weights are assumptions, not learned predictions or measured demand.")

    rows = []
    for index, community in enumerate(communities):
        score, factors = score_community(community)
        predicted = predictions[index] if predictions is not None else None
        rows.append({**community, "need_score": score, "score_factors": factors,
                     "predicted_weekly_kits": predicted,
                     "allocation_weight": predicted if predicted is not None else community["population"] * score / 100,
                     "allocation_cap": ceil(predicted) if predicted is not None else inventory})
    # Severity ranking is independent of inventory and population.
    rows.sort(key=lambda row: (-row["need_score"], row["area_id"]))
    allocations = allocate_kits([row["allocation_weight"] for row in rows], inventory,
                                [row["allocation_cap"] for row in rows])
    for rank, (row, allocated) in enumerate(zip(rows, allocations), start=1):
        row["rank"] = rank
        row["allocated_kits"] = allocated
    return {"mode": mode, "data_label": data_label, "week_start": week_start,
            "inventory_kits": inventory, "allocated_kits": sum(allocations),
            "unallocated_kits": inventory - sum(allocations),
            "allocation_basis": "predicted weekly requests, capped at rounded-up prediction" if mode == "model" else "population times manual need score",
            "model_evaluation": report, "warnings": warnings, "communities": rows}


def map_features(communities, metric="need_score", min_value=0):
    allowed = {"need_score", "low_income_pct", "low_food_access_pct", "no_vehicle_pct"}
    if metric not in allowed:
        raise ValueError(f"Metric must be one of: {', '.join(sorted(allowed))}")
    features = []
    for community in communities:
        score, _ = score_community(community)
        properties = {**community, "need_score": score}
        value = properties[metric]
        if value < min_value:
            continue
        properties.update({"metric": metric, "value": value, "heat_weight": value / 100})
        features.append({"type": "Feature", "id": community["area_id"],
                         "geometry": {"type": "Point", "coordinates": [community["longitude"], community["latitude"]]},
                         "properties": properties})
    return {"type": "FeatureCollection", "features": features,
            "metric": metric, "geometry_note": "Community center points; polygons require real area boundaries."}
