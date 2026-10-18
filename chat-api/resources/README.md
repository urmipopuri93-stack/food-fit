# Food resources (Phase 2)

## Data
| | |
|---|---|
| Source file | `data/resources/source/LocationListInfo.csv`, an export of an agency list (`LocationListInfo.pdf`) covering **15 miles around Executive Education Center, 790 Drive E, Richardson, TX 75080**. It was added to the repo on branch `manila/data` (commit `5c072ba`, 2026-10-17). |
| Publisher / capture date | **Not recorded.** The UI and the chatbot say "capture date not recorded" until you rebuild with `--captured-at` and `--publisher`. |
| Records | 34 programs at 20 organizations: food distribution (17), SNAP application help (11), CSFP senior boxes (1), other non-food services (5). |
| Coordinates | US Census Geocoder (`Public_AR_Current`), run 2026-10-18. 13 of 20 addresses matched, giving coordinates for 24 of the 34 records. The 7 unmatched addresses get **no marker and no distance**. Results: `data/resources/source/geocode_census.csv`. |
| Licence | Unconfirmed. Get permission from the list's publisher before public use. |

## Normalization rules (`build_snapshot.py`)
- Values are copied from the source. A missing value stays `null`; nothing is filled in.
- **Hours.** The original text is kept as written. A weekly schedule is parsed only from entries like "Monday 9:00 AM - 1:00 PM". Qualifiers such as "1st, 3rd Week of Month" are kept and marked `recurrence_limited`. Holiday closures are parsed into dates.
- **Programs that say to call.** A program that says "Call for Information" never inherits its host organization's office hours.
- **Personal details are dropped.** That includes contact names and personal or gmail addresses. Generic mailboxes such as `info@` are kept. An email whose domain looks like a typo of the website's domain is omitted with a note.

Rebuild after you confirm provenance:
```bash
cd chat-api
python -m resources.build_snapshot --captured-at 2026-10-15 --publisher "North Texas Food Bank"
python -m resources.build_snapshot --geocode   # re-geocode (needs internet)
```

## API
- `GET /api/resources/meta`: counts, coverage bounds, source and freshness, and today's date in America/Chicago.
- `GET /api/resources/search?lat&lng&radius_miles(≤25)&category(repeatable)&day(today|Monday…)&limit(≤25)`
  - Results are sorted by **straight-line** distance.
  - Resources with no parseable hours are reported separately under `hours_unknown_in_radius`.
  - Resources with no verified location are listed under `unlocated`, with no distance.
  - `out_of_coverage` is set when the search is outside the list's area.
- `GET /api/resources/{id}`

## Adding a real, maintained source
Implement the `ResourceProvider` protocol in `service.py`: `records()`, `source()`, `skipped()`. Map the source's fields onto `models.Resource` and pass the provider to `ResourceService`. Keep any API key in `.env`. Candidates:
- North Texas Food Bank / Vivery Find Food Map. NTFB re-verifies pantries every 90 days. Needs a data-sharing agreement.
- 211 National Data Platform API. A trial key is available; full access is by request.
