
import type { FeatureCollection, Geometry } from "geojson";

export type TractCenters = Record<
  string,
  { lat: number; lng: number }
>;

export function nearbyCommunities<T extends { GEOID: string }>(communities: T[], centers: TractCenters, lat: number, lng: number, miles: number): T[] {
  if (!Number.isFinite(miles) || miles <= 0 || miles > 100) throw new Error('Distance must be between 1 and 100 miles.');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) throw new Error('Invalid search location.');
  return communities.filter(c => {
    const point = centers[c.GEOID];
    return point && distanceMiles(lat,lng,point.lat,point.lng)<=miles;
  });
}

export function distanceMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (degrees: number) => degrees * Math.PI / 180;

  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusMiles *
    Math.asin(Math.min(1, Math.sqrt(a)));
}

function collectCoordinates(
  coordinates: unknown,
  output: number[][]
): void {
  if (!Array.isArray(coordinates)) return;

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    output.push([coordinates[0], coordinates[1]]);
    return;
  }

  for (const item of coordinates) {
    collectCoordinates(item, output);
  }
}

export function getTractCenters(
  geojson: FeatureCollection<Geometry, { GEOID: string }>
): TractCenters {
  const centers: TractCenters = {};

  for (const feature of geojson.features) {
    const geoid = feature.properties?.GEOID;
    if (!geoid || !feature.geometry) continue;

    const positions: number[][] = [];

    if ("coordinates" in feature.geometry) {
      collectCoordinates(feature.geometry.coordinates, positions);
    }

    if (positions.length === 0) continue;

    const lngs = positions.map(([lng]) => lng);
    const lats = positions.map(([, lat]) => lat);

    centers[geoid] = {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
  }

  return centers;
}
