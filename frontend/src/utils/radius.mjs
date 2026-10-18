/** Great-circle distance; same Haversine formula as the original radius branch. */
export function distanceKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const dlat = rad(b[0]-a[0]), dlon = rad(b[1]-a[1]);
  const h = Math.sin(dlat/2)**2 + Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dlon/2)**2;
  return 6371*2*Math.asin(Math.sqrt(Math.max(0,Math.min(1,h))));
}
/** Bounding-box center is an approximate representative point, not a population center. */
export function areaCenter(geometry) {
  if (!geometry || !['Polygon','MultiPolygon'].includes(geometry.type)) return null;
  let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
  function visit(coords) {
    if (typeof coords[0]==='number') {
      const [lon,lat]=coords;
      if (!Number.isFinite(lat)||!Number.isFinite(lon)) return;
      west=Math.min(west,lon); east=Math.max(east,lon); south=Math.min(south,lat); north=Math.max(north,lat);
    } else for (const child of coords) visit(child);
  }
  visit(geometry.coordinates);
  return Number.isFinite(west) ? [(south+north)/2,(west+east)/2] : null;
}
export function withinRadius(center, point, km) {
  return !!point && Number.isFinite(km) && km>0 && km<=500 && distanceKm(center,point)<=km;
}
