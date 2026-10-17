# Foodbank AI decision engine

This is the Python backend for the datathon's three tasks: rank community need,
allocate meal kits, and compare mobile-foodbank locations. It includes the data
responses your teammates need for the heat map, not a frontend application.

**Current status:** all included community data and coordinates are fictional.
The manual baseline runs now. The machine-learning pipeline is implemented but
has not been trained or validated on real demand data. No API key is required.

## Run the terminal version

In the VS Code terminal, from this folder:

```powershell
python main.py
```

Enter inventory, then choose whether to run a what-if. With 1,000 kits the sample
baseline allocates 294 to C, 294 to A, and 412 to B. A foodbank at A with a 5 km
radius allocates 417 to A and 583 to B. C's center is outside that radius.

If `python` is not your working interpreter, use the Python executable shown by
VS Code's Run button. On the current machine that is:

```powershell
& "C:\Users\kashm\AppData\Local\Python\pythoncore-3.14-64\python.exe" main.py
```

Noninteractive use and JSON export:

```powershell
python main.py --kits 1000 --no-interactive --output recommendations.json
```

## How the pieces fit

- `community_data.py` loads and validates the current geographic dataset.
- `engine.py` calculates scores, obtains optional predictions, and builds recommendations.
- `allocation.py` divides inventory into whole kits, respecting caps in model mode.
- `simulation.py` compares one proposed location against the distribution plan.
- `train_model.py` learns weekly requests from historical observations and evaluates them.
- `prediction.py` loads a selected trained candidate for inference.
- `main.py` lets you use this through terminal prompts.
- `api.py` lets your teammates' app use the same functions through HTTP.

The score is `0.4 * low_income_pct + 0.4 * low_food_access_pct + 0.2 * no_vehicle_pct`.
These weights are manually chosen assumptions, not trained parameters. Score rank
measures indicator severity; it is separate from the allocation order or predicted
total demand. Score explanations describe this formula, not the learned model.

In baseline mode, kit shares use `population * score / 100`. This weight is not
a count of people needing assistance. In model mode, shares use predicted weekly
requests; each area is capped at its prediction rounded up to a whole kit.
Surplus stays unallocated. These caps are estimates, not known demand limits.

The what-if replaces the baseline allocation with a single-location scenario
using the same inventory and demand caps. It uses straight-line distance to
community centers. It cannot yet predict attendance, driving accessibility, or
causal changes in food insecurity. Population in radius is not people served.
In model mode it also compares estimated unmet requests under the baseline and
proposed location. This is arithmetic on predicted requests and allocated kits,
not evidence of a causal change in food insecurity. Baseline mode reports no
unmet-demand estimate because no demand model has been loaded.

## App integration

### Local test frontend

With the API running, open http://127.0.0.1:8000/ for the disposable test screen.
It calls the existing endpoints for recommendations and location simulations.
Enter inventory, calculate distribution, choose a location and radius, then run
a what-if. Change the map metric to inspect each indicator. The geographic view
is a schematic of community centers, with no external map service or API key.
This page is a testing aid, not the team's final frontend.

Install dependencies once using the same interpreter that runs your code:

```powershell
python -m pip install -r requirements.txt
```

Start the local API:

```powershell
python -m uvicorn api:app --reload
```

Open http://127.0.0.1:8000/docs to try requests using the generated API interface.
Press Ctrl+C in the terminal to stop the server.

- `GET /health`: service status, data label, whether a model path is configured.
- `GET /communities`: GeoJSON points with area IDs, population, indicators, and scores.
- `GET /communities?metric=no_vehicle_pct&min_value=50`: heat-map data filtered to that indicator and threshold.
- `POST /recommend`: inventory to ranked community recommendations.
- `POST /simulate`: inventory and proposed coordinates to a location comparison.

Map metrics: `need_score`, `low_income_pct`, `low_food_access_pct`, `no_vehicle_pct`.
Each feature has `value` (0–100) and `heat_weight` (0–1). Filtering the map only
changes displayed points; it does not silently change distribution recommendations.
Coordinates in GeoJSON are `[longitude, latitude]`. Use `area_id` to join real
boundary polygons later. Food-access data is not a direct nutrition measurement.

Recommendation request:

```json
{"inventory_kits": 1000, "mode": "baseline"}
```

Simulation request:

```json
{
  "inventory_kits": 1000,
  "mode": "baseline",
  "latitude": 32.7767,
  "longitude": -96.7970,
  "radius_km": 5
}
```

Frontend example (while the API is running):

```javascript
const response = await fetch("http://127.0.0.1:8000/recommend", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ inventory_kits: 1000, mode: "baseline" }),
});
const result = await response.json();
if (!response.ok) throw new Error(JSON.stringify(result.detail));
// result.communities contains area_id, need_score, allocated_kits, and reasons.
```

Local frontend origins localhost:3000 and localhost:5173 are enabled. If your
frontend uses a different origin, set it before starting the API:

```powershell
$env:FOOD_FRONTEND_ORIGINS = "http://localhost:3000,http://127.0.0.1:5173"
```

## When your friend's data arrives

See DATA_HANDOFF.md for exact fields and TRAINING.md for training assumptions.
To use a separate real community file:

```powershell
python main.py --data real_communities.csv --data-label "Team community dataset"
```

For the API:

```powershell
$env:FOOD_DATA_PATH = "C:\path\to\real_communities.csv"
$env:FOOD_DATA_LABEL = "Team community dataset"
```

Train and inspect the evaluation before using the candidate:

```powershell
python train_model.py historical_demand.csv
```

Then explicitly select model mode; inventory must cover the same one-week period
as the model target. Replace the example date with the desired reporting week:

```powershell
python main.py --data real_communities.csv --data-label "Team community dataset" --mode model --model models/demand_candidate.joblib --week-start 2026-10-19 --kits 1000
```

For model inference through the API:

```powershell
$env:FOOD_MODEL_PATH = (Resolve-Path models/demand_candidate.joblib).Path
```

Send `"mode": "model"` and `"week_start": "2026-10-19"` with either POST request.
Until a trained model is configured, model requests return a clear error; they do
not masquerade as trained predictions. Baseline mode remains explicitly labeled.

## Verify

```powershell
python -m unittest -v test_pipeline
```

Tests include inventory conservation, prediction caps, map metrics, location
coverage, invalid inputs, terminal/API flows, and a temporary synthetic training
round-trip. Synthetic test results measure code behavior, not real-world accuracy.

## What still needs real data

Real community ranking, geographic conclusions, demand-model accuracy, and
choosing useful model features require the actual data and definitions. The
initial model learns typical weekly requests from community indicators; it has
no seasonality or event features yet. If no historical request labels exist,
use the scoring baseline rather than claiming a trained demand predictor.
