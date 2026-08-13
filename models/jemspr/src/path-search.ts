import type { JemsprAlignment, JemsprOptions, JemsprPathBreakpoint, JemsprPathIteration, JemsprPathResult, JemsprPathRun, JemsprTreeState } from "./types.js";
import { inferNjTree, multiscaleNjSeeds, type MultiscaleSeed } from "./nj.js";
import { scoreTree, scoreTreeSubset, totalScore } from "./parsimony.js";
import {
  iterateRootedSprNeighbours,
  publicMove,
  rootPlacements,
  rootedRfDistance,
  treeSignature,
  treeToNewick,
  type InternalSprMove,
  type RootedNode,
} from "./tree.js";

interface GraphArc {
  readonly to: number;
  readonly move: InternalSprMove;
}

export interface InternalTreeState {
  readonly tree: RootedNode;
  readonly signature: string;
  readonly scores: Float64Array;
  readonly total: number;
}

export interface RootedTreeGraph {
  readonly states: InternalTreeState[];
  readonly adjacency: GraphArc[][];
  readonly bySignature: Map<string, number>;
}

interface DpResult {
  readonly objective: number;
  readonly states: Int16Array;
  readonly forward: Float64Array;
  readonly backward: Float64Array;
  readonly distances: readonly Int16Array[];
  readonly master: number;
  /** Exact fixed-master objective for every state in this candidate graph. */
  readonly masterObjectives: Float64Array;
}

interface Candidate {
  readonly parent: number;
  readonly tree: RootedNode;
  readonly signature: string;
  readonly move: InternalSprMove;
  readonly inverse: InternalSprMove;
  readonly proxy: number;
  readonly seedDistance: number;
  readonly connections: { readonly parent: number; readonly move: InternalSprMove; readonly inverse: InternalSprMove }[];
  scores?: Float64Array;
  intervalGain?: number;
}

interface SearchConfig {
  readonly method: "fitch" | "sankoff";
  readonly transition: number;
  readonly transversion: number;
  readonly maximumStates: number;
  readonly iterations: number;
  readonly neighbourScreen: number;
  readonly frontierStates: number;
  readonly nearImprovers: number;
  readonly breakpointPenalty: number;
  readonly endpointPenalty: number;
  readonly spanPenalty: number;
}

export interface InternalPathStartResult {
  readonly public: JemsprPathResult;
  readonly graph: RootedTreeGraph;
  readonly dp: DpResult;
  readonly rootStart: number;
  readonly seedCount: number;
  readonly rootPlacementCount: number;
  readonly resourceLimited: boolean;
}

export interface InternalPathSearchResult extends InternalPathStartResult {
  /** All independently expanded root starts, retained for the joint network/master stage. */
  readonly rootStarts: readonly InternalPathStartResult[];
}

const COLORS = ["#177f72", "#d46d35", "#6658d3", "#cc3d6e", "#719e2b", "#2575b8", "#a45d1a", "#0e918c", "#8c4eb2", "#56645f"];

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new DOMException("Analysis cancelled.", "AbortError");
}

function addState(graph: RootedTreeGraph, state: InternalTreeState): number {
  const existing = graph.bySignature.get(state.signature);
  if (existing !== undefined) return existing;
  const index = graph.states.length;
  graph.states.push(state);
  graph.adjacency.push([]);
  graph.bySignature.set(state.signature, index);
  return index;
}

function addEdge(graph: RootedTreeGraph, from: number, to: number, move: InternalSprMove, inverse: InternalSprMove): void {
  if (!graph.adjacency[from]!.some((edge) => edge.to === to)) graph.adjacency[from]!.push({ to, move });
  if (!graph.adjacency[to]!.some((edge) => edge.to === from)) graph.adjacency[to]!.push({ to: from, move: inverse });
}

