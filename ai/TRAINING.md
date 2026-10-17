# Demand model

The existing main.py remains a manually weighted baseline. train_model.py trains
a separate candidate model; it does not change allocations automatically.

## Data contract

Copy historical_demand_template.csv to historical_demand.csv and add real records.
One row represents one area during one seven-day week. Use consistent week start
days, geographic boundaries, indicator definitions, and reporting coverage.

- area_id: stable geographic identifier, preserved as text.
- week_start: YYYY-MM-DD.
- population: positive whole number.
- low_income_pct, low_food_access_pct, no_vehicle_pct: percentages from 0 to 100.
- meal_kits_requested: nonnegative whole count requested in that area that week.

All input indicators must have been available before the week being predicted.
Use historical snapshots rather than later data when validating a forecast.
Do not fill unknown demand with zero, use our calculated need score as a target,
or relabel visits/distributions as requested kits. If the available target is
different, adapt the model and its output meaning first.

At least five distinct weeks are needed to run this initial split; that minimum
is a software check, not evidence that a dataset is sufficient for accuracy.
More communities and longer history improve the opportunity to evaluate it.

## Run in the VS Code terminal

```powershell
python -m pip install -r requirements.txt
python train_model.py historical_demand.csv
```

Use the same Python interpreter that runs main.py.

## What training does

1. Reads and validates real historical records.
2. Holds out the most recent roughly 20% of distinct weeks for testing.
3. Fits a Random Forest regression model on the earlier weeks.
4. Measures mean absolute error (MAE), in kits per area per week.
5. Compares with predicting each area's last observed request count.
6. Saves a candidate model and a JSON evaluation report in models/.

Lower MAE is better. Beating the baseline on one holdout is an initial signal,
not proof of general accuracy. The holdout evaluates later weeks, not explicitly
unseen communities. This initial model uses community indicators, not seasonal
or event features, and is not a causal model of foodbank effects.

No real training data or real accuracy results are included in this project yet.
The candidate is selected explicitly using main.py --mode model --model PATH
--week-start YYYY-MM-DD, or the API's model mode and FOOD_MODEL_PATH setting.
Review its real-data performance before using it for food allocation. The manual
score is labeled separately from predicted weekly demand. A model that loses to
the holdout baseline is still loadable for experiments, with an explicit warning.

In model mode, inventory is for one week and per-area allocations are capped at
the predicted weekly requests rounded up. This is an estimated cap, not observed
demand. Excess inventory remains unallocated, including during what-if scenarios.
