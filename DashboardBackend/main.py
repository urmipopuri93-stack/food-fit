import csv
import os
from contextlib import closing
import sqlite3

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = os.getenv("DB_PATH", "harvestgrowth.db")
PRED_CSV = os.getenv("PREDICTIONS_CSV", "predictions.csv")
EXTRA_ORIGINS = [o for o in os.getenv("EXTRA_ORIGINS", "").split(",") if o]

app = FastAPI(title="HarvestGrowth API")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_origins=EXTRA_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# (name, lat, lng, population, nutrition, access, income, combined, driver), scores 0-100
DEMO_AREAS = [
    ("South Dallas", 32.76, -96.77, 38000, 82, 75, 90, 87, "High estimated need"),
    ("West Oak Cliff", 32.74, -96.88, 41000, 70, 85, 66, 76, "Limited grocery access"),
    ("East Plano", 33.02, -96.65, 36000, 55, 80, 45, 62, "Transportation barriers"),
    ("Pleasant Grove", 32.72, -96.69, 33000, 78, 62, 80, 74, "Low household income"),
    ("Fair Park", 32.78, -96.76, 12000, 74, 66, 84, 77, "Few fresh-food outlets"),
    ("Garland South", 32.88, -96.63, 29000, 55, 50, 58, 56, "Low household income"),
    ("Irving East", 32.83, -96.93, 31000, 52, 56, 50, 53, "Transportation barriers"),
    ("Lake Highlands", 32.89, -96.72, 44000, 35, 30, 32, 33, "Few fresh-food outlets"),
    ("Oak Lawn", 32.81, -96.81, 27000, 30, 28, 30, 29, "Limited grocery access"),
    ("Richardson West", 32.95, -96.75, 40000, 22, 25, 20, 22, "Low household income"),
    ("Plano West", 33.05, -96.78, 45000, 15, 12, 10, 12, "Low household income"),
    ("Highland Park", 32.83, -96.80, 9000, 8, 5, 5, 6, "Low household income"),
]
DEMO_PANTRIES = [
    ("South Dallas Community Pantry", 32.763, -96.775, "Open Mon-Sat"),
    ("West Oak Cliff Food Hub", 32.742, -96.885, "Open Tue-Sun"),
    ("East Plano Food Pantry", 33.021, -96.655, "Open Wed-Sat"),
    ("Linden Park Mutual Aid", 32.790, -96.790, "Open daily"),
]


def load_areas() -> list[dict]:
    if os.path.exists(PRED_CSV):
        with open(PRED_CSV, newline="") as f:
            return [
                {
                    "id": r["area_id"], "name": r["name"],
                    "lat": float(r["lat"]), "lng": float(r["lng"]),
                    "population": int(float(r["population"])),
                    "nutrition_score": float(r["nutrition_score"]),
                    "access_score": float(r["access_score"]),
                    "income_score": float(r["income_score"]),
                    "combined_score": float(r["combined_score"]),
                    "top_driver": r["top_driver"],
                }
                for r in csv.DictReader(f)
            ]
    return [
        {
            "id": str(i + 1), "name": a[0], "lat": a[1], "lng": a[2], "population": a[3],
            "nutrition_score": a[4], "access_score": a[5], "income_score": a[6],
            "combined_score": a[7], "top_driver": a[8],
        }
        for i, a in enumerate(DEMO_AREAS)
    ]


