# Login and donation integration

Branch: `manila/login-donation-integration`, based on `origin/manila/login-page` and merged with `origin/feat/donation-what-if`.

## Combined behavior

Landing START opens Clerk sign-in for signed-out users, or the dashboard for signed-in users. Sign-in and sign-up route through the existing Clerk provider. Dashboard Planner opens the protected `/heatmap` page, including the donation simulator and radius/income controls. Planner Home and Dashboard links use React Router.

The sole merge conflict was `frontend/src/main.tsx`: retained the Clerk AuthRouter instead of the donation branch's unguarded routes and global navigation bar. Equivalent navigation remains in the dashboard and planner without altering the landing design. Removed the global document overflow lock so the below-map simulator and its results are reachable on desktop; the dashboard retains its own fixed layout and internal scrolling. Existing datasets, scoring, calculations, and data preparation script are retained.

The donation branch supplies packaged target data and `scripts/prepare_donation_targets.py`, not a running backend service. The website uses packaged dashboard/heatmap JSON/GeoJSON and needs no Python process for this feature. Data regeneration is optional; see DONATION_SIMULATION.md.

Clerk dependencies and the login branch's lockfile remain intact; the donation feature adds no npm dependencies. Added `npm test` for the existing donation/radius tests. Environment variable names and local configuration are unchanged. `.env` and `.env.*` are now ignored alongside node_modules and build outputs.

## Local run

Keep your existing ignored `frontend/.env.local` with `VITE_CLERK_PUBLISHABLE_KEY` set to your development publishable key. Do not commit environment files or secrets.

```sh
cd ~/Desktop/food-fit
# After switching to this branch, if needed:
# git switch manila/login-donation-integration
cd frontend
npm ci
npm run dev -- --host localhost --port 5173 --strictPort
```

Open http://localhost:5173. Sign in, choose Planner, select an area, enter meal kits, and run the simulation. Use the Dashboard link to return. Account controls are on the dashboard.

## Validation

- `npm ci`: successful; audit reports no vulnerabilities.
- `npm run build`: TypeScript and production Vite build pass. Existing bundle-size warning remains.
- `npm run lint`: passes with two inherited heatmap warnings (state update in effect from donation branch, ref cleanup from login/shared base).
- `npm test`: all seven donation/radius tests pass, including real map ID joins and conservation/validation checks.
- Actual app browser checks: public landing, START, real Clerk sign-in/sign-up forms, links between forms, signed-out dashboard/heatmap redirects, and browser Back.
- Isolated browser component checks (not a Clerk session): 5,238 heatmap polygons render; actual donation target data loads; for target 327, donating 100 produces 30.6% coverage and 227 remaining, while 500 produces 100% and 173 surplus. Desktop document can scroll to simulator; 375px viewport has no horizontal overflow. No runtime exceptions occurred in the working harness. The harness observed intentional localhost request aborts during StrictMode effect cleanup, with no failed application load.
- Not verified: completing account creation/verification, a signed-in dashboard session, refresh persistence, signed-in route redirects, dashboard-to-planner navigation within a real session, and sign-out. These require interactive authentication; no fake session or test account was created.
