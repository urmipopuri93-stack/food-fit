"""Normalized food-resource record. Every optional field may be null = not provided by the source."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, StringConstraints
from typing_extensions import Annotated

Category = Literal["food_distribution", "snap_application_help", "senior_food_box", "other_services"]
FOOD_CATEGORIES: tuple[Category, ...] = ("food_distribution", "snap_application_help", "senior_food_box")
ALL_CATEGORIES: tuple[Category, ...] = FOOD_CATEGORIES + ("other_services",)
CATEGORY_LABELS: dict[str, str] = {
    "food_distribution": "Food pantry / distribution",
    "snap_application_help": "SNAP application help",
    "senior_food_box": "Senior food box (CSFP)",
    "other_services": "Other services (non-food)",
}

Day = Literal["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
HHMM = Annotated[str, StringConstraints(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
Short = Annotated[str, StringConstraints(min_length=1, max_length=300)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Location(Strict):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lng: float = Field(ge=-180, le=180, allow_inf_nan=False)
    matched_address: str | None = None
    geocoder: str
    note: str | None = None


class ScheduleEntry(Strict):
    day: Day
    opens: HHMM
    closes: HHMM
    note: str | None = None
    recurrence_limited: bool = False


class Resource(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]{3,120}$")]
    name: Short
    program: Short | None = None
    category: Category
    source_category: str | None = None
    address: Short
    city: str | None = None
    zip: Annotated[str, StringConstraints(pattern=r"^\d{5}$")] | None = None
    location: Location | None = None
    phone: Annotated[str, StringConstraints(pattern=r"^\d{3}-\d{3}-\d{4}$")] | None = None
    phone_label: str | None = None
    website: HttpUrl | None = None
    email: Annotated[str, StringConstraints(pattern=r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")] | None = None
    hours_text: str | None = None
    schedule: list[ScheduleEntry] = Field(default_factory=list)
    schedule_basis: Literal["program", "organization"] | None = None
    hours_notes: list[str] = Field(default_factory=list)
    closures: list[Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]] = Field(default_factory=list)
    appointment: Literal["required", "prioritized_walk_ins_welcome"] | None = None
    notes: list[str] = Field(default_factory=list)


class SourceInfo(Strict):
    file: str | None = None
    search_area: str | None = None
    publisher: str | None = None
    captured_at: str | None = None
    added_to_repository: str | None = None
