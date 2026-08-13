import { enumerateSprNeighbors, fitchParsimonyBySite, invertSprMove, topologySignature, type SprMove, type SprNeighbor } from "./spr-tree.js";
import type {
  MosaicSprAlignment,
  SprBreakpointEvent,
  SprEdit,
  SprReconstructionOptions,
  SprReconstructionResult,
  SprReconstructionRun,
  SprSearchIteration,
  SprTopologyState,
} from "./types.js";

const COLORS = ["#156f66", "#e0664f", "#5d64d9", "#c28b22", "#9b4fc1", "#2d8bc4", "#6b8e23", "#c54f74", "#6b6f76", "#2f9b72"];
const INF = Number.POSITIVE_INFINITY;

interface SearchState {
  readonly tree: string;
  readonly signature: string;
  readonly costs: Uint16Array;
  readonly parsimony: number;
}

interface SearchEdge {
  readonly first: number;
  readonly second: number;
  readonly forward: SprMove;
  readonly reverse: SprMove;
}

interface SearchGraph {
  readonly states: SearchState[];
  readonly bySignature: Map<string, number>;
  readonly adjacency: Array<Map<number, SearchEdge>>;
}

interface DecodedPath {
  readonly objective: number;
  readonly dataCost: number;
  readonly path: Uint16Array;
  readonly runs: Array<{ readonly start: number; readonly end: number; readonly state: number }>;
  readonly master: number;
}

interface Candidate {
  readonly source: number;
  readonly tree: string;
  readonly signature: string;
  readonly move: SprMove;
  readonly guideDistance: number;
  costs?: Uint16Array;
  potential?: number;
}

interface SearchRun {
  readonly graph: SearchGraph;
  readonly decoded: DecodedPath;
  readonly startIndex: number;
  readonly iterations: SprSearchIteration[];
  readonly completeNeighborhood: boolean;
  readonly candidatesEnumerated: number;
  readonly candidatesScored: number;
}

function sum(values: ArrayLike<number>): number {
  let output = 0;
  for (let index = 0; index < values.length; index += 1) output += Number(values[index]);
  return output;
}

function signatureSplitDistance(first: string, second: string): number {
  const firstDivider = first.indexOf("::");
  const secondDivider = second.indexOf("::");
  if (firstDivider < 0 || secondDivider < 0 || first.slice(0, firstDivider) !== second.slice(0, secondDivider)) return INF;
  const firstSplits = first.slice(firstDivider + 2);
  const secondSplits = second.slice(secondDivider + 2);
  const left = new Set(firstSplits.length === 0 ? [] : firstSplits.split("|"));
  const right = new Set(secondSplits.length === 0 ? [] : secondSplits.split("|"));
  let unique = 0;
  for (const split of left) if (!right.has(split)) unique += 1;
  for (const split of right) if (!left.has(split)) unique += 1;
  return unique / 2;
}

function addState(graph: SearchGraph, tree: string, alignment: MosaicSprAlignment, suppliedCosts?: Uint16Array): number {
  const signature = topologySignature(tree);
  const previous = graph.bySignature.get(signature);
  if (previous !== undefined) return previous;
  const costs = suppliedCosts ?? fitchParsimonyBySite(tree, alignment);
  const index = graph.states.length;
  graph.states.push({ tree, signature, costs, parsimony: sum(costs) });
  graph.bySignature.set(signature, index);
  graph.adjacency.push(new Map());
  return index;
}

function addEdge(graph: SearchGraph, first: number, second: number, move: SprMove): void {
  if (first === second || graph.adjacency[first]!.has(second)) return;
  const edge: SearchEdge = { first, second, forward: move, reverse: invertSprMove(move) };
  graph.adjacency[first]!.set(second, edge);
  graph.adjacency[second]!.set(first, edge);
}

function allPairsDistances(graph: SearchGraph): Float64Array {
  const count = graph.states.length;
  const output = new Float64Array(count * count).fill(INF);
  for (let start = 0; start < count; start += 1) {
    const queue = new Uint16Array(count);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    output[start * count + start] = 0;
    while (head < tail) {
      const current = queue[head++]!;
      const distance = output[start * count + current]! + 1;
      for (const next of graph.adjacency[current]!.keys()) {
        if (output[start * count + next]! <= distance) continue;
        output[start * count + next] = distance;
        queue[tail++] = next;
      }
    }
  }
  return output;
}

