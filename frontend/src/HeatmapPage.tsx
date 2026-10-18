
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import "./heatmap.css";
import WhatIfSimulator from "./WhatIfSimulator";
import {
  TABS,
  getColor,
  formatCount,
  formatScore,
  NO_DATA_COLOR,
  sanitizeTractFeatures,
  tractName,
  valueFor,
  type TabId,
  type TractProperties,
} from "./heatmapLayers";
import ChatPanel from "./chat/ChatPanel";
import { COUNTY_HIGHLIGHT, createChatBridge } from "./chat/chatBridge";
import { buildTractIndex, type TractIndex } from "./chat/tractIndex";
import ResourcePanel from "./resources/ResourcePanel";
import { createResourceLayer, type ResourceLayer } from "./resources/ResourceLayer";
import { createResourceStore } from "./resources/resourceStore";

type TractData = FeatureCollection<Geometry, TractProperties>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export default function HeatmapPage() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const tractLayer = useRef<L.GeoJSON | null>(null);
  const polygonLayers = useRef<Map<string, L.Polygon>>(new Map());
  const initialBoundsSet = useRef(false);

  const [data, setData] = useState<TractData | null>(null);
  const [tab, setTab] = useState<TabId>("combined");
  const [loading, setLoading] = useState(true);
  const [skippedFeatures, setSkippedFeatures] = useState(0);
  const [error, setError] = useState("");

  const current = TABS.find((t) => t.id === tab)!;

  // Chatbot bridge: refs let the controller read the latest committed state
  // without re-creating it or adding listeners to the map.
  const tabRef = useRef<TabId>(tab);
  const selectedRef = useRef<string | null>(null);
  const selectedCountyRef = useRef<string | null>(null);
  const indexRef = useRef<TractIndex | null>(null);
  const tractIndex = useMemo(() => (data ? buildTractIndex(data) : null), [data]);

  useLayoutEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useLayoutEffect(() => {
    indexRef.current = tractIndex;
  }, [tractIndex]);

  // Food-resource search state shared by the panel, the map markers and the chatbot.
  const [resourceStore] = useState(() => createResourceStore());
  const resourceLayerRef = useRef<ResourceLayer | null>(null);

  // Created once after mount (refs are only handed over outside render).
  const [chatBridge, setChatBridge] = useState<ReturnType<typeof createChatBridge> | null>(null);
  useEffect(() => {
    setChatBridge(
      createChatBridge({
        map, polygonLayers, indexRef, tabRef, selectedRef, selectedCountyRef, tractLayer, mapEl, resourceLayerRef,
        store: resourceStore, setTab,
      })
    );
  }, [resourceStore]);

  // Initialize the Leaflet map.
  useEffect(() => {
    if (!mapEl.current) return;

    const m = L.map(mapEl.current).setView([31, -99], 6);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18,
    }).addTo(m);

    map.current = m;
    // Mirror the live viewport onto the map element so map-action failures can be diagnosed
    // in DevTools (and verified by browser tests) without reading Leaflet internals.
    const el = mapEl.current;
    const mirrorView = () => {
      const c = m.getCenter();
      const b = m.getBounds();
      el.dataset.zoom = String(m.getZoom());
      el.dataset.center = `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
      el.dataset.bounds = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(4)).join(",");
    };
    mirrorView();
    m.on("moveend zoomend", mirrorView);
    const resourceLayer = createResourceLayer(m, resourceStore);
    resourceLayerRef.current = resourceLayer;
    const polygons = polygonLayers.current; // the same Map instance for the component's lifetime

    return () => {
      resourceLayer.destroy();
      resourceLayerRef.current = null;
      m.off("moveend zoomend", mirrorView);
      m.remove();
      map.current = null;
      tractLayer.current = null;
      polygons.clear();
      selectedCountyRef.current = null;
      initialBoundsSet.current = false;
    };
  }, [resourceStore]);

  // Load the predictions exported by the Python ML pipeline.
  useEffect(() => {
    const controller = new AbortController();

    async function loadData() {
      try {
        const response = await fetch(
          "/data/texas_heatmap.geojson",
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const result: TractData = await response.json();

        if (
          result.type !== "FeatureCollection" ||
          !Array.isArray(result.features)
        ) {
          throw new Error("Invalid GeoJSON data");
        }

        if (!controller.signal.aborted) {
          const clean = sanitizeTractFeatures(result.features);
          setData({ ...result, features: clean.features });
          setSkippedFeatures(clean.skipped);
          setError("");
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to load ML heatmap data."
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => controller.abort();
  }, []);

  // Rank census tracts by the selected model score.
  const rows = useMemo(() => {
    if (!data) return [];

    return data.features
      .map((feature) => feature.properties)
      .filter(
        (p): p is TractProperties =>
          p !== null &&
          Number.isFinite(valueFor(p, tab)) &&
          Number.isFinite(p.TotalPop) &&
          p.TotalPop > 0
      )
      .sort((a, b) => valueFor(b, tab) - valueFor(a, tab));
  }, [data, tab]);

  // Render actual census tract polygons using ML scores.
  useEffect(() => {
    const m = map.current;
    if (!m || !data) return;

    if (tractLayer.current) {
      m.removeLayer(tractLayer.current);
    }

    polygonLayers.current.clear();

    const layer = L.geoJSON(data, {
      style: (feature) => {
        const score = feature?.properties
          ? valueFor(feature.properties, tab)
          : 0;

        return {
          fillColor: Number.isFinite(score) ? getColor(score, current.ramp) : NO_DATA_COLOR,
          fillOpacity: 0.7,
          color: "#ffffff",
          weight: 0.35,
          opacity: 0.6,
        };
      },

      onEachFeature: (feature, featureLayer) => {
        const p = feature.properties;

        if (!p) return;

        if (featureLayer instanceof L.Polygon) {
          polygonLayers.current.set(p.GEOID, featureLayer);
        }

        const score = valueFor(p, tab);

        featureLayer.bindPopup(`
          <div style="min-width:180px;line-height:1.6">
            <strong>${escapeHtml(tractName(p))}</strong>
            <div>Population: ${formatCount(p.TotalPop)}</div>
            <div><b>${escapeHtml(current.label)}:</b> ${formatScore(score)}</div>
            <hr />
            <div>Overall: ${formatScore(p.overall_need_score)}</div>
            <div>Transportation: ${formatScore(p.transportation_score)}</div>
            <div>Grocery: ${formatScore(p.grocery_score)}</div>
            <div>Income: ${formatScore(p.income_score)}</div>
            <small>Historical ML estimates</small>
          </div>
        `);

        featureLayer.on("click", () => {
          selectedRef.current = p.GEOID;
        });

        featureLayer.on("mouseover", () => {
          if (featureLayer instanceof L.Path) {
            featureLayer.setStyle({
              weight: 2,
              color: "#333333",
              fillOpacity: 0.9,
            });
          }
        });

        if (selectedCountyRef.current === p.County && featureLayer instanceof L.Path) {
          featureLayer.setStyle(COUNTY_HIGHLIGHT); // survives layer switches
        }

        featureLayer.on("mouseout", () => {
          layer.resetStyle(featureLayer);
          if (selectedCountyRef.current === p.County && featureLayer instanceof L.Path) {
            featureLayer.setStyle(COUNTY_HIGHLIGHT);
          }
        });
      },
    }).addTo(m);

    tractLayer.current = layer;

    if (!initialBoundsSet.current && layer.getBounds().isValid()) {
      m.fitBounds(layer.getBounds(), {
        padding: [20, 20],
        animate: false, // an animated zoom here could override a chatbot map action issued during it
      });
      initialBoundsSet.current = true;
    }
  }, [data, tab, current.label, current.ramp]);

  function focusOnTract(geoid: string) {
    const polygon = polygonLayers.current.get(geoid);
    const m = map.current;

    if (!polygon || !m) return;

    m.fitBounds(polygon.getBounds(), {
      padding: [60, 60],
      maxZoom: 12,
    });

    polygon.openPopup();
  }

  return (
    <div className="heatmap-page">
      <div className="heatmap-top" role="tablist">
        <Link to="/dashboard" className="back">
          ← Dashboard
        </Link>

        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            onClick={() => setTab(t.id)}
          >
            <span
              className="dot"
              style={{ background: t.color }}
            />
            {t.label}
          </button>
        ))}
      </div>

      {skippedFeatures > 0 && !error && (
        <div className="heatmap-error" role="status">
          {skippedFeatures.toLocaleString()} map record{skippedFeatures === 1 ? " was" : "s were"} skipped because
          {skippedFeatures === 1 ? " it was" : " they were"} incomplete (missing a boundary or identifier).
        </div>
      )}

      {error && (
        <div className="heatmap-error">
          Couldn't load the ML heatmap: {error}
        </div>
      )}

      <div className="heatmap-body">
        <div ref={mapEl} className="heatmap-map" />

        <aside className="heatmap-side">
          <h2>Top 3: {current.label}</h2>
          <p>{current.desc}</p>

          {loading && <p>Loading ML predictions...</p>}

          {!loading && !error && rows.length === 0 && (
            <p>No census tract predictions available.</p>
          )}

          {rows.slice(0, 3).map((p, i) => {
            const score = valueFor(p, tab);

            return (
              <button
                key={p.GEOID}
                type="button"
                className="heatmap-item"
                onClick={() => focusOnTract(p.GEOID)}
              >
                <b>
                  {i + 1}. {tractName(p)}
                </b>

                <span>
                  Score {score.toFixed(1)} / 100
                </span>

                <div className="bar">
                  <i
                    style={{
                      width: `${Math.max(0, Math.min(100, score))}%`,
                      background: current.color,
                    }}
                  />
                </div>
              </button>
            );
          })}

          <div className="legend">
            <div>Estimated access barriers</div>

            <div
              className="ramp"
              style={{
                background: `linear-gradient(90deg, ${current.ramp.join(",")})`,
              }}
            />

            <div className="ends">
              <span>Lower</span>
              <span>Higher</span>
            </div>

            <div className="legend-nodata">
              <span className="swatch" style={{ background: NO_DATA_COLOR }} /> No data for this layer
            </div>
          </div>

          <p>
            Historical model-based scores, not real-time food
            demand measurements.
          </p>
        </aside>
      </div>

      {chatBridge && (
        <ResourcePanel
          store={resourceStore}
          getLayer={chatBridge.resourceTools.getLayer}
          originDeps={chatBridge.resourceTools}
        />
      )}

      <WhatIfSimulator />

      {chatBridge && (
        <ChatPanel
          controller={chatBridge.controller}
          getIndex={chatBridge.getIndex}
          resourceTools={chatBridge.resourceTools}
          dataStatus={loading ? "loading" : error || !tractIndex ? "error" : "ready"}
        />
      )}
    </div>
  );
}