def data_source() -> str:
    return "model" if os.path.exists(PRED_CSV) else "simulated"


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def init_db() -> None:
    with closing(db()) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS inventory (item TEXT PRIMARY KEY, quantity INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS contributions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pantry TEXT, item_type TEXT, quantity INTEGER, date TEXT,
                metric TEXT, before_pct REAL, after_pct REAL);
            """
        )
        if not c.execute("SELECT 1 FROM inventory").fetchone():
            c.executemany(
                "INSERT INTO inventory VALUES (?, ?)",
                [("meal_kits", 1240), ("fresh_produce_lbs", 520), ("canned_goods", 380), ("dairy_items", 210)],
            )
        if not c.execute("SELECT 1 FROM contributions").fetchone():
            c.executemany(
                "INSERT INTO contributions (pantry,item_type,quantity,date,metric,before_pct,after_pct) VALUES (?,?,?,?,?,?,?)",
                [
                    ("South Dallas Community Pantry", "Meal kits", 400, "2026-10-16", "Estimated Unmet Demand", 100, 82),
                    ("West Oak Cliff Food Hub", "Fresh produce", 320, "2026-10-14", "Food Access Coverage", 45, 67),
                    ("East Plano Food Pantry", "Canned goods", 280, "2026-10-11", "Distribution Coverage", 30, 58),
                    ("Linden Park Mutual Aid", "Meal kits", 360, "2026-10-08", "Food Access Coverage", 38, 56),
                ],
            )
        c.commit()


init_db()


def get_inventory() -> dict:
    with closing(db()) as c:
        return {r["item"]: r["quantity"] for r in c.execute("SELECT item, quantity FROM inventory")}


class InventoryIn(BaseModel):
    meal_kits: int = Field(ge=0)
    fresh_produce_lbs: int = Field(ge=0)
    canned_goods: int = Field(ge=0)
    dairy_items: int = Field(ge=0)


class ContributionIn(BaseModel):
    pantry: str
    item_type: str
    quantity: int = Field(gt=0)
    date: str
    metric: str
    before_pct: float = Field(ge=0, le=100)
    after_pct: float = Field(ge=0, le=100)


def top_areas(n: int) -> list[dict]:
    return sorted(load_areas(), key=lambda a: a["combined_score"], reverse=True)[:n]


def allocate(total: int, areas: list[dict]) -> list[int]:
    weight = sum(a["combined_score"] for a in areas) or 1
    out = [round(total * a["combined_score"] / weight) for a in areas]
    if out:
        out[-1] += total - sum(out)
    return out


@app.get("/api/dashboard/summary")
def summary():
    kits = get_inventory()["meal_kits"]
    return {
        "available_meal_kits": kits,
        "communities_analyzed": len(load_areas()),
        "priority_areas": 3,
        "donation_allocation": kits,
        "data_source": data_source(),
    }


@app.get("/api/inventory")
def read_inventory():
    return get_inventory()


@app.put("/api/inventory")
def update_inventory(body: InventoryIn):
    with closing(db()) as c:
        c.executemany(
            "INSERT INTO inventory (item, quantity) VALUES (?, ?) "
            "ON CONFLICT(item) DO UPDATE SET quantity = excluded.quantity",
            body.model_dump().items(),
        )
        c.commit()
    return get_inventory()


@app.get("/api/recommendations")
def recommendations(top: int = Query(3, ge=1, le=10)):
    areas = top_areas(top)
    total = get_inventory()["meal_kits"]
    kits = allocate(total, areas)
    return {
        "areas": [
            {
                "rank": i + 1, "id": a["id"], "name": a["name"],
                "need_score": a["combined_score"], "reason": a["top_driver"],
                "allocated_kits": k,
            }
            for i, (a, k) in enumerate(zip(areas, kits))
        ],
        "total_recommended": total,
        "allocation_method": "Proportional to need score",
        "data_source": data_source(),
    }


@app.get("/api/contributions")
def list_contributions(limit: int = Query(4, ge=1, le=100)):
    with closing(db()) as c:
        rows = c.execute("SELECT * FROM contributions ORDER BY date DESC, id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


@app.post("/api/contributions", status_code=201)
def add_contribution(body: ContributionIn):
    with closing(db()) as c:
        cur = c.execute(
            "INSERT INTO contributions (pantry,item_type,quantity,date,metric,before_pct,after_pct) VALUES (?,?,?,?,?,?,?)",
            (body.pantry, body.item_type, body.quantity, body.date, body.metric, body.before_pct, body.after_pct),
        )
        c.commit()
        return {"id": cur.lastrowid, **body.model_dump()}


@app.get("/api/areas")
def list_areas():
    return load_areas()


@app.get("/api/areas/{area_id}")
def get_area(area_id: str):
    for a in load_areas():
        if a["id"] == area_id:
            return a
    raise HTTPException(404, "Area not found")


@app.get("/api/heatmap")
def heatmap():
    return [
        {
            "id": a["id"], "name": a["name"], "lat": a["lat"], "lng": a["lng"],
            "score": round(a["combined_score"] / 100, 3),
            "details": {
                "nutrition_score": round(a["nutrition_score"] / 100, 3),
                "access_score": round(a["access_score"] / 100, 3),
                "income_score": round(a["income_score"] / 100, 3),
            },
            "props": {"population": a["population"], "top_driver": a["top_driver"]},
        }
        for a in load_areas()
    ]


@app.get("/api/pantries")
def pantries():
    return [{"id": i + 1, "name": n, "lat": la, "lng": lo, "hours": h} for i, (n, la, lo, h) in enumerate(DEMO_PANTRIES)]