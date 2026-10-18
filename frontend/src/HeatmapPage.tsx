
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import type { FeatureCollection, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";
import "./heatmap.css";
import WhatIfSimulator from "./WhatIfSimulator";
import { areaCenter, distanceKm, withinRadius } from './utils/radius.mjs';

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
  const [center, setCenter] = useState<[number, number] | null>(null);
  const [radius, setRadius] = useState(10);
  const [radiusApplied, setRadiusApplied] = useState(false);
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  const locationRequest = useRef(0);
  const [locationMessage, setLocationMessage] = useState('');
  const [locating, setLocating] = useState(false);
  const [incomeOnly, setIncomeOnly] = useState(false);
  const centers = useMemo(() => new Map(data?.features.map(f => [f.properties.GEOID, areaCenter(f.geometry)]) ?? []), [data]);
  const visibleData = useMemo<TractData | null>(() => data ? ({ ...data, features: data.features.filter(f =>
    (!center || !radiusApplied || withinRadius(center, centers.get(f.properties.GEOID) ?? null, radius)) &&
    (!incomeOnly || f.properties.income_score >= 75)) }) : null, [data, center, centers, radius, radiusApplied, incomeOnly]);

  function useMyLocation() {
    const request = ++locationRequest.current;
    if (!navigator.geolocation) { setLocationMessage('Location is unavailable in this browser. Choose a spot on the map instead.'); return; }
    setLocating(true); setLocationMessage('Finding your location...');
    navigator.geolocation.getCurrentPosition(position => {
      if (request !== locationRequest.current) return;
      setCenter([position.coords.latitude, position.coords.longitude]);
      setRadiusApplied(false); setSimulationArea(''); setLocating(false);
      setLocationMessage(`Using your location (accuracy about ${Math.round(position.coords.accuracy)} meters).`);
    }, () => {
      if (request !== locationRequest.current) return;
      setLocating(false); setLocationMessage('Could not get your location. Allow location access or choose a spot on the map.');
    }, { timeout: 10000, maximumAge: 60000 });
  }

  useEffect(() => {
    if (!center || !map.current) return;
    const group = L.layerGroup().addTo(map.current);
    if (radiusApplied) {
      const circle = L.circle(center, { radius: radius * 1000, color: '#264f83', fill: false, weight: 2, interactive: false }).addTo(group);
      map.current.fitBounds(circle.getBounds(), { padding: [20,20] });
    } else {
      map.current.setView(center, 10);
    }
    L.circleMarker(center, { radius: 6, color: '#264f83', fillOpacity: 1 }).bindTooltip('Your search location').addTo(group);
    return () => { group.remove(); };
  }, [center, radius, radiusApplied]);

  useEffect(() => {
    if (simulationArea && !visibleData?.features.some(f => f.properties.GEOID === simulationArea)) setSimulationArea('');
  }, [visibleData, simulationArea]);

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
    const pickLocation = (event: MouseEvent) => {
      if (!pickingRef.current) return;
      event.preventDefault(); event.stopPropagation();
      const point = m.mouseEventToLatLng(event);
      ++locationRequest.current; setLocating(false);
      setCenter([point.lat, point.lng]); setRadiusApplied(false); setSimulationArea('');
      pickingRef.current = false; setPicking(false);
      setLocationMessage('Using the spot you selected on the map.');
    };
    m.getContainer().addEventListener('click', pickLocation, true);

    return () => {
      m.getContainer().removeEventListener('click', pickLocation, true);
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
    if (!visibleData) return [];

    return visibleData.features
      .map((feature) => feature.properties)
      .filter(
        (p): p is TractProperties =>
          p !== null &&
          Number.isFinite(valueFor(p, tab)) &&
          Number.isFinite(p.TotalPop) &&
          p.TotalPop > 0
      )
      .sort((a, b) => valueFor(b, tab) - valueFor(a, tab));
  }, [visibleData, tab]);

  // Render actual census tract polygons using ML scores.
  useEffect(() => {
    const m = map.current;
    if (!m || !visibleData) return;

    if (tractLayer.current) {
      m.removeLayer(tractLayer.current);
    }

    polygonLayers.current.clear();

    const layer = L.geoJSON(visibleData, {
      bubblingMouseEvents: true,
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
        featureLayer.on("click", () => { if (!pickingRef.current) setSimulationArea(p.GEOID); });

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
  }, [visibleData, tab, current.label, current.ramp]);

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

      <section className="radius-controls" aria-label="Find nearby areas">
        <h2>Find areas near you</h2>
        <div className="radius-inputs">
          <button type="button" disabled={locating} onClick={useMyLocation}>{locating ? 'Finding location...' : 'Use my location'}</button>
          <button type="button" aria-pressed={picking} onClick={() => { ++locationRequest.current; setLocating(false); pickingRef.current = !pickingRef.current; setPicking(pickingRef.current); setLocationMessage(pickingRef.current ? 'Click a spot on the map to search around it.' : 'Map selection cancelled.'); }}>Choose a spot on the map</button>
          <label>Distance<select value={radius} onChange={e => { setRadius(Number(e.target.value)); setRadiusApplied(false); }}>
            {[5,10,25,50,100,250,500].map(km => <option key={km} value={km}>{km} km</option>)}
          </select></label>
          <button type="button" disabled={!center} onClick={() => { setRadiusApplied(true); setLocationMessage(`Showing areas within ${radius} km of your selected spot.`); }}>Apply distance</button>
          <label><input type="checkbox" checked={incomeOnly} onChange={e => setIncomeOnly(e.target.checked)} /> Only areas with the highest income barriers</label>
          <button type="button" onClick={() => { ++locationRequest.current; setLocating(false); setCenter(null); setRadiusApplied(false); setIncomeOnly(false); pickingRef.current = false; setPicking(false); setLocationMessage('Showing all Texas areas.'); if (data && map.current) map.current.fitBounds(L.geoJSON(data).getBounds()); }}>Show all Texas</button>
        </div>
        <p role="status">{locationMessage}</p>
        <p>{loading ? 'Loading areas...' : `${rows.length.toLocaleString()} areas shown${center && radiusApplied ? ` within ${radius} km` : ' across Texas'}.`} {center && !radiusApplied ? 'Spot selected. Choose a distance, then click Apply distance to show the ring and nearby areas.' : !center ? 'Choose a location to filter by distance.' : ''}</p>
        <p>Distance is measured straight to each area's approximate center, not along roads. Data covers Texas only. The income filter shows the highest quarter of the model's income-barrier scores; it is not a poverty percentage.</p>
      </section>

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
            <p>No matching areas here. Try a larger distance, turn off the income filter, or choose a location in Texas.</p>
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
                  {center && radiusApplied && centers.get(p.GEOID) && ` · ${distanceKm(center, centers.get(p.GEOID)!).toFixed(1)} km away`}
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
