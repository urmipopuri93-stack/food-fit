import { useEffect, useState } from 'react';
import { simulateDonation } from './utils/donationSimulation.mjs';
type Area = { GEOID: string; County: string; TotalPop: number; overall_need_score: number };
type Targets = { source: string; assumption: string; areas: Record<string, number | null> };
export default function WhatIfSimulator({ areas, selectedId, onSelect }: {
  areas: Area[]; selectedId: string; onSelect: (id: string) => void;
}) {
  const [kits, setKits] = useState('500');
  const [targets, setTargets] = useState<Targets | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof simulateDonation> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/data/donation_targets.json', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw Error('Could not load donation planning data.');
        const data: Targets = await response.json();
        if (!data.areas || typeof data.areas !== 'object') throw Error('Invalid donation planning data.');
        if (!controller.signal.aborted) setTargets(data);
      }).catch(err => { if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : 'Data unavailable.'); });
    return () => controller.abort();
  }, []);
  const area = areas.find(a => a.GEOID === selectedId);
  const count = area ? targets?.areas[area.GEOID] : undefined;
  const target = typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.ceil(count) : null;
  function reset() { setResult(null); setError(''); }
  function downloadScenario() {
    if (!result || !area || !targets) return;
    const payload = { area_id: area.GEOID, county: area.County, donation_kits: Number(kits),
      target_kits: target, original_model_score: area.overall_need_score,
      scenario: result, source: targets.source, assumption: targets.assumption,
      limitation: 'Illustrative target coverage; not measured demand or a causal prediction. No donation recorded.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `donation-scenario-${area.GEOID}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="sim-slot" aria-labelledby="sim-title">
    <h2 id="sim-title">What if I donate here?</h2>
    <p>Choose an area and enter how many meal kits you want to donate. See how much of its estimated kit goal your donation would cover.</p>
    <form className="simulation-form" onSubmit={e => {
      e.preventDefault();
      try {
        if (!area || target === null || target === 0) throw Error('A positive donation target is unavailable for this area.');
        if (!kits.trim()) throw Error('Enter meal kits to donate.');
        setResult(simulateDonation(area.overall_need_score, Number(kits), target));
        setError('');
      } catch (err) { setResult(null); setError(err instanceof Error ? err.message : 'Check your inputs.'); }
    }}>
      <label>Area<select required value={selectedId} onChange={e => { reset(); onSelect(e.target.value); }}>
        <option value="">Choose an area or click the map</option>
        {areas.map(a => <option key={a.GEOID} value={a.GEOID}>{a.County} County · Area {a.GEOID.slice(-6)}</option>)}
      </select></label>
      <label>Meal kits you would donate<input required type="number" min="0" step="1" value={kits} onChange={e => { reset(); setKits(e.target.value); }} /></label>
      <button disabled={target === null || target === 0} type="submit">Run simulation</button>
    </form>
    {!targets && !loadError && <p>Loading donation planning data...</p>}
    {loadError && <p role="alert">{loadError}</p>}
    {area && targets && target === null && <p>No matching USDA count is available for this area. We cannot calculate a donation target from this dataset.</p>}
    {target === 0 && <p>The source lists zero residents for this particular access measure. That does not mean nobody needs food; this target cannot measure donation impact here.</p>}
    {target !== null && target > 0 && <p>Estimated kit goal: <strong>{target.toLocaleString()} kits</strong>. For this example, we plan one kit for each low-income resident listed as living far from a grocery store.</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div className="simulation-results" aria-live="polite">
      <h3>What your donation would do</h3>
      <p><strong>Your donation would cover {result.coverage.toFixed(1)}% of this area's estimated kit goal.</strong></p>
      <progress aria-label="Donation target coverage" max="100" value={result.coverage} />
      <div className="simulation-score-comparison">
        <div><span>Kits to reach the goal before your donation</span><strong>{target!.toLocaleString()}</strong></div>
        <div><span>Kits your donation would provide toward the goal</span><strong>{result.used.toLocaleString()}</strong></div>
        <div><span>Kits still needed to reach the goal afterward</span><strong>{result.remaining.toLocaleString()}</strong></div>
      </div>
      {result.remaining === 0
        ? <p>Your donation would meet this example's kit goal.</p>
        : <p>After your donation, another {result.remaining.toLocaleString()} kits would be needed to reach this example's goal.</p>}
      {result.extra > 0 && <p>You would have {result.extra.toLocaleString()} extra kits beyond this goal, which you could consider donating to another area.</p>}
      <p>This is an estimate using older food-access data and one kit per listed resident. It doesn't tell us how many people would actually collect food or whether everyone has enough food long term.</p>
      <div className="simulation-actions"><button type="button" onClick={reset}>Clear result</button><button type="button" onClick={downloadScenario}>Download results</button></div>
    </div>}
  </section>;
}
