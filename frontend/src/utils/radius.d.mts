import type { Geometry } from 'geojson';
export function distanceKm(a: [number,number], b: [number,number]): number;
export function areaCenter(geometry: Geometry | null): [number,number] | null;
export function withinRadius(center: [number,number], point: [number,number] | null, km: number): boolean;
