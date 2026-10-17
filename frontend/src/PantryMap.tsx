import { useCallback, useEffect, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import { RefreshCw } from "lucide-react";
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

const HIGH_NEED = 75; // same threshold the Pantry Overview uses

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

  return (
    <section className="rounded-[24px] border border-[#C5D3DD] bg-white p-6">
      <div className="flex flex-wrap justify-between items-start gap-3 mb-5">
        <div>
          <p className="uppercase tracking-[0.15em] text-xs font-bold text-[#B48928] mb-2">
            Live locations
          </p>
          <h3 className="font-serif tracking-tight text-2xl font-bold">Pantry Map</h3>
          <p className="text-sm text-[#83919B] mt-1">
            Circle size shows demand. Darker circles have the highest unmet need.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="bg-[#FFF1CE] text-[#927022] px-3 py-1.5 rounded-full text-xs font-semibold">
            {status === "ready" ? `${points.length} locations` : status === "loading" ? "Loading" : "Backend offline"}
          </span>
          <button
            onClick={load}
            aria-label="Reload locations"
            className="rounded-full border border-[#DEE7ED] p-2 text-[#5F7D91] cursor-pointer hover:bg-[#F4F8FA]"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {status === "error" && (
        <p className="mb-4 rounded-xl bg-[#FBE7DF] text-[#A65C45] text-sm px-4 py-3">
          Can't reach the backend at {API}. Start it from the MapBackend folder with
          python -m uvicorn app.main:app --reload, then press reload.
        </p>
      )}
      {status === "ready" && points.length === 0 && (
        <p className="mb-4 rounded-xl bg-[#F4F8FA] text-[#697A88] text-sm px-4 py-3">
          No locations yet. Add some with POST /points/bulk at {API}/docs, then press reload.
        </p>
      )}

      {/* isolate keeps Leaflet's internal z-indexes from covering the sidebar */}
      <div className="isolate h-[380px] overflow-hidden rounded-2xl border border-[#E2E9EE]">
        <MapContainer center={[32.78, -96.8]} zoom={10} className="h-full w-full">
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <FitToPoints points={points} />
          {points.map((p) => {
            const size = p.props?.demand ?? p.props?.value ?? 40;
            const high = unmet(p) >= HIGH_NEED;
            return (
              <CircleMarker
                key={p.id}
                center={[p.lat, p.lng]}
                radius={Math.max(7, size / 8)}
                pathOptions={{
                  color: high ? "#A65C45" : "#C89A2B",
                  fillColor: high ? "#A65C45" : "#C89A2B",
                  fillOpacity: 0.55,
                }}
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

      <div className="flex flex-wrap gap-5 mt-4 text-xs text-[#677987]">
        <span className="flex gap-2 items-center">
          <span className="w-3 h-3 rounded-full bg-[#C89A2B]" />
          Monitor
        </span>
        <span className="flex gap-2 items-center">
          <span className="w-3 h-3 rounded-full bg-[#A65C45]" />
          High need (unmet {HIGH_NEED}+ kits)
        </span>
      </div>
    </section>
  );
}
