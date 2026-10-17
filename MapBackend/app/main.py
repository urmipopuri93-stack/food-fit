from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import analysis
from .database import Base, SessionLocal, engine, get_db
from .inference import MODEL
from .models import Point, Prediction
from .schemas import InferenceRequest, PointIn, PointOut, PredictionOut

Base.metadata.create_all(engine)

app = FastAPI(title="Food Fit API")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",  # any local Vite port
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Points: store ----
@app.post("/points", response_model=PointOut)
def create_point(body: PointIn, db: Session = Depends(get_db)):
    p = Point(**body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@app.post("/points/bulk")
def create_points_bulk(body: list[PointIn], db: Session = Depends(get_db)):
    db.add_all([Point(**b.model_dump()) for b in body])
    db.commit()
    return {"inserted": len(body)}


@app.get("/points", response_model=list[PointOut])
def list_points(
    min_lat: float | None = None, max_lat: float | None = None,
    min_lng: float | None = None, max_lng: float | None = None,
    limit: int = Query(1000, le=10000), offset: int = 0,
    db: Session = Depends(get_db),
):
    """Bounding-box query: the frontend sends the map's visible bounds."""
    q = select(Point)
    if min_lat is not None: q = q.where(Point.lat >= min_lat)
    if max_lat is not None: q = q.where(Point.lat <= max_lat)
    if min_lng is not None: q = q.where(Point.lng >= min_lng)
    if max_lng is not None: q = q.where(Point.lng <= max_lng)
    return db.scalars(q.order_by(Point.id).limit(limit).offset(offset)).all()


@app.get("/points/{point_id}", response_model=PointOut)
def get_point(point_id: int, db: Session = Depends(get_db)):
    p = db.get(Point, point_id)
    if not p:
        raise HTTPException(404, "Point not found")
    return p


@app.patch("/points/{point_id}/props", response_model=PointOut)
def merge_props(point_id: int, props: dict, db: Session = Depends(get_db)):
    """Add or update info on a point without touching the rest."""
    p = db.get(Point, point_id)
    if not p:
        raise HTTPException(404, "Point not found")
    p.props = {**(p.props or {}), **props}  # reassign so SQLAlchemy sees the change
    db.commit()
    db.refresh(p)
    return p


@app.delete("/points/{point_id}")
def delete_point(point_id: int, db: Session = Depends(get_db)):
    p = db.get(Point, point_id)
    if not p:
        raise HTTPException(404, "Point not found")
    db.delete(p)
    db.commit()
    return {"deleted": point_id}


# ---- Calculations ----
@app.get("/analysis/summary")
def summary(db: Session = Depends(get_db)):
    return analysis.summary(db.scalars(select(Point)).all())


@app.get("/analysis/nearby")
def nearby(lat: float, lng: float, radius_km: float = 10, limit: int = 100, db: Session = Depends(get_db)):
    return analysis.nearby(db.scalars(select(Point)).all(), lat, lng, radius_km, limit)


# ---- Inference ----
def _run_inference(point_ids: list[int] | None):
    db = SessionLocal()  # background task needs its own session
    try:
        q = select(Point)
        if point_ids:
            q = q.where(Point.id.in_(point_ids))
        points = db.scalars(q).all()
        for i in range(0, len(points), 500):  # batch so big runs don't hold everything at once
            batch = points[i:i + 500]
            for p, (score, details) in zip(batch, MODEL.predict(batch)):
                db.add(Prediction(point_id=p.id, model_name=MODEL.name,
                                  model_version=MODEL.version, score=score, details=details))
            db.commit()
    finally:
        db.close()


@app.post("/inference/run", status_code=202)
def run_inference(body: InferenceRequest, tasks: BackgroundTasks):
    tasks.add_task(_run_inference, body.point_ids)
    return {"status": "started", "model": MODEL.name, "version": MODEL.version}


@app.get("/points/{point_id}/predictions", response_model=list[PredictionOut])
def point_predictions(point_id: int, db: Session = Depends(get_db)):
    q = select(Prediction).where(Prediction.point_id == point_id).order_by(Prediction.id.desc())
    return db.scalars(q).all()
