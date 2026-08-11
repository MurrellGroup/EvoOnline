/** Complementary error function with better than ~1e-7 relative tail accuracy. */
export function erfc(value: number): number {
  const z = Math.abs(value);
  const t = 1 / (1 + 0.5 * z);
  let polynomial = 0.17087277;
  polynomial = -0.82215223 + t * polynomial;
  polynomial = 1.48851587 + t * polynomial;
  polynomial = -1.13520398 + t * polynomial;
  polynomial = 0.27886807 + t * polynomial;
  polynomial = -0.18628806 + t * polynomial;
  polynomial = 0.09678418 + t * polynomial;
  polynomial = 0.37409196 + t * polynomial;
  polynomial = 1.00002368 + t * polynomial;
  const approximation = t * Math.exp(-z * z - 1.26551223 + t * polynomial);
  return value >= 0 ? approximation : 2 - approximation;
}

/** Three-rate BS-REL calibration from the updated fixed-complexity test. */
export function bsrelPValue(likelihoodRatio: number): number {
  if (!(likelihoodRatio > 0)) return 0.5;
  const chi1Survival = erfc(Math.sqrt(likelihoodRatio / 2));
  const chi2Survival = Math.exp(-likelihoodRatio / 2);
  return Math.max(0, Math.min(0.5, 0.05 * chi1Survival + 0.45 * chi2Survival));
}

export function holmBonferroni(pValues: readonly number[]): Float64Array {
  const adjusted = new Float64Array(pValues.length);
  const order = pValues.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  let running = 0;
  for (let rank = 0; rank < order.length; rank += 1) {
    const item = order[rank]!;
    running = Math.max(running, Math.min(1, (order.length - rank) * item.value));
    adjusted[item.index] = running;
  }
  return adjusted;
}
