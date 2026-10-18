// Resolves "where to search from" using only verified application data:
// the user's selected tract, the current map centre, a county or tract from the
// FoodFit tract data, or a resource that has verified coordinates.

import type L from "leaflet";
import { GEOID_PATTERN, resolveCounty, type Bounds, type TractIndex } from "../chat/tractIndex";
import type { ResourceStore } from "./resourceStore";
import type { SearchOrigin } from "./types";

export type OriginKind = "selected_tract" | "map_center" | "county" | "tract" | "resource";
export const ORIGIN_KINDS: readonly OriginKind[] = ["selected_tract", "map_center", "county", "tract", "resource"];

export type OriginDeps = {
  getMap: () => Pick<L.Map, "getCenter"> | null;
  getIndex: () => TractIndex | null;
  getSelected: () => string | null;
  store: ResourceStore;
};

export type OriginResult =
  | { ok: true; origin: SearchOrigin }
  | { ok: false; error: string; message: string; options?: string[] };

const mid = (b: Bounds) => ({ lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 });

export function resolveOrigin(kind: unknown, id: unknown, deps: OriginDeps): OriginResult {
  const index = deps.getIndex();
  switch (kind) {
    case "map_center": {
      const map = deps.getMap();
      if (!map) return { ok: false, error: "map_unavailable", message: "The map is not ready yet." };
      const c = map.getCenter();
      return { ok: true, origin: { lat: c.lat, lng: c.lng, label: "the centre of the current map view" } };
    }
    case "selected_tract": {
      const g = deps.getSelected();
      if (!g) {
        return { ok: false, error: "no_selection", message: "No tract is selected. Ask the user to click a tract, name a county, or use the current map view." };
      }
      return resolveOrigin("tract", g, deps);
    }
    case "tract": {
      if (typeof id !== "string" || !GEOID_PATTERN.test(id)) {
        return { ok: false, error: "invalid_geoid", message: "A tract GEOID must be 11 digits starting with 48." };
      }
      const b = index?.tractBounds.get(id);
      const t = index?.tracts.get(id);
      if (!b || !t) return { ok: false, error: "not_found", message: `Tract ${id} is not in FoodFit data.` };
      return { ok: true, origin: { ...mid(b), label: `the centre of ${t.County} County tract ${id.slice(-6)}` } };
    }
    case "county": {
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded." };
      const r = resolveCounty(index, id);
      if (r.status === "found") return { ok: true, origin: { ...mid(r.county.bounds), label: `the centre of ${r.county.name} County` } };
      if (r.status === "ambiguous") return { ok: false, error: "ambiguous", message: "That county name is ambiguous.", options: r.options };
      return {
        ok: false,
        error: r.status,
        message: "That is not a Texas county in FoodFit data. City and neighbourhood names are not supported; ask which county, or use the map view.",
      };
    }
    case "resource": {
      if (typeof id !== "string") return { ok: false, error: "invalid_arguments", message: "A resource id is required." };
      const r = deps.store.find(id);
      if (!r) return { ok: false, error: "not_found", message: "That resource is not in the current results." };
      if (!r.location) return { ok: false, error: "no_coordinates", message: `${r.name} has no verified map location, so distances from it can't be calculated.` };
      return { ok: true, origin: { lat: r.location.lat, lng: r.location.lng, label: r.name } };
    }
    default:
      return { ok: false, error: "invalid_arguments", message: `near.kind must be one of: ${ORIGIN_KINDS.join(", ")}.` };
  }
}
