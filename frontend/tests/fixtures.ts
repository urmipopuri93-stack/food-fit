import L from "leaflet";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { vi } from "vitest";
import type { TabId, TractProperties } from "../src/heatmapLayers";
import { createMapController, type MapLike, type PolygonLike } from "../src/chat/mapController";
import { buildTractIndex, type TractIndex } from "../src/chat/tractIndex";

function square(lng: number, lat: number, size = 0.1): Polygon {
  return {
    type: "Polygon",
    coordinates: [[[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]]],
  };
}

function tract(geoid: string, county: string, lng: number, lat: number, over: Partial<TractProperties> = {}): Feature<Polygon, TractProperties> {
  return {
    type: "Feature",
    geometry: square(lng, lat),
    properties: {
      GEOID: geoid,
      County: county,
      TotalPop: 1000,
      Urban: 1,
      overall_need_score: 50,
      income_score: 50,
      transportation_score: 50,
      grocery_score: 50,
      income_observed: true,
      transportation_observed: true,
      grocery_observed: true,
      poverty_rate: 10,
      no_vehicle_pct: 5,
      low_access_pct: 20,
      ...over,
    },
  };
}

export const FIXTURE: FeatureCollection<Polygon, TractProperties> = {
  type: "FeatureCollection",
  features: [
    tract("48113000100", "Dallas", -96.8, 32.7, { TotalPop: 1000, overall_need_score: 80, income_score: 90 }),
    tract("48113000200", "Dallas", -96.7, 32.8, {
      TotalPop: 3000, overall_need_score: 40, income_score: 30,
      low_access_pct: null, grocery_observed: false,
    }),
    tract("48439000100", "Tarrant", -97.3, 32.7, { TotalPop: 2000, overall_need_score: 60 }),
    tract("48411000100", "San Saba", -98.7, 31.2, { TotalPop: 0, overall_need_score: 99 }),
    tract("48407000100", "San Jacinto", -95.1, 30.6),
    tract("48157000100", "Fort Bend", -95.7, 29.5),
  ],
};

export function makeIndex(): TractIndex {
  return buildTractIndex(FIXTURE);
}

/** A minimal stand-in for L.Map that behaves like Leaflet for the methods we use. */
export function makeFakeMap(opts: { broken?: boolean } = {}) {
  let bounds = L.latLngBounds([25, -107], [37, -93]);
  let zoom = 6;
  const map = {
    fitBounds: vi.fn((b: L.LatLngBoundsExpression) => {
      if (opts.broken) return map;
      bounds = L.latLngBounds(b as L.LatLngBoundsLiteral);
      zoom = 10;
      return map;
    }),
    getZoom: () => zoom,
    setZoom: vi.fn((z: number) => {
      if (!opts.broken) zoom = z;
      return map;
    }),
    getMinZoom: () => 0,
    getMaxZoom: () => 18,
    getBounds: () => bounds,
    getCenter: () => bounds.getCenter(),
    closePopup: vi.fn(() => map),
    // A real map computes this from its container size; the fake's fitBounds always lands on zoom 10.
    getBoundsZoom: () => 10,
    // test helper: simulate the user dragging the map
    __pan(b: L.LatLngBounds) {
      bounds = b;
    },
  };
  return map as unknown as MapLike & { fitBounds: ReturnType<typeof vi.fn>; setZoom: ReturnType<typeof vi.fn>; closePopup: ReturnType<typeof vi.fn>; __pan(b: L.LatLngBounds): void };
}

export function makeFakePolygons(index: TractIndex) {
  const popups = new Map<string, boolean>();
  const get = (geoid: string): PolygonLike | null => {
    const b = index.tractBounds.get(geoid);
    if (!b) return null;
    return {
      getBounds: () => L.latLngBounds([b.south, b.west], [b.north, b.east]),
      openPopup: () => popups.set(geoid, true),
      isPopupOpen: () => popups.get(geoid) === true,
    };
  };
  return { get, popups };
}

export function makeController(opts: { broken?: boolean; noData?: boolean } = {}) {
  const index = makeIndex();
  const map = makeFakeMap(opts);
  const polygons = makeFakePolygons(index);
  const state = { tab: "combined" as TabId, selected: null as string | null };
  const controller = createMapController({
    getMap: () => map,
    getPolygon: polygons.get,
    getIndex: () => (opts.noData ? null : index),
    getTab: () => state.tab,
    setTab: (t) => {
      if (!opts.broken) state.tab = t;
    },
    getSelected: () => state.selected,
    setSelected: (g) => {
      state.selected = g;
    },
  });
  return { controller, map, index, state, polygons };
}
