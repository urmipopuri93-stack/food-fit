"""Calculations over points. Uses numpy/pandas; fine up to a few hundred thousand rows.
Past that, push the work into PostGIS (ST_DWithin, ST_ClusterDBSCAN, ...)."""
import numpy as np
import pandas as pd

EARTH_KM = 6371.0088


def haversine_km(lat1, lng1, lat2, lng2):
    lat1, lng1, lat2, lng2 = map(np.radians, (lat1, lng1, lat2, lng2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lng2 - lng1) / 2) ** 2
    return 2 * EARTH_KM * np.arcsin(np.sqrt(a))


def points_to_df(points) -> pd.DataFrame:
    return pd.DataFrame([{"id": p.id, "name": p.name, "lat": p.lat, "lng": p.lng, **(p.props or {})} for p in points])


def summary(points) -> dict:
    df = points_to_df(points)
    if df.empty:
        return {"count": 0}
    out = {
        "count": int(len(df)),
        "centroid": {"lat": float(df.lat.mean()), "lng": float(df.lng.mean())},
        "bounds": {
            "min_lat": float(df.lat.min()), "max_lat": float(df.lat.max()),
            "min_lng": float(df.lng.min()), "max_lng": float(df.lng.max()),
        },
    }
    numeric = df.drop(columns=["id", "lat", "lng"]).select_dtypes("number")
    if not numeric.empty:
        desc = numeric.describe().round(3).astype(object)
        out["numeric_props"] = desc.where(desc.notna(), None).to_dict()  # NaN is not valid JSON
    return out


def nearby(points, lat: float, lng: float, radius_km: float, limit: int = 100) -> list[dict]:
    if not points:
        return []
    lats = np.array([p.lat for p in points])
    lngs = np.array([p.lng for p in points])
    d = haversine_km(lat, lng, lats, lngs)
    idx = np.where(d <= radius_km)[0]
    idx = idx[np.argsort(d[idx])][:limit]
    return [{"id": points[i].id, "name": points[i].name, "distance_km": round(float(d[i]), 3)} for i in idx]
