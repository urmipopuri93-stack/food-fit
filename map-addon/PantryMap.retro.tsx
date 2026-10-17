import { useCallback, useEffect, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { MapPinned, RefreshCw } from "lucide-react";
import "leaflet/dist/leaflet.css";

// Backend address. Override with VITE_API_URL in frontend/.env if it moves.
const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

interface ApiPoint {
  id: number;
  name: string;
  lat: number;
  lng: number;
  props: { location?: string; demand?: number; stock?: number; value?: number };
}

const HIGH_NEED = 75; // unmet kits at or above this count as high need
const OLIVE = "#71865f";
const RUST = "#a65c45";

function unmet(p: ApiPoint) {
  const { demand, stock } = p.props ?? {};
  return demand === undefined ? 0 : Math.max(0, demand - (stock ?? 0));
}

// Zooms the map to fit all points whenever they change
function FitToPoints({ points }: { points: ApiPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), {
      padding: [40, 40],
      maxZoom: 12,
    });
  }, [points, map]);
  return null;
}

// Uses the same panel classes as the rest of the dashboard (retro-panel, panel-heading, ...)
export default function PantryMap() {
  const [points, setPoints] = useState<ApiPoint[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(() => {
    setStatus("loading");
    fetch(`${API}/points?limit=10000`)
      .then((r) => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then((pts: ApiPoint[]) => {
        setPoints(pts);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  useEffect(load, [load]);

  const tag =
    status === "ready" ? `${points.length} locations` : status === "loading" ? "Loading" : "Backend offline";

  return (
    <section className="retro-panel" style={{ marginBottom: 10 }}>
      <div className="panel-heading">
        <div className="flex items-center gap-2">
          <MapPinned size={17} />
          <h2>Pantry Map</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="heading-tag">{tag}</span>
          <button type="button" onClick={load} aria-label="Reload locations" style={{ display: "flex" }}>
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="panel-content">
        <p className="panel-description">
          Circle size shows demand. Rust-colored circles have the highest unmet need.
        </p>

        {status === "error" && (
          <p className="tiny-note" style={{ marginTop: 0, marginBottom: 10, color: RUST }}>
            Can't reach the backend at {API}. Start it from the MapBackend folder with
            python -m uvicorn app.main:app --reload, then press reload.
          </p>
        )}
        {status === "ready" && points.length === 0 && (
          <p className="tiny-note" style={{ marginTop: 0, marginBottom: 10 }}>
            No locations yet. Add some with POST /points/bulk at {API}/docs, then press reload.
          </p>
        )}

        {/* isolate keeps Leaflet's internal z-indexes from covering other panels */}
        <div style={{ isolation: "isolate", height: 380, border: "1px solid #b7b09d" }}>
          <MapContainer center={[32.78, -96.8]} zoom={10} style={{ height: "100%", width: "100%" }}>
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution="&copy; OpenStreetMap contributors"
            />
            <FitToPoints points={points} />
            {points.map((p) => {
              const size = p.props?.demand ?? p.props?.value ?? 40;
              const color = unmet(p) >= HIGH_NEED ? RUST : OLIVE;
              return (
                <CircleMarker
                  key={p.id}
                  center={[p.lat, p.lng]}
                  radius={Math.max(7, size / 8)}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.55 }}
                >
                  <Popup>
                    <strong>{p.name}</strong>
                    {p.props?.location && <div>{p.props.location}</div>}
                    {p.props?.demand !== undefined && (
                      <div>
                        Demand {p.props.demand}, stock {p.props.stock ?? 0}, unmet {unmet(p)} kits
                      </div>
                    )}
                    {p.props?.demand === undefined && p.props?.value !== undefined && (
                      <div>Value {p.props.value}</div>
                    )}
                  </Popup>
                </CircleMarker>
              );
            })}
          </MapContainer>
        </div>

        <div className="tiny-note" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <span><span style={{ color: OLIVE }}>&#9679;</span> Monitor</span>
          <span><span style={{ color: RUST }}>&#9679;</span> High need (unmet {HIGH_NEED}+ kits)</span>
        </div>
      </div>
    </section>
  );
}
