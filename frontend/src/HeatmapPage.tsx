
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import "./heatmap.css";
import WhatIfSimulator from "./WhatIfSimulator";

type TabId = "combined" | "transportation" | "access" | "income";

type TractProperties = {
  GEOID: string;
  County: string;
  TotalPop: number;
  overall_need_score: number;
  transportation_score: number;
  grocery_score: number;
  income_score: number;
  grocery_observed?: boolean;
};

type TractData = FeatureCollection<Geometry, TractProperties>;

const TABS: {
  id: TabId;
  label: string;
  color: string;
  desc: string;
  ramp: string[];
}[] = [
  {
    id: "combined",
    label: "Overall need",
    color: "#7a1f1f",
    desc: "Combined historical need based on income, transportation, and grocery-access barriers.",
    ramp: ["#f6e3da", "#e7a58b", "#c8553d", "#7a1f1f"],
  },
  {
    id: "transportation",
    label: "Transportation",
    color: "#3f7d3a",
    desc: "Estimated barriers to accessing food due to limited vehicle availability.",
    ramp: ["#e6f0d8", "#a9cf86", "#5a9a4a", "#1f4f22"],
  },
  {
    id: "access",
    label: "Grocery access",
    color: "#2a6f97",
    desc: "Estimated barriers related to distance from supermarkets and grocery stores.",
    ramp: ["#dcebf4", "#9cc8e0", "#3f8bb8", "#12405f"],
  },
  {
    id: "income",
    label: "Income barriers",
    color: "#8a5a12",
    desc: "Estimated economic barriers associated with food access.",
    ramp: ["#f5e8c6", "#e3bd6a", "#b8801f", "#5c3a06"],
  },
];

function valueFor(p: TractProperties, tab: TabId): number {
  switch (tab) {
    case "combined":
      return p.overall_need_score;
    case "transportation":
      return p.transportation_score;
    case "access":
      return p.grocery_score;
    case "income":
      return p.income_score;
  }
}

function getColor(score: number, ramp: string[]): string {
  if (score >= 75) return ramp[3];
  if (score >= 50) return ramp[2];
  if (score >= 25) return ramp[1];
  return ramp[0];
}

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

function tractName(p: TractProperties): string {
  return `${p.County} County · Tract ${p.GEOID.slice(-6)}`;
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
  const [error, setError] = useState("");
  const [simulationArea, setSimulationArea] = useState("");

  const current = TABS.find((t) => t.id === tab)!;

  // Initialize the Leaflet map.
  useEffect(() => {
    if (!mapEl.current) return;

    const m = L.map(mapEl.current).setView([31, -99], 6);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 18,
    }).addTo(m);

    map.current = m;

    return () => {
      m.remove();
      map.current = null;
      tractLayer.current = null;
      polygonLayers.current.clear();
      initialBoundsSet.current = false;
    };
  }, []);

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
          setData(result);
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
          fillColor: getColor(score, current.ramp),
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
        featureLayer.on("click", () => setSimulationArea(p.GEOID));

        featureLayer.bindPopup(`
          <div style="min-width:180px;line-height:1.6">
            <strong>${escapeHtml(tractName(p))}</strong>
            <div>Population: ${p.TotalPop.toLocaleString()}</div>
            <div><b>${escapeHtml(current.label)}:</b> ${score.toFixed(1)} / 100</div>
            <hr />
            <div>Overall: ${p.overall_need_score.toFixed(1)}</div>
            <div>Transportation: ${p.transportation_score.toFixed(1)}</div>
            <div>Grocery: ${p.grocery_score.toFixed(1)}</div>
            <div>Income: ${p.income_score.toFixed(1)}</div>
            <small>Historical ML estimates</small>
          </div>
        `);

        featureLayer.on("mouseover", () => {
          if (featureLayer instanceof L.Path) {
            featureLayer.setStyle({
              weight: 2,
              color: "#333333",
              fillOpacity: 0.9,
            });
          }
        });

        featureLayer.on("mouseout", () => {
          layer.resetStyle(featureLayer);
        });
      },
    }).addTo(m);

    tractLayer.current = layer;

    if (!initialBoundsSet.current && layer.getBounds().isValid()) {
      m.fitBounds(layer.getBounds(), {
        padding: [20, 20],
      });
      initialBoundsSet.current = true;
    }
  }, [data, tab, current.label, current.ramp]);

  function focusOnTract(geoid: string) {
    setSimulationArea(geoid);
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
          </div>

          <p>
            Historical model-based scores, not real-time food
            demand measurements.
          </p>
        </aside>
      </div>

      <WhatIfSimulator key={simulationArea} areas={rows} selectedId={simulationArea} onSelect={focusOnTract} />
    </div>
  );
}