function buildRuns(path: Uint16Array): Array<{ readonly start: number; readonly end: number; readonly state: number }> {
  if (path.length === 0) return [];
  const output: Array<{ start: number; end: number; state: number }> = [];
  let start = 0;
  let state = path[0]!;
  for (let site = 1; site <= path.length; site += 1) {
    if (site < path.length && path[site] === state) continue;
    output.push({ start, end: site - 1, state });
    if (site < path.length) { start = site; state = path[site]!; }
  }
  return output;
}

/** Exact minimum-duration semi-Markov decoder for a fixed topology graph. */
function decode(
  graph: SearchGraph,
  distances: Float64Array,
  minimumRunLength: number,
  breakpointPenalty: number,
  sprPenalty: number,
  master: number,
  masterPenalty: number,
): DecodedPath {
  const stateCount = graph.states.length;
  const sites = graph.states[0]?.costs.length ?? 0;
  if (stateCount === 0 || sites === 0) return { objective: INF, dataCost: INF, path: new Uint16Array(), runs: [], master };
  const minimum = Math.max(1, Math.min(sites, Math.floor(minimumRunLength)));
  if (sites < minimum * 2) {
    let best = 0;
    let bestCost = INF;
    for (let state = 0; state < stateCount; state += 1) {
      const distance = distances[master * stateCount + state]!;
      const cost = graph.states[state]!.parsimony + masterPenalty * distance;
      if (cost < bestCost) { bestCost = cost; best = state; }
    }
    const path = new Uint16Array(sites).fill(best);
    return { objective: bestCost, dataCost: graph.states[best]!.parsimony, path, runs: buildRuns(path), master };
  }

  const prefix = new Float64Array(stateCount * (sites + 1));
  for (let state = 0; state < stateCount; state += 1) {
    const offset = state * (sites + 1);
    const costs = graph.states[state]!.costs;
    for (let site = 0; site < sites; site += 1) prefix[offset + site + 1] = prefix[offset + site]! + costs[site]!;
  }
  const scores = new Float64Array(sites * stateCount).fill(INF);
  const backStart = new Uint32Array(sites * stateCount);
  const backState = new Int16Array(sites * stateCount).fill(-1);
  const entryCost = new Float64Array(stateCount).fill(INF);
  const entryStart = new Uint32Array(stateCount);
  const entryPrevious = new Int16Array(stateCount).fill(-1);

  for (let end = minimum - 1; end < sites; end += 1) {
    const start = end - minimum + 1;
    for (let state = 0; state < stateCount; state += 1) {
      const prefixOffset = state * (sites + 1);
      let candidate = INF;
      let previous = -1;
      if (start === 0) {
        candidate = masterPenalty * distances[master * stateCount + state]!;
      } else {
        const previousEnd = start - 1;
        for (let from = 0; from < stateCount; from += 1) {
          if (from === state) continue;
          const distance = distances[from * stateCount + state]!;
          if (!Number.isFinite(distance)) continue;
          const value = scores[previousEnd * stateCount + from]!
            + breakpointPenalty + sprPenalty * distance
            + masterPenalty * distances[master * stateCount + state]!;
          if (value < candidate) { candidate = value; previous = from; }
        }
      }
      candidate -= prefix[prefixOffset + start]!;
      if (candidate < entryCost[state]!) {
        entryCost[state] = candidate;
        entryStart[state] = start;
        entryPrevious[state] = previous;
      }
      const index = end * stateCount + state;
      scores[index] = prefix[prefixOffset + end + 1]! + entryCost[state]!;
      backStart[index] = entryStart[state]!;
      backState[index] = entryPrevious[state]!;
    }
  }

  let finalState = 0;
  let objective = scores[(sites - 1) * stateCount]!;
  for (let state = 1; state < stateCount; state += 1) {
    const value = scores[(sites - 1) * stateCount + state]!;
    if (value < objective) { objective = value; finalState = state; }
  }
  const path = new Uint16Array(sites);
  let end = sites - 1;
  let current = finalState;
  while (end >= 0) {
    const index = end * stateCount + current;
    const start = backStart[index]!;
    path.fill(current, start, end + 1);
    current = backState[index]!;
    end = start - 1;
    if (end >= 0 && current < 0) throw new Error("SPR path traceback terminated before the first site.");
  }
  let dataCost = 0;
  for (let site = 0; site < sites; site += 1) dataCost += graph.states[path[site]!]!.costs[site]!;
  return { objective, dataCost, path, runs: buildRuns(path), master };
}

