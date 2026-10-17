import { useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { Site } from "./data";

interface Props {
  sites: Site[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

// Moves the map when a site is selected (must be a child of MapContainer to use useMap)
function FlyToSelected({ sites, selectedId }: Pick<Props, "sites" | "selectedId">) {
  const map = useMap();
  useEffect(() => {
    const s = sites.find((x) => x.id === selectedId);
    if (s) map.flyTo([s.lat, s.lng], 8, { duration: 0.8 });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function MapView({ sites, selectedId, onSelect }: Props) {
  return (
    <MapContainer center={[31.5, -99]} zoom={6} className="map">
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap contributors"
      />
      <FlyToSelected sites={sites} selectedId={selectedId} />
      {sites.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.lat, s.lng]}
          radius={Math.max(6, s.value / 8)}
          pathOptions={{
            color: s.id === selectedId ? "#b91c1c" : "#1d4ed8",
            fillOpacity: 0.55,
          }}
          eventHandlers={{ click: () => onSelect(s.id) }}
        >
          <Popup>
            <strong>{s.name}</strong>
            <br />
            Value: {s.value}
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