function graphDistances(graph: RootedTreeGraph): readonly Int16Array[] {
  return graph.states.map((_state, source) => {
    const distance = new Int16Array(graph.states.length);
    distance.fill(32767);
    distance[source] = 0;
    const queue = new Int16Array(graph.states.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = source;
    while (head < tail) {
      const node = queue[head++]!;
      for (const edge of graph.adjacency[node]!) {
        if (distance[edge.to] !== 32767) continue;
        distance[edge.to] = distance[node]! + 1;
        queue[tail++] = edge.to;
      }
    }
    return distance;
  });
}

function movementTransform(graph: RootedTreeGraph, input: Float64Array, breakpointPenalty: number, endpointPenalty: number): { readonly values: Float64Array; readonly sources: Int16Array } {
  const n = graph.states.length;
  const values = new Float64Array(n);
  const sources = new Int16Array(n);
  const used = new Uint8Array(n);
  for (let node = 0; node < n; node += 1) {
    values[node] = input[node]! + breakpointPenalty;
    sources[node] = node;
  }
  for (let step = 0; step < n; step += 1) {
    let best = -1;
    let bestValue = Number.POSITIVE_INFINITY;
    for (let node = 0; node < n; node += 1) {
      if (used[node] === 0 && values[node]! < bestValue) {
        best = node;
        bestValue = values[node]!;
      }
    }
    if (best < 0) break;
    used[best] = 1;
    for (const edge of graph.adjacency[best]!) {
      const proposed = bestValue + endpointPenalty;
      if (proposed < values[edge.to]! - 1e-12) {
        values[edge.to] = proposed;
        sources[edge.to] = sources[best]!;
      }
    }
  }
  for (let node = 0; node < n; node += 1) {
    if (input[node]! <= values[node]!) {
      values[node] = input[node]!;
      sources[node] = node;
    }
  }
  return { values, sources };
}

function emission(alignment: JemsprAlignment, graph: RootedTreeGraph, distances: readonly Int16Array[], master: number, site: number, state: number, spanPenalty: number): number {
  const span = alignment.cellEnds[site]! - alignment.cellStarts[site]!;
  return graph.states[state]!.scores[site]! + spanPenalty * span * distances[master]![state]!;
}

function fixedMasterObjective(alignment: JemsprAlignment, graph: RootedTreeGraph, distances: readonly Int16Array[], master: number, config: SearchConfig): number {
  const k = graph.states.length;
  const sites = alignment.sites;
  if (sites === 0) return 0;
  let previous = new Float64Array(k);
  for (let state = 0; state < k; state += 1) previous[state] = emission(alignment, graph, distances, master, 0, state, config.spanPenalty);
  for (let site = 1; site < sites; site += 1) {
    const moved = movementTransform(graph, previous, config.breakpointPenalty, config.endpointPenalty).values;
    const next = new Float64Array(k);
    for (let state = 0; state < k; state += 1) next[state] = moved[state]! + emission(alignment, graph, distances, master, site, state, config.spanPenalty);
    previous = next;
  }
  return Math.min(...previous);
}

function detailedDp(alignment: JemsprAlignment, graph: RootedTreeGraph, distances: readonly Int16Array[], master: number, masterObjectives: Float64Array, config: SearchConfig): DpResult {
  const k = graph.states.length;
  const sites = alignment.sites;
  if (sites === 0) return { objective: 0, states: new Int16Array(0), forward: new Float64Array(0), backward: new Float64Array(0), distances, master, masterObjectives };
  const forward = new Float64Array(sites * k);
  const backpointer = new Int16Array(sites * k);
  for (let state = 0; state < k; state += 1) forward[state] = emission(alignment, graph, distances, master, 0, state, config.spanPenalty);
  for (let site = 1; site < sites; site += 1) {
    const previous = forward.subarray((site - 1) * k, site * k);
    const moved = movementTransform(graph, previous, config.breakpointPenalty, config.endpointPenalty);
    for (let state = 0; state < k; state += 1) {
      forward[site * k + state] = moved.values[state]! + emission(alignment, graph, distances, master, site, state, config.spanPenalty);
      backpointer[site * k + state] = moved.sources[state]!;
    }
  }
  let finalState = 0;
  for (let state = 1; state < k; state += 1) if (forward[(sites - 1) * k + state]! < forward[(sites - 1) * k + finalState]!) finalState = state;
  const objective = forward[(sites - 1) * k + finalState]!;
  const states = new Int16Array(sites);
  states[sites - 1] = finalState;
  for (let site = sites - 1; site > 0; site -= 1) states[site - 1] = backpointer[site * k + states[site]!]!;

  const backward = new Float64Array(sites * k);
  for (let state = 0; state < k; state += 1) backward[(sites - 1) * k + state] = emission(alignment, graph, distances, master, sites - 1, state, config.spanPenalty);
  for (let site = sites - 2; site >= 0; site -= 1) {
    const next = backward.subarray((site + 1) * k, (site + 2) * k);
    const moved = movementTransform(graph, next, config.breakpointPenalty, config.endpointPenalty).values;
    for (let state = 0; state < k; state += 1) backward[site * k + state] = emission(alignment, graph, distances, master, site, state, config.spanPenalty) + moved[state]!;
  }
  return { objective, states, forward, backward, distances, master, masterObjectives };
}

function solveGraph(alignment: JemsprAlignment, graph: RootedTreeGraph, config: SearchConfig): DpResult {
  const distances = graphDistances(graph);
  let master = 0;
  let objective = Number.POSITIVE_INFINITY;
  const masterObjectives = new Float64Array(graph.states.length);
  for (let candidate = 0; candidate < graph.states.length; candidate += 1) {
    const value = fixedMasterObjective(alignment, graph, distances, candidate, config);
    masterObjectives[candidate] = value;
    if (value < objective - 1e-9 || (Math.abs(value - objective) <= 1e-9 && graph.states[candidate]!.signature < graph.states[master]!.signature)) {
      master = candidate;
      objective = value;
    }
  }
  return detailedDp(alignment, graph, distances, master, masterObjectives, config);
}

function evenlySpacedIndexes(length: number, count: number): readonly number[] {
  if (length <= count) return Array.from({ length }, (_value, index) => index);
  return Array.from({ length: count }, (_value, index) => Math.min(length - 1, Math.floor((index + 0.5) * length / count)));
}

function occupiedSpans(alignment: JemsprAlignment, states: Int16Array, k: number): Float64Array {
  const spans = new Float64Array(k);
  for (let site = 0; site < states.length; site += 1) {
    const state = states[site]!;
    spans[state] = spans[state]! + alignment.cellEnds[site]! - alignment.cellStarts[site]!;
  }
  return spans;
}

function frontier(dp: DpResult, alignment: JemsprAlignment, graph: RootedTreeGraph, limit: number): readonly number[] {
  const spans = occupiedSpans(alignment, dp.states, graph.states.length);
  const ranked = Array.from({ length: graph.states.length }, (_value, index) => index)
    .filter((index) => spans[index]! > 0 || index === dp.master)
    .sort((a, b) => spans[b]! - spans[a]! || graph.states[a]!.signature.localeCompare(graph.states[b]!.signature));
  if (!ranked.includes(dp.master)) ranked.unshift(dp.master);
  return ranked.slice(0, Math.max(1, limit));
}

function exactIntervalPrice(alignment: JemsprAlignment, graph: RootedTreeGraph, dp: DpResult, parents: readonly number[], scores: Float64Array, config: SearchConfig): number {
  const sites = alignment.sites;
  const k = graph.states.length;
  const candidateDistances = new Int16Array(k);
  for (let state = 0; state < k; state += 1) candidateDistances[state] = Math.min(...parents.map((parent) => dp.distances[parent]![state]!)) + 1;
  const prefix = new Float64Array(sites + 1);
  const masterDistance = candidateDistances[dp.master]!;
  for (let site = 0; site < sites; site += 1) {
    const span = alignment.cellEnds[site]! - alignment.cellStarts[site]!;
    prefix[site + 1] = prefix[site]! + scores[site]! + config.spanPenalty * span * masterDistance;
  }
  let minimumA = Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let end = 0; end < sites; end += 1) {
    const start = end;
    let left = 0;
    if (start > 0) {
      left = Number.POSITIVE_INFINITY;
      for (let state = 0; state < k; state += 1) {
        left = Math.min(left, dp.forward[(start - 1) * k + state]! + config.breakpointPenalty + config.endpointPenalty * candidateDistances[state]!);
      }
    }
    minimumA = Math.min(minimumA, left - prefix[start]!);
    let right = 0;
    if (end + 1 < sites) {
      right = Number.POSITIVE_INFINITY;
      for (let state = 0; state < k; state += 1) {
        right = Math.min(right, config.breakpointPenalty + config.endpointPenalty * candidateDistances[state]! + dp.backward[(end + 1) * k + state]!);
      }
    }
    best = Math.min(best, minimumA + prefix[end + 1]! + right);
  }
  return dp.objective - best;
}

