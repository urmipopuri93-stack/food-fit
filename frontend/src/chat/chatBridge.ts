// The bridge between FitBasket (chat) and the existing Leaflet map on /heatmap.
// Built from ref *objects* (not their values), so nothing is read during React render.

import { flushSync } from "react-dom";
import type L from "leaflet";
import type { TabId } from "../heatmapLayers";
import type { ResourceLayer } from "../resources/ResourceLayer";
import type { ResourceStore } from "../resources/resourceStore";
import type { ResourceToolDeps } from "../resources/resourceTools";
import { createMapController } from "./mapController";
import type { TractIndex } from "./tractIndex";

export type RefBox<T> = { current: T };

/** Outline style for the tracts of the county FitBasket navigated to ("selected county"). */
export const COUNTY_HIGHLIGHT: L.PathOptions = { weight: 1.6, color: "#111a11", opacity: 1 };

// Built from ref *objects* (not their values), so nothing is read during render.
export function createChatBridge(refs: {
  map: RefBox<L.Map | null>;
  polygonLayers: RefBox<Map<string, L.Polygon>>;
  indexRef: RefBox<TractIndex | null>;
  tabRef: RefBox<TabId>;
  selectedRef: RefBox<string | null>;
  selectedCountyRef: RefBox<string | null>;
  tractLayer: RefBox<L.GeoJSON | null>;
  mapEl: RefBox<HTMLDivElement | null>;
  resourceLayerRef: RefBox<ResourceLayer | null>;
  store: ResourceStore;
  setTab: (tab: TabId) => void;
}) {
  const getIndex = () => refs.indexRef.current;
  const controller = createMapController({
    getMap: () => refs.map.current,
    getPolygon: (geoid) => refs.polygonLayers.current.get(geoid) ?? null,
    getIndex,
    getTab: () => refs.tabRef.current,
    setTab: (next) => flushSync(() => refs.setTab(next)),
    getSelected: () => refs.selectedRef.current,
    setSelected: (geoid) => {
      refs.selectedRef.current = geoid;
    },
    setSelectedCounty: (county) => {
      // Un-highlight the previous county, highlight the new one; returns how many tract polygons are highlighted.
      const index = refs.indexRef.current;
      const prev = refs.selectedCountyRef.current;
      const restyle = (name: string | null, on: boolean) => {
        if (!name || !index) return 0;
        const info = [...index.counties.values()].find((c) => c.name === name);
        let n = 0;
        for (const g of info?.geoids ?? []) {
          const poly = refs.polygonLayers.current.get(g);
          if (!poly) continue;
          if (on) poly.setStyle(COUNTY_HIGHLIGHT);
          else refs.tractLayer.current?.resetStyle(poly);
          n++;
        }
        return n;
      };
      if (prev && prev !== county?.name) restyle(prev, false);
      refs.selectedCountyRef.current = county?.name ?? null;
      if (refs.mapEl.current) refs.mapEl.current.dataset.selectedCounty = county?.name ?? "";
      return restyle(county?.name ?? null, true);
    },
    getSelectedCounty: () => refs.selectedCountyRef.current,
  });
  const resourceTools: ResourceToolDeps = {
    getMap: () => refs.map.current,
    getIndex,
    getSelected: () => refs.selectedRef.current,
    store: refs.store,
    getLayer: () => refs.resourceLayerRef.current,
  };
  return { controller, getIndex, resourceTools };
}

