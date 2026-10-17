# Data request for the team

Choose one geographic level and region, preferably census tracts, and preserve
stable area IDs as text (including leading zeros). Please send source links,
definitions, units, geographic vintage, dates, and the meaning of missing values.
The prototype assumes weekly inventory for model-based recommendations.

## Current community snapshot: real_communities.csv

One row per area, with these exact columns or a description so we can map them:

```csv
area_id,name,population,low_income_pct,low_food_access_pct,no_vehicle_pct,latitude,longitude
```

- `area_id`: stable geographic identifier.
- `name`: readable area name.
- `population`: positive integer residents.
- `low_income_pct`: low-income residents as a percentage, 0–100; send its definition.
- `low_food_access_pct`: residents with limited food access, 0–100; send its definition.
- `no_vehicle_pct`: households without a vehicle, 0–100; send its denominator.
- `latitude`, `longitude`: decimal-degree community center, not projected map coordinates.

Raw percentages may use different denominators; the score is a composite index,
not a headcount. Do not convert score times population into claimed people in need.
Send counts and denominators when percentages need to be calculated. Do not mix
0–1 fractions with 0–100 percentages. Nutritious-food access needs its own valid
measurement if the team wants that distinct filter; grocery distance is not enough.

If possible include a GeoJSON boundary file with the same area IDs for filled
heat-map regions. The engine already supplies point GeoJSON when polygons are absent.
Keep year/source metadata alongside the files, even though the prototype doesn't
currently require those extra columns. Align years and area boundaries before joining.

## Historical requests: historical_demand.csv

```csv
area_id,week_start,population,low_income_pct,low_food_access_pct,no_vehicle_pct,meal_kits_requested
```

One row per area and seven-day period; use the same week-start weekday everywhere.
Input indicators must be available before the week being predicted. The target
is observed kits requested, including unfulfilled requests where captured, not
the score produced by our program. Send at least several months if available;
five distinct weeks is only the code's minimum to run a holdout, not enough to
claim useful accuracy. Do not label missing observations as zero.

Also send distributed quantities and inventory limits if available. Distribution
alone can understate demand when the foodbank ran out. If all you can find is
visits, households served, annual food-insecurity rates, or county-level data,
send it with definitions: we must adapt the target and geography rather than
rename those values to meal-kit requests.

## For improving the location simulation later

Existing foodbank sites, schedules, capacity, event attendance, origin areas of
attendees, road/transit travel times, and unmet requests can support stronger
coverage assumptions. Current simulation only tests center-to-location distance
and reallocates kits; these additional records are needed to validate actual reach.

No data should be invented to complete missing columns. Share what is available,
and we will adapt the pipeline after examining it.
