// Executes a model-requested tool after strict validation. Only names in
// TOOL_NAMES are accepted; arguments must be a plain object with known keys.
// Nothing here evaluates strings as code or touches the DOM directly.

import { isTabId, TABS, BIN_THRESHOLDS } from "../heatmapLayers";
import { DATA_METADATA } from "./dataMetadata";
import type { MapController } from "./mapController";
import {
  compareLocations,
  coverageReport,
  isLocationRef,
  listTopTracts,
  lookupLocation,
  resolveCounty,
  SOURCE_NOTE,
  type TractIndex,
} from "./tractIndex";
import { isToolName, type ActionChip, type ToolResult } from "./types";

export type ExecutorDeps = { controller: MapController; getIndex: () => TractIndex | null };

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  explain_heatmap: [],
  get_map_context: [],
  zoom_to_county: ["county"],
  select_tract: ["geoid"],
  zoom_in: ["steps"],
  zoom_out: ["steps"],
  reset_map: [],
  set_layer: ["layer"],
  summarize_location: ["location"],
  compare_locations: ["a", "b"],
  list_top_tracts: ["layer", "county", "limit"],
  data_coverage: [],
};

const invalid = (message: string): ToolResult => ({ ok: false, error: "invalid_arguments", message });

export function executeTool(name: unknown, args: unknown, deps: ExecutorDeps): ToolResult {
  if (!isToolName(name) || !(name in ALLOWED_KEYS)) {
    return { ok: false, error: "unsupported_action", message: "That action is not available." };
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return invalid("Arguments must be a JSON object.");
  }
  const a = args as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => !ALLOWED_KEYS[name].includes(k));
  if (extra.length) return invalid(`Unexpected argument(s): ${extra.join(", ")}.`);

  const index = deps.getIndex();
  switch (name) {
    case "explain_heatmap": {
      const active = deps.controller.getContext()?.layer ?? null;
      return {
        ok: true,
        active_layer: active,
        visualisation: DATA_METADATA.visualisation,
        layers: TABS.map((t) => ({
          id: t.id,
          label: t.label,
          description: t.desc,
          score_field: t.field,
          score_definition: DATA_METADATA.scores[t.field as keyof typeof DATA_METADATA.scores],
        })),
        colour_bins: DATA_METADATA.colourBins,
        bin_lower_bounds: [...BIN_THRESHOLDS],
        score_method: DATA_METADATA.scoreMethod,
        observed_flags: DATA_METADATA.observedFlags,
        geographic_levels: DATA_METADATA.geographicLevels,
        not_available: DATA_METADATA.notAvailable,
        sources: DATA_METADATA.sources,
        warning: DATA_METADATA.warning,
      };
    }
    case "get_map_context": {
      const ctx = deps.controller.getContext();
      return ctx ? { ok: true, ...ctx } : { ok: false, error: "map_unavailable", message: "The map is not ready yet." };
    }
    case "zoom_to_county":
      if (typeof a.county !== "string") return invalid("county must be a string.");
      return deps.controller.zoomToCounty(a.county);
    case "select_tract":
      if (typeof a.geoid !== "string") return invalid("geoid must be a string.");
      return deps.controller.selectTract(a.geoid);
    case "zoom_in":
      return deps.controller.zoomIn(a.steps);
    case "zoom_out":
      return deps.controller.zoomOut(a.steps);
    case "reset_map":
      return deps.controller.reset();
    case "set_layer":
      return deps.controller.setLayer(a.layer);
    case "summarize_location": {
      if (!isLocationRef(a.location)) return invalid("location must be {kind: 'county'|'tract', id: string}.");
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded." };
      const r = lookupLocation(index, a.location);
      return r.ok ? { ok: true, ...r.summary, ...SOURCE_NOTE } : { ...r };
    }
    case "compare_locations": {
      if (!isLocationRef(a.a) || !isLocationRef(a.b)) return invalid("a and b must be {kind, id} location references.");
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded." };
      const r = compareLocations(index, a.a, a.b);
      return r.ok ? { ...r, ...SOURCE_NOTE } : { ...r };
    }
    case "data_coverage": {
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded." };
      return { ok: true, ...coverageReport(index), ...SOURCE_NOTE };
    }
    case "list_top_tracts": {
      if (!isTabId(a.layer)) return invalid("layer must be one of combined, transportation, access, income.");
      const limit = a.limit === undefined ? 3 : a.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 5) {
        return invalid("limit must be a whole number from 1 to 5.");
      }
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded." };
      let county = null;
      if (a.county !== undefined) {
        const res = resolveCounty(index, a.county);
        if (res.status !== "found") {
          return {
            ok: false,
            error: res.status,
            message: res.status === "ambiguous" ? "County name is ambiguous." : "County not found in FoodFit data.",
            ...(res.status === "ambiguous" ? { options: res.options } : {}),
          };
        }
        county = res.county;
      }
      return {
        ok: true,
        layer: a.layer,
        within: county ? `${county.name} County` : "Texas",
        tracts: listTopTracts(index, a.layer, county, limit),
        note: "Ranked by score among tracts with population > 0. Scores are relative historical estimates.",
        ...SOURCE_NOTE,
      };
    }
    default:
      return { ok: false, error: "unsupported_action", message: "That action is not available." };
  }
}

