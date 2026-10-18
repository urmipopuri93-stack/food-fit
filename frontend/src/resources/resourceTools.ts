// Chatbot tools for food resources. Each validates its arguments, uses the
// shared store / real API, and returns only what the records contain.

import { getLocations as defaultLocations, getResource as defaultGet, ResourceError } from "./resourceClient";
import { findServiceGaps } from "../chat/serviceGaps";
import type { ResourceLayer } from "./ResourceLayer";
import { resolveOrigin, type OriginDeps } from "./origin";
import {
  RESOURCE_CATEGORIES,
  RESOURCE_ID_PATTERN,
  FOOD_CATEGORIES,
  WEEKDAYS,
  sourceLine,
  type ResourceCategory,
  type ResourceDetail,
  type ResourceRecord,
  type SearchOrigin,
  CITY_PATTERN,
} from "./types";
import type { ToolResult } from "../chat/types";

export const RESOURCE_TOOL_NAMES = [
  "search_resources",
  "get_resource_details",
  "compare_resources",
  "show_resource_on_map",
  "clear_resource_search",
  "find_service_gaps",
] as const;
export type ResourceToolName = (typeof RESOURCE_TOOL_NAMES)[number];

export function isResourceTool(name: unknown): name is ResourceToolName {
  return typeof name === "string" && (RESOURCE_TOOL_NAMES as readonly string[]).includes(name);
}

export type ResourceToolDeps = OriginDeps & {
  getLayer: () => ResourceLayer | null;
  getResource?: typeof defaultGet;
  getLocations?: typeof defaultLocations;
};

const ALLOWED: Record<ResourceToolName, readonly string[]> = {
  search_resources: ["near", "radius_miles", "categories", "day", "limit"],
  get_resource_details: ["resource_id"],
  compare_resources: ["a", "b"],
  show_resource_on_map: ["resource_id"],
  clear_resource_search: [],
  find_service_gaps: ["county", "limit"],
};

const invalid = (message: string): ToolResult => ({ ok: false, error: "invalid_arguments", message });
const fromError = (e: unknown): ToolResult =>
  e instanceof ResourceError
    ? { ok: false, error: e.code, message: e.message }
    : { ok: false, error: "resources_unavailable", message: "Food resource data is unavailable right now." };

/** The fields the model may cite, nothing more. */
export function forModel(r: ResourceRecord) {
  return {
    id: r.id,
    name: r.name,
    program: r.program,
    category: r.category_label,
    address: r.address,
    has_map_location: r.location !== null,
    distance_miles_straight_line: r.distance_miles_straight_line,
    phone: r.phone,
    phone_label: r.phone_label,
    website: r.website,
    email: r.email,
    listed_hours: r.hours_text,
    hours_basis: r.schedule_basis,
    hours_notes: r.hours_notes,
    day_status: r.day_status ?? null,
    listed_closures: r.closures,
    appointment: r.appointment === "required" ? "appointment required (as listed)"
      : r.appointment === "prioritized_walk_ins_welcome" ? "appointments prioritized; walk-ins welcome (as listed)" : null,
    not_listed: r.missing_fields,
    notes: r.notes,
  };
}

function cityLabel(city: string): string {
  return city.toLowerCase() === "dallas" ? "Dallas (North Dallas) listings" : `${city} listings`;
}

