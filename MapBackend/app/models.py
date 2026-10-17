from datetime import datetime, timezone
from sqlalchemy import ForeignKey, JSON, String, Float, DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def now():
    return datetime.now(timezone.utc)


class Point(Base):
    __tablename__ = "points"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    props: Mapped[dict] = mapped_column(JSON, default=dict)  # any extra info you store per point
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    predictions: Mapped[list["Prediction"]] = relationship(back_populates="point", cascade="all, delete-orphan")

    __table_args__ = (Index("ix_points_lat_lng", "lat", "lng"),)


class Prediction(Base):
    __tablename__ = "predictions"
    id: Mapped[int] = mapped_column(primary_key=True)
    point_id: Mapped[int] = mapped_column(ForeignKey("points.id", ondelete="CASCADE"), index=True)
    model_name: Mapped[str] = mapped_column(String(100))
    model_version: Mapped[str] = mapped_column(String(50))
    score: Mapped[float | None] = mapped_column(Float, nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    point: Mapped[Point] = relationship(back_populates="predictions")