/** A user-visible record of what the application actually did. */
export function describeResult(name: string, result: ToolResult): ActionChip | null {
  if (!result.ok) {
    const msg = typeof result.message === "string" ? result.message : "Action failed.";
    return { status: "failed", text: msg.length > 120 ? `${msg.slice(0, 117)}…` : msg };
  }
  switch (name) {
    case "zoom_to_county":
      return { status: "success", text: `Map moved to ${String(result.county)}` };
    case "select_tract":
      return { status: "success", text: `Selected tract ${String(result.geoid)}` };
    case "zoom_in":
    case "zoom_out":
      return { status: "success", text: `Zoom ${String(result.from_zoom)} → ${String(result.zoom)}` };
    case "reset_map":
      return { status: "success", text: "Map reset to full Texas view" };
    case "set_layer":
      return { status: "success", text: `Layer: ${String(result.label)}` };
    case "summarize_location":
      return { status: "info", text: `Read FoodFit data: ${String(result.kind === "tract" ? result.geoid : result.name)}` };
    case "compare_locations":
      return { status: "info", text: "Compared FoodFit data" };
    case "list_top_tracts":
      return { status: "info", text: `Ranked tracts in ${String(result.within)}` };
    case "explain_heatmap":
      return { status: "info", text: "Read map legend & metadata" };
    case "data_coverage":
      return { status: "info", text: "Checked data coverage" };
    case "search_resources":
      return {
        status: "info",
        text: `Found ${String(result.total_in_radius)} resource${result.total_in_radius === 1 ? "" : "s"} within ${String(result.radius_miles)} mi (straight-line)`,
      };
    case "get_resource_details":
    case "compare_resources":
      return { status: "info", text: "Read resource record" };
    case "show_resource_on_map":
      return { status: "success", text: `Showing ${String(result.name)} on the map` };
    case "clear_resource_search":
      return { status: "success", text: "Resource search cleared" };
    case "find_service_gaps":
      return { status: "info", text: `Checked ${String(result.tracts_analyzed)} tracts against ${String(result.listed_locations)} mapped food listings` };
    default:
      return null;
  }
}

const HEATMAP_SOURCE = `Map data: ${DATA_METADATA.sources.map((s) => `${s.name} (${s.year})`).join(" · ")}. Historical estimates, not current conditions.`;

/** The source line to show under an answer that used this tool's result, if any. */
export function sourceFor(name: string, result: ToolResult): string | null {
  if (!result.ok) return null;
  if (["summarize_location", "compare_locations", "list_top_tracts", "explain_heatmap", "data_coverage"].includes(name)) return HEATMAP_SOURCE;
  if (["search_resources", "get_resource_details", "compare_resources"].includes(name) && typeof result.source === "string") {
    return `Food resources: ${result.source}`;
  }
  if (name === "find_service_gaps" && typeof result.source === "string") {
    return `${HEATMAP_SOURCE} Food resources: ${result.source}`;
  }
  return null;
}
