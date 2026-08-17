import { informationCriterion, treeHmmParameterCount } from "./stepwise.js";
import type {
  TreeEmissionProfile,
  TreeHmmOptions,
  TreeHmmSubsetHypothesis,
  TreeHmmSubsetSearchStep,
  TreeHmmSubsetSearchSummary,
  TreeHmmSubsetTransition,
} from "./types.js";

interface RapidScore {
  readonly indexes: readonly number[];
  readonly logLikelihood: number;
  readonly criterionValue: number;
  readonly expectedResets: number;
  readonly parameterCount: number;
}

function resetGrid(sites: number, states: number): number[] {
  if (states <= 1 || sites <= 1) return [0];
  const maximum = Math.min(48, Math.max(6, 3 * (states - 1)));
  return [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32, maximum]
    .filter((value) => value <= maximum)
    .filter((value, index, values) => values.indexOf(value) === index);
}

/** Fast deterministic proxy for the exact HMM stationary-weight fit. Averaged
 * sitewise likelihood responsibilities let a topology serving a short tract
 * carry a correspondingly small reset weight; a uniform K-way reset would
 * otherwise make adding such a state look artificially bad during search. */
function approximateWeights(
  profiles: readonly TreeEmissionProfile[],
  indexes: readonly number[],
): Float64Array {
  const sites = profiles[0]!.siteLogLikelihoods.length;
  const weights = new Float64Array(indexes.length).fill(0.05);
  for (let site = 0; site < sites; site += 1) {
    let maximum = -Infinity;
    for (const index of indexes) {
      const value = Number(profiles[index]!.siteLogLikelihoods[site]);
      if (Number.isFinite(value) && value > maximum) maximum = value;
    }
    if (!Number.isFinite(maximum)) continue;
    let total = 0;
    for (let state = 0; state < indexes.length; state += 1) {
      const value = Number(profiles[indexes[state]!]!.siteLogLikelihoods[site]);
      total += Number.isFinite(value) ? Math.exp(Math.max(-60, value - maximum)) : 0;
    }
    if (!(total > 0)) continue;
    for (let state = 0; state < indexes.length; state += 1) {
      const value = Number(profiles[indexes[state]!]!.siteLogLikelihoods[site]);
      if (Number.isFinite(value)) weights[state] = weights[state]! + Math.exp(Math.max(-60, value - maximum)) / total;
    }
  }
  const sum = weights.reduce((total, value) => total + value, 0);
  for (let state = 0; state < weights.length; state += 1) weights[state] = weights[state]! / sum;
  return weights;
}

/** O(LK) marginal likelihood with sitewise-responsibility proxy reset weights,
 * used only by the combinatorial search. The selected subset is subsequently
 * refit with full forward/backward and optimized stationary weights. */
