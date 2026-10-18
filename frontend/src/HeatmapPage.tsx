import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import L from "leaflet";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import "./heatmap.css";
import WhatIfSimulator from "./WhatIfSimulator";
import { fetchHeatmap, type HeatPoint } from "./api";

type TabId = "combined" | "nutrition" | "access" | "income";

const TABS: { id: TabId; label: string; color: string; desc: string; ramp: string[] }[] = [
  { id: "combined", label: "All combined", color: "#7a1f1f", desc: "Overall need, from all factors together.",
    ramp: ["#f6e3da", "#e7a58b", "#c8553d", "#7a1f1f"] },
  { id: "nutrition", label: "Nutrition", color: "#3f7d3a", desc: "Few fresh or whole-food options nearby.",
    ramp: ["#e6f0d8", "#a9cf86", "#5a9a4a", "#1f4f22"] },
  { id: "access", label: "Grocery access", color: "#2a6f97", desc: "Far from a grocery store, or no vehicle.",
    ramp: ["#dcebf4", "#9cc8e0", "#3f8bb8", "#12405f"] },
  { id: "income", label: "Low income", color: "#8a5a12", desc: "Higher poverty and lower household income.",
    ramp: ["#f5e8c6", "#e3bd6a", "#b8801f", "#5c3a06"] },
];

function valueFor(p: HeatPoint, tab: TabId): number {
  if (tab === "combined") return p.score;
  if (tab === "nutrition") return p.details.nutrition_score;
  if (tab === "access") return p.details.access_score;
  return p.details.income_score;
}

export default function HeatmapPage() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const heat = useRef<L.Layer | null>(null);
  const [points, setPoints] = useState<HeatPoint[]>([]);
  const [tab, setTab] = useState<TabId>("combined");
  const [error, setError] = useState("");

  useEffect(() => {
    const m = L.map(mapEl.current!).setView([32.85, -96.8], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      maxZoom: 18,
    }).addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      heat.current = null;
    };
  }, []);

  useEffect(() => {
    fetchHeatmap()
      .then(setPoints)
      .catch((e: Error) =>
        setError(`Couldn't load the heatmap (${e.message}). Is the backend running on port 8000?`)
      );
  }, []);

  const current = TABS.find((t) => t.id === tab)!;
  const rows = points.map((p) => ({ p, v: valueFor(p, tab) })).sort((a, b) => b.v - a.v);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (heat.current) m.removeLayer(heat.current);
    const [c0, c1, c2, c3] = current.ramp;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    heat.current = (L as any)
      .heatLayer(
        rows.map((r) => [r.p.lat, r.p.lng, r.v]),
        { radius: 38, blur: 28, minOpacity: 0.25, max: 1, gradient: { 0.2: c0, 0.45: c1, 0.7: c2, 1.0: c3 } }
      )
      .addTo(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, tab]);

  return (
    <div className="heatmap-page">
      <div className="heatmap-top" role="tablist">
        <Link to="/dashboard" className="back">← Dashboard</Link>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={t.id === tab} onClick={() => setTab(t.id)}>
            <span className="dot" style={{ background: t.color }} />
            {t.label}
          </button>
        ))}
      </div>
      {error && <div className="heatmap-error">{error}</div>}
      <div className="heatmap-body">
        <div ref={mapEl} className="heatmap-map" />
        <aside className="heatmap-side">
          <h2>Top 3: {current.label}</h2>
          <p>{current.desc}</p>
          {rows.slice(0, 3).map((r, i) => (
            <button
              key={r.p.id}
              className="heatmap-item"
              onClick={() => map.current?.flyTo([r.p.lat, r.p.lng], 13)}
            >
              <b>{i + 1}. {r.p.name}</b>
              Score {Math.round(r.v * 100)} / 100
              <div className="bar"><i style={{ width: `${r.v * 100}%`, background: current.color }} /></div>
            </button>
          ))}
          <div className="legend">
            <div>Need for attention</div>
            <div className="ramp" style={{ background: `linear-gradient(90deg, ${current.ramp.join(",")})` }} />
            <div className="ends"><span>Lower</span><span>Higher</span></div>
          </div>
        </aside>
      </div>
      <WhatIfSimulator />
    </div>
  );
}
