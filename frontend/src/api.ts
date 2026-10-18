export const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export type HeatPoint = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  score: number;
  details: { nutrition_score: number; access_score: number; income_score: number };
  props: { population: number; top_driver: string };
};

export async function fetchHeatmap(): Promise<HeatPoint[]> {
  const res = await fetch(`${API_BASE}/api/heatmap`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
