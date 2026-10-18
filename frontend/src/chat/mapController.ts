// The only bridge between the chatbot and the existing Leaflet map.
// Each method validates its input, acts on the *existing* map instance, then
// re-reads the map to confirm the outcome before reporting success.

import L from "leaflet";
import { isTabId, TABS, type TabId } from "../heatmapLayers";
import { GEOID_PATTERN, resolveCounty, type Bounds, type TractIndex } from "./tractIndex";
import type { MapContextPayload, ToolResult } from "./types";

export type MapLike = Pick<
  L.Map,
  "fitBounds" | "getZoom" | "setZoom" | "getMinZoom" | "getMaxZoom" | "getBounds" | "getCenter" | "closePopup" | "getBoundsZoom"
>;

export type PolygonLike = { getBounds(): L.LatLngBounds; openPopup(): unknown; isPopupOpen(): boolean };

export type MapControllerDeps = {
  getMap: () => MapLike | null;
  getPolygon: (geoid: string) => PolygonLike | null;
  getIndex: () => TractIndex | null;
  getTab: () => TabId;
  /** Must apply synchronously (e.g. wrapped in flushSync) so it can be verified. */
  setTab: (tab: TabId) => void;
  getSelected: () => string | null;
  setSelected: (geoid: string | null) => void;
  /**
   * Optional: highlight a county's tracts as the "selected county" (null clears it) and return
   * how many tract polygons were highlighted. Separate from the viewport move, so both are checked.
   */
  setSelectedCounty?: (county: { name: string; geoids: string[] } | null) => number;
  getSelectedCounty?: () => string | null;
};

export type MapController = ReturnType<typeof createMapController>;

const toLeaflet = (b: Bounds) => L.latLngBounds([b.south, b.west], [b.north, b.east]);
const center = (b: Bounds) => L.latLng((b.south + b.north) / 2, (b.west + b.east) / 2);
const fail = (action: string, error: string, message: string, extra: object = {}): ToolResult => ({
  ok: false,
  action,
  error,
  message,
  ...extra,
});
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** Geometry sanity check: finite, correctly ordered, inside Texas' rough extent. */
export function validBounds(b: Bounds | null | undefined): b is Bounds {
  if (!b) return false;
  const vals = [b.south, b.west, b.north, b.east];
  if (!vals.every(Number.isFinite)) return false;
  return b.south < b.north && b.west < b.east && b.south > 24 && b.north < 38 && b.west > -108 && b.east < -92;
}

/**
 * True when the map is actually showing `target` the way fitBounds should have left it:
 * the target's centre is in view AND the zoom is at least the zoom Leaflet computes to fit
 * the target in this container (same padding / maxZoom). This works for any container
 * size or aspect ratio — a wide or tall map shows extra area around the target, which is
 * correct and must not be reported as a failure.
 */
export function viewFits(map: MapLike, target: L.LatLngBounds, paddingPx: number, maxZoom?: number): boolean {
  const fitZoom = map.getBoundsZoom(target, false, L.point(paddingPx * 2, paddingPx * 2));
  const expected = Math.min(fitZoom, maxZoom ?? Number.POSITIVE_INFINITY);
  return map.getBounds().contains(target.getCenter()) && map.getZoom() >= expected - 1e-6;
}

