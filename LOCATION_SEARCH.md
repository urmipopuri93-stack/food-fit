# Experimental dashboard location search

Isolated checkout of feat/location-search. The completed feat/donation-what-if project is not modified. Nothing has been pushed from this checkout.

## Run
Install LocationBackend/requirements.txt in a Python virtual environment. From project root: python -m uvicorn main:app --app-dir LocationBackend --port 8002

In frontend: npm ci, then npm run dev -- --host 127.0.0.1 --port 5176. Open http://127.0.0.1:5176/dashboard. The Vite dev proxy forwards /api/geocode to 8002; LOCATION_API_TARGET changes that target. For a deployed frontend configure VITE_LOCATION_API_URL and the backend CORS origins or route the endpoint through the same origin.

Enter an address, city or ZIP; choose 10/25/50/100 miles; submit. Only areas within that distance are ranked by the existing overall barrier score; the top three receive population-times-score proportional kit allocations. Fewer than three matches are allowed. Distances are straight-line to polygon bounding-box centers, not travel routes. Texas data only. The matched geocoder label is displayed so users can verify the location. Clear Search restores statewide recommendations. Changing the distance requires resubmitting the search.

Fixes: Record lookup instead of Map.get, enforced 100-mile maximum, timeout/cancel handling, abort on clear/unmount, same-origin development proxy, geocoder application identification without requiring an email, and distance labels on recommendations. Optional GEOCODER_CONTACT_EMAIL and GEOCODER_URL configure the provider. Production backend should run one process for the in-memory geocoder rate limiter/cache to apply globally.

Geocoding uses the existing Nominatim provider under https://operations.osmfoundation.org/policies/nominatim/. No autocomplete or bulk lookup; user-submit only, cached and at most one upstream request per second. OSM attribution is shown. No private/confidential information should be submitted to the public provider. Before broader deployment choose a provider with appropriate address-data terms and scale limits. API errors are shown instead of inventing coordinates.

## Verification
node --test frontend/src/utils/nearbyRecommendations.test.mjs (Node 24+ supporting TypeScript stripping); frontend npm run build. Tests cover distance, invalid radius, missing coordinates, Dallas 10 vs 100 miles, out-of-region empty result and immutable data. Live backend and browser: Dallas TX 75201 resolved successfully. Top three within 10 miles: Dallas areas 008604 (4.4 mi), 002701 (3.3 mi), 020500 (3.9 mi); kit allocations 318+337+585=1240. Optional email was not required.
