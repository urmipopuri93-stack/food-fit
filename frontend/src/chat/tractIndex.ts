// Deterministic, read-only access to FoodFit tract data for the chatbot.
// Everything the chatbot says about a place comes from here, never from the model.
// Missing values are returned as null — never coerced to 0.

import type { FeatureCollection, Geometry, Position } from "geojson";
import { TABS, tractName, valueFor, type TabId, type TractProperties } from "../heatmapLayers";
import { DATA_METADATA } from "./dataMetadata";

export type Bounds = { south: number; west: number; north: number; east: number };

export type CountyInfo = { name: string; geoids: string[]; bounds: Bounds };

export type TractIndex = {
  tracts: Map<string, TractProperties>;
  tractBounds: Map<string, Bounds>;
  counties: Map<string, CountyInfo>; // key: normalised name
  fullBounds: Bounds | null;
};

export type CountyResolution =
  | { status: "found"; county: CountyInfo }
  | { status: "ambiguous"; query: string; options: string[] }
  | { status: "not_found"; query: string }
  | { status: "invalid"; query: string };

export const GEOID_PATTERN = /^48\d{9}$/;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function round1(v: number | null): number | null {
  return v === null ? null : Math.round(v * 10) / 10;
}

function extend(b: Bounds | null, lng: number, lat: number): Bounds {
  if (!b) return { south: lat, north: lat, west: lng, east: lng };
  return {
    south: Math.min(b.south, lat),
    north: Math.max(b.north, lat),
    west: Math.min(b.west, lng),
    east: Math.max(b.east, lng),
  };
}

function mergeBounds(a: Bounds | null, b: Bounds): Bounds {
  if (!a) return { ...b };
  return {
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
  };
}

function geometryBounds(g: Geometry | null): Bounds | null {
  if (!g) return null;
  let b: Bounds | null = null;
  const visit = (ring: Position[]) => {
    for (const [lng, lat] of ring) {
      if (Number.isFinite(lng) && Number.isFinite(lat)) b = extend(b, lng, lat);
    }
  };
  if (g.type === "Polygon") g.coordinates.forEach(visit);
  else if (g.type === "MultiPolygon") g.coordinates.forEach((poly) => poly.forEach(visit));
  return b;
}