export function createMapController(deps: MapControllerDeps) {
  function ready(action: string): { map: MapLike; index: TractIndex } | ToolResult {
    const map = deps.getMap();
    const index = deps.getIndex();
    if (!map) return fail(action, "map_unavailable", "The map is not ready yet.");
    if (!index) return fail(action, "data_unavailable", "Map data has not loaded, so this action cannot be performed.");
    return { map, index };
  }

  function zoomToCounty(county: unknown): ToolResult {
    const action = "zoom_to_county";
    const r = ready(action);
    if ("ok" in r) return r;
    const res = resolveCounty(r.index, county);
    if (res.status === "invalid") return fail(action, "invalid_county", "That is not a valid county name.");
    if (res.status === "ambiguous") {
      return fail(action, "ambiguous", `"${res.query}" could mean more than one county. Ask the user which one.`, {
        options: res.options,
      });
    }
    if (res.status === "not_found") {
      return fail(
        action,
        "not_found",
        `"${res.query}" is not a Texas county in FoodFit data. FoodFit only supports county and census-tract locations; city and neighbourhood names are not available.`,
      );
    }
    const target = res.county.bounds;
    if (!validBounds(target) || res.county.geoids.length === 0) {
      return fail(action, "invalid_geometry", `${res.county.name} County has no usable boundary in FoodFit's map data.`);
    }
    const bounds = toLeaflet(target);
    r.map.closePopup();
    deps.setSelected(null);
    r.map.fitBounds(bounds, { padding: [30, 30], animate: false });
    if (!viewFits(r.map, bounds, 30)) {
      deps.setSelectedCounty?.(null);
      return fail(action, "move_failed", "The map did not move to the requested county.", { county: `${res.county.name} County` });
    }
    let highlighted: number | undefined;
    if (deps.setSelectedCounty) {
      highlighted = deps.setSelectedCounty(res.county);
      if (highlighted === 0) {
        return fail(action, "select_failed", `The map moved to ${res.county.name} County, but its tracts could not be highlighted.`, {
          county: `${res.county.name} County`,
        });
      }
    }
    const c = r.map.getCenter();
    return {
      ok: true,
      action,
      county: `${res.county.name} County`,
      selected_county: res.county.name,
      tract_count: res.county.geoids.length,
      ...(highlighted !== undefined ? { highlighted_tracts: highlighted } : {}),
      zoom: r.map.getZoom(),
      center: { lat: r4(c.lat), lng: r4(c.lng) },
    };
  }

  function selectTract(geoid: unknown): ToolResult {
    const action = "select_tract";
    const r = ready(action);
    if ("ok" in r) return r;
    if (typeof geoid !== "string" || !GEOID_PATTERN.test(geoid)) {
      return fail(action, "invalid_geoid", "A tract GEOID must be 11 digits starting with 48.");
    }
    const tract = r.index.tracts.get(geoid);
    const polygon = deps.getPolygon(geoid);
    if (!tract || !polygon) return fail(action, "not_found", `Tract ${geoid} is not on the map.`);
    const bounds = polygon.getBounds();
    r.map.fitBounds(bounds, { padding: [60, 60], maxZoom: 12, animate: false });
    polygon.openPopup();
    deps.setSelected(geoid);
    if (!polygon.isPopupOpen() || !viewFits(r.map, bounds, 60, 12)) {
      return fail(action, "select_failed", "The tract could not be selected on the map.");
    }
    return { ok: true, action, geoid, county: tract.County };
  }

  function zoomBy(direction: 1 | -1, steps: unknown): ToolResult {
    const action = direction > 0 ? "zoom_in" : "zoom_out";
    const map = deps.getMap();
    if (!map) return fail(action, "map_unavailable", "The map is not ready yet.");
    const n = steps === undefined ? 1 : steps;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 3) {
      return fail(action, "invalid_steps", "Zoom steps must be a whole number from 1 to 3.");
    }
    const from = map.getZoom();
    const min = map.getMinZoom();
    const max = Math.min(map.getMaxZoom(), 18);
    const to = Math.max(min, Math.min(max, from + direction * n));
    if (to === from) {
      return fail(action, "at_limit", direction > 0 ? "The map is already fully zoomed in." : "The map is already fully zoomed out.");
    }
    map.setZoom(to, { animate: false });
    const actual = map.getZoom();
    if (actual !== to) return fail(action, "zoom_failed", "The map zoom did not change.");
    return { ok: true, action, from_zoom: from, zoom: actual };
  }

  function reset(): ToolResult {
    const action = "reset_map";
    const r = ready(action);
    if ("ok" in r) return r;
    const full = r.index.fullBounds;
    if (!full) return fail(action, "data_unavailable", "No map extent is available.");
    r.map.closePopup();
    deps.setSelected(null);
    deps.setSelectedCounty?.(null);
    r.map.fitBounds(toLeaflet(full), { padding: [20, 20], animate: false });
    if (!viewFits(r.map, toLeaflet(full), 20)) return fail(action, "move_failed", "The map did not return to the statewide view.");
    return { ok: true, action, zoom: r.map.getZoom() };
  }

  function setLayer(layer: unknown): ToolResult {
    const action = "set_layer";
    if (!isTabId(layer)) {
      return fail(action, "invalid_layer", `Unknown layer. Valid layers: ${TABS.map((t) => t.id).join(", ")}.`);
    }
    deps.setTab(layer);
    if (deps.getTab() !== layer) return fail(action, "layer_failed", "The layer did not change.");
    return { ok: true, action, layer, label: TABS.find((t) => t.id === layer)!.label };
  }

  function getContext(): MapContextPayload | null {
    const map = deps.getMap();
    if (!map) return null;
    const index = deps.getIndex();
    const view = map.getBounds();
    const c = map.getCenter();
    const visible = index
      ? [...index.counties.values()].filter((county) => view.contains(center(county.bounds))).map((x) => x.name).sort()
      : [];
    const selected = deps.getSelected();
    const tract = selected && index ? index.tracts.get(selected) : undefined;
    return {
      layer: deps.getTab(),
      zoom: map.getZoom(),
      center: { lat: r4(c.lat), lng: r4(c.lng) },
      selected_tract: tract ? { geoid: tract.GEOID, county: tract.County } : null,
      // Omitted when nothing is selected, so the payload stays valid for older chat-api versions.
      ...(deps.getSelectedCounty?.() ? { selected_county: deps.getSelectedCounty() } : {}),
      visible_counties: visible.length <= 12 ? visible : [],
      visible_county_count: visible.length,
    };
  }

  return {
    zoomToCounty,
    selectTract,
    zoomIn: (steps?: unknown) => zoomBy(1, steps),
    zoomOut: (steps?: unknown) => zoomBy(-1, steps),
    reset,
    setLayer,
    getContext,
  };
}
