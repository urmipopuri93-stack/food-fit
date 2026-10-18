# Donation what-if feature

On /heatmap, select an area on the map, ranking list, or dropdown, enter donated meal kits, and run the simulation. Results show estimated target coverage, kits applied, remaining kits, and any surplus. Clear and JSON download controls are included. Original heatmap predictions are unchanged. No donations are saved.

## Data and calculation
Source: manila/combined-data commit b3da75fa7cc5e87a806e2b4d6d31cc5dd65b7073, backend/data/original/usda_food_access_2019/Food Access Research Atlas.csv. LALOWI1_10 counts low-income residents beyond 1 mile (urban) or 10 miles (rural) from supermarkets. USDA 2019 access data uses 2010 population. Join uses full 11-digit Census IDs.

Estimated goal = ceil(LALOWI1_10), assuming one kit per listed resident for one distribution. This is an illustrative outreach goal, not observed demand, attendance, or a prediction that hunger will decrease. Missing counts disable the calculation; zero counts do not mean no hunger. The 5,238 map records include 3,349 positive targets, 181 zero counts and 1,708 unavailable counts.

Applied kits=min(donation,goal); remaining=max(0,goal-donation); surplus=max(0,donation-goal). Coverage=applied/goal*100. The helper retains a separate illustrative score for compatibility/export, but the interface presents kit counts rather than high/low scores. No retraining or modification of the original model is performed.

The source branch's fictional pantry records use kilograms and unrelated service-area IDs, so they cannot be substituted for real Texas demand. Existing stock, other donations, capacity, repeat visits and delivery losses are not modeled.

## Regeneration and checks
Fetch the source branch, then run python scripts/prepare_donation_targets.py from repository root. Generated frontend/public/data/donation_targets.json includes source provenance and can be served directly; users do not need Python to run the frontend.

From frontend: node --test src/utils/donationSimulation.test.mjs and npm run build. Five tests verify partial/full/zero/surplus donations, validation, conservation, monotonicity, and calculations against every supported real map ID. Browser verified target 327 with 100 donated: coverage 30.6%, remaining 227; 500 donated: remaining 0 and surplus 173.
