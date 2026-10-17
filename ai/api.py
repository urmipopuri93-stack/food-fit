"""App integration: python -m uvicorn api:app --reload"""

from datetime import date
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from community_data import DEFAULT_DATA, load_communities
from engine import map_features, recommend
from simulation import simulate

app = FastAPI(title="Foodbank Decision Engine", version="0.1.0",
              description="Manual need scoring, optional learned weekly demand, allocations, and geographic what-if coverage.")
origins = os.getenv("FOOD_FRONTEND_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")
app.add_middleware(CORSMiddleware, allow_origins=[origin.strip() for origin in origins],
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


@app.get("/", include_in_schema=False)
def demo():
    return FileResponse(Path(__file__).with_name("demo.html"))


class RecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inventory_kits: int = Field(gt=0, strict=True)
    mode: Literal["baseline", "model"] = "baseline"
    week_start: date | None = None


class SimulationRequest(RecommendationRequest):
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    radius_km: float = Field(gt=0, le=20040, allow_inf_nan=False)


def current_data():
    return load_communities(Path(os.getenv("FOOD_DATA_PATH", str(DEFAULT_DATA))))


def create_plan(request):
    model_path = os.getenv("FOOD_MODEL_PATH")
    if request.mode == "model" and not model_path:
        raise HTTPException(409, "No trained model configured. Train on real data, then set FOOD_MODEL_PATH.")
    try:
        return recommend(current_data(), request.inventory_kits, request.mode, model_path,
                         request.week_start.isoformat() if request.week_start else None,
                         os.getenv("FOOD_DATA_LABEL", "fictional sample data"))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    except (OSError, ImportError) as error:
        raise HTTPException(503, f"Data or model unavailable: {error}") from error


@app.get("/health")
def health():
    return {"status": "ok", "model_configured": bool(os.getenv("FOOD_MODEL_PATH")),
            "data_label": os.getenv("FOOD_DATA_LABEL", "fictional sample data")}


@app.get("/communities")
def communities(metric: Literal["need_score", "low_income_pct", "low_food_access_pct", "no_vehicle_pct"] = "need_score",
                min_value: float = 0):
    if not 0 <= min_value <= 100:
        raise HTTPException(422, "min_value must be from 0 to 100.")
    try:
        result = map_features(current_data(), metric, min_value)
        result["data_label"] = os.getenv("FOOD_DATA_LABEL", "fictional sample data")
        return result
    except (ValueError, OSError) as error:
        raise HTTPException(503, f"Community data unavailable: {error}") from error


@app.post("/recommend")
def recommendations(request: RecommendationRequest):
    return create_plan(request)


@app.post("/simulate")
def simulation(request: SimulationRequest):
    plan = create_plan(request)
    result = simulate(plan["communities"], request.inventory_kits, request.latitude,
                      request.longitude, request.radius_km)
    result.update({"mode": plan["mode"], "data_label": plan["data_label"],
                   "week_start": plan["week_start"], "warnings": plan["warnings"],
                   "inventory_kits": request.inventory_kits,
                   "model_evaluation": plan["model_evaluation"],
                   "baseline_unallocated_kits": plan["unallocated_kits"]})
    return result