function rapidForward(
  profiles: readonly TreeEmissionProfile[],
  indexes: readonly number[],
  expectedResets: number,
  weights: Float64Array,
): number {
  const sites = profiles[0]!.siteLogLikelihoods.length;
  const states = indexes.length;
  if (expectedResets <= 0) {
    const stateScores = indexes.map((profileIndex, state) => {
      let total = Math.log(Math.max(Number.MIN_VALUE, weights[state]!));
      for (let site = 0; site < sites; site += 1) total += Number(profiles[profileIndex]!.siteLogLikelihoods[site]);
      return total;
    });
    const maximum = Math.max(...stateScores);
    return maximum + Math.log(stateScores.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
  }
  const transition = states <= 1 || sites <= 1 ? 0 : 1 - Math.exp(-expectedResets / (sites - 1));
  const stay = 1 - transition;
  let alpha = new Float64Array(states);
  let next = new Float64Array(states);
  let logLikelihood = 0;
  for (let site = 0; site < sites; site += 1) {
    let maximum = -Infinity;
    for (let state = 0; state < states; state += 1) {
      const value = Number(profiles[indexes[state]!]!.siteLogLikelihoods[site]);
      if (Number.isFinite(value) && value > maximum) maximum = value;
    }
    if (!Number.isFinite(maximum)) maximum = 0;
    let scale = 0;
    for (let state = 0; state < states; state += 1) {
      const value = Number(profiles[indexes[state]!]!.siteLogLikelihoods[site]);
      const emission = Number.isFinite(value) ? Math.exp(Math.max(-745, value - maximum)) : 0;
      const prior = site === 0 ? weights[state]! : stay * alpha[state]! + transition * weights[state]!;
      next[state] = emission * prior;
      scale += next[state]!;
    }
    if (!(scale > 0)) scale = Number.MIN_VALUE;
    for (let state = 0; state < states; state += 1) next[state] = next[state]! / scale;
    [alpha, next] = [next, alpha];
    logLikelihood += maximum + Math.log(scale);
  }
  return logLikelihood;
}

function key(indexes: readonly number[]): string {
  return indexes.join(",");
}

function compare(first: RapidScore, second: RapidScore): number {
  return first.criterionValue - second.criterionValue
    || first.indexes.length - second.indexes.length
    || key(first.indexes).localeCompare(key(second.indexes));
}

function setDifference(first: readonly number[], second: readonly number[]): number[] {
  const right = new Set(second);
  return first.filter((value) => !right.has(value));
}

export function searchTreeHmmSubsets(
  profiles: readonly TreeEmissionProfile[],
  options: TreeHmmOptions,
): TreeHmmSubsetSearchSummary {
  if (profiles.length === 0) throw new Error("At least one tree emission profile is required.");
  const started = performance.now();
  const sites = profiles[0]!.siteLogLikelihoods.length;
  const criterion = options.criterion ?? "aicc";
  const beamWidth = Math.max(1, Math.min(12, Math.round(options.beamWidth ?? 4)));
  const beamDepth = Math.max(1, Math.min(profiles.length, Math.round(options.maximumStates ?? 12)));
  for (const profile of profiles) {
    const invalid = Array.from(profile.siteLogLikelihoods).findIndex((value) => !Number.isFinite(Number(value)));
    if (invalid >= 0) throw new Error(`Tree emission profile '${profile.id}' has a non-finite log likelihood at aligned site ${invalid + 1}.`);
  }
  const cache = new Map<string, RapidScore>();
  const transitions = new Map<string, TreeHmmSubsetTransition>();
  const estimatedEvaluations = Math.max(profiles.length, profiles.length + beamWidth * profiles.length * Math.max(1, beamDepth - 1));
  let evaluations = 0;
  const score = (rawIndexes: readonly number[]): RapidScore => {
    options.signal?.throwIfAborted();
    const indexes = Array.from(new Set(rawIndexes)).sort((a, b) => a - b);
    const signature = key(indexes);
    const cached = cache.get(signature);
    if (cached !== undefined) return cached;
    const weights = approximateWeights(profiles, indexes);
    let bestLogLikelihood = -Infinity;
    let bestExpectedResets = 0;
    for (const expectedResets of resetGrid(sites, indexes.length)) {
      const value = rapidForward(profiles, indexes, expectedResets, weights);
      if (value > bestLogLikelihood) {
        bestLogLikelihood = value;
        bestExpectedResets = expectedResets;
      }
    }
    const parameters = treeHmmParameterCount(options.taxa, indexes.length);
    const result = {
      indexes,
      logLikelihood: bestLogLikelihood,
      criterionValue: informationCriterion(criterion, bestLogLikelihood, parameters, sites),
      expectedResets: bestExpectedResets,
      parameterCount: parameters,
    };
    cache.set(signature, result);
    evaluations += 1;
    if (evaluations === 1 || evaluations % 8 === 0) {
      options.onProgress?.(Math.min(0.96, evaluations / estimatedEvaluations), {
        message: `Rapid topology-subset search · ${evaluations.toLocaleString()} cached hypotheses · ${indexes.length} states`,
        current: evaluations,
        total: estimatedEvaluations,
        metricLabel: criterion.toUpperCase(),
        metricValue: result.criterionValue,
      });
    }
    return result;
  };

  const connect = (from: RapidScore, to: RapidScore, phase: TreeHmmSubsetTransition["phase"]): void => {
    const removed = setDifference(from.indexes, to.indexes);
    const added = setDifference(to.indexes, from.indexes);
    const move = removed.length > 0 && added.length > 0 ? "swap" as const : removed.length > 0 ? "drop" as const : "add" as const;
    const transition = { fromKey: key(from.indexes), toKey: key(to.indexes), move, phase };
    transitions.set(`${transition.fromKey}>${transition.toKey}:${phase}`, transition);
  };

  const singletonScores = profiles.map((_profile, index) => score([index])).sort(compare);
  const nullScore = score([0]);
  // Index zero is the whole-alignment null. Keep it as a beam seed even when
  // a regional singleton scores better, so a narrow beam still evaluates the
  // null's neighbors. It is not forced into any child or final hypothesis.
  const beamSeeds = [nullScore, ...singletonScores.filter((candidate) => key(candidate.indexes) !== key(nullScore.indexes))];
  let beam = Array.from(new Map(beamSeeds.map((candidate) => [key(candidate.indexes), candidate])).values()).slice(0, beamWidth);
  let best = singletonScores[0]!;
  const steps: TreeHmmSubsetSearchStep[] = [{
    round: 0,
    move: "seed",
    treeIds: best.indexes.map((index) => profiles[index]!.id),
    criterionValue: best.criterionValue,
    deltaCriterion: nullScore.criterionValue - best.criterionValue,
  }];
  let round = 1;
  for (let size = 2; size <= beamDepth; size += 1) {
    const expanded = new Map<string, RapidScore>();
    for (const parent of beam) {
      for (let index = 0; index < profiles.length; index += 1) {
        if (parent.indexes.includes(index)) continue;
        const candidate = score([...parent.indexes, index]);
        connect(parent, candidate, "beam");
        expanded.set(key(candidate.indexes), candidate);
      }
    }
    if (expanded.size === 0) break;
    beam = Array.from(expanded.values()).sort(compare).slice(0, beamWidth);
    if (compare(beam[0]!, best) < 0) {
      const previous = best;
      best = beam[0]!;
      steps.push({
        round: round++,
        move: "add",
        treeIds: best.indexes.map((index) => profiles[index]!.id),
        criterionValue: best.criterionValue,
        deltaCriterion: previous.criterionValue - best.criterionValue,
      });
    }
  }

  let locallyConverged = false;
  const seen = new Set<string>([key(best.indexes)]);
  const floatingIterationLimit = Math.max(12, Math.min(512, 4 * profiles.length));
  let floatingIterations = 0;
  for (; floatingIterations < floatingIterationLimit; floatingIterations += 1) {
    const neighbors = new Map<string, RapidScore>();
    if (best.indexes.length > 1) {
      for (const removed of best.indexes) {
        const candidate = score(best.indexes.filter((value) => value !== removed));
        connect(best, candidate, "floating");
        neighbors.set(key(candidate.indexes), candidate);
      }
    }
    // The beam depth is only an initializer. Forward floating additions are
    // deliberately allowed to grow all the way to the available candidate
    // set, so a winner at the beam boundary is never mistaken for a local
    // optimum without evaluating every one-tree addition.
    if (best.indexes.length < profiles.length) {
      for (let added = 0; added < profiles.length; added += 1) {
        if (best.indexes.includes(added)) continue;
        const candidate = score([...best.indexes, added]);
        connect(best, candidate, "floating");
        neighbors.set(key(candidate.indexes), candidate);
      }
    }
    for (const removed of best.indexes) {
      for (let added = 0; added < profiles.length; added += 1) {
        if (best.indexes.includes(added)) continue;
        const candidate = score([...best.indexes.filter((value) => value !== removed), added]);
        connect(best, candidate, "floating");
        neighbors.set(key(candidate.indexes), candidate);
      }
    }
    const next = Array.from(neighbors.values()).sort(compare)[0];
    if (next === undefined || compare(next, best) >= 0 || seen.has(key(next.indexes))) {
      locallyConverged = true;
      break;
    }
    const removed = setDifference(best.indexes, next.indexes);
    const added = setDifference(next.indexes, best.indexes);
    const move = removed.length > 0 && added.length > 0 ? "swap" as const : removed.length > 0 ? "drop" as const : "add" as const;
    const previous = best;
    best = next;
    seen.add(key(best.indexes));
    steps.push({
      round: round++,
      move,
      treeIds: best.indexes.map((index) => profiles[index]!.id),
      criterionValue: best.criterionValue,
      deltaCriterion: previous.criterionValue - best.criterionValue,
    });
  }
  options.onProgress?.(1, {
    message: `Rapid search retained ${best.indexes.length}/${profiles.length} topology states after ${cache.size.toLocaleString()} subset evaluations`,
    current: cache.size,
    total: cache.size,
    metricLabel: criterion.toUpperCase(),
    metricValue: best.criterionValue,
  });
  const ordered = Array.from(cache.values()).sort(compare);
  const bestCriterion = ordered.find((candidate) => Number.isFinite(candidate.criterionValue))?.criterionValue;
  const hypotheses: TreeHmmSubsetHypothesis[] = ordered.map((candidate) => ({
    key: key(candidate.indexes),
    treeIds: candidate.indexes.map((index) => profiles[index]!.id),
    profileIndexes: candidate.indexes,
    stateCount: candidate.indexes.length,
    logLikelihood: candidate.logLikelihood,
    criterionValue: candidate.criterionValue,
    deltaFromBest: bestCriterion === undefined || !Number.isFinite(candidate.criterionValue) ? null : candidate.criterionValue - bestCriterion,
    parameterCount: candidate.parameterCount,
    expectedResets: candidate.expectedResets,
  }));
  return {
    algorithm: "beam-forward-floating",
    evaluatedSubsets: cache.size,
    beamWidth,
    maximumStates: beamDepth,
    selectedTreeIds: best.indexes.map((index) => profiles[index]!.id),
    selectedProfileIndexes: best.indexes,
    criterionValue: best.criterionValue,
    nullCriterionValue: nullScore.criterionValue,
    converged: locallyConverged,
    floatingIterations,
    floatingIterationLimit,
    steps,
    hypotheses,
    transitions: Array.from(transitions.values()),
    nullKey: key(nullScore.indexes),
    selectedKey: key(best.indexes),
    exactVerifiedKeys: [],
    elapsedMs: performance.now() - started,
  };
}
