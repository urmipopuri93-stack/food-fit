import { describe, expect, it } from "vitest";
import { executeTool } from "../src/chat/toolExecutor";
import { TABS } from "../src/heatmapLayers";
import { makeController } from "./fixtures";

function setup() {
  const c = makeController();
  return { ...c, run: (name: unknown, args: unknown) => executeTool(name, args, { controller: c.controller, getIndex: () => c.index }) };
}

describe("tool executor allowlist", () => {
  it.each(["eval", "run_javascript", "document.write", "__proto__", 42, null])("rejects unknown tool %j", (name) => {
    const { run, map } = setup();
    expect(run(name, {})).toMatchObject({ ok: false, error: "unsupported_action" });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it.each([null, "Dallas", [1], 5])("rejects non-object arguments %j", (args) => {
    const { run } = setup();
    expect(run("zoom_to_county", args)).toMatchObject({ ok: false, error: "invalid_arguments" });
  });

  it("rejects unexpected or wrongly typed arguments", () => {
    const { run, map } = setup();
    expect(run("zoom_to_county", { county: "Dallas", code: "alert(1)" })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(run("zoom_to_county", { county: { $gt: "" } })).toMatchObject({ ok: false, error: "invalid_arguments" });
    expect(run("list_top_tracts", { layer: "combined", limit: 500 })).toMatchObject({ ok: false });
    expect(map.fitBounds).not.toHaveBeenCalled();
  });
});

describe("grounded data tools", () => {
  it("explain_heatmap returns the app's real layer labels and bins", () => {
    const { run } = setup();
    const r = run("explain_heatmap", {});
    expect(r.ok).toBe(true);
    expect((r.layers as { label: string }[]).map((l) => l.label)).toEqual(TABS.map((t) => t.label));
    expect(r.bin_lower_bounds).toEqual([0, 25, 50, 75]);
    expect(String(r.visualisation)).toMatch(/not a point-density heat map/);
    expect(r.active_layer).toBe("combined");
  });

  it("summarize_location returns data with sources and keeps nulls", () => {
    const { run } = setup();
    const r = run("summarize_location", { location: { kind: "tract", id: "48113000200" } });
    expect(r.ok).toBe(true);
    expect((r.raw_indicators as Record<string, unknown>).low_access_pct).toBeNull();
    expect(String(r.sources)).toMatch(/2015/);
  });

  it("summarize_location explains unknown places instead of fabricating", () => {
    const { run } = setup();
    expect(run("summarize_location", { location: { kind: "county", id: "Fort Worth" } })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("compare_locations rejects incompatible levels", () => {
    const { run } = setup();
    const r = run("compare_locations", { a: { kind: "county", id: "Dallas" }, b: { kind: "tract", id: "48439000100" } });
    expect(r).toMatchObject({ ok: false, error: "incompatible_kinds" });
  });

  it("list_top_tracts handles ambiguous county filters", () => {
    const { run } = setup();
    expect(run("list_top_tracts", { layer: "combined", county: "San" })).toMatchObject({ ok: false, error: "ambiguous" });
    expect(run("list_top_tracts", { layer: "combined", county: "Dallas", limit: 1 })).toMatchObject({
      ok: true,
      within: "Dallas County",
      tracts: [{ geoid: "48113000100", score: 80 }],
    });
  });

  it("get_map_context returns live state", () => {
    const { run } = setup();
    run("zoom_to_county", { county: "Tarrant" });
    expect(run("get_map_context", {})).toMatchObject({ ok: true, layer: "combined", visible_counties: ["Tarrant"] });
  });
});
