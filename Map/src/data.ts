export interface Site {
  id: number;
  name: string;
  lat: number;
  lng: number;
  value: number;
}

// Sample data. Later, replace with: fetch("http://localhost:8000/api/locations")
export const sites: Site[] = [
  { id: 1, name: "Dallas", lat: 32.7767, lng: -96.797, value: 120 },
  { id: 2, name: "Richardson", lat: 32.9483, lng: -96.7299, value: 65 },
  { id: 3, name: "Austin", lat: 30.2672, lng: -97.7431, value: 80 },
  { id: 4, name: "Houston", lat: 29.7604, lng: -95.3698, value: 150 },
  { id: 5, name: "San Antonio", lat: 29.4241, lng: -98.4936, value: 95 },
  { id: 6, name: "El Paso", lat: 31.7619, lng: -106.485, value: 40 },
  { id: 7, name: "Lubbock", lat: 33.5779, lng: -101.8552, value: 30 },
];
