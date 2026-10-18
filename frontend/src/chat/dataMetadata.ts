// Provenance for the map data, transcribed from the pipeline that produced it:
//   ml/prepare_data.py  (sources and raw indicator definitions)
//   ml/predict.py       (score method, weights, prediction_metadata.json)
//   ml/export_geojson.py (tract boundaries)
// Update this file whenever the ML pipeline changes. Do not add anything here
// that cannot be traced to those scripts.

export const DATA_METADATA = {
  scope: "Texas census tracts (5,238 mapped tracts in 254 counties)",
  geographicLevels: ["county", "census tract"],
  notAvailable: [
    "City, neighbourhood, ZIP code or street-level data",
    "Current (real-time) food insecurity, demand or pantry availability",
    "Grocery store locations or prices",
  ],
  sources: [
    { name: "American Community Survey census-tract data", year: 2015, usedFor: "Population, poverty rate and model features" },
    { name: "USDA Food Access Research Atlas", year: 2019, usedFor: "No-vehicle households and low grocery access (1 mile urban / 10 miles rural)" },
    { name: "US Census TIGER/Line census-tract boundaries", year: 2019, usedFor: "Map polygons" },
  ],
  scoreMethod:
    "Each barrier score is a Texas-relative percentile rank (0-100) of a random-forest model's estimate of a historical indicator. 80 means the tract's estimate is higher than about 80% of Texas tracts. It is not a percentage of residents.",
  scores: {
    income_score: "Percentile rank of the model-estimated poverty rate (ACS 2015 'Poverty').",
    transportation_score: "Percentile rank of the model-estimated share of occupied housing units without a vehicle (USDA Atlas TractHUNV / OHU2010).",
    grocery_score: "Percentile rank of the model-estimated share of residents with low grocery access (USDA Atlas LAPOP1_10 / Pop2010).",
    overall_need_score: "Weighted sum: 0.4 × income + 0.3 × transportation + 0.3 × grocery. Prototype policy weights chosen by the team, not learned.",
  },
  rawIndicators: {
    poverty_rate: "Observed poverty rate (%) from ACS 2015, when available.",
    no_vehicle_pct: "Observed % of occupied housing units without a vehicle, when available.",
    low_access_pct: "Observed % of residents with low grocery access, when available.",
  },
  observedFlags:
    "When an *_observed flag is false, the source value was missing and that score comes only from the model's estimate.",
  warning:
    "Experimental estimates, not current food-insecurity measurements or validated allocation recommendations.",
  colourBins: "Each layer colours tracts in four bins by score: 0–24.9, 25–49.9, 50–74.9 and 75–100. Darker means a higher estimated barrier relative to other Texas tracts.",
  visualisation:
    "Choropleth: each census tract polygon is filled by its score. It is not a point-density heat map.",
} as const;