export async function executeResourceTool(name: ResourceToolName, args: unknown, deps: ResourceToolDeps): Promise<ToolResult> {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return invalid("Arguments must be a JSON object.");
  const a = args as Record<string, unknown>;
  const extra = Object.keys(a).filter((k) => !ALLOWED[name].includes(k));
  if (extra.length) return invalid(`Unexpected argument(s): ${extra.join(", ")}.`);
  const get = deps.getResource ?? defaultGet;

  switch (name) {
    case "search_resources": {
      const near = a.near as Record<string, unknown> | undefined;
      if (!near || typeof near !== "object" || Array.isArray(near)) return invalid("near must be an object with a kind.");
      if (Object.keys(near).some((k) => k !== "kind" && k !== "id")) return invalid("near accepts only kind and id.");
      const radius = a.radius_miles === undefined ? 5 : a.radius_miles;
      if (typeof radius !== "number" || !Number.isFinite(radius) || radius < 0.5 || radius > 25) {
        return invalid("radius_miles must be between 0.5 and 25.");
      }
      const cats = a.categories === undefined ? [...FOOD_CATEGORIES] : a.categories;
      if (!Array.isArray(cats) || cats.length === 0 || cats.length > 4 || !cats.every((c) => (RESOURCE_CATEGORIES as readonly unknown[]).includes(c))) {
        return invalid(`categories must be a non-empty list from: ${RESOURCE_CATEGORIES.join(", ")}.`);
      }
      const day = a.day ?? null;
      if (day !== null && day !== "today" && !(WEEKDAYS as readonly unknown[]).includes(day)) return invalid("day must be 'today' or a weekday name.");
      const limit = a.limit === undefined ? 5 : a.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) return invalid("limit must be 1-10.");

      let origin: SearchOrigin | null = null;
      let city: string | undefined;
      if (near.kind === "city") {
        if (typeof near.id !== "string" || !CITY_PATTERN.test(near.id)) return invalid("near.id must be a city name for kind 'city'.");
        city = near.id;
      } else {
        const resolved = resolveOrigin(near.kind, near.id, deps);
        if (!resolved.ok) return { ...resolved };
        origin = resolved.origin;
      }
      try {
        const res = await deps.store.search({
          origin,
          city,
          radiusMiles: radius,
          categories: cats as ResourceCategory[],
          day: day as never,
          limit,
        });
        return {
          ok: true,
          searched_from: origin ? origin.label : cityLabel(res.query.city ?? city ?? ""),
          radius_miles: res.query.radius_miles,
          ...(res.unknown_city ? { unknown_city: true, known_cities: res.known_cities ?? [] } : {}),
          day: res.query.day,
          date: res.query.date,
          total_in_radius: res.total_in_radius,
          results: res.results.map(forModel),
          hours_unknown_for_day: res.hours_unknown_in_radius.map((r) => ({ id: r.id, name: r.name, program: r.program })),
          listed_without_map_location: res.unlocated.map((r) => ({ id: r.id, name: r.name, program: r.program, address: r.address })),
          out_of_coverage: res.out_of_coverage,
          distance_note: res.distance_note,
          hours_note: res.hours_note,
          source: sourceLine(res.source),
          shown_on_map: true,
        };
      } catch (e) {
        return fromError(e);
      }
    }
    case "get_resource_details": {
      const id = a.resource_id;
      if (typeof id !== "string" || !RESOURCE_ID_PATTERN.test(id)) return invalid("resource_id is not valid.");
      try {
        const r = await get(id);
        return { ok: true, resource: { ...forModel(r), schedule: r.schedule }, source: sourceLine(r.source) };
      } catch (e) {
        return fromError(e);
      }
    }
    case "compare_resources": {
      const ids = [a.a, a.b];
      if (!ids.every((x) => typeof x === "string" && RESOURCE_ID_PATTERN.test(x))) return invalid("a and b must be resource ids.");
      if (a.a === a.b) return { ok: false, error: "same_resource", message: "Both ids refer to the same resource." };
      try {
        const [x, y] = await Promise.all(ids.map((i) => get(i as string)));
        const known = (r: ResourceDetail) => deps.store.find(r.id)?.distance_miles_straight_line ?? null;
        return {
          ok: true,
          a: { ...forModel(x), distance_miles_straight_line: known(x) },
          b: { ...forModel(y), distance_miles_straight_line: known(y) },
          note: "Side-by-side listed facts only. FoodFit does not rate resources.",
          source: sourceLine(x.source),
        };
      } catch (e) {
        return fromError(e);
      }
    }
    case "show_resource_on_map": {
      const id = a.resource_id;
      if (typeof id !== "string" || !RESOURCE_ID_PATTERN.test(id)) return invalid("resource_id is not valid.");
      const layer = deps.getLayer();
      if (!layer) return { ok: false, error: "map_unavailable", message: "The map is not ready yet." };
      let record: ResourceRecord | undefined = deps.store.find(id);
      if (!record) {
        try {
          record = await get(id);
        } catch (e) {
          return fromError(e);
        }
      }
      if (!record.location) {
        return { ok: false, error: "no_coordinates", message: `${record.name} has no verified map location (its address could not be geocoded). Address: ${record.address}.` };
      }
      if (!layer.has(id)) deps.store.pin(record);
      const shown = layer.focus(id);
      return shown
        ? { ok: true, resource_id: id, name: record.name, address: record.address }
        : { ok: false, error: "show_failed", message: "The resource could not be shown on the map." };
    }
    case "find_service_gaps": {
      const county = a.county ?? null;
      if (county !== null && (typeof county !== "string" || county.trim().length === 0 || county.length > 60)) {
        return invalid("county must be a county name.");
      }
      const limit = a.limit === undefined ? 5 : a.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10) return invalid("limit must be 1-10.");
      const index = deps.getIndex();
      if (!index) return { ok: false, error: "data_unavailable", message: "Map data has not loaded, so service gaps can't be measured." };
      try {
        const data = await (deps.getLocations ?? defaultLocations)();
        const result = findServiceGaps(index, data, { county, limit });
        return result.ok ? { ...result, source: sourceLine(data.source), distance_note: data.distance_note } : result;
      } catch (e) {
        return fromError(e);
      }
    }
    case "clear_resource_search": {
      deps.store.clear();
      return { ok: true, cleared: true };
    }
  }
}
