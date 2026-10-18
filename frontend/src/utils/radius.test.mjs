import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm,areaCenter,withinRadius } from './radius.mjs';
test('Haversine distance and radius boundaries',()=>{
 assert.equal(distanceKm([32,-96],[32,-96]),0);
 assert.ok(Math.abs(distanceKm([0,0],[1,0])-111.195)<.01);
 assert.equal(withinRadius([0,0],[1,0],100),false);
 assert.equal(withinRadius([0,0],[1,0],120),true);
 assert.equal(withinRadius([0,0],null,120),false);
 assert.equal(withinRadius([0,0],[0,0],501),false);
});
test('polygon and multipolygon representative points',()=>{
 const ring=[[0,0],[2,0],[2,4],[0,4],[0,0]];
 assert.deepEqual(areaCenter({type:'Polygon',coordinates:[ring]}),[2,1]);
 assert.deepEqual(areaCenter({type:'MultiPolygon',coordinates:[[ring]]}),[2,1]);
 assert.equal(areaCenter(null),null);
});
