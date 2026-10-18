/** Illustrative donation planning, not a learned effect on historical barriers. */
export function simulateDonation(score, kits, need) {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw Error('Invalid area score.');
  if (!Number.isSafeInteger(kits) || kits < 0) throw Error('Donation must be a nonnegative whole number.');
  if (!Number.isSafeInteger(need) || need <= 0) throw Error('Estimated kits needed must be a positive whole number.');
  const used = Math.min(kits, need);
  return { used, remaining: need-used, extra: kits-used, coverage: used/need*100, score: score*((need-used)/need) };
}
