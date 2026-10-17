from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class PointIn(BaseModel):
    name: str
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    props: dict = {}


class PointOut(PointIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime


class PredictionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    point_id: int
    model_name: str
    model_version: str
    score: float | None
    details: dict
    created_at: datetime


class InferenceRequest(BaseModel):
    point_ids: list[int] | None = None  # None = all points
