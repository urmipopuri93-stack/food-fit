# FoodFit synthetic data pack

ALL DATA IS SYNTHETIC. Five fictional pantries and fictional service areas near Dallas. No actual NTFB operations, Census estimates, real household records, real facility locations, or measured travel times. This is a coherent demo/test dataset, not evidence of real demand or model accuracy in Dallas.

## Coverage
104 completed weeks: 2024-10-14 through 2026-10-11. Snapshot: 2026-10-17. No movements are assumed between history end and snapshot. CSV dates are ISO YYYY-MM-DD. Service schedules use America/Chicago. All food quantities are kilograms; never add households, people, meals and kilograms together.

## Files and joins
pantries.csv: 5 fictional sites, map coordinates, total/cold storage kg limits and weekly household capacity.
service_areas.csv + synthetic_service_areas.geojson: 5 illustrative polygons and synthetic income/access features; join service_area_id. These IDs do NOT join to Census GEOIDs. Replace these demo features with your verified real demographic/boundary data when available, using an explicit spatial mapping.
pantry_hours.csv: recurring food service schedules, one row per open day.
weekly_pantry_history.csv: 520 rows, targets and history; join pantry_id + week_start.
weekly_category_demand.csv: 2,600 category demand/distribution rows; add food_category to the key.
weekly_inventory_movements.csv: 2,600 stock ledger rows, same category key.
attendance_events.csv: 1,560 event rows. Repeated visits are not unique residents.
inventory_batches.csv: 50 current batches and expiry dates for FEFO.
current_inventory.csv: 25 category aggregates of the SAME current batches; do not add both sources.
incoming_donations.csv: 5 unallocated donation lots; these are separate from existing stock.
food_categories.csv: category shares and shelf-life assumptions.
scenario_parameters.csv: editable planning assumptions.
data_dictionary.csv: column types, units and table descriptions.

## Forecasting
Forecast households_requesting or requested_kg separately per pantry, or requested_kg per pantry/category. Begin with last-week and 4-week rolling-mean baselines; compare on a chronological holdout. Train on weeks before 2026-07-20 and evaluate later completed weeks. Build lag features ONLY from earlier weeks. Current-week requested/distributed/unmet counts and closing inventory are future information at forecast time: do not use them as predictors. There are only 104 observations per pantry; prefer simple baselines. Random row splitting leaks temporal information. Any measured accuracy here describes generated data only.

The next planning week is 2026-10-19. The intervening week 2026-10-12 is intentionally incomplete and excluded. Forecast with the corresponding two-week lead from the last complete history; do not treat the incomplete week as zero or shift dates silently.

## Allocation simulation
Use forecast demand, current unexpired inventory, donation quantities, total storage, cold storage, and pantry household capacity. Define whether demand is total demand or additional need; avoid subtracting stock twice. Allocate in kg by category, enforce donation-pool limits, and compute unmet_kg = max(0, forecast_requested_kg - planned_distribution_kg). Model receiving and distribution timing explicitly before enforcing storage constraints. Prioritize earliest-expiring usable batches. Do not equate the count of unserved households with unmet kg: served households can receive partial quantities. Transport times/distances and real routes are NOT provided; vehicle capacity is only an editable assumption.

## Import
Python: pd.read_csv('weekly_pantry_history.csv', parse_dates=['week_start','week_end']). Load pantry/category IDs as strings. Convert is_synthetic values to booleans as needed. Every CSV includes is_synthetic=True. Store these in backend/data/synthetic/ and label the website 'Simulated operations — fictional pantries'. Do not combine NYC service totals with these records as if they describe the same geography.

## Refresh
This is a fixed snapshot, not a live feed. Regenerate only when you intentionally update the scenario and version. Missing real observations cannot be repaired by changing the synthetic label. Keep real-directory and synthetic operating data separate.
