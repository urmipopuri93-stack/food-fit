# FoodFit map add-on

Adds a live "Pantry Map" panel to the team's dashboard without replacing their files.
It matches the retro dashboard style on `main` and `landing`, and the older Tailwind-card
dashboard too (the script picks the right one).

## Steps

1. Start from the team's latest code, on a new branch (commit or stash your work first):

       git fetch origin
       git switch -c feature/map-on-dashboard origin/main

   (Use `origin/landing` instead if that is the version you want to build on.)

2. Extract this zip into the `food-fit` folder. It adds `MapBackend`, `Map` and `map-addon`
   and does not touch `frontend`.

3. Backend (first time only: `python -m venv .venv`, `.venv\Scripts\activate`, `pip install -r requirements.txt`):

       cd MapBackend
       .venv\Scripts\activate
       python -m uvicorn app.main:app --reload

4. Load the five pantries once: open http://localhost:8000/docs, `POST /points/bulk`, Try it out,
   paste `map-addon/seed-pantries.json`, Execute.

5. From `food-fit`, add the map to the frontend:

       node map-addon/apply-map.mjs

   This copies `PantryMap.tsx` into `frontend/src`, adds the import and `<PantryMap />` to
   `App.tsx`, and installs `leaflet` and `react-leaflet` (v5 for React 19, v4 for React 18).

6. `cd frontend`, then `npm run dev`.

7. Commit:

       git add frontend MapBackend Map
       git commit -m "Add pantry map panel and backend"

If the team's `App.tsx` layout changes and the script can't find the spot, it tells you the two
lines to add by hand. Running it twice is safe.

## Undo

    git restore frontend/src/App.tsx frontend/package.json frontend/package-lock.json
    del frontend\src\PantryMap.tsx

## Notes

- `npm run build` currently fails on the team's branches because of unused imports they left in
  `App.tsx` (TS6133). `npm run dev` is not affected. That is separate from the map.
- Backend points need `props` like `{"location": "...", "demand": 120, "stock": 40}`.
- Change the backend address with `VITE_API_URL` in `frontend/.env`.
- Don't commit `.venv`, `node_modules`, `*.db`, or `.pem` files. Also don't run `npm install` in the
  `food-fit` root: that created the stray root `package.json` on `feature/map`.
- `Map` is a standalone copy of the map (`cd Map`, `npm install`, `npm run dev`) for testing
  without touching `frontend`.
