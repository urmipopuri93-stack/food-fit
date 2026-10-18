# FoodFit chat API (FitBasket map-aware chatbot)

A small FastAPI service behind the FoodFit heat-map page. It runs FitBasket's built-in
(deterministic) assistant, optionally calls IBM watsonx.ai, keeps any API key on the server,
and validates every request and response.

## How it works

1. The browser sends the conversation and the current map state to `POST /api/chat`.
2. The built-in assistant (`rules.py`) classifies the request. Map commands are always planned by it; other questions go to watsonx.ai (`/ml/v1/text/chat`) when it is configured, and to the built-in assistant otherwise.
3. If an action is needed, such as zooming to a county or reading a tract's data, it is returned to the browser as an allowlisted tool call plus a structured `map_action` with `status: "requested"`.
4. The browser validates it again, performs it against the real Leaflet map and the FoodFit data, and sends back the **actual** result.
5. The reply is written from that result. `map_action.status` becomes `"applied"` only when the browser's own verification says the map is in the new position; otherwise it is `"failed"` with a structured `error` and recovery suggestions.

The service never executes actions, never stores conversations, and never logs message content.

## Requirements
- **Python 3.10 or newer.** The macOS system `python3` is 3.9 and will stop with a clear message. Install a newer one with `brew install python@3.12`.
- **Node.js 20.19+ or 22.12+**, which Vite 8 requires. Check with `node -v`.

## Setup

```bash
cd chat-api
python3.12 -m venv .venv          # any Python 3.10+
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then fill in your values; .env is git-ignored
uvicorn main:app --port 8001 --reload
```

In a second terminal:

```bash
cd frontend
npm ci
npm run dev             # Vite proxies /api to http://127.0.0.1:8001
```

Then open http://localhost:5173/heatmap and click the FitBasket button in the bottom-right corner.

Health check: `curl localhost:8001/api/health` returns `ok`, `ai_configured`, `ai_missing` (variable **names** only), `assistant`, `env_file_found`, `geography_loaded` and `resource_cities`. It never returns secret values.

## Environment variables (`chat-api/.env`)

| Variable | Required | Purpose |
|---|---|---|
| `WATSONX_API_KEY` | yes | IBM Cloud API key. It is exchanged for an IAM token on the server only. |
| `WATSONX_PROJECT_ID` | yes | The watsonx.ai project ID. |
| `WATSONX_URL` | yes | Your region's endpoint, e.g. `https://us-south.ml.cloud.ibm.com`. |
| `WATSONX_MODEL_ID` | no | A chat model in your project that supports tool calling. Default: `mistralai/mistral-large`. |
| `WATSONX_TIMEOUT_S` | no | Provider timeout in seconds. Default: 30. |
| `ALLOWED_ORIGINS` | no | Comma-separated CORS origins. Default: `http://localhost:5173`. |
| `CHAT_RATE_LIMIT_PER_MIN` | no | Requests per minute per IP. Default: 30. One user message is usually 1–3 requests. |
| `WATSONX_IAM_URL` | no | Override the IAM token URL. Used only for testing. |
| `TRACT_GEOJSON_PATH` | no | Tract GeoJSON used to recognise county names. Default: `../frontend/public/data/texas_heatmap.geojson`. |
| `RESOURCE_RATE_LIMIT_PER_MIN` | no | Resource API requests per minute per IP. Default: 60. |
| `FRONTEND_DIST` | no | Serve the built frontend from this process (see Deploying). |

If the watsonx variables are missing, FitBasket's built-in assistant answers everything and labels its replies "Answered by FitBasket's built-in assistant — The AI model isn't configured on this server…". Nothing else changes.

**Enable IBM watsonx.ai:** put `WATSONX_API_KEY`, `WATSONX_PROJECT_ID` and `WATSONX_URL` in `chat-api/.env` (never in `frontend/` or any `VITE_*` variable), restart uvicorn, and check that `curl -s http://127.0.0.1:8001/api/health` shows `"ai_configured": true`. Model output is validated before anything reaches the browser: only allowlisted tools with valid arguments are forwarded, map commands are never delegated to the model, and replies are rendered as text, never as HTML or script.

## Limits and safeguards

- Request body ≤ 96 KB, 60 messages, 2,000 characters per user message, and 5 tool calls per model reply.
- Only the 18 tools in `tools.py` are allowed. Unknown tool names from the model are dropped. A model-requested map action with invalid arguments is rejected on the server (the built-in assistant answers instead), and the browser validates every action again before anything runs.
- Validation errors never echo user input back.
- Provider failures map to clear codes: `not_configured` (503), `timeout` (504), `rate_limited` (429), `auth_failed`, `bad_response` and `provider_error` (502).

## Testing