function shortestGraphPath(graph: RootedTreeGraph, from: number, to: number): readonly GraphArc[] {
  if (from === to) return [];
  const previous = new Int16Array(graph.states.length);
  previous.fill(-1);
  const queue: number[] = [from];
  previous[from] = from;
  for (let head = 0; head < queue.length && previous[to]! < 0; head += 1) {
    const node = queue[head]!;
    for (const edge of graph.adjacency[node]!) {
      if (previous[edge.to]! >= 0) continue;
      previous[edge.to] = node;
      queue.push(edge.to);
    }
  }
  if (previous[to]! < 0) throw new Error("Candidate rSPR graph is disconnected.");
  const nodes: number[] = [to];
  while (nodes[0] !== from) nodes.unshift(previous[nodes[0]!]!);
  return nodes.slice(0, -1).map((node, index) => graph.adjacency[node]!.find((edge) => edge.to === nodes[index + 1]!)!);
}

function boundaryGap(alignment: JemsprAlignment, graph: RootedTreeGraph, dp: DpResult, boundary: number, config: SearchConfig): number {
  const k = graph.states.length;
  let stay = Number.POSITIVE_INFINITY;
  let change = Number.POSITIVE_INFINITY;
  for (let a = 0; a < k; a += 1) {
    stay = Math.min(stay, dp.forward[(boundary - 1) * k + a]! + dp.backward[boundary * k + a]!);
    for (let b = 0; b < k; b += 1) {
      if (a === b) continue;
      change = Math.min(change, dp.forward[(boundary - 1) * k + a]! + config.breakpointPenalty + config.endpointPenalty * dp.distances[a]![b]! + dp.backward[boundary * k + b]!);
    }
  }
  const actualChanged = dp.states[boundary - 1] !== dp.states[boundary];
  return Math.max(0, (actualChanged ? stay : change) - dp.objective);
}