export function normaliseCountyQuery(query: string): string | null {
  if (typeof query !== "string") return null;
  const q = query
    .toLowerCase()
    .trim()
    .replace(/,?\s*(tx|texas)\.?$/i, "")
    .replace(/\s+(county|co\.?)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!q || q.length > 40 || !/^[a-z][a-z .'-]*$/.test(q)) return null;
  return q;
}

export function buildTractIndex(data: FeatureCollection<Geometry, TractProperties>): TractIndex {
  const tracts = new Map<string, TractProperties>();
  const tractBounds = new Map<string, Bounds>();
  const counties = new Map<string, CountyInfo>();
  let fullBounds: Bounds | null = null;

  for (const f of data.features) {
    const p = f.properties;
    if (!p || typeof p.GEOID !== "string" || typeof p.County !== "string") continue;
    const b = geometryBounds(f.geometry);
    tracts.set(p.GEOID, p);
    if (b) {
      tractBounds.set(p.GEOID, b);
      fullBounds = mergeBounds(fullBounds, b);
    }
    const key = normaliseCountyQuery(p.County) ?? p.County.toLowerCase();
    const existing = counties.get(key);
    if (existing) {
      existing.geoids.push(p.GEOID);
      if (b) existing.bounds = mergeBounds(existing.bounds, b);
    } else if (b) {
      counties.set(key, { name: p.County, geoids: [p.GEOID], bounds: b });
    }
  }
  return { tracts, tractBounds, counties, fullBounds };
}

export function resolveCounty(index: TractIndex, query: unknown): CountyResolution {
  const raw = typeof query === "string" ? query.slice(0, 80) : "";
  const q = normaliseCountyQuery(raw);
  if (!q) return { status: "invalid", query: raw };
  const exact = index.counties.get(q) ?? index.counties.get(q.replace(/[ .'-]/g, ""));
  if (exact) return { status: "found", county: exact };
  // Only a strict prefix counts as a possible match; we never guess beyond that.
  const options = [...index.counties.values()]
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .map((c) => `${c.name} County`)
    .sort()
    .slice(0, 8);
  if (options.length > 0) return { status: "ambiguous", query: raw, options };
  return { status: "not_found", query: raw };
}

export type ScoreSet = {
  overall_need_score: number | null;
  income_score: number | null;
  transportation_score: number | null;
  grocery_score: number | null;
};

const SCORE_KEYS = ["overall_need_score", "income_score", "transportation_score", "grocery_score"] as const;
const RAW_KEYS = ["poverty_rate", "no_vehicle_pct", "low_access_pct"] as const;

export type TractSummary = {
  kind: "tract";
  geoid: string;
  name: string;
  county: string;
  population: number | null;
  urban: boolean | null;
  scores: ScoreSet;
  observed: { income: boolean | null; transportation: boolean | null; grocery: boolean | null };
  raw_indicators: Record<(typeof RAW_KEYS)[number], number | null>;
  notes: string[];
};

export type CountySummary = {
  kind: "county";
  name: string;
  tract_count: number;
  population: number | null;
  scores: ScoreSet;
  score_aggregation: string;
  tracts_with_observed_grocery_data: number;
  raw_indicators: Record<(typeof RAW_KEYS)[number], { value: number | null; tracts_missing: number }>;
  highest_overall_need_tract: { geoid: string; name: string; score: number } | null;
  notes: string[];
};

export const SOURCE_NOTE = {
  sources: DATA_METADATA.sources.map((s) => `${s.name} (${s.year})`),
  warning: DATA_METADATA.warning,
};

export function summarizeTract(index: TractIndex, geoid: unknown): TractSummary | null {
  if (typeof geoid !== "string" || !GEOID_PATTERN.test(geoid)) return null;
  const p = index.tracts.get(geoid);
  if (!p) return null;
  // Tract values are returned at source precision so they match the data file exactly.
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, num(p[k])])) as ScoreSet;
  const raw = Object.fromEntries(RAW_KEYS.map((k) => [k, num(p[k])])) as TractSummary["raw_indicators"];
  const observed = {
    income: bool(p.income_observed),
    transportation: bool(p.transportation_observed),
    grocery: bool(p.grocery_observed),
  };
  const notes: string[] = [];
  for (const [k, v] of Object.entries(observed)) {
    if (v === false) notes.push(`No observed ${k} source value for this tract; the ${k} score is a model estimate only.`);
  }
  for (const [k, v] of Object.entries(raw)) {
    if (v === null) notes.push(`${k} is missing (not zero).`);
  }
  const urban = num(p.Urban);
  return {
    kind: "tract",
    geoid,
    name: tractName(p),
    county: p.County,
    population: num(p.TotalPop),
    urban: urban === null ? null : urban === 1,
    scores,
    observed,
    raw_indicators: raw,
    notes,
  };
}

function weightedMean(values: Array<[number | null, number | null]>): { value: number | null; missing: number } {
  let sum = 0;
  let weight = 0;
  let missing = 0;
  for (const [v, w] of values) {
    if (v === null || w === null || w <= 0) {
      missing++;
      continue;
    }
    sum += v * w;
    weight += w;
  }
  return { value: weight > 0 ? round1(sum / weight) : null, missing };
}

export function summarizeCounty(index: TractIndex, county: CountyInfo): CountySummary {
  const rows = county.geoids.map((g) => index.tracts.get(g)).filter((p): p is TractProperties => !!p);
  const pops = rows.map((p) => num(p.TotalPop));
  const knownPops = pops.filter((v): v is number => v !== null);
  const scores = Object.fromEntries(
    SCORE_KEYS.map((k) => [k, weightedMean(rows.map((p, i) => [num(p[k]), pops[i]])).value]),
  ) as ScoreSet;
  const raw = Object.fromEntries(
    RAW_KEYS.map((k) => {
      const r = weightedMean(rows.map((p, i) => [num(p[k]), pops[i]]));
      return [k, { value: r.value, tracts_missing: r.missing }];
    }),
  ) as CountySummary["raw_indicators"];
  let top: CountySummary["highest_overall_need_tract"] = null;
  for (const p of rows) {
    const s = num(p.overall_need_score);
    if (s !== null && (num(p.TotalPop) ?? 0) > 0 && (!top || s > top.score)) {
      top = { geoid: p.GEOID, name: tractName(p), score: s };
    }
  }
  const observedGrocery = rows.filter((p) => p.grocery_observed === true).length;
  const notes = [
    "County values are population-weighted averages of tract scores, not a separate county percentile.",
  ];
  if (observedGrocery < rows.length) {
    notes.push(`${rows.length - observedGrocery} of ${rows.length} tracts have no observed grocery-access value; their grocery scores are model estimates only.`);
  }
  return {
    kind: "county",
    name: `${county.name} County`,
    tract_count: rows.length,
    population: knownPops.length ? knownPops.reduce((a, b) => a + b, 0) : null,
    scores,
    score_aggregation: "population-weighted mean of tract scores (tracts with population > 0)",
    tracts_with_observed_grocery_data: observedGrocery,
    raw_indicators: raw,
    highest_overall_need_tract: top,
    notes,
  };
}

export type LocationRef = { kind: "county" | "tract"; id: string };

export type LocationLookup =
  | { ok: true; summary: TractSummary | CountySummary }
  | { ok: false; error: string; message: string; options?: string[] };

export function isLocationRef(v: unknown): v is LocationRef {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (r.kind === "county" || r.kind === "tract") && typeof r.id === "string" && r.id.length <= 80;
}

export function lookupLocation(index: TractIndex, ref: LocationRef): LocationLookup {
  if (ref.kind === "tract") {
    if (!GEOID_PATTERN.test(ref.id)) {
      return { ok: false, error: "invalid_geoid", message: "A tract GEOID must be 11 digits starting with 48." };
    }
    const s = summarizeTract(index, ref.id);
    return s ? { ok: true, summary: s } : { ok: false, error: "not_found", message: `Tract ${ref.id} is not in FoodFit data.` };
  }
  const r = resolveCounty(index, ref.id);
  switch (r.status) {
    case "found":
      return { ok: true, summary: summarizeCounty(index, r.county) };
    case "ambiguous":
      return { ok: false, error: "ambiguous", message: `"${r.query}" matches more than one county or is incomplete.`, options: r.options };
    case "not_found":
      return {
        ok: false,
        error: "not_found",
        message: `"${r.query}" is not a Texas county in FoodFit data. FoodFit groups data only by county and census tract; city and neighbourhood names are not available.`,
      };
    default:
      return { ok: false, error: "invalid", message: "That is not a valid county name." };
  }
}

export type Comparison =
  | {
      ok: true;
      kind: "county" | "tract";
      a: TractSummary | CountySummary;
      b: TractSummary | CountySummary;
      difference_a_minus_b: ScoreSet;
      comparability_notes: string[];
    }
  | { ok: false; error: string; message: string; options?: string[] };

export function compareLocations(index: TractIndex, a: LocationRef, b: LocationRef): Comparison {
  if (a.kind !== b.kind) {
    return {
      ok: false,
      error: "incompatible_kinds",
      message: "A county and a census tract are different geographic levels, so their values are not directly comparable. Compare two counties or two tracts.",
    };
  }
  const la = lookupLocation(index, a);
  if (!la.ok) return la;
  const lb = lookupLocation(index, b);
  if (!lb.ok) return lb;
  const keyA = la.summary.kind === "tract" ? la.summary.geoid : la.summary.name;
  const keyB = lb.summary.kind === "tract" ? lb.summary.geoid : lb.summary.name;
  if (keyA === keyB) {
    return { ok: false, error: "same_location", message: "Both references point to the same location." };
  }
  const diff = Object.fromEntries(
    SCORE_KEYS.map((k) => {
      const x = la.summary.scores[k];
      const y = lb.summary.scores[k];
      return [k, x === null || y === null ? null : round1(x - y)];
    }),
  ) as ScoreSet;
  const notes = [
    "All scores are Texas-relative percentile ranks of historical model estimates (same definitions, units and reference years for both locations).",
    "A difference in score is a difference in estimated relative barrier, not a measured difference in food insecurity.",
  ];
  if (la.summary.kind === "county" && lb.summary.kind === "county") {
    notes.push("County figures are population-weighted averages of their tracts.");
    const ca = la.summary;
    const cb = lb.summary;
    const shareA = ca.tracts_with_observed_grocery_data / Math.max(1, ca.tract_count);
    const shareB = cb.tracts_with_observed_grocery_data / Math.max(1, cb.tract_count);
    if (Math.abs(shareA - shareB) > 0.2) {
      notes.push(`Observed grocery-access coverage differs: ${Math.round(shareA * 100)}% of tracts in ${ca.name} vs ${Math.round(shareB * 100)}% in ${cb.name}, so grocery scores rely on model estimates to different degrees.`);
    }
  } else if (la.summary.kind === "tract" && lb.summary.kind === "tract") {
    if (la.summary.observed.grocery !== lb.summary.observed.grocery) {
      notes.push("Only one of these tracts has an observed grocery-access value; the other's grocery score is a model estimate.");
    }
  }
  return { ok: true, kind: a.kind, a: la.summary, b: lb.summary, difference_a_minus_b: diff, comparability_notes: notes };
}

export function listTopTracts(index: TractIndex, layer: TabId, county: CountyInfo | null, limit: number) {
  const pool = county
    ? county.geoids.map((g) => index.tracts.get(g)).filter((p): p is TractProperties => !!p)
    : [...index.tracts.values()];
  // Same eligibility rule as the sidebar's Top 3 in HeatmapPage.
  return pool
    .filter((p) => num(valueFor(p, layer)) !== null && (num(p.TotalPop) ?? 0) > 0)
    .sort((x, y) => valueFor(y, layer) - valueFor(x, layer))
    .slice(0, limit)
    .map((p, i) => ({
      rank: i + 1,
      geoid: p.GEOID,
      name: tractName(p),
      score: valueFor(p, layer),
      population: num(p.TotalPop),
    }));
}

export function layerLabel(layer: TabId): string {
  return TABS.find((t) => t.id === layer)!.label;
}

/** Which values are missing (null — not zero) across the loaded tracts, overall and by county. */
export function coverageReport(index: TractIndex) {
  const tracts = [...index.tracts.values()];
  const missingScores = Object.fromEntries(SCORE_KEYS.map((k) => [k, tracts.filter((p) => num(p[k]) === null).length]));
  const rawMissing = Object.fromEntries(RAW_KEYS.map((k) => [k, tracts.filter((p) => num(p[k]) === null).length]));
  const unobserved = {
    income: tracts.filter((p) => p.income_observed === false).length,
    transportation: tracts.filter((p) => p.transportation_observed === false).length,
    grocery: tracts.filter((p) => p.grocery_observed === false).length,
  };
  const byCounty = [...index.counties.values()].map((c) => {
    const rows = c.geoids.map((g) => index.tracts.get(g)).filter((p): p is TractProperties => !!p);
    return { county: c.name, total: rows.length, missing: rows.filter((p) => p.grocery_observed === false).length };
  });
  return {
    total_tracts: tracts.length,
    counties: index.counties.size,
    tracts_missing_scores: missingScores,
    raw_missing: rawMissing,
    unobserved_source_values: unobserved,
    counties_with_unobserved_grocery: byCounty
      .filter((c) => c.missing > 0)
      .sort((a, b) => b.missing / b.total - a.missing / a.total || b.missing - a.missing || a.county.localeCompare(b.county))
      .slice(0, 10),
    counties_fully_observed: byCounty.filter((c) => c.missing === 0).length,
  };
}
