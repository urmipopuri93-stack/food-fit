// Mirrors chat-api/resources (models.py + service.py). Optional fields are null when the source omits them.

export type ResourceCategory = "food_distribution" | "snap_application_help" | "senior_food_box" | "other_services";
export const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
  "food_distribution",
  "snap_application_help",
  "senior_food_box",
  "other_services",
];
export const FOOD_CATEGORIES: readonly ResourceCategory[] = ["food_distribution", "snap_application_help", "senior_food_box"];
export const CATEGORY_LABELS: Record<ResourceCategory, string> = {
  food_distribution: "Food pantry / distribution",
  snap_application_help: "SNAP application help",
  senior_food_box: "Senior food box (CSFP)",
  other_services: "Other services (non-food)",
};

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type DayFilter = Weekday | "today";

export type DayStatus = {
  status: "listed" | "some_weeks_only" | "not_listed" | "listed_closed" | "unknown";
  detail: string;
};

export type ResourceRecord = {
  id: string;
  name: string;
  program: string | null;
  category: ResourceCategory;
  category_label: string;
  address: string;
  city: string | null;
  zip: string | null;
  location: { lat: number; lng: number; matched_address: string | null; geocoder: string; note: string | null } | null;
  phone: string | null;
  phone_label: string | null;
  website: string | null;
  email: string | null;
  hours_text: string | null;
  schedule: { day: Weekday; opens: string; closes: string; note: string | null; recurrence_limited: boolean }[];
  schedule_basis: "program" | "organization" | null;
  hours_notes: string[];
  closures: string[];
  appointment: "required" | "prioritized_walk_ins_welcome" | null;
  notes: string[];
  distance_miles_straight_line: number | null;
  missing_fields: string[];
  day_status?: DayStatus;
};

export type ResourceSource = {
  file: string | null;
  search_area: string | null;
  publisher: string | null;
  captured_at: string | null;
  added_to_repository: string | null;
  freshness: { captured_at: string | null; age_days: number | null; stale: boolean | null; message: string };
};

export type SearchResponse = {
  query: {
    lat: number | null;
    lng: number | null;
    radius_miles: number | null;
    city?: string | null;
    categories: ResourceCategory[];
    day: Weekday | null;
    date: string | null;
  };
  total_in_radius: number;
  results: ResourceRecord[];
  hours_unknown_in_radius: ResourceRecord[];
  unlocated: ResourceRecord[];
  out_of_coverage: boolean;
  /** City searches only: the city has no listings in the dataset. */
  unknown_city?: boolean;
  known_cities?: string[];
  distance_note: string;
  hours_note: string;
  source: ResourceSource;
};

export type ResourceDetail = ResourceRecord & { source: ResourceSource };

export type SearchOrigin = { lat: number; lng: number; label: string };

export type SearchParams = {
  /** Point search (distances); null for a city search. */
  origin: SearchOrigin | null;
  /** City search: listings whose address is in this city (no distances). */
  city?: string;
  radiusMiles: number;
  categories: ResourceCategory[];
  day: DayFilter | null;
  limit: number;
};

export const RESOURCE_ID_PATTERN = /^[a-z0-9-]{3,120}$/;

export function sourceLine(s: ResourceSource | null | undefined): string {
  if (!s) return "Food resource list (source details unavailable). Call before visiting.";
  const parts = [s.publisher, s.file].filter(Boolean).join(" · ") || "Food resource list";
  const area = s.search_area ? ` (${s.search_area})` : "";
  const when = s.captured_at ? `captured ${s.captured_at}` : "capture date not recorded";
  return `${parts}${area}, ${when}. Call before visiting.`;
}

export const CITY_PATTERN = /^[A-Za-z][A-Za-z .'-]{1,39}$/;

export function searchLabel(p: SearchParams | null | undefined): string {
  if (!p) return "";
  if (p.origin) return p.origin.label;
  return p.city?.toLowerCase() === "dallas" ? "listings with a Dallas address (the list covers North Dallas)" : `listings with a ${p.city ?? ""} address`;
}

/** GET /api/resources/locations: geocoded food listings for the service-gap analysis. */
export type ResourceLocation = { id: string; name: string; city: string | null; category: ResourceCategory; category_label: string; lat: number; lng: number };
export type LocationsResponse = {
  locations: ResourceLocation[];
  unlocated_count: number;
  coverage: { lat: number; lng: number; reach_miles: number } | null;
  source: ResourceSource;
  distance_note: string;
};