function publicResult(alignment: JemsprAlignment, graph: RootedTreeGraph, dp: DpResult, iterations: readonly JemsprPathIteration[], config: SearchConfig, names: readonly string[]): JemsprPathResult {
  const spans = occupiedSpans(alignment, dp.states, graph.states.length);
  const states: JemsprTreeState[] = graph.states.map((state, index) => ({
    id: `T${index + 1}`,
    signature: state.signature,
    tree: treeToNewick(state.tree, names),
    totalParsimony: state.total,
    occupiedSpan: spans[index]!,
    masterDistance: dp.distances[dp.master]![index]!,
    color: COLORS[index % COLORS.length]!,
  }));
  const runs: JemsprPathRun[] = [];
  if (dp.states.length > 0) {
    let first = 0;
    for (let site = 1; site <= dp.states.length; site += 1) {
      if (site < dp.states.length && dp.states[site] === dp.states[first]) continue;
      const stateIndex = dp.states[first]!;
      let parsimony = 0;
      for (let cursor = first; cursor < site; cursor += 1) parsimony += graph.states[stateIndex]!.scores[cursor]!;
      runs.push({
        id: `P${runs.length + 1}`,
        start: alignment.cellStarts[first]! + 1,
        end: alignment.cellEnds[site - 1]!,
        stateId: states[stateIndex]!.id,
        stateIndex,
        dataParsimony: parsimony,
      });
      first = site;
    }
  } else {
    runs.push({ id: "P1", start: 1, end: alignment.sites, stateId: states[dp.master]!.id, stateIndex: dp.master, dataParsimony: 0 });
  }
  const breakpoints: JemsprPathBreakpoint[] = [];
  for (let site = 1; site < dp.states.length; site += 1) {
    const from = dp.states[site - 1]!;
    const to = dp.states[site]!;
    if (from === to) continue;
    const path = shortestGraphPath(graph, from, to);
    breakpoints.push({
      afterSite: alignment.cellStarts[site]!,
      intervalLow: site,
      intervalHigh: site,
      fromStateId: states[from]!.id,
      toStateId: states[to]!.id,
      graphDistance: path.length,
      edits: path.map((edge) => publicMove(edge.move, names)),
      minMarginalGap: boundaryGap(alignment, graph, dp, site, config),
    });
  }
  let dataParsimony = 0;
  for (let site = 0; site < dp.states.length; site += 1) dataParsimony += graph.states[dp.states[site]!]!.scores[site]!;
  return {
    objective: dp.objective,
    dataParsimony,
    masterStateId: states[dp.master]!.id,
    states,
    runs,
    breakpoints,
    iterations,
    lowerBoundKind: "adaptive-restricted-rspr-graph",
    certificate: "Exact joint master/path optimum on the final verified rooted-SPR graph. Outer rooted-tree-space expansion is budgeted; no global topology-space optimum is claimed.",
  };
}