```bash
# Backend unit tests
pip install -r requirements-dev.txt
pytest -q

# Frontend unit and UI tests
cd ../frontend
npm test

# Browser smoke tests (real UI + real chat-api, with a scripted fake watsonx)
cd ../chat-api
uvicorn dev.fake_watsonx:app --port 8099 &
CHAT_RATE_LIMIT_PER_MIN=500 WATSONX_URL=http://127.0.0.1:8099 \
  WATSONX_IAM_URL=http://127.0.0.1:8099/identity/token \
  WATSONX_API_KEY=test WATSONX_PROJECT_ID=test uvicorn main:app --port 8001 &
cd ../frontend
npm run dev &
npx playwright install chromium   # first time only
npm run test:e2e

# Phase 5 acceptance tests: NO credentials, real map, 5 window sizes (1920, 2560, Retina, 1440, phone).
# Verifies the real viewport (data-zoom / data-center / data-bounds / data-selected-county on the map
# element), not just the reply text, and fails on any browser console warning or error.
cd chat-api && env -u WATSONX_API_KEY -u WATSONX_PROJECT_ID -u WATSONX_URL CHAT_RATE_LIMIT_PER_MIN=1000 RESOURCE_RATE_LIMIT_PER_MIN=1000 uvicorn main:app --port 8001 &
cd ../frontend && npm run dev &
P5_URL=http://localhost:5173 npx playwright test e2e/phase5.spec.ts   # needs WATSONX_* empty in chat-api/.env too
#   or against the production build served by chat-api (FRONTEND_DIST, see Deploying):  P5_URL=http://127.0.0.1:8011

# Phase 4 browser tests: built-in assistant with NO credentials, plus an unreachable provider
cd frontend && npm run build && cd ../chat-api
env -u WATSONX_API_KEY -u WATSONX_PROJECT_ID -u WATSONX_URL FRONTEND_DIST="$PWD/../frontend/dist" uvicorn main:app --port 8011 &
FRONTEND_DIST="$PWD/../frontend/dist" WATSONX_API_KEY=x WATSONX_PROJECT_ID=x WATSONX_URL=http://127.0.0.1:9 \
  WATSONX_IAM_URL=http://127.0.0.1:9/identity/token WATSONX_TIMEOUT_S=5 uvicorn main:app --port 8012 &
cd ../frontend && P4_URL=http://127.0.0.1:8011 P4_OFFLINE_URL=http://127.0.0.1:8012 npx playwright test e2e/phase4.spec.ts
```

Note: with the scripted model configured, map commands are still answered by the built-in assistant (by design); the other questions go to the scripted model.

`dev/fake_watsonx.py` is **test-only**. It returns scripted tool calls and echoes tool results so the test can check what the UI shows. It is not an AI, and it must never be pointed at by a real deployment.

## Deploying

The frontend calls `/api/...` on its own origin. The Vite dev server proxies that path for you; a production host has to route it too. There are two supported setups.

**A. One process (recommended).** `chat-api` serves the built site and the API together. Direct links such as `/heatmap` work on reload.
```bash
cd frontend && npm ci && npm run build
cd ../chat-api && source .venv/bin/activate
FRONTEND_DIST="$(pwd)/../frontend/dist" uvicorn main:app --host 0.0.0.0 --port 8001
# open http://<host>:8001/heatmap
```

**B. Separate frontend host.** Static hosting, with the API somewhere else.
```bash
cd frontend && VITE_CHAT_API_BASE=https://api.example.org npm run build   # bakes the API origin into the bundle
# on the API server, .env:  ALLOWED_ORIGINS=https://www.example.org
```
The static host must send unknown paths to `index.html` (SPA fallback). Otherwise `/heatmap` returns 404 on reload.

If `/api` isn't routed to `chat-api`, the chat and resource panels say "isn't reachable at this address". The map itself still works.

## FitBasket assistant (Phase 4)

FitBasket answers in one of two ways, and every reply says which one answered.

| Who answers | When |
|---|---|
| **Built-in assistant** (`rules.py`, deterministic) | Always for map commands: show/zoom to a county or tract, zoom in/out, reset, change layer, clear resource search. An LLM is never allowed to choose a county or a map action. Also answers everything else when watsonx isn't configured, or when watsonx fails (timeout, rate limit, sign-in failure, unusable output). |
| **IBM watsonx.ai** | All other questions, when `WATSONX_API_KEY`, `WATSONX_PROJECT_ID` and `WATSONX_URL` are set. |

Either way, facts come from the same allowlisted tools, which the browser runs against the real map and data. The built-in assistant writes its answer **only** from those tool results: missing values say "missing", and nothing is invented.

