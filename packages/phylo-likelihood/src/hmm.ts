export interface HmmResult {
  readonly logMarginalLikelihood: number;
  readonly viterbiLogJoint: number;
  readonly path: Int32Array;
  /** Site-major posterior state probabilities. */
  readonly posterior: Float64Array;
  /** Posterior probability of a state change after each site; final entry is zero. */
  readonly switchPosterior: Float64Array;
}

function logAdd(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

/** Exact dense HMM recursion. Inputs are ordinary probabilities/emissions in log space. */
export function decodeLogHmm(
  emissions: Float64Array,
  sites: number,
  states: number,
  initialLogProbabilities: Float64Array,
  transitionLogProbabilities: Float64Array,
): HmmResult {
  if (emissions.length !== sites * states || initialLogProbabilities.length !== states || transitionLogProbabilities.length !== states * states) throw new RangeError("HMM array dimensions are inconsistent.");
  const forward = new Float64Array(sites * states);
  const viterbi = new Float64Array(sites * states);
  const predecessor = new Uint16Array(sites * states);
  for (let state = 0; state < states; state += 1) {
    forward[state] = initialLogProbabilities[state]! + emissions[state]!;
    viterbi[state] = forward[state]!;
  }
  for (let site = 1; site < sites; site += 1) {
    for (let target = 0; target < states; target += 1) {
      let sum = Number.NEGATIVE_INFINITY;
      let best = Number.NEGATIVE_INFINITY;
      let bestSource = 0;
      for (let source = 0; source < states; source += 1) {
        const transition = transitionLogProbabilities[source * states + target]!;
        sum = logAdd(sum, forward[(site - 1) * states + source]! + transition);
        const candidate = viterbi[(site - 1) * states + source]! + transition;
        if (candidate > best) { best = candidate; bestSource = source; }
      }
      forward[site * states + target] = sum + emissions[site * states + target]!;
      viterbi[site * states + target] = best + emissions[site * states + target]!;
      predecessor[site * states + target] = bestSource;
    }
  }
  let logMarginalLikelihood = Number.NEGATIVE_INFINITY;
  let viterbiLogJoint = Number.NEGATIVE_INFINITY;
  let finalState = 0;
  for (let state = 0; state < states; state += 1) {
    logMarginalLikelihood = logAdd(logMarginalLikelihood, forward[(sites - 1) * states + state]!);
    if (viterbi[(sites - 1) * states + state]! > viterbiLogJoint) { viterbiLogJoint = viterbi[(sites - 1) * states + state]!; finalState = state; }
  }
  const path = new Int32Array(sites);
  path[sites - 1] = finalState;
  for (let site = sites - 1; site > 0; site -= 1) path[site - 1] = predecessor[site * states + path[site]!]!;
  const backward = new Float64Array(sites * states);
  for (let site = sites - 2; site >= 0; site -= 1) {
    for (let source = 0; source < states; source += 1) {
      let sum = Number.NEGATIVE_INFINITY;
      for (let target = 0; target < states; target += 1) sum = logAdd(sum, transitionLogProbabilities[source * states + target]! + emissions[(site + 1) * states + target]! + backward[(site + 1) * states + target]!);
      backward[site * states + source] = sum;
    }
  }
  const posterior = new Float64Array(sites * states);
  for (let site = 0; site < sites; site += 1) for (let state = 0; state < states; state += 1) posterior[site * states + state] = Math.exp(forward[site * states + state]! + backward[site * states + state]! - logMarginalLikelihood);
  const switchPosterior = new Float64Array(sites);
  for (let site = 0; site < sites - 1; site += 1) {
    let stay = 0;
    for (let state = 0; state < states; state += 1) stay += Math.exp(forward[site * states + state]! + transitionLogProbabilities[state * states + state]! + emissions[(site + 1) * states + state]! + backward[(site + 1) * states + state]! - logMarginalLikelihood);
    switchPosterior[site] = Math.max(0, Math.min(1, 1 - stay));
  }
  return { logMarginalLikelihood, viterbiLogJoint, path, posterior, switchPosterior };
}

export function empiricalBitTransitionMatrix(masks: readonly number[], pathMasks: Int32Array, bits: number): { readonly initial: Float64Array; readonly transition: Float64Array; readonly openProbability: number; readonly closeProbability: number } {
  let opens = 0;
  let closes = 0;
  let inactive = 0;
  let active = 0;
  for (let site = 1; site < pathMasks.length; site += 1) {
    const before = pathMasks[site - 1]!;
    const after = pathMasks[site]!;
    for (let bit = 0; bit < bits; bit += 1) {
      const flag = 1 << bit;
      if ((before & flag) === 0) { inactive += 1; if ((after & flag) !== 0) opens += 1; }
      else { active += 1; if ((after & flag) === 0) closes += 1; }
    }
  }
  const openProbability = Math.max(1e-7, Math.min(0.25, (opens + 0.5) / (inactive + 50)));
  const closeProbability = Math.max(1e-7, Math.min(0.5, (closes + 0.5) / (active + 10)));
  const transition = new Float64Array(masks.length * masks.length);
  for (let source = 0; source < masks.length; source += 1) {
    let rowTotal = 0;
    for (let target = 0; target < masks.length; target += 1) {
      let probability = 1;
      for (let bit = 0; bit < bits; bit += 1) {
        const flag = 1 << bit;
        const before = (masks[source]! & flag) !== 0;
        const after = (masks[target]! & flag) !== 0;
        probability *= before ? (after ? 1 - closeProbability : closeProbability) : (after ? openProbability : 1 - openProbability);
      }
      transition[source * masks.length + target] = probability;
      rowTotal += probability;
    }
    for (let target = 0; target < masks.length; target += 1) transition[source * masks.length + target] = Math.log(transition[source * masks.length + target]! / rowTotal);
  }
  const initial = new Float64Array(masks.length);
  let initialTotal = 0;
  for (let state = 0; state < masks.length; state += 1) {
    let probability = 1;
    for (let bit = 0; bit < bits; bit += 1) probability *= (masks[state]! & (1 << bit)) !== 0 ? openProbability : 1 - openProbability;
    initial[state] = probability;
    initialTotal += probability;
  }
  for (let state = 0; state < masks.length; state += 1) initial[state] = Math.log(initial[state]! / initialTotal);
  return { initial, transition, openProbability, closeProbability };
}