function medoid(decoded: DecodedPath, distances: Float64Array, stateCount: number): number {
  const occupancy = new Uint32Array(stateCount);
  for (let site = 0; site < decoded.path.length; site += 1) {
    const state = decoded.path[site]!;
    occupancy[state] = occupancy[state]! + 1;
  }
  let best = decoded.master;
  let bestCost = INF;
  for (let candidate = 0; candidate < stateCount; candidate += 1) {
    let cost = 0;
    for (let state = 0; state < stateCount; state += 1) {
      if (occupancy[state] === 0) continue;
      cost += Math.sqrt(occupancy[state]!) * distances[candidate * stateCount + state]!;
    }
    if (cost < bestCost) { bestCost = cost; best = candidate; }
  }
  return best;
}

function jointlyDecode(
  graph: SearchGraph,
  minimumRunLength: number,
  breakpointPenalty: number,
  sprPenalty: number,
  masterPenalty: number,
  initialMaster = 0,
): DecodedPath {
  const distances = allPairsDistances(graph);
  let master = Math.min(initialMaster, graph.states.length - 1);
  let result = decode(graph, distances, minimumRunLength, breakpointPenalty, sprPenalty, master, masterPenalty);
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const nextMaster = medoid(result, distances, graph.states.length);
    if (nextMaster === master) break;
    master = nextMaster;
    result = decode(graph, distances, minimumRunLength, breakpointPenalty, sprPenalty, master, masterPenalty);
  }
  return result;
}

function bestIntervalGain(candidate: Uint16Array, graph: SearchGraph, decoded: DecodedPath, minimumRunLength: number): number {
  const sites = candidate.length;
  const minimum = Math.max(1, Math.min(sites, minimumRunLength));
  const prefix = new Float64Array(sites + 1);
  for (let site = 0; site < sites; site += 1) {
    const current = graph.states[decoded.path[site]!]!.costs[site]!;
    prefix[site + 1] = prefix[site]! + current - candidate[site]!;
  }
  let minimumPrefix = 0;
  let best = -INF;
  for (let end = minimum; end <= sites; end += 1) {
    minimumPrefix = Math.min(minimumPrefix, prefix[end - minimum]!);
    best = Math.max(best, prefix[end]! - minimumPrefix);
  }
  return best;
}

function diverseCandidates(candidates: Candidate[], limit: number): Candidate[] {
  if (candidates.length <= limit) return candidates;
  const sorted = candidates.slice().sort((a, b) => a.guideDistance - b.guideDistance || a.signature.localeCompare(b.signature));
  const selected = new Map<string, Candidate>();
  const guided = Math.ceil(limit * 0.7);
  for (let index = 0; index < guided; index += 1) selected.set(sorted[index]!.signature, sorted[index]!);
  const remaining = limit - selected.size;
  for (let index = 0; index < remaining; index += 1) {
    const position = Math.min(sorted.length - 1, Math.floor((index + 0.5) * sorted.length / remaining));
    selected.set(sorted[position]!.signature, sorted[position]!);
  }
  return Array.from(selected.values());
}

function occupiedStates(decoded: DecodedPath): number[] {
  return Array.from(new Set(decoded.runs.map((run) => run.state)));
}

