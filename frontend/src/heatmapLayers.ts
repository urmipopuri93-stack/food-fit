// Single source of truth for map layers, colour bins and tract properties.
// Shared by HeatmapPage (rendering) and the chatbot (explanations), so the
// chatbot's description can never drift from what the map actually draws.

export type TabId = "combined" | "transportation" | "access" | "income";

export const TAB_IDS: readonly TabId[] = ["combined", "transportation", "access", "income"];

export type TractProperties = {
  GEOID: string;
  County: string;
  TotalPop: number;
  overall_need_score: number;
  transportation_score: number;
  grocery_score: number;
  income_score: number;
  grocery_observed?: boolean;
  income_observed?: boolean;
  transportation_observed?: boolean;
  Urban?: number | null;
  poverty_rate?: number | null;
  no_vehicle_pct?: number | null;
  low_access_pct?: number | null;
};

export type LayerDef = {
  id: TabId;
  label: string;
  color: string;
  desc: string;
  field: keyof TractProperties;
  ramp: string[];
};

export const TABS: LayerDef[] = [
  {
    id: "combined",
    label: "Overall need",
    color: "#7a1f1f",
    desc: "Combined historical need based on income, transportation, and grocery-access barriers.",
    field: "overall_need_score",
    ramp: ["#f6e3da", "#e7a58b", "#c8553d", "#7a1f1f"],
  },
  {
    id: "transportation",
    label: "Transportation",
    color: "#3f7d3a",
    desc: "Estimated barriers to accessing food due to limited vehicle availability.",
    field: "transportation_score",
    ramp: ["#e6f0d8", "#a9cf86", "#5a9a4a", "#1f4f22"],
  },
  {
    id: "access",
    label: "Grocery access",
    color: "#2a6f97",
    desc: "Estimated barriers related to distance from supermarkets and grocery stores.",
    field: "grocery_score",
    ramp: ["#dcebf4", "#9cc8e0", "#3f8bb8", "#12405f"],
  },
  {
    id: "income",
    label: "Income barriers",
    color: "#8a5a12",
    desc: "Estimated economic barriers associated with food access.",
    field: "income_score",
    ramp: ["#f5e8c6", "#e3bd6a", "#b8801f", "#5c3a06"],
  },
];

/** Lower bound of each colour bin, in ramp order. */
export const BIN_THRESHOLDS = [0, 25, 50, 75] as const;

export function valueFor(p: TractProperties, tab: TabId): number {
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

export function getColor(score: number, ramp: string[]): string {
  if (score >= BIN_THRESHOLDS[3]) return ramp[3];
  if (score >= BIN_THRESHOLDS[2]) return ramp[2];
  if (score >= BIN_THRESHOLDS[1]) return ramp[1];
  return ramp[0];
}

export function tractName(p: Pick<TractProperties, "County" | "GEOID">): string {
  return `${p.County} County · Tract ${p.GEOID.slice(-6)}`;
}

export function isTabId(value: unknown): value is TabId {
  return typeof value === "string" && (TAB_IDS as readonly string[]).includes(value);
}

/** Fill for tracts whose score for the active layer is missing — never shown as a low score. */
export const NO_DATA_COLOR = "#bdbdbd";

export function formatScore(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} / 100` : "not available";
}

export function formatCount(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toLocaleString() : "not available";
}

const POLYGON_TYPES = new Set(["Polygon", "MultiPolygon"]);

/**
 * Keep only features the map can draw: a polygon geometry and properties with a
 * string GEOID and County. Missing score values are kept (shown as "No data");
 * structurally broken features are dropped and counted so the UI can say so.
 */
export function sanitizeTractFeatures<F extends { geometry: { type: string } | null; properties: unknown }>(
  features: F[],
): { features: F[]; skipped: number } {
  const kept: F[] = [];
  for (const f of features) {
    const p = f?.properties as Partial<TractProperties> | null | undefined;
    if (
      f && f.geometry && POLYGON_TYPES.has(f.geometry.type) &&
      p && typeof p.GEOID === "string" && typeof p.County === "string"
    ) {
      kept.push(f);
    }
  }
  return { features: kept, skipped: features.length - kept.length };
}
