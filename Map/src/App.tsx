import { useEffect, useMemo, useState } from "react";
import MapView from "./MapView";
import type { Site } from "./data";

const API = "http://localhost:8000";

interface ApiPoint {
  id: number;
  name: string;
  lat: number;
  lng: number;
  props: { value?: number };
}

export default function App() {
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [minValue, setMinValue] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    fetch(`${API}/points?limit=10000`)
      .then((r) => {
        if (!r.ok) throw new Error(`API returned ${r.status}`);
        return r.json();
      })
      .then((pts: ApiPoint[]) =>
        setSites(
          pts.map((p) => ({
            id: p.id,
            name: p.name,
            lat: p.lat,
            lng: p.lng,
            value: p.props?.value ?? 0,
          }))
        )
      )
      .catch((e) => setError(`Could not load points: ${e.message}`));
  }, []);

  const visible = useMemo(() => sites.filter((s) => s.value >= minValue), [sites, minValue]);
  const total = visible.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="layout">
      <aside className="panel">
        <h1>Map POC</h1>
        {error && <p className="empty">{error}</p>}

        <label className="filter">
          Minimum value: <strong>{minValue}</strong>
          <input
            type="range"
            min={0}
            max={150}
            step={5}
            value={minValue}
            onChange={(e) => setMinValue(Number(e.target.value))}
          />
        </label>

        <p className="summary">
          {visible.length} of {sites.length} sites, total value {total}
        </p>

        <ul className="list">
          {visible.map((s) => (
            <li key={s.id}>
              <button
                className={s.id === selectedId ? "row active" : "row"}
                onClick={() => setSelectedId(s.id)}
              >
                <span>{s.name}</span>
                <span>{s.value}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <MapView sites={visible} selectedId={selectedId} onSelect={setSelectedId} />
    </div>
  );
}