// Service-gap finder: which high-need census tracts are farthest from any food listing in
// FoodFit's resource list? It joins the ML need scores already on the map with the geocoded
// resource locations. Everything here is computed from loaded data; nothing is estimated or
// invented. Distances are straight-line from each tract's bounding-box centre.

import type { TractIndex } from "./tractIndex";
import { resolveCounty } from "./tractIndex";
import type { LocationsResponse, ResourceLocation } from "../resources/types";
import type { ToolResult } from "./types";

const EARTH_MI = 3958.8;
export function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.sqrt(a));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

export const GAP_CAVEATS = [
  "Only listings in FoodFit's resource list are counted (Richardson, Plano and North Dallas area); other pantries, stores or programs may exist nearby.",
  "Distances are straight-line from the centre of each tract, not travel distance or time.",
  "Need scores are model estimates from historical data (see the map's sources), not current conditions.",
  "This is a screening aid to decide where to look closer, not a needs assessment.",
];

export function findServiceGaps(
  index: TractIndex,
  data: LocationsResponse,
  opts: { county?: string | null; limit?: number },
): ToolResult {
  const limit = opts.limit ?? 5;
  const locs: ResourceLocation[] = data.locations;
  if (!data.coverage || locs.length === 0) {
    return { ok: false, error: "no_locations", message: "FoodFit's resource list has no mapped locations, so service gaps can't be measured." };
  }
  const cov = data.coverage;

  let countyName: string | null = null;
  let candidates = [...index.tracts.keys()];
  if (opts.county) {
    const res = resolveCounty(index, opts.county);
    if (res.status !== "found") {
      return { ok: false, error: res.status === "ambiguous" ? "ambiguous" : "not_found", message: `"${String(opts.county)}" is not a Texas county in FoodFit data.` };
    }
    countyName = res.county.name;
    const inCounty = new Set(res.county.geoids);
    candidates = candidates.filter((g) => inCounty.has(g));
  }

  type Row = { geoid: string; county: string; need: number; pop: number; dist: number; nearest: ResourceLocation };
  const covered: Row[] = [];
  for (const geoid of candidates) {
    const p = index.tracts.get(geoid);
    const b = index.tractBounds.get(geoid);
    if (!p || !b || p.overall_need_score === null || !p.TotalPop || p.TotalPop <= 0) continue;
    const lat = (b.south + b.north) / 2;
    const lng = (b.west + b.east) / 2;
    // Only measure inside the area the list covers; beyond it, "far from a listing" means "outside the list".
    if (haversineMi(lat, lng, cov.lat, cov.lng) > cov.reach_miles) continue;
    let best = locs[0];
    let dist = Number.POSITIVE_INFINITY;
    for (const l of locs) {
      const d = haversineMi(lat, lng, l.lat, l.lng);
      if (d < dist) {
        dist = d;
        best = l;
      }
    }
    covered.push({ geoid, county: p.County, need: p.overall_need_score, pop: p.TotalPop, dist, nearest: best });
  }

  if (covered.length === 0) {
    return {
      ok: false,
      error: "out_of_coverage",
      message: `${countyName ? `${countyName} County is` : "This area is"} outside the area FoodFit's resource list covers (about ${round1(cov.reach_miles)} mi around Richardson/Plano/North Dallas), so service gaps can't be measured there.`,
    };
  }

  const threshold = percentile(covered.map((r) => r.need), 75);
  const high = covered.filter((r) => r.need >= threshold);
  high.sort((a, b) => b.dist - a.dist || b.need - a.need);
  const gaps = high.slice(0, limit).map((r) => ({
    geoid: r.geoid,
    county: r.county,
    overall_need_score: round1(r.need),
    population: r.pop,
    nearest_resource: { id: r.nearest.id, name: r.nearest.name, city: r.nearest.city },
    distance_miles_straight_line: round1(r.dist),
  }));
  const dists = high.map((r) => r.dist);
  return {
    ok: true,
    area: countyName ? `the part of ${countyName} County covered by FoodFit's resource list` : "the area covered by FoodFit's resource list",
    tracts_analyzed: covered.length,
    high_need_threshold: round1(threshold),
    high_need_count: high.length,
    median_distance_high_need: round1(percentile(dists, 50)),
    listed_locations: locs.length,
    unlocated_listings: data.unlocated_count,
    gaps,
    method: "High-need = overall need score in the top quarter of tracts analyzed. Ranked by straight-line distance from each tract's centre to the nearest mapped food listing.",
    caveats: GAP_CAVEATS,
  };
}