function runSearch(
  alignment: MosaicSprAlignment,
  seedSignatures: readonly string[],
  seed: string,
  startNumber: number,
  options: Required<Pick<SprReconstructionOptions,
    "minimumRunLength" | "breakpointPenalty" | "sprPenalty" | "masterPenalty" | "maximumStates" | "maximumIterations" | "beamWidth" | "parsimonyScreenLimit" | "patience">>,
  signal: AbortSignal | undefined,
  onProgress: SprReconstructionOptions["onProgress"],
): SearchRun {
  const graph: SearchGraph = { states: [], bySignature: new Map(), adjacency: [] };
  const initial = addState(graph, seed, alignment);
  let decoded = jointlyDecode(graph, options.minimumRunLength, options.breakpointPenalty, options.sprPenalty, options.masterPenalty, initial);
  let frontier = [initial];
  let bestObjective = decoded.objective;
  let stale = 0;
  const iterations: SprSearchIteration[] = [];
  let completeNeighborhood = false;
  let totalEnumerated = 0;
  let totalScored = 0;
  const neighborCache = new Map<number, readonly SprNeighbor[]>();

  for (let iteration = 1; iteration <= options.maximumIterations && graph.states.length < options.maximumStates; iteration += 1) {
    signal?.throwIfAborted();
    const started = performance.now();
    const sources = Array.from(new Set([...occupiedStates(decoded), ...frontier])).slice(0, Math.max(options.beamWidth * 2, 4));
    const candidatesBySignature = new Map<string, Candidate>();
    let enumerated = 0;
    let fullyScreened = true;
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const source = sources[sourceIndex]!;
      let neighbors = neighborCache.get(source);
      if (neighbors === undefined) {
        onProgress?.(
          Math.min(0.99, (iteration - 1 + 0.08 * sourceIndex / Math.max(1, sources.length)) / options.maximumIterations),
          {
            message: `SPR start ${startNumber} · round ${iteration} · enumerating all one-SPR neighbours of state S${source + 1}`,
            current: sourceIndex + 1,
            total: sources.length,
            indeterminate: true,
          },
        );
        neighbors = enumerateSprNeighbors(graph.states[source]!.tree);
        neighborCache.set(source, neighbors);
      }
      enumerated += neighbors.length;
      for (const neighbor of neighbors) {
        const existing = graph.bySignature.get(neighbor.topologySignature);
        if (existing !== undefined) {
          addEdge(graph, source, existing, neighbor.moves[0]!);
          continue;
        }
        if (candidatesBySignature.has(neighbor.topologySignature)) continue;
        let guideDistance = INF;
        for (const target of seedSignatures) guideDistance = Math.min(guideDistance, signatureSplitDistance(neighbor.topologySignature, target));
        candidatesBySignature.set(neighbor.topologySignature, {
          source,
          tree: neighbor.tree,
          signature: neighbor.topologySignature,
          move: neighbor.moves[0]!,
          guideDistance,
        });
      }
    }
    totalEnumerated += enumerated;
    const candidates = Array.from(candidatesBySignature.values());
    const screened = diverseCandidates(candidates, options.parsimonyScreenLimit);
    if (screened.length < candidates.length) fullyScreened = false;
    for (let index = 0; index < screened.length; index += 1) {
      signal?.throwIfAborted();
      const candidate = screened[index]!;
      candidate.costs = fitchParsimonyBySite(candidate.tree, alignment);
      candidate.potential = bestIntervalGain(candidate.costs, graph, decoded, options.minimumRunLength)
        - 2 * (options.breakpointPenalty + options.sprPenalty)
        - 0.05 * candidate.guideDistance;
      if ((index & 7) === 0) onProgress?.(
        Math.min(0.99, (iteration - 1 + index / Math.max(1, screened.length)) / options.maximumIterations),
        { message: `SPR start ${startNumber} · round ${iteration} · Fitch screening ${index + 1}/${screened.length}`, current: index + 1, total: screened.length },
      );
    }
    totalScored += screened.length;
    screened.sort((a, b) => (b.potential ?? -INF) - (a.potential ?? -INF) || a.guideDistance - b.guideDistance || a.signature.localeCompare(b.signature));
    const room = options.maximumStates - graph.states.length;
    const chosen = screened.slice(0, Math.min(options.beamWidth, room));
    frontier = [];
    for (const candidate of chosen) {
      const index = addState(graph, candidate.tree, alignment, candidate.costs);
      addEdge(graph, candidate.source, index, candidate.move);
      frontier.push(index);
    }
    const previous = decoded.objective;
    decoded = jointlyDecode(graph, options.minimumRunLength, options.breakpointPenalty, options.sprPenalty, options.masterPenalty, decoded.master);
    const improvement = previous - decoded.objective;
    if (decoded.objective + 1e-9 < bestObjective) { bestObjective = decoded.objective; stale = 0; }
    else stale += 1;
    completeNeighborhood = fullyScreened && chosen.length === 0;
    iterations.push({
      start: startNumber,
      iteration,
      topologyStates: graph.states.length,
      occupiedStates: occupiedStates(decoded).length,
      candidatesEnumerated: enumerated,
      candidatesScored: screened.length,
      candidatesAdded: chosen.length,
      objective: decoded.objective,
      improvement,
      masterStateId: `S${decoded.master + 1}`,
      elapsedMs: performance.now() - started,
    });
    onProgress?.(
      Math.min(0.99, iteration / options.maximumIterations),
      {
        message: `SPR start ${startNumber} · round ${iteration}: ${graph.states.length} states, ${occupiedStates(decoded).length} occupied, objective ${decoded.objective.toFixed(2)}`,
        current: iteration,
        total: options.maximumIterations,
        metricLabel: "objective",
        metricValue: decoded.objective,
      },
    );
    if (chosen.length === 0) break;
    // This is a search-patience budget, not a state-space/model restriction:
    // every retained state can still be an arbitrarily deep SPR composition.
    // Several non-improving layers are deliberately allowed so a useful
    // multi-edit topology need not have useful intermediate trees.
    if (stale >= options.patience) break;
  }
  return { graph, decoded, startIndex: initial, iterations, completeNeighborhood, candidatesEnumerated: totalEnumerated, candidatesScored: totalScored };
}

