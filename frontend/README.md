# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.


## Harvest Growth login setup

1. Open https://dashboard.clerk.com and create an application named Harvest Growth (or select your existing FoodFit application). Enable Email and Password authentication and allow sign-ups. Keep email verification enabled. Use the Development instance for localhost.
2. Under Configure → API keys, copy the Publishable key (`pk_test_…`). Never put a secret key in frontend files.
3. Copy `frontend/.env.example` to `frontend/.env.local` (paths from repository root). Replace its placeholder with the real key:
   ```dotenv
   VITE_CLERK_PUBLISHABLE_KEY=pk_test_YOUR_ACTUAL_KEY
   ```
   Git ignores `.env.local` via `*.local`.
4. From `frontend/`, run `npm install` and `npm run dev -- --host localhost --port 5173`. Restart Vite after changing environment variables. Open http://localhost:5173.

This Vite SPA uses `@clerk/react`, following the [React quickstart](https://clerk.com/docs/react/getting-started/quickstart) and [authentication page guide](https://clerk.com/docs/react/guides/development/custom-sign-in-or-up-page). The provider configures sign-in at `/sign-in`, sign-up at `/sign-up`, success at `/dashboard`, and sign-out at `/`. Clerk handles verification, recovery, validation, and persistent sessions.

Development instances support localhost without a production domain or an additional redirect allowlist for these same-origin redirects. If setting application paths in Clerk's dashboard, use local sign-in `http://localhost:5173/sign-in`, sign-up `http://localhost:5173/sign-up`, and home `http://localhost:5173/`. No custom OAuth callback route is needed. Optional social providers require their own Clerk setup; use email/password initially.

Without a key the landing remains public, and authentication/protected routes display setup instructions. Route guards protect frontend navigation only, not public datasets or backend endpoints. Private APIs require server-side token validation and authorization.

### Verification

Run `npm run lint` and `npm run build` in `frontend/`. No browser test suite is currently configured.

With a valid development key:
- Signed out, open `/`, use START, create an account, finish verification, and confirm `/dashboard` opens.
- Use the account avatar to sign out; confirm `/` opens. Use START and log in again. Test recovery and invalid credentials using Clerk's forms.
- Refresh `/dashboard` and confirm the session persists. Visit `/sign-in` and `/sign-up` while signed in; both should redirect to the dashboard.
- Use Planner to open `/heatmap`, test the map/simulator, and return via Dashboard or browser Back. Refresh both direct URLs.
- Signed out, visit `/dashboard` and `/heatmap`; confirm sign-in opens without showing protected content.
- Repeat at 375px width and using keyboard Tab/Enter, checking START, home links, forms, navigation, and account controls.

Vite supports local SPA deep links. A future static host must rewrite unknown routes to `index.html` for direct URLs and refresh. No hosting changes or deployment are included here.
