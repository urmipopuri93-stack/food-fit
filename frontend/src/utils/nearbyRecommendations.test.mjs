import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {distanceMiles,getTractCenters,nearbyCommunities} from './nearbyRecommendations.ts';
test('distance, cap and missing coordinates',()=>{
 assert.equal(distanceMiles(32,-96,32,-96),0);
 assert.ok(Math.abs(distanceMiles(0,0,1,0)-69.094)<.1);
 const data=[{GEOID:'near'},{GEOID:'far'},{GEOID:'missing'}];
 const centers={near:{lat:0,lng:0},far:{lat:1,lng:0}};
 assert.equal(nearbyCommunities(data,centers,0,0,10).length,1);
 assert.equal(nearbyCommunities(data,centers,0,0,100).length,2);
 for(const n of [0,-1,101,NaN,Infinity]) assert.throws(()=>nearbyCommunities(data,centers,0,0,n));
});
test('real Dallas and distant searches filter without mutating source',async()=>{
 const data=JSON.parse(await readFile(new URL('../../public/data/texas_dashboard.json',import.meta.url),'utf8'));
 const geo=JSON.parse(await readFile(new URL('../../public/data/texas_heatmap.geojson',import.meta.url),'utf8'));
 const centers=getTractCenters(geo);
 const original=JSON.stringify(data);
 const near=nearbyCommunities(data,centers,32.7762719,-96.7968559,10);
 const wide=nearbyCommunities(data,centers,32.7762719,-96.7968559,100);
 assert.ok(near.length>3 && wide.length>near.length);
 assert.ok(near.every(c=>distanceMiles(32.7762719,-96.7968559,centers[c.GEOID].lat,centers[c.GEOID].lng)<=10));
 assert.equal(nearbyCommunities(data,centers,40.7,-74,100).length,0);
 assert.equal(JSON.stringify(data),original);
});
