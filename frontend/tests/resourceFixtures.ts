// SYNTHETIC records for tests only — not real resources.
import type { ResourceRecord, SearchResponse, ResourceSource } from "../src/resources/types";

export const SOURCE: ResourceSource = {
  file: "TEST-ONLY.pdf",
  search_area: "test area",
  publisher: null,
  captured_at: null,
  added_to_repository: null,
  freshness: { captured_at: null, age_days: null, stale: null, message: "The date this list was captured is not recorded. Call before visiting." },
};

export function rec(over: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "test-pantry-a--food",
    name: "TEST Pantry A",
    program: "Food Pantry",
    category: "food_distribution",
    category_label: "Food pantry / distribution",
    address: "1 Test St, Richardson, TX 75080",
    city: "Richardson",
    zip: "75080",
    location: { lat: 32.95, lng: -96.73, matched_address: null, geocoder: "test", note: null },
    phone: "555-555-0100",
    phone_label: null,
    website: null,
    email: null,
    hours_text: "Tuesday 8:00 AM - 12:00 PM",
    schedule: [{ day: "Tuesday", opens: "08:00", closes: "12:00", note: null, recurrence_limited: false }],
    schedule_basis: "program",
    hours_notes: [],
    closures: [],
    appointment: null,
    notes: [],
    distance_miles_straight_line: 0.8,
    missing_fields: ["website", "appointment requirement"],
    ...over,
  };
}

export const A = rec();
export const B = rec({
  id: "test-pantry-b--snap",
  name: "TEST Center B",
  program: "SNAP Application Assistance",
  category: "snap_application_help",
  category_label: "SNAP application help",
  address: "2 Test Ave, Plano, TX 75074",
  location: { lat: 33.02, lng: -96.7, matched_address: null, geocoder: "test", note: null },
  phone: null,
  hours_text: "Call for Information",
  schedule: [],
  schedule_basis: null,
  distance_miles_straight_line: 5.2,
  missing_fields: ["phone", "website", "hours", "appointment requirement"],
});
export const SAME_ADDRESS_AS_A = rec({ id: "test-pantry-a--snap", program: "SNAP Application Assistance", category: "snap_application_help", category_label: "SNAP application help" });
export const UNLOCATED = rec({ id: "test-unlocated--food", name: "TEST Unlocated <b>Org</b>", location: null, distance_miles_straight_line: null, missing_fields: ["location"] });

export function response(over: Partial<SearchResponse> = {}): SearchResponse {
  return {
    query: { lat: 32.95, lng: -96.73, radius_miles: 5, categories: ["food_distribution"], day: null, date: null },
    total_in_radius: 2,
    results: [A, B],
    hours_unknown_in_radius: [],
    unlocated: [UNLOCATED],
    out_of_coverage: false,
    distance_note: "Distances are straight-line (as the crow flies), not driving or walking distance.",
    hours_note: "Hours are as listed in the source and are not live. Call before visiting.",
    source: SOURCE,
    ...over,
  };
}