function shortestScript(graph: SearchGraph, from: number, to: number, cap = 32): { readonly edits: SprEdit[]; readonly count: number; readonly capped: boolean } {
  const count = graph.states.length;
  const distance = new Int16Array(count).fill(-1);
  const queue = new Uint16Array(count);
  let head = 0;
  let tail = 0;
  queue[tail++] = to;
  distance[to] = 0;
  while (head < tail) {
    const current = queue[head++]!;
    for (const next of graph.adjacency[current]!.keys()) if (distance[next]! < 0) {
      distance[next] = distance[current]! + 1;
      queue[tail++] = next;
    }
  }
  if (distance[from]! < 0) throw new Error("Two decoded topology states are disconnected in the SPR graph.");
  const ways = new Uint32Array(count);
  ways[to] = 1;
  const ordered = Array.from({ length: count }, (_, index) => index).sort((a, b) => distance[a]! - distance[b]!);
  let capped = false;
  for (const current of ordered) {
    if (current === to || distance[current]! < 0) continue;
    let total = 0;
    for (const next of graph.adjacency[current]!.keys()) if (distance[next] === distance[current]! - 1) {
      total += ways[next]!;
      if (total >= cap) { total = cap; capped = true; break; }
    }
    ways[current] = total;
  }
  const edits: SprEdit[] = [];
  let current = from;
  for (let step = 1; current !== to; step += 1) {
    const next = Array.from(graph.adjacency[current]!.keys())
      .filter((candidate) => distance[candidate] === distance[current]! - 1)
      .sort((a, b) => graph.states[a]!.signature.localeCompare(graph.states[b]!.signature))[0]!;
    const edge = graph.adjacency[current]!.get(next)!;
    const move = edge.first === current ? edge.forward : edge.reverse;
    edits.push({
      step,
      fromStateId: `S${current + 1}`,
      toStateId: `S${next + 1}`,
      prunedTaxa: move.prunedTaxa,
      sourceSplit: move.sourceSplit,
      sourceAttachmentSplit: move.sourceAttachmentSplit,
      destinationSplit: move.destinationSplit,
    });
    current = next;
  }
  return { edits, count: ways[from]!, capped };
}

