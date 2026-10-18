import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDonation } from './donationSimulation.mjs';
test('partial coverage', () => assert.deepEqual(simulateDonation(80,500,1000), {used:500,remaining:500,extra:0,coverage:50,score:40}));
test('zero, full, surplus donations', () => {
  assert.equal(simulateDonation(80,0,1000).score,80);
  assert.equal(simulateDonation(80,1000,1000).score,0);
  assert.equal(simulateDonation(80,1200,1000).extra,200);
  assert.equal(simulateDonation(80,1200,1000).remaining,0);
});
test('reject invalid and unsafe counts', () => {
  for (const n of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(() => simulateDonation(80,n,100));
    assert.throws(() => simulateDonation(80,1,n));
  }
  assert.throws(() => simulateDonation(80,1,0));
  assert.throws(() => simulateDonation(101,1,100));
});
test('all donation sizes conserve kits and give bounded monotone coverage', () => {
  for (const target of [1,2,461,1000,100000]) {
    let lastScore = 100;
    for (const kits of [0,1,2,100,500,1000,100001]) {
      const r = simulateDonation(80,kits,target);
      assert.equal(r.used+r.extra,kits);
      assert.equal(r.used+r.remaining,target);
      assert.ok(r.coverage>=0 && r.coverage<=100);
      assert.ok(r.score>=0 && r.score<=80 && r.score<=lastScore);
      lastScore=r.score;
    }
  }
});
test('packaged data joins actual map IDs; original scores are preserved', async () => {
  const { readFile } = await import('node:fs/promises');
  const targets=JSON.parse(await readFile(new URL('../../public/data/donation_targets.json',import.meta.url),'utf8'));
  const map=JSON.parse(await readFile(new URL('../../public/data/texas_heatmap.geojson',import.meta.url),'utf8'));
  let checked=0;
  for (const {properties:p} of map.features) {
    const n=targets.areas[p.GEOID];
    if (typeof n!=='number' || n<=0) continue;
    const snapshot=JSON.stringify(p);
    simulateDonation(p.overall_need_score,500,Math.ceil(n));
    assert.equal(JSON.stringify(p),snapshot);
    checked++;
  }
  assert.equal(checked,3349);
  assert.ok(targets.source_commit);
});
