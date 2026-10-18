// Draws the current resource search on the EXISTING Leaflet map.
// Markers live in their own layer group above the tract choropleth and are
// rebuilt from the store on every search, so results can never go stale or duplicate.

import L from "leaflet";
import type { ResourceStore } from "./resourceStore";
import type { ResourceRecord } from "./types";

function esc(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

type Group = { key: string; lat: number; lng: number; records: ResourceRecord[] };

export function groupByLocation(records: ResourceRecord[]): Group[] {
  const groups = new Map<string, Group>();
  for (const r of records) {
    if (!r.location) continue;
    const key = `${r.location.lat.toFixed(6)},${r.location.lng.toFixed(6)}`;
    const g = groups.get(key) ?? { key, lat: r.location.lat, lng: r.location.lng, records: [] };
    if (!g.records.some((x) => x.id === r.id)) g.records.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function popupHtml(g: Group): string {
  const first = g.records[0];
  const items = g.records
    .map((r) => {
      const d = r.distance_miles_straight_line;
      return `<li><b>${esc(r.program ?? r.name)}</b> <span class="ffr-pop-cat">${esc(r.category_label)}</span>` +
        (r.day_status ? `<br><span>${esc(r.day_status.detail)}</span>` : "") +
        (d !== null ? `<br><span>${d} mi straight-line</span>` : "") + `</li>`;
    })
    .join("");
  return `<div class="ffr-popup"><strong>${esc(first.name)}</strong><div>${esc(first.address)}</div>` +
    (first.phone ? `<div>Phone: ${esc(first.phone)}</div>` : `<div>Phone: not listed</div>`) +
    `<ul>${items}</ul><small>Listed information, not live. Call to confirm.</small></div>`;
}

export function createResourceLayer(map: L.Map, store: ResourceStore) {
  const group = L.layerGroup().addTo(map);
  const markers = new Map<string, L.Marker>(); // resource id -> marker
  let lastVersion = -1;
  let previousView: { center: L.LatLng; zoom: number } | null = null;
  let lastSelected: string | null = null;

  function render() {
    const s = store.getState();
    if (s.status === "loading" && !previousView) {
      previousView = { center: map.getCenter(), zoom: map.getZoom() };
    }
    if (s.version !== lastVersion) {
      lastVersion = s.version;
      group.clearLayers();
      markers.clear();
      if (s.status === "idle") {
        if (previousView) map.setView(previousView.center, previousView.zoom, { animate: false });
        previousView = null;
      }
      const r = s.response;
      const shown = [...(r ? [...r.results, ...r.hours_unknown_in_radius] : []), ...s.pinned];
      if (r && s.params && r.query.lat !== null && r.query.lng !== null && r.query.radius_miles !== null) {
        L.circle([r.query.lat, r.query.lng], {
          radius: r.query.radius_miles * 1609.344,
          color: "#2b3a2b", weight: 1.5, dashArray: "6 6", fill: false, interactive: false,
        }).addTo(group);
        L.circleMarker([r.query.lat, r.query.lng], { radius: 5, color: "#2b3a2b", fillColor: "#f7f3e6", fillOpacity: 1, interactive: false })
          .addTo(group);
      }
      for (const g of groupByLocation(shown)) {
        const label = g.records.length > 1 ? `${g.records[0].name} (${g.records.length} programs)` : g.records[0].name;
        const m = L.marker([g.lat, g.lng], {
          title: label,
          alt: label,
          keyboard: true,
          riseOnHover: true,
          icon: L.divIcon({
            className: "ffr-marker",
            html: `<span class="ffr-pin">${g.records.length > 1 ? g.records.length : ""}</span>`,
            iconSize: [26, 26],
            iconAnchor: [13, 26],
            popupAnchor: [0, -24],
          }),
        });
        m.bindPopup(popupHtml(g), { maxWidth: 280 });
        // popupopen covers mouse, keyboard (Enter) and programmatic opening alike.
        m.on("popupopen", () => { if (!g.records.some((x) => x.id === store.getState().selectedId)) store.select(g.records[0].id); });
        m.addTo(group);
        for (const rec of g.records) markers.set(rec.id, m);
      }
      if (r && s.params && s.pinned.length === 0) {
        const origin: L.LatLngExpression[] = r.query.lat !== null && r.query.lng !== null ? [[r.query.lat, r.query.lng]] : [];
        const pts: L.LatLngExpression[] = [...origin, ...[...markers.values()].map((m) => m.getLatLng())];
        if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14, animate: false });
        else if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 11), { animate: false });
      }
    }
    if (s.selectedId !== lastSelected) {
      lastSelected = s.selectedId;
      for (const m of markers.values()) m.getElement()?.classList.remove("ffr-selected");
      const m = s.selectedId ? markers.get(s.selectedId) : undefined;
      if (m) {
        m.getElement()?.classList.add("ffr-selected");
        if (!m.isPopupOpen()) m.openPopup();
      }
    }
  }

  const unsubscribe = store.subscribe(render);
  render();

  return {
    /** Zoom to a resource marker and open it. Returns true only if the map really shows it. */
    focus(id: string): boolean {
      const m = markers.get(id);
      if (!m) return false;
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 14), { animate: false });
      store.select(id);
      m.openPopup();
      return map.getBounds().contains(m.getLatLng()) && m.isPopupOpen();
    },
    has: (id: string) => markers.has(id),
    markerCount: () => new Set(markers.values()).size,
    destroy() {
      unsubscribe();
      group.remove();
      markers.clear();
    },
  };
}

export type ResourceLayer = ReturnType<typeof createResourceLayer>;
