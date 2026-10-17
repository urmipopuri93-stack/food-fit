# AI-Powered Food Waste Management — Synthetic Dataset

## Overview

This dataset simulates **8,000 daily inventory records** for food businesses —
restaurants, supermarkets, cafeterias, and cloud kitchens — collected over a
**one-year period (Jan 1 – Dec 31, 2025)**. Each row represents one
business/food-category's inventory activity for a single day: how much was
purchased, how much was sold, what was left over, and how much of that
leftover stock was ultimately wasted.

The data is **fully synthetic** but built from an explicit causal model
(demand → purchasing → sales → remaining stock → waste → waste severity)
rather than independently randomized columns, so it behaves like real
operational data: correlated, occasionally messy, and internally consistent.

- **Rows:** 8,000
- **Columns:** 16 (15 features + ID)
- **Time span:** 2025-01-01 to 2025-12-31
- **Target variable:** `Waste_Level` (Low / Medium / High)

## Files

| File | Description |
|---|---|
| `food_waste_dataset.csv` | The main dataset (8,000 rows × 16 columns). |
| `data_dictionary.csv` | Column-by-column description, data type, and missingness. |
| `generate_dataset.py` | Fully reproducible generator script (`python generate_dataset.py`, seed=42). |
| `README.md` | This file. |

## Feature Descriptions

| Column | Type | Description |
|---|---|---|
| `Inventory_ID` | string | Unique record ID (e.g. `INV000001`). |
| `Date` | date | Day the record was collected. |
| `Business_Type` | categorical | Restaurant, Supermarket, Cafeteria, Cloud Kitchen. |
| `Food_Category` | categorical | Fruits, Vegetables, Dairy, Bakery, Meat, Prepared Food. |
| `Purchase_Quantity` | integer | Units purchased/stocked that day. |
| `Units_Sold` | integer | Units sold that day (always ≤ `Purchase_Quantity`). |
| `Remaining_Stock` | integer | `Purchase_Quantity − Units_Sold`. |
| `Shelf_Life_Days` | float | Days before expiry; depends on `Food_Category`. |
| `Storage_Temperature` | float | Storage temp (°C); depends on `Food_Category`. |
| `Daily_Demand` | float | Realized customer demand that day. |
| `Promotion` | Yes/No | Whether a promotion ran that day. |
| `Weather` | categorical | Sunny, Rainy, Cloudy, Hot. |
| `Waste_Quantity` | integer | Units wasted (always ≤ `Remaining_Stock`). |
| `Waste_Reason` | categorical | Expired, Overproduction, Low Demand, Storage Issue, or No Waste. |
| `Donation_Made` | Yes/No | Whether surplus (non-expired) food was donated. |
| `Waste_Level` | categorical (target) | Low / Medium / High severity of waste for the record. |

Full details, including missing-value rates, are in `data_dictionary.csv`.

## How the Data Was Generated (Business Logic)

The generator (`generate_dataset.py`) builds each row through a causal
pipeline instead of sampling columns independently:

1. **Category drives shelf life & storage temperature.** Prepared Food and
   Bakery have short shelf lives; Dairy and Meat need cold storage; Bakery
   and Prepared Food are stored warm.
2. **Purchasing happens *before* the day's weather is known.** `Purchase_Quantity`
   is based on a forecast of expected demand (business size + *planned*
   promotions), with realistic over-ordering noise — but it cannot react to
   weather, since orders are placed in advance.
3. **Realized demand reacts to weather and promotions on the day itself.**
   `Daily_Demand` and `Units_Sold` are scaled down on rainy days (lower
   footfall) and scaled up on hot/sunny days and promotion days — and
   promotions are modeled to *outperform* their forecast, so promoted days
   sell through more completely and waste less.
4. **Waste is driven by shelf life, storage temperature, and sell-through.**
   Short shelf life, high storage temperature (relative to the category's
   ideal), and a low sell-through rate (lots of `Remaining_Stock` relative to
   `Purchase_Quantity`) all increase `Waste_Quantity`.
5. **Waste_Reason** is chosen as the dominant driver behind each wasted
   batch (expiry risk, over-ordering, weak demand, or poor storage), so it
   is explainable from the other columns rather than random.
6. **Donation_Made** is more likely when waste is larger *and* the batch
   wasn't already expired (i.e., the food was still safe to give away).
7. **Waste_Level** (the target) is derived from the waste-to-purchase ratio,
   calibrated so the dataset lands close to the requested **Low ≈ 55% /
   Medium ≈ 30% / High ≈ 15%** split (actual: 54.1% / 30.0% / 15.9%), with
   ~3% random label noise added so classes are realistic, not perfectly
   separable.

**Business rules enforced everywhere (validated with assertions in the
generator):**
- `Units_Sold` never exceeds `Purchase_Quantity`.
- `Waste_Quantity` never exceeds `Remaining_Stock`.
- No negative inventory values; `Shelf_Life_Days` is always ≥ 1.

## Data Quality / Realism

- **Missing values (~2–3%)** injected into `Shelf_Life_Days`,
  `Storage_Temperature`, `Daily_Demand`, `Weather`, and `Donation_Made` —
  simulating incomplete data entry. Missingness is applied *after* all
  business rules are computed, so it never breaks internal consistency.
- **~1% outliers** in `Purchase_Quantity` (2.5×–4.5× normal order size),
  simulating bulk orders, festival stocking, or data-entry errors.
- **Noise** is layered into demand, purchasing, and waste calculations so
  relationships are strong but not perfectly deterministic — models will
  need to learn real signal, not just invert a formula.
- **Balanced categories:** all 4 business types and 6 food categories are
  represented in reasonable, non-trivial proportions.

## Assumptions Used

- Purchasing decisions are made **before** the day's weather is known;
  promotions, by contrast, are planned ahead but tend to outperform the
  original forecast.
- "Ideal" storage temperature is category-specific (e.g. ~2°C for Meat,
  ~22°C for Bakery); waste risk increases only when a batch is stored
  *warmer* than that ideal, not colder.
- Food that is wasted for reasons other than expiry (overproduction, low
  demand, storage issues) is more likely to still be donation-eligible than
  food that expired.
- `Waste_Level` is a **relative** measure (waste as a share of what was
  purchased), not a raw unit count, so a small café and a large supermarket
  are judged on the same scale.

## Suggested ML Use Cases

- **Classification:** Predict `Waste_Level` (Low/Medium/High) from
  operational features.
- **Regression:** Predict `Waste_Quantity` directly.
- **Demand Forecasting:** Predict `Daily_Demand` or `Units_Sold` from
  business type, weather, promotion, and category.
- **Inventory Optimization:** Explore how `Purchase_Quantity` decisions
  affect `Remaining_Stock` and downstream waste.
- **Expiry Prediction:** Model relationships between `Shelf_Life_Days`,
  `Storage_Temperature`, and `Waste_Reason == "Expired"`.
- **Sustainability Analysis / EDA:** Waste trends by business type, food
  category, weather, and season; donation-rate analysis.
- **Feature Engineering practice:** e.g. sell-through rate
  (`Units_Sold / Purchase_Quantity`), waste ratio
  (`Waste_Quantity / Purchase_Quantity`), day-of-week/season from `Date`.



## License / Usage

This dataset is entirely synthetic — no real business or customer data was
used. It is free to use for learning, portfolio projects, and publishing
(e.g. on Kaggle), with attribution appreciated.