function materialize(
  run: SearchRun,
  options: Required<Pick<SprReconstructionOptions, "minimumRunLength" | "breakpointPenalty" | "sprPenalty" | "masterPenalty">>,
  elapsedMs: number,
  searchedStarts: number,
  seedSignatures: readonly string[],
): SprReconstructionResult {
  const { graph, decoded } = run;
  const occupancy = new Uint32Array(graph.states.length);
  for (let site = 0; site < decoded.path.length; site += 1) {
    const state = decoded.path[site]!;
    occupancy[state] = occupancy[state]! + 1;
  }
  const distances = allPairsDistances(graph);
  const states: SprTopologyState[] = graph.states.map((state, index) => ({
    id: `S${index + 1}`,
    tree: state.tree,
    topologySignature: state.signature,
    seedDistance: distances[run.startIndex * graph.states.length + index]!,
    parsimony: state.parsimony,
    occupiedSites: occupancy[index]!,
    color: COLORS[index % COLORS.length]!,
  }));
  const runs: SprReconstructionRun[] = decoded.runs.map((segment, index) => {
    let parsimony = 0;
    for (let site = segment.start; site <= segment.end; site += 1) parsimony += graph.states[segment.state]!.costs[site]!;
    return { id: `R${index + 1}`, start: segment.start + 1, end: segment.end + 1, stateId: `S${segment.state + 1}`, stateIndex: segment.state, parsimony };
  });
  const events: SprBreakpointEvent[] = [];
  for (let index = 0; index + 1 < decoded.runs.length; index += 1) {
    const left = decoded.runs[index]!;
    const right = decoded.runs[index + 1]!;
    const script = shortestScript(graph, left.state, right.state);
    events.push({
      breakpoint: left.end + 1,
      fromStateId: `S${left.state + 1}`,
      toStateId: `S${right.state + 1}`,
      sprDistance: script.edits.length,
      edits: script.edits,
      alternativeShortestScripts: script.count,
      alternativesCapped: script.capped,
    });
  }
  const derivations = states
    .filter((state) => state.occupiedSites > 0)
    .map((state) => {
      const stateIndex = Number(state.id.slice(1)) - 1;
      const script = shortestScript(graph, decoded.master, stateIndex);
      return {
        stateId: state.id,
        occupiedSites: state.occupiedSites,
        sprDistanceFromMaster: script.edits.length,
        edits: script.edits,
        alternativeShortestScripts: script.count,
        alternativesCapped: script.capped,
      };
    });
  const edgeCount = graph.adjacency.reduce((total, neighbors) => total + neighbors.size, 0) / 2;
  const nullParsimony = graph.states.reduce((best, state) => Math.min(best, state.parsimony), INF);
  return {
    status: "complete",
    scoreKind: "fitch-parsimony-mdl",
    objective: decoded.objective,
    parsimony: decoded.dataCost,
    nullParsimony,
    breakpointPenalty: options.breakpointPenalty,
    sprPenalty: options.sprPenalty,
    masterPenalty: options.masterPenalty,
    minimumRunLength: options.minimumRunLength,
    initialSeedStateId: `S${run.startIndex + 1}`,
    masterStateId: `S${decoded.master + 1}`,
    masterChangedFromSeed: decoded.master !== run.startIndex,
    states,
    runs,
    derivations,
    events,
    iterations: run.iterations,
    certificate: {
      globalOptimal: false,
      completeOneSprNeighborhood: run.completeNeighborhood,
      scope: run.completeNeighborhood ? "exhaustive-one-spr-local" : "budgeted-column-generation",
      searchedStarts,
      topologyStates: states.length,
      graphEdges: edgeCount,
      unconnectedSeedTopologies: seedSignatures.reduce((total, signature) => total + (graph.bySignature.has(signature) ? 0 : 1), 0),
      message: run.completeNeighborhood
        ? "Every one-SPR neighbour of the final occupied/frontier states fit inside the scoring budget; none entered the reconstruction. This is a local, not global, certificate."
        : "The explicit graph and edit scripts are exact, but topology-space search was budgeted. No claim of global SPR/parsimony optimality is made.",
    },
    elapsedMs,
    message: `${runs.length} genomic run${runs.length === 1 ? "" : "s"} use ${occupiedStates(decoded).length} local topologies. Boundary scripts contain ${events.reduce((total, event) => total + event.sprDistance, 0)} explicit SPR edit${events.reduce((total, event) => total + event.sprDistance, 0) === 1 ? "" : "s"}; local trees may be any discovered multi-SPR composition from the jointly selected master.`,
  };
}