function candidateRank(a: Candidate, b: Candidate): number {
  return a.proxy - b.proxy || a.seedDistance - b.seedDistance || a.signature.localeCompare(b.signature);
}

function retainScreenedCandidate(candidates: Map<string, Candidate>, candidate: Candidate, limit: number): void {
  const previous = candidates.get(candidate.signature);
  if (previous !== undefined) {
    previous.connections.push(...candidate.connections);
    return;
  }
  if (candidates.size < limit) {
    candidates.set(candidate.signature, candidate);
    return;
  }
  let worst: Candidate | undefined;
  for (const current of candidates.values()) {
    if (worst === undefined || candidateRank(current, worst) > 0) worst = current;
  }
  if (worst !== undefined && candidateRank(candidate, worst) < 0) {
    candidates.delete(worst.signature);
    candidates.set(candidate.signature, candidate);
  }
}

function runStart(alignment: JemsprAlignment, root: RootedNode, seeds: readonly MultiscaleSeed[], start: number, config: SearchConfig, options: JemsprOptions): InternalPathStartResult {
  const initialScores = scoreTree(root, alignment, config.method, config.transition, config.transversion);
  const graph: RootedTreeGraph = { states: [], adjacency: [], bySignature: new Map() };
  addState(graph, { tree: root, signature: treeSignature(root), scores: initialScores, total: totalScore(initialScores) });
  const screenIndexes = evenlySpacedIndexes(alignment.informativePositions.length, 48);
  const history: JemsprPathIteration[] = [];
  let dp = solveGraph(alignment, graph, config);
  let resourceLimited = false;
  for (let iteration = 1; iteration <= config.iterations && graph.states.length < config.maximumStates; iteration += 1) {
    checkAbort(options.signal);
    const started = performance.now();
    const parents = frontier(dp, alignment, graph, config.frontierStates);
    const candidatesBySignature = new Map<string, Candidate>();
    let enumerated = 0;
    let existingEdgesAdded = 0;
    const enumerationBudget = Math.max(4_096, config.neighbourScreen * 32);
    for (let parentRank = 0; parentRank < parents.length; parentRank += 1) {
      const parent = parents[parentRank]!;
      const parentTree = graph.states[parent]!.tree;
      for (const neighbour of iterateRootedSprNeighbours(parentTree, { maximumCandidates: enumerationBudget })) {
        enumerated += 1;
        if ((enumerated & 255) === 0) {
          checkAbort(options.signal);
          options.onProgress?.("jemspr-tree-space", Math.min(0.97, (iteration - 1 + (parentRank + 0.5) / parents.length) / config.iterations), {
            message: `Root start ${start}, round ${iteration}: streaming genuine rSPR neighbours (${enumerated.toLocaleString()} examined).`,
            current: enumerated,
            metricLabel: "candidate neighbours",
            metricValue: enumerated,
          });
        }
        const existingState = graph.bySignature.get(neighbour.signature);
        if (existingState !== undefined) {
          const before = graph.adjacency[parent]!.length;
          addEdge(graph, parent, existingState, neighbour.move, neighbour.inverse);
          if (graph.adjacency[parent]!.length > before) existingEdgesAdded += 1;
          continue;
        }
        const proxy = scoreTreeSubset(neighbour.tree, alignment, screenIndexes, config.method, config.transition, config.transversion);
        const seedDistance = Math.min(...seeds.map((seed) => rootedRfDistance(neighbour.tree, seed.tree)));
        const candidate: Candidate = { parent, tree: neighbour.tree, signature: neighbour.signature, move: neighbour.move, inverse: neighbour.inverse, proxy, seedDistance, connections: [{ parent, move: neighbour.move, inverse: neighbour.inverse }] };
        retainScreenedCandidate(candidatesBySignature, candidate, config.neighbourScreen);
      }
      options.onProgress?.("jemspr-tree-space", Math.min(0.97, (iteration - 1 + (parentRank + 1) / parents.length) / config.iterations), {
        message: `Root start ${start}, round ${iteration}: streamed ${enumerated.toLocaleString()} genuine rSPR neighbours; retaining ${candidatesBySignature.size} for full pricing.`,
        current: parentRank + 1,
        total: parents.length,
        metricLabel: "candidate neighbours",
        metricValue: enumerated,
      });
    }
    if (existingEdgesAdded > 0) dp = solveGraph(alignment, graph, config);
    const screened = [...candidatesBySignature.values()].sort(candidateRank);
    for (const candidate of screened) {
      checkAbort(options.signal);
      candidate.scores = scoreTree(candidate.tree, alignment, config.method, config.transition, config.transversion);
      candidate.intervalGain = exactIntervalPrice(alignment, graph, dp, [...new Set(candidate.connections.map((connection) => connection.parent))], candidate.scores, config);
    }
    const byGain = screened.sort((a, b) => (b.intervalGain ?? -Infinity) - (a.intervalGain ?? -Infinity) || candidateRank(a, b));
    const selected: Candidate[] = [];
    for (const candidate of byGain) {
      if ((candidate.intervalGain ?? -Infinity) > 1e-8 && selected.length < config.frontierStates) selected.push(candidate);
    }
    for (const candidate of byGain) {
      if (selected.includes(candidate)) continue;
      const parentSeed = Math.min(...seeds.map((seed) => rootedRfDistance(graph.states[candidate.parent]!.tree, seed.tree)));
      if (candidate.seedDistance < parentSeed && selected.length < config.frontierStates + 1) selected.push(candidate);
    }
    for (const candidate of byGain) {
      if (selected.includes(candidate)) continue;
      if (selected.length >= config.frontierStates + config.nearImprovers) break;
      selected.push(candidate);
    }
    const room = config.maximumStates - graph.states.length;
    const additions = selected.slice(0, room);
    for (const candidate of additions) {
      const index = addState(graph, { tree: candidate.tree, signature: candidate.signature, scores: candidate.scores!, total: totalScore(candidate.scores!) });
      for (const connection of candidate.connections) addEdge(graph, connection.parent, index, connection.move, connection.inverse);
    }
    const previousObjective = dp.objective;
    if (additions.length > 0) dp = solveGraph(alignment, graph, config);
    history.push({
      start,
      iteration,
      graphStates: graph.states.length,
      graphEdges: graph.adjacency.reduce((sum, edges) => sum + edges.length, 0) / 2,
      occupiedStates: new Set(dp.states).size,
      mastersEvaluated: graph.states.length,
      neighboursEnumerated: enumerated,
      neighboursPriced: screened.length,
      statesAdded: additions.length,
      objective: dp.objective,
      masterStateId: `T${dp.master + 1}`,
      bestOmittedIntervalGain: Math.max(0, ...screened.map((candidate) => candidate.intervalGain ?? 0)),
      elapsedMs: performance.now() - started,
    });
    options.onProgress?.("jemspr-tree-space", Math.min(0.98, iteration / config.iterations), {
      message: `Root start ${start}: ${graph.states.length} verified trees; ${new Set(dp.states).size} occupied; master T${dp.master + 1}.`,
      current: iteration,
      total: config.iterations,
      metricLabel: "objective",
      metricValue: dp.objective,
    });
    if (additions.length === 0 || (Math.abs(previousObjective - dp.objective) < 1e-10 && history.length >= 3 && history.slice(-3).every((entry) => entry.bestOmittedIntervalGain <= 1e-8))) break;
    if (graph.states.length >= config.maximumStates) resourceLimited = true;
  }
  return {
    public: publicResult(alignment, graph, dp, history, config, alignment.names),
    graph,
    dp,
    rootStart: start,
    seedCount: seeds.length,
    rootPlacementCount: 1,
    resourceLimited,
  };
}

