
export interface Community {
  GEOID: string;
  County: string;
  location: string;
  TotalPop: number;
  income_score: number;
  transportation_score: number;
  grocery_score: number;
  overall_need_score: number;
  grocery_observed: boolean;
}

export interface Recommendation extends Community {
  rank: number;
  recommendedKits: number;
}

export function rankDonationLocations(
  communities: Community[],
  availableKits: number
): Recommendation[] {
  const inventory = Math.max(
    0,
    Math.floor(Number(availableKits) || 0)
  );

  // Rank by model-derived need score.
  const ranked = communities
    .filter(
      (community) =>
        Number.isFinite(community.overall_need_score) &&
        Number.isFinite(community.TotalPop) &&
        community.TotalPop > 0
    )
    .sort(
      (a, b) =>
        b.overall_need_score - a.overall_need_score
    );

  const topThree = ranked.slice(0, 3);

  if (topThree.length === 0) {
    return [];
  }

  // Prototype allocation weight combines:
  // 1. Relative estimated need
  // 2. Population as a size proxy
  //
  // This does NOT measure actual unmet meal-kit demand.
  const weights = topThree.map(
    (community) =>
      (community.overall_need_score / 100) *
      community.TotalPop
  );

  const totalWeight = weights.reduce(
    (sum, weight) => sum + weight,
    0
  );

  // Allocate integer kits while preserving the total.
  const rawAllocations = weights.map(
    (weight) =>
      totalWeight > 0
        ? (inventory * weight) / totalWeight
        : inventory / topThree.length
  );

  const allocations = rawAllocations.map(Math.floor);

  let remaining =
    inventory -
    allocations.reduce((sum, count) => sum + count, 0);

  const remainderOrder = rawAllocations
    .map((raw, index) => ({
      index,
      fraction: raw - allocations[index],
    }))
    .sort((a, b) => b.fraction - a.fraction);

  for (const item of remainderOrder) {
    if (remaining <= 0) break;
    allocations[item.index]++;
    remaining--;
  }

  return topThree.map((community, index) => ({
    ...community,
    rank: index + 1,
    recommendedKits: allocations[index],
  }));
}