export function skippedSprReconstruction(message: string): SprReconstructionResult {
  return {
    status: "skipped",
    scoreKind: "fitch-parsimony-mdl",
    objective: null,
    parsimony: null,
    nullParsimony: null,
    breakpointPenalty: 0,
    sprPenalty: 0,
    masterPenalty: 0,
    minimumRunLength: 1,
    initialSeedStateId: null,
    masterStateId: null,
    masterChangedFromSeed: false,
    states: [],
    runs: [],
    derivations: [],
    events: [],
    iterations: [],
    certificate: { globalOptimal: false, completeOneSprNeighborhood: false, scope: "budgeted-column-generation", searchedStarts: 0, topologyStates: 0, graphEdges: 0, unconnectedSeedTopologies: 0, message },
    elapsedMs: 0,
    message,
  };
}

/**
 * Jointly search a master topology and a piecewise path through an explicitly
 * generated SPR graph. Every graph edge is a real one-SPR operation; a change
 * at one breakpoint may traverse any number of those edges.
 */
export function reconstructSprHistory(alignment: MosaicSprAlignment, trees: readonly string[], supplied: SprReconstructionOptions = {}): SprReconstructionResult {
  const started = performance.now();
  const unique = new Map<string, string>();
  for (const tree of trees) {
    try { unique.set(topologySignature(tree), tree); } catch { /* unusable proposal */ }
  }
  if (unique.size === 0) return skippedSprReconstruction("No resolved labelled tree was available to seed the unrestricted SPR reconstruction.");
  const breakpointPenalty = supplied.breakpointPenalty ?? 0.5 * Math.log(Math.max(2, alignment.sites));
  const possibleMoves = Math.max(4, (2 * alignment.taxa - 3) * Math.max(2, 2 * alignment.taxa - 6));
  const sprPenalty = supplied.sprPenalty ?? 0.35 * Math.log(possibleMoves);
  const masterPenalty = supplied.masterPenalty ?? 0.25 * sprPenalty;
  const options = {
    minimumRunLength: Math.max(1, Math.min(alignment.sites, Math.round(supplied.minimumRunLength ?? Math.max(30, Math.min(150, alignment.sites / 8))))),
    breakpointPenalty: Math.max(0, breakpointPenalty),
    sprPenalty: Math.max(0, sprPenalty),
    masterPenalty: Math.max(0, masterPenalty),
    maximumStates: Math.max(4, Math.min(128, Math.round(supplied.maximumStates ?? 48))),
    maximumIterations: Math.max(1, Math.min(40, Math.round(supplied.maximumIterations ?? 12))),
    beamWidth: Math.max(1, Math.min(16, Math.round(supplied.beamWidth ?? 4))),
    parsimonyScreenLimit: Math.max(8, Math.min(512, Math.round(supplied.parsimonyScreenLimit ?? 96))),
    maximumStarts: Math.max(1, Math.min(12, Math.round(supplied.maximumStarts ?? 3))),
    patience: Math.max(1, Math.min(20, Math.round(supplied.patience ?? 5))),
  };
  const seeds = Array.from(unique.values())
    .map((tree) => ({ tree, parsimony: sum(fitchParsimonyBySite(tree, alignment)) }))
    .sort((a, b) => a.parsimony - b.parsimony || topologySignature(a.tree).localeCompare(topologySignature(b.tree)));
  const starts = seeds.slice(0, Math.min(options.maximumStarts, seeds.length));
  const seedSignatures = seeds.map((seed) => topologySignature(seed.tree));
  let best: SearchRun | undefined;
  const allIterations: SprSearchIteration[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    supplied.signal?.throwIfAborted();
    supplied.onProgress?.(index / starts.length, { message: `Unrestricted SPR search start ${index + 1}/${starts.length}`, current: index, total: starts.length });
    const run = runSearch(alignment, seedSignatures, starts[index]!.tree, index + 1, options, supplied.signal, (fraction, detail) => {
      supplied.onProgress?.((index + fraction) / starts.length, detail);
    });
    allIterations.push(...run.iterations);
    if (best === undefined || run.decoded.objective < best.decoded.objective) best = run;
  }
  if (best === undefined) return skippedSprReconstruction("The unrestricted SPR search produced no valid topology graph.");
  const result = materialize({ ...best, iterations: allIterations }, options, performance.now() - started, starts.length, seedSignatures);
  supplied.onProgress?.(1, {
    message: result.message,
    current: result.states.length,
    total: result.states.length,
    ...(result.objective === null ? {} : { metricLabel: "objective", metricValue: result.objective }),
  });
  return result;
}