The built-in assistant handles:
- county navigation: names, "X County", "X Co", aliases such as "ft bend". Ambiguous names like "Austin" get a clarification question; unknown names keep the map where it is.
- census tracts by GEOID
- zoom in/out, reset to the Texas overview, layer switching
- map explanations, data sources, county vs tract, "which counties have missing data?"
- county and tract summaries ("summarize this area" uses the selected tract, the county FitBasket last moved to, or the single visible county)
- service gaps: high-need tracts farthest from any listed food resource
- county comparisons
- food-resource searches in Richardson, Plano, North Dallas (Dallas addresses), Addison and Garland; a county; the map view; or the selected tract
- follow-ups ("contact the first one", "compare the first two", "show the first one on the map")
- help and unsupported requests

### Response contract (`POST /api/chat`)
Every response is validated by Pydantic (`assistant.py`) before it is sent. The original fields (`type`, `content`, `tool_calls`, `assistant_message`) are unchanged, so older callers keep working. Phase 5 added `message`, `map_action`, `data` and `error`.

| Field | Meaning |
|---|---|
| `type` | `"tool_calls"` (actions for the browser) or `"message"` (the answer) |
| `message` | The human-readable answer (same text as `content`). `null` on a `tool_calls` response: nothing is claimed until the browser reports back. |
| `intent` | The classified request, e.g. `navigate_county`, `reset_view`, `compare`, `resource_search`, `service_gaps`, `geography_level`, `unsupported` |
| `map_action` | `{type, arguments, status, result}` or `null`. `type` is one of `zoom_to_county`, `select_tract`, `zoom_in`, `zoom_out`, `reset_map`, `set_layer`; arguments are validated (county 1–60 chars, 11-digit Texas GEOID, known layer, 1–3 zoom steps). `status` is `"requested"` in round 1. In round 2 it is `"applied"` or `"failed"`, **as reported by the browser**, and `result` holds what the browser measured (county, selected_county, tract_count, zoom, center). |
| `geography` | `{level, name/names/id, validated}`. County names are checked against the same GeoJSON the map draws. |
| `data` | The browser-computed data the answer was written from: summary, comparison, coverage, resource or service-gap results. Truncated (and flagged) above 24 KB. |
| `suggestions` | Follow-up questions (shown as buttons). After a failed map action they start with a retry and "Reset the map". |
| `source` | `"rules"` or `"watsonx"`: who wrote the answer |
| `error` | `{code, message, retryable}` when a map action failed in the browser (e.g. `move_failed`), else `null` |
| `fallback_used` / `notice` | Whether the built-in assistant answered, and why (not configured, timeout, sign-in failure…) |
| `tool_calls` / `assistant_message` | The allowlisted calls the browser must execute (unchanged wire format) |

The server cannot move the map. It only **requests** an action; the frontend applies it with Leaflet, re-reads the map to verify it, and only then shows "Map moved to …".

### Where "The AI assistant isn't set up on this server yet" came from
Before Phase 4, `POST /api/chat` returned **HTTP 503 `not_configured`** whenever `WATSONX_API_KEY`, `WATSONX_PROJECT_ID` or `WATSONX_URL` was empty, for example in a fresh checkout or a `.env` copied from `.env.example` without values. The frontend showed that message, and every chat request failed.

Now:
- the server reads `chat-api/.env` next to `main.py` whatever directory you start it from
- surrounding quotes and spaces in values are ignored
- `GET /api/health` lists missing variable names (never values)
- the built-in assistant answers instead of failing

## Phase 5: map actions, diagnosis and examples

### What was wrong with "Show me Dallas County on the map"
Nothing upstream was broken. The built-in assistant resolved Dallas, the browser received `zoom_to_county {"county":"Dallas"}`, and Leaflet's `fitBounds` moved the map. The **verification** that runs afterwards (`frontend/src/chat/mapController.ts`) then wrongly reported failure. It required the visible area's longest side to be at most 4× the county's. On a wide map container (a 1920×1080 or larger window makes the map about 1600×560 px), fitting Dallas County correctly shows more than 4× its width. So the check failed, the chip said "Failed: The map did not move to the requested county.", and the answer repeated it. On a 1440×900 MacBook window it passed, which is why it looked intermittent.

**Fix:** the check now asks Leaflet for the zoom that fits the county in *this* container (`map.getBoundsZoom`, with the same padding) and confirms the map reached it with the county's centre in view. That is correct at any size or aspect ratio. Zooming to a county now also selects it: its tracts are outlined, the outline survives hover and layer changes, and it is cleared on reset. The selection is sent back as `selected_county` in the map context, so "Summarize this area" refers to that county. County geometry is sanity-checked before use (`invalid_geometry`), and unknown "X County" names are rejected on the server against the map's own GeoJSON, with "Did you mean…" suggestions.

