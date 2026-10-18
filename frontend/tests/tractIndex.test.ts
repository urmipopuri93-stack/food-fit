import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { FeatureCollection, Geometry } from "geojson";
import type { TractProperties } from "../src/heatmapLayers";
import {
  buildTractIndex,
  compareLocations,
  listTopTracts,
  lookupLocation,
  normaliseCountyQuery,
  resolveCounty,
  summarizeCounty,
  summarizeTract,
} from "../src/chat/tractIndex";
import { makeIndex } from "./fixtures";

describe("county resolution", () => {
  const index = makeIndex();

  it.each(["Dallas", "dallas", "Dallas County", "  DALLAS  county ", "Dallas, TX"])("resolves %j exactly", (q) => {
    const r = resolveCounty(index, q);
    expect(r.status).toBe("found");
    if (r.status === "found") expect(r.county.name).toBe("Dallas");
  });

  it("asks for clarification on an incomplete name matching several counties", () => {
    const r = resolveCounty(index, "San");
    expect(r).toEqual({ status: "ambiguous", query: "San", options: ["San Jacinto County", "San Saba County"] });
  });

  it("does not map city names to counties (no guessing)", () => {
    expect(resolveCounty(index, "Fort Worth").status).toBe("not_found");
    expect(resolveCounty(index, "Austin").status).toBe("not_found");
  });

  it.each(["", "<script>", "a".repeat(100), "1234", "Dallas; drop table"])("rejects malformed input %j", (q) => {
    expect(resolveCounty(index, q).status).toBe("invalid");
  });

  it("rejects non-string input", () => {
    expect(resolveCounty(index, 42).status).toBe("invalid");
    expect(normaliseCountyQuery(undefined as unknown as string)).toBeNull();
  });

  it("computes county bounds from tract polygons", () => {
    const r = resolveCounty(index, "Dallas");
    if (r.status !== "found") throw new Error("expected found");
    const b = r.county.bounds;
    expect([b.south, b.west, b.north, b.east].map((v) => +v.toFixed(6))).toEqual([32.7, -96.8, 32.9, -96.6]);
    expect(r.county.geoids).toHaveLength(2);
  });
});

describe("summaries", () => {
  const index = makeIndex();

  it("returns tract values exactly and keeps missing values as null, not zero", () => {
    const s = summarizeTract(index, "48113000200")!;
    expect(s.raw_indicators.low_access_pct).toBeNull();
    expect(s.observed.grocery).toBe(false);
    expect(s.scores.overall_need_score).toBe(40);
    expect(s.notes.join(" ")).toMatch(/model estimate only/);
    expect(s.notes.join(" ")).toMatch(/low_access_pct is missing \(not zero\)/);
  });

  it("rejects invalid or unknown GEOIDs", () => {
    expect(summarizeTract(index, "123")).toBeNull();
    expect(summarizeTract(index, "48999999999")).toBeNull();
  });

  it("population-weights county averages and excludes missing values", () => {
    const r = resolveCounty(index, "Dallas");
    if (r.status !== "found") throw new Error();
    const s = summarizeCounty(index, r.county);
    expect(s.population).toBe(4000);
    expect(s.scores.overall_need_score).toBe(50); // (80*1000 + 40*3000) / 4000
    expect(s.scores.income_score).toBe(45); // (90*1000 + 30*3000) / 4000
    expect(s.raw_indicators.low_access_pct).toEqual({ value: 20, tracts_missing: 1 });
    expect(s.tracts_with_observed_grocery_data).toBe(1);
    expect(s.highest_overall_need_tract?.geoid).toBe("48113000100");
  });

  it("explains a missing location instead of inventing one", () => {
    const r = lookupLocation(index, { kind: "county", id: "Fort Worth" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not a Texas county/);
  });
});

describe("comparisons", () => {
  const index = makeIndex();

  it("compares two counties with matching metrics and differences", () => {
    const r = compareLocations(index, { kind: "county", id: "Dallas" }, { kind: "county", id: "Tarrant" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.difference_a_minus_b.overall_need_score).toBe(-10);
      expect(r.comparability_notes.join(" ")).toMatch(/population-weighted/);
      expect(r.comparability_notes.join(" ")).toMatch(/coverage differs/);
    }
  });

  it("rejects comparing a county with a tract", () => {
    const r = compareLocations(index, { kind: "county", id: "Dallas" }, { kind: "tract", id: "48439000100" });
    expect(r).toMatchObject({ ok: false, error: "incompatible_kinds" });
  });

  it("rejects comparing a location with itself, or with an unknown location", () => {
    expect(compareLocations(index, { kind: "county", id: "Dallas" }, { kind: "county", id: "dallas county" })).toMatchObject({ ok: false, error: "same_location" });
    expect(compareLocations(index, { kind: "county", id: "Dallas" }, { kind: "county", id: "Fort Worth" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("flags tract comparisons where only one has observed grocery data", () => {
    const r = compareLocations(index, { kind: "tract", id: "48113000100" }, { kind: "tract", id: "48113000200" });
    expect(r.ok && r.comparability_notes.some((n) => n.includes("Only one of these tracts"))).toBe(true);
  });
});

describe("top tracts", () => {
  it("uses the same eligibility rule as the sidebar (population > 0)", () => {
    const index = makeIndex();
    const top = listTopTracts(index, "combined", null, 3);
    expect(top.map((t) => t.geoid)).toEqual(["48113000100", "48439000100", "48407000100"]);
    expect(top.find((t) => t.geoid === "48411000100")).toBeUndefined(); // San Saba tract has TotalPop 0
  });
});

describe("real FoodFit data", () => {
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../public/data/texas_heatmap.geojson"), "utf8")) as FeatureCollection<Geometry, TractProperties>;
  const index = buildTractIndex(raw);

  it("indexes every tract and county in the shipped file", () => {
    expect(index.tracts.size).toBe(raw.features.length);
    expect(index.counties.size).toBe(254);
    const dallas = resolveCounty(index, "Dallas");
    expect(dallas.status === "found" && dallas.county.geoids.length).toBe(528);
  });

  it("tract summaries match the underlying records exactly", () => {
    for (const f of raw.features.slice(0, 200)) {
      const p = f.properties;
      const s = summarizeTract(index, p.GEOID)!;
      expect(s.county).toBe(p.County);
      expect(s.population).toBe(p.TotalPop);
      expect(s.scores.overall_need_score).toBe(p.overall_need_score);
      expect(s.scores.grocery_score).toBe(p.grocery_score);
      expect(s.raw_indicators.low_access_pct).toBe(p.low_access_pct ?? null);
      expect(s.raw_indicators.poverty_rate).toBe(p.poverty_rate ?? null);
    }
  });

  it("top overall tract statewide matches a direct sort of the file", () => {
    const expected = raw.features
      .map((f) => f.properties)
      .filter((p) => p.TotalPop > 0)
      .sort((a, b) => b.overall_need_score - a.overall_need_score)[0];
    expect(listTopTracts(index, "combined", null, 1)[0].geoid).toBe(expected.GEOID);
  });
});