export function searchRootedTreePath(alignment: JemsprAlignment, options: JemsprOptions = {}): InternalPathSearchResult {
  const minimumWindow = Math.max(16, Math.round(options.minimumWindow ?? Math.max(64, Math.min(250, alignment.sites / 8))));
  const seeds = multiscaleNjSeeds(alignment, minimumWindow, Math.max(1, Math.round(options.maximumDyadicTrees ?? 16)));
  const globalTree = seeds[0]?.tree ?? inferNjTree(alignment);
  const placements = rootPlacements(globalTree).slice().sort((a, b) => treeSignature(a).localeCompare(treeSignature(b)));
  const requestedRoots = Math.max(1, Math.round(options.rootPlacements ?? 3));
  const alternatives = placements.filter((tree) => treeSignature(tree) !== treeSignature(globalTree));
  const roots: RootedNode[] = [globalTree];
  const additional = Math.min(requestedRoots - 1, alternatives.length);
  for (let index = 0; index < additional; index += 1) {
    const selected = alternatives[Math.min(alternatives.length - 1, Math.floor((index + 0.5) * alternatives.length / Math.max(1, additional)))]!;
    if (!roots.some((tree) => treeSignature(tree) === treeSignature(selected))) roots.push(selected);
  }
  const method = options.scoreMethod ?? "fitch";
  const config: SearchConfig = {
    method,
    transition: Math.max(0, options.transitionCost ?? 1),
    transversion: Math.max(0, options.transversionCost ?? 1),
    maximumStates: Math.max(4, Math.round(options.maximumGraphStates ?? 36)),
    iterations: Math.max(1, Math.round(options.maximumGraphIterations ?? 10)),
    neighbourScreen: Math.max(4, Math.round(options.neighbourScreen ?? 72)),
    frontierStates: Math.max(1, Math.round(options.frontierStates ?? 4)),
    nearImprovers: Math.max(0, Math.round(options.nearImprovers ?? 2)),
    breakpointPenalty: options.pathBreakpointPenalty !== undefined && options.pathBreakpointPenalty > 0 ? options.pathBreakpointPenalty : options.pathBreakpointPenalty === 0 ? Math.log2(alignment.sites + 1) : 4,
    endpointPenalty: options.pathEndpointPenalty !== undefined && options.pathEndpointPenalty > 0 ? options.pathEndpointPenalty : options.pathEndpointPenalty === 0 ? Math.max(1, Math.log2(alignment.taxa) / 2) : 1,
    spanPenalty: options.pathSpanPenalty !== undefined && options.pathSpanPenalty > 0 ? options.pathSpanPenalty : options.pathSpanPenalty === 0 ? 1 / Math.max(80, minimumWindow) : 0.002,
  };
  let best: InternalPathStartResult | undefined;
  const rootStarts: InternalPathStartResult[] = [];
  const allIterations: JemsprPathIteration[] = [];
  for (let start = 0; start < roots.length; start += 1) {
    checkAbort(options.signal);
    options.onProgress?.("jemspr-root-search", start / roots.length, { message: `Searching inferred root placement ${start + 1} of ${roots.length}.`, current: start + 1, total: roots.length });
    const result = runStart(alignment, roots[start]!, seeds, start + 1, config, options);
    rootStarts.push(result);
    allIterations.push(...result.public.iterations);
    if (best === undefined || result.dp.objective < best.dp.objective - 1e-9) best = result;
  }
  if (best === undefined) throw new Error("No rooted master-tree search was completed.");
  return {
    ...best,
    public: { ...best.public, iterations: allIterations },
    rootStarts,
    rootPlacementCount: roots.length,
    resourceLimited: rootStarts.some((result) => result.resourceLimited) || roots.length < placements.length,
  };
}

export function shortestPathMoves(graph: RootedTreeGraph, from: number, to: number): readonly InternalSprMove[] {
  return shortestGraphPath(graph, from, to).map((edge) => edge.move);
}

export function pathSearchPenalties(alignment: JemsprAlignment, options: JemsprOptions): Readonly<{ breakpoint: number; endpoint: number; span: number }> {
  const minimumWindow = Math.max(16, Math.round(options.minimumWindow ?? Math.max(64, Math.min(250, alignment.sites / 8))));
  return {
    breakpoint: options.pathBreakpointPenalty !== undefined && options.pathBreakpointPenalty > 0 ? options.pathBreakpointPenalty : options.pathBreakpointPenalty === 0 ? Math.log2(alignment.sites + 1) : 4,
    endpoint: options.pathEndpointPenalty !== undefined && options.pathEndpointPenalty > 0 ? options.pathEndpointPenalty : options.pathEndpointPenalty === 0 ? Math.max(1, Math.log2(alignment.taxa) / 2) : 1,
    span: options.pathSpanPenalty !== undefined && options.pathSpanPenalty > 0 ? options.pathSpanPenalty : options.pathSpanPenalty === 0 ? 1 / Math.max(80, minimumWindow) : 0.002,
  };
}
