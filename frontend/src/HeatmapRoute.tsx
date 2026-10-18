import { Suspense, lazy } from "react";

// The map page (Leaflet, the tract data and FitBasket) loads as its own chunk, so the landing
// page and dashboard stay small.
const HeatmapPage = lazy(() => import("./HeatmapPage"));

export default function HeatmapRoute() {
  return (
    <Suspense fallback={<p role="status" style={{ padding: 24 }}>Loading the FoodFit map…</p>}>
      <HeatmapPage />
    </Suspense>
  );
}
