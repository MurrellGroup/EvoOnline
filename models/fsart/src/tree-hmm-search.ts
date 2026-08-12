import { informationCriterion } from "./stepwise.js";
import type {
  TreeEmissionProfile,
  TreeHmmOptions,
  TreeHmmSubsetSearchStep,
  TreeHmmSubsetSearchSummary,
} from "./types.js";

interface RapidScore {
  readonly indexes: readonly number[];
  readonly logLikelihood: number;
  readonly criterionValue: number;
  readonly expectedResets: number;
}

function parameterCount(taxa: number, states: number): number {
  if (states <= 1) return 2 * taxa + 6;
  return 8 + states * (2 * taxa - 2) + (states - 1) + 1;
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
  const maximumStates = Math.max(1, Math.min(profiles.length, Math.round(options.maximumStates ?? 8)));
  const cache = new Map<string, RapidScore>();
  const estimatedEvaluations = Math.max(profiles.length, profiles.length + beamWidth * profiles.length * Math.max(1, maximumStates - 1));
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
    const result = {
      indexes,
      logLikelihood: bestLogLikelihood,
      criterionValue: informationCriterion(criterion, bestLogLikelihood, parameterCount(options.taxa, indexes.length), sites),
      expectedResets: bestExpectedResets,
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

  const singletonScores = profiles.map((_profile, index) => score([index])).sort(compare);
  const nullScore = score([0]);
  let beam = singletonScores.slice(0, beamWidth);
  let best = singletonScores[0]!;
  const steps: TreeHmmSubsetSearchStep[] = [{
    round: 0,
    move: "seed",
    treeIds: best.indexes.map((index) => profiles[index]!.id),
    criterionValue: best.criterionValue,
    deltaCriterion: nullScore.criterionValue - best.criterionValue,
  }];
  let round = 1;
  for (let size = 2; size <= maximumStates; size += 1) {
    const expanded = new Map<string, RapidScore>();
    for (const parent of beam) {
      for (let index = 0; index < profiles.length; index += 1) {
        if (parent.indexes.includes(index)) continue;
        const candidate = score([...parent.indexes, index]);
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
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const neighbors = new Map<string, RapidScore>();
    if (best.indexes.length > 1) {
      for (const removed of best.indexes) {
        const candidate = score(best.indexes.filter((value) => value !== removed));
        neighbors.set(key(candidate.indexes), candidate);
      }
    }
    if (best.indexes.length < maximumStates) {
      for (let added = 0; added < profiles.length; added += 1) {
        if (best.indexes.includes(added)) continue;
        const candidate = score([...best.indexes, added]);
        neighbors.set(key(candidate.indexes), candidate);
      }
    }
    for (const removed of best.indexes) {
      for (let added = 0; added < profiles.length; added += 1) {
        if (best.indexes.includes(added)) continue;
        const candidate = score([...best.indexes.filter((value) => value !== removed), added]);
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
  return {
    algorithm: "beam-forward-floating",
    evaluatedSubsets: cache.size,
    beamWidth,
    maximumStates,
    selectedTreeIds: best.indexes.map((index) => profiles[index]!.id),
    selectedProfileIndexes: best.indexes,
    criterionValue: best.criterionValue,
    nullCriterionValue: nullScore.criterionValue,
    converged: locallyConverged,
    steps,
    elapsedMs: performance.now() - started,
  };
}