### Diagnosing map-action failures
1. **Server side.** Run `curl -s localhost:8001/api/chat -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"Show me Dallas County"}]}'`. Expect `"map_action": {"type": "zoom_to_county", "arguments": {"county": "Dallas"}, "status": "requested", …}`. If `map_action` is null, the request wasn't recognised as a map command (check `intent`).
2. **Browser, network.** In DevTools → Network, open the second `/api/chat` request of the turn. Its last message is the browser's real tool result, e.g. `{"ok": true, "county": "Dallas County", "selected_county": "Dallas", "zoom": 10, "center": …}`, or `{"ok": false, "error": "move_failed" | "invalid_geometry" | "select_failed" | "not_found" | "map_unavailable" | "data_unavailable", "message": …}`.
3. **Browser, map state.** Inspect `<div class="heatmap-map">`. Its `data-zoom`, `data-center`, `data-bounds` and `data-selected-county` attributes mirror the live Leaflet viewport after every move.
4. **What the user sees.** A green chip ("Map moved to …") only after verification. Any failure shows a red chip and a "The map did not change" alert with a "Reset the map" button. A failed action is never shown as a success, even when the AI model writes the answer.

### Service-gap finder
"Where are the service gaps?" (optionally "…in Collin County") joins the model's tract need scores with the geocoded food listings (`GET /api/resources/locations`). It computes, in the browser, which high-need tracts are farthest in straight-line miles from any listed food resource:
- high-need = top quarter of overall need among the tracts analyzed
- only tracts inside the resource list's coverage area are analyzed; outside it, FitBasket says it can't measure
- answers repeat the caveats: list coverage, straight-line distance, modelled historical need, screening aid not a needs assessment
- follow-up buttons can show or summarize the top tract

### Tested chatbot examples (no IBM credentials)
| You type | Expected behaviour | Tested in |
|---|---|---|
| Show me Dallas County on the map | Map zooms to Dallas County, its tracts are outlined, green "Map moved to Dallas County", answer cites its 528 tracts | pytest, vitest (real Leaflet at 5 sizes), Playwright (5 window sizes) |
| Show me Dallas County. / Zoom into Dallas County, Texas. / DALLAS COUNTY!! / dallas co | Same `zoom_to_county {"county":"Dallas"}` | pytest |
| Take me to Collin County. / Show Tarrant County on the map. | Map moves to that county; the highlight follows | pytest, vitest, Playwright |
| Zoom out to show all of Texas. / Reset the map. / Show me the whole state again. / Show me all of Texas | Full Texas view, selection cleared | pytest, vitest, Playwright |
| Switch to census tracts. | Explains the map already shows census tracts (no fake switch) | pytest, Playwright |
| Switch to counties / Show county level | Explains there's no county-shaded layer; offers county zoom/summary | pytest |
| Show me Springfield County | "couldn't find "Springfield County" … left the map where it is"; map unchanged | pytest, Playwright |
| Show me Dalas County | Suggests "Did you mean Dallas County?" | pytest |
| Summarize this area (after a county zoom) | Summary of the selected county | pytest |
| Compare Dallas County and Collin County | Table whose values match population-weighted means of the GeoJSON | pytest, Playwright |
| Find food pantries in Plano | Only Plano listings from the resource list, with markers, "Call before visiting", no "open now" | pytest, Playwright |
| Where are the service gaps? | Table of high-need tracts farthest from a listed resource, with method and caveats; "Show tract …" button moves the map | pytest, vitest, Playwright |
| Service gaps in Harris County | "outside the area FoodFit's resource list covers … can't be measured" | pytest |
| Book me a flight to Paris | "I can't help with that one…" plus what FitBasket can do | pytest, Playwright |
| (map fails to move) | Red "Failed" chip, "The map did not change" alert, Retry/Reset suggestions; never a success | pytest, vitest |

## Food resources (Phase 2)

`GET /api/resources/search`, `/api/resources/{id}`, `/api/resources/meta` and `/api/resources/locations` (geocoded food listings for the service-gap finder) serve FoodFit's food-assistance list. The same server process runs them; no extra credentials are needed. For the data source, how it's normalized, and how to plug in a maintained source, see [`resources/README.md`](resources/README.md).

## Known limitations

- FoodFit data has only counties and census tracts. City and neighbourhood names (Fort Worth, Oak Cliff…) are not resolved. The assistant explains this and asks which county the user means.
- The scores are historical (ACS 2015 / USDA Atlas 2019) Texas-relative percentile ranks of model estimates. They are not current food-insecurity measurements.
- Rate limiting is in-memory and per process. Use a shared store if you run several workers.
- Model quality varies with `WATSONX_MODEL_ID`. All rules are enforced in code, but answer wording comes from the model.
