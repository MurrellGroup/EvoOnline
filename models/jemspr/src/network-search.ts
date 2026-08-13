import type {
  JemsprAlignment,
  JemsprEventOccurrence,
  JemsprEventTemplate,
  JemsprMaskRun,
  JemsprNetworkResult,
  JemsprNetworkSearchStep,
  JemsprNetworkTree,
  JemsprOptions,
  JemsprTemporalCheck,
} from "./types.js";
import { scoreTree, totalScore } from "./parsimony.js";
import { shortestPathMoves, type InternalPathSearchResult, type InternalPathStartResult } from "./path-search.js";
import { publicMove, treeSignature, treeToNewick, type InternalSprMove, type RootedNode } from "./tree.js";
import {
  compileReticulation,
  displayNetwork,
  networkHash,
  networkToSerializable,
  treeNetwork,
  type SwitchingNetwork,
} from "./switching-network.js";

interface EventCandidate {
  readonly key: string;
  readonly move: InternalSprMove;
  support: number;
  depth: number;
}

interface MasterStart {
  readonly path: InternalPathStartResult;
  readonly master: number;
  readonly objective: number;
  readonly signature: string;
}

interface NetworkEvaluation {
  readonly network: SwitchingNetwork;
  readonly objective: number;
  readonly objectiveWithoutStructure: number;
  readonly dataParsimony: number;
  readonly masks: readonly number[];
  readonly maskPath: Int32Array;
  readonly maskDisplays: readonly DisplayScore[];
  readonly forward: Float64Array;
  readonly backward: Float64Array;
  readonly maximumOverlap: number;
  readonly occurrences: number;
  readonly displaySetKey: string;
}

interface DisplayScore {
  readonly tree: RootedNode;
  readonly signature: string;
  readonly scores: Float64Array;
}

interface NetworkConfig {
  readonly method: "fitch" | "sankoff";
  readonly transition: number;
  readonly transversion: number;
  readonly maximumReticulations: number;
  readonly overlapCap: number;
  readonly beamWidth: number;
  readonly poolSize: number;
  readonly openPenalty: number;
  readonly closePenalty: number;
  readonly breakpointPenalty: number;
  readonly spanPenalty: number;
  readonly reticulationPenalty: number;
  readonly boundaryConvention: "closed" | "open" | "penalized-open";
  readonly censorPenalty: number;
  readonly uncertaintyTolerance: number;
}

export interface InternalNetworkSearchResult {
  readonly public: JemsprNetworkResult;
  readonly network: SwitchingNetwork;
  readonly candidateTemplates: number;
  readonly serializableNetwork: unknown;
}

const COLORS = ["#177f72", "#d46d35", "#6658d3", "#cc3d6e", "#719e2b", "#2575b8", "#a45d1a", "#0e918c", "#8c4eb2", "#56645f"];
const popcount = (value: number): number => {
  let x = value >>> 0;
  let count = 0;
  while (x !== 0) {
    x &= x - 1;
    count += 1;
  }
  return count;
};
const moveKey = (move: InternalSprMove): string => `${move.pruned.join(".")}>${move.destinationIsRoot ? "ROOT" : move.destination.join(".")}|${move.sourceSibling.join(".")}`;

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason ?? new DOMException("Analysis cancelled.", "AbortError");
}

function topMasterStarts(path: InternalPathSearchResult, limit: number): readonly MasterStart[] {
  const ranked: MasterStart[] = [];
  for (const start of path.rootStarts) {
    for (let master = 0; master < start.graph.states.length; master += 1) {
      ranked.push({
        path: start,
        master,
        objective: start.dp.masterObjectives[master]!,
        signature: start.graph.states[master]!.signature,
      });
    }
  }
  ranked.sort((a, b) => a.objective - b.objective || a.signature.localeCompare(b.signature) || a.path.rootStart - b.path.rootStart);
  const unique: MasterStart[] = [];
  const signatures = new Set<string>();
  for (const candidate of ranked) {
    if (signatures.has(candidate.signature)) continue;
    signatures.add(candidate.signature);
    unique.push(candidate);
    if (unique.length >= limit) break;
  }
  return unique;
}

function eventPool(alignment: JemsprAlignment, starts: readonly MasterStart[], limit: number): readonly EventCandidate[] {
  const candidates = new Map<string, EventCandidate>();
  for (const masterStart of starts) {
    const path = masterStart.path;
    const occupied = new Set(path.dp.states);
    const masterScores = path.graph.states[masterStart.master]!.scores;
    for (let state = 0; state < path.graph.states.length; state += 1) {
      const moves = shortestPathMoves(path.graph, masterStart.master, state);
      if (moves.length === 0) continue;
      let stateSupport = occupied.has(state) ? 1 : 0;
      const scores = path.graph.states[state]!.scores;
      for (let site = 0; site < scores.length; site += 1) stateSupport += Math.max(0, masterScores[site]! - scores[site]!);
      for (let depth = 0; depth < moves.length; depth += 1) {
        const move = moves[depth]!;
        const key = moveKey(move);
        const current = candidates.get(key);
        if (current === undefined) candidates.set(key, { key, move, support: stateSupport / (depth + 1), depth });
        else {
          current.support += stateSupport / (depth + 1);
          current.depth = Math.min(current.depth, depth);
        }
      }
    }
    // Give path-occupied derivations genomic exposure rather than only state count.
    for (let site = 0; site < path.dp.states.length; site += 1) {
      const span = alignment.cellEnds[site]! - alignment.cellStarts[site]!;
      for (const move of shortestPathMoves(path.graph, masterStart.master, path.dp.states[site]!)) {
        const candidate = candidates.get(moveKey(move));
        if (candidate !== undefined) candidate.support += span;
      }
    }
  }
  return [...candidates.values()]
    .sort((a, b) => b.support - a.support || a.depth - b.depth || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function allowedMasks(q: number, overlapCap: number): readonly number[] {
  const masks: number[] = [];
  for (let mask = 0; mask < (1 << q); mask += 1) if (popcount(mask) <= overlapCap) masks.push(mask);
  return masks;
}

function transitionCost(from: number, to: number, config: NetworkConfig): number {
  if (from === to) return 0;
  const opened = popcount(to & ~from);
  const closed = popcount(from & ~to);
  return config.breakpointPenalty + config.openPenalty * opened + config.closePenalty * closed;
}

interface MaskMovement {
  readonly values: Float64Array;
  readonly sources: Uint16Array;
}

/**
 * Exact min-plus transform over the overlap-capped one-bit mask graph.
 *
 * The first add/remove edge pays the coordinate breakpoint penalty; all later
 * edges at that same boundary pay only their endpoint cost. Removing active
 * bits before adding new ones never exceeds the endpoint masks' overlap, so
 * the capped graph contains an optimal path for every legal transition.
 * `reverse` computes min_y transition(x,y)+input[y] for backward recursion.
 */
export function maskMovementTransform(
  input: Float64Array,
  masks: readonly number[],
  bits: number,
  config: Pick<NetworkConfig, "openPenalty" | "closePenalty" | "breakpointPenalty">,
  reverse = false,
): MaskMovement {
  const count = masks.length;
  const byMask = new Map(masks.map((mask, index) => [mask, index]));
  const values = new Float64Array(count);
  values.fill(Number.POSITIVE_INFINITY);
  const sources = new Uint16Array(count);
  const heapNodes: number[] = [];
  const heapValues: number[] = [];
  const push = (node: number, value: number): void => {
    let index = heapNodes.length;
    heapNodes.push(node);
    heapValues.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heapValues[parent]! < value || (heapValues[parent] === value && heapNodes[parent]! <= node)) break;
      heapNodes[index] = heapNodes[parent]!;
      heapValues[index] = heapValues[parent]!;
      index = parent;
    }
    heapNodes[index] = node;
    heapValues[index] = value;
  };
  const pop = (): { readonly node: number; readonly value: number } | undefined => {
    if (heapNodes.length === 0) return undefined;
    const node = heapNodes[0]!;
    const value = heapValues[0]!;
    const lastNode = heapNodes.pop()!;
    const lastValue = heapValues.pop()!;
    if (heapNodes.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heapNodes.length) break;
        const right = left + 1;
        let child = left;
        if (right < heapNodes.length && (heapValues[right]! < heapValues[left]! || (heapValues[right] === heapValues[left] && heapNodes[right]! < heapNodes[left]!))) child = right;
        if (heapValues[child]! > lastValue || (heapValues[child] === lastValue && heapNodes[child]! >= lastNode)) break;
        heapNodes[index] = heapNodes[child]!;
        heapValues[index] = heapValues[child]!;
        index = child;
      }
      heapNodes[index] = lastNode;
      heapValues[index] = lastValue;
    }
    return { node, value };
  };
  const edgeCost = (sourceMask: number, bit: number): number => {
    const sourceActive = (sourceMask & (1 << bit)) !== 0;
    if (!reverse) return sourceActive ? config.closePenalty : config.openPenalty;
    return sourceActive ? config.openPenalty : config.closePenalty;
  };
  // Initialize every possible nonempty movement with exactly one breakpoint
  // charge. This deliberately does not seed a zero-edge stay transition.
  for (let source = 0; source < count; source += 1) {
    for (let bit = 0; bit < bits; bit += 1) {
      const target = byMask.get(masks[source]! ^ (1 << bit));
      if (target === undefined) continue;
      const proposed = input[source]! + config.breakpointPenalty + edgeCost(masks[source]!, bit);
      if (proposed < values[target]! - 1e-12 || (Math.abs(proposed - values[target]!) <= 1e-12 && masks[source]! < masks[sources[target]!]!)) {
        values[target] = proposed;
        sources[target] = source;
        push(target, proposed);
      }
    }
  }
  while (heapNodes.length > 0) {
    const current = pop()!;
    if (current.value > values[current.node]! + 1e-12) continue;
    const source = sources[current.node]!;
    for (let bit = 0; bit < bits; bit += 1) {
      const target = byMask.get(masks[current.node]! ^ (1 << bit));
      if (target === undefined) continue;
      const proposed = current.value + edgeCost(masks[current.node]!, bit);
      if (proposed < values[target]! - 1e-12 || (Math.abs(proposed - values[target]!) <= 1e-12 && masks[source]! < masks[sources[target]!]!)) {
        values[target] = proposed;
        sources[target] = source;
        push(target, proposed);
      }
    }
  }
  return { values, sources };
}

function leftBoundary(mask: number, config: NetworkConfig): number {
  if (config.boundaryConvention === "open") return 0;
  if (config.boundaryConvention === "penalized-open") return config.censorPenalty * popcount(mask);
  return mask === 0 ? 0 : config.breakpointPenalty + config.openPenalty * popcount(mask);
}

function rightBoundary(mask: number, config: NetworkConfig): number {
  if (config.boundaryConvention === "open") return 0;
  if (config.boundaryConvention === "penalized-open") return config.censorPenalty * popcount(mask);
  return mask === 0 ? 0 : config.breakpointPenalty + config.closePenalty * popcount(mask);
}

function evaluateNetwork(
  network: SwitchingNetwork,
  alignment: JemsprAlignment,
  config: NetworkConfig,
  cache: Map<string, DisplayScore>,
): NetworkEvaluation | undefined {
  const masks = allowedMasks(network.reticulations.length, config.overlapCap);
  const maskDisplays: DisplayScore[] = [];
  for (const mask of masks) {
    const display = displayNetwork(network, mask);
    if (display === undefined) return undefined;
    let scored = cache.get(display.signature);
    if (scored === undefined) {
      const scores = scoreTree(display.tree, alignment, config.method, config.transition, config.transversion);
      scored = { tree: display.tree, signature: display.signature, scores };
      cache.set(display.signature, scored);
    }
    maskDisplays.push(scored);
  }
  const sites = alignment.sites;
  const states = masks.length;
  if (sites === 0) {
    const zeroIndex = masks.indexOf(0);
    return {
      network,
      objective: config.reticulationPenalty * network.reticulations.length,
      objectiveWithoutStructure: 0,
      dataParsimony: 0,
      masks,
      maskPath: new Int32Array(0),
      maskDisplays,
      forward: new Float64Array(0),
      backward: new Float64Array(0),
      maximumOverlap: 0,
      occurrences: 0,
      displaySetKey: maskDisplays[zeroIndex]?.signature ?? "",
    };
  }
  const emit = (site: number, state: number): number => {
    const span = alignment.cellEnds[site]! - alignment.cellStarts[site]!;
    return maskDisplays[state]!.scores[site]! + config.spanPenalty * span * popcount(masks[state]!);
  };
  const forward = new Float64Array(sites * states);
  const predecessor = new Uint16Array(sites * states);
  for (let state = 0; state < states; state += 1) forward[state] = leftBoundary(masks[state]!, config) + emit(0, state);
  for (let site = 1; site < sites; site += 1) {
    const previous = forward.subarray((site - 1) * states, site * states);
    const moved = maskMovementTransform(previous, masks, network.reticulations.length, config);
    for (let state = 0; state < states; state += 1) {
      const stay = previous[state]!;
      const change = moved.values[state]!;
      const source = stay <= change + 1e-12 ? state : moved.sources[state]!;
      const best = source === state ? stay : change;
      forward[site * states + state] = best + emit(site, state);
      predecessor[site * states + state] = source;
    }
  }
  let finalState = 0;
  let objectiveWithoutStructure = Number.POSITIVE_INFINITY;
  for (let state = 0; state < states; state += 1) {
    const value = forward[(sites - 1) * states + state]! + rightBoundary(masks[state]!, config);
    if (value < objectiveWithoutStructure - 1e-12 || (Math.abs(value - objectiveWithoutStructure) <= 1e-12 && masks[state]! < masks[finalState]!)) {
      objectiveWithoutStructure = value;
      finalState = state;
    }
  }
  const pathStates = new Uint16Array(sites);
  pathStates[sites - 1] = finalState;
  for (let site = sites - 1; site > 0; site -= 1) pathStates[site - 1] = predecessor[site * states + pathStates[site]!]!;
  const maskPath = new Int32Array(sites);
  let dataParsimony = 0;
  let maximumOverlap = 0;
  let occurrences = 0;
  let previousMask = 0;
  for (let site = 0; site < sites; site += 1) {
    const state = pathStates[site]!;
    const mask = masks[state]!;
    maskPath[site] = mask;
    dataParsimony += maskDisplays[state]!.scores[site]!;
    maximumOverlap = Math.max(maximumOverlap, popcount(mask));
    occurrences += popcount(mask & ~previousMask);
    previousMask = mask;
  }
  const backward = new Float64Array(sites * states);
  for (let state = 0; state < states; state += 1) backward[(sites - 1) * states + state] = emit(sites - 1, state) + rightBoundary(masks[state]!, config);
  for (let site = sites - 2; site >= 0; site -= 1) {
    const next = backward.subarray((site + 1) * states, (site + 2) * states);
    const moved = maskMovementTransform(next, masks, network.reticulations.length, config, true);
    for (let state = 0; state < states; state += 1) {
      backward[site * states + state] = emit(site, state) + Math.min(next[state]!, moved.values[state]!);
    }
  }
  const occupiedDisplays = new Set<string>();
  for (const state of pathStates) occupiedDisplays.add(maskDisplays[state]!.signature);
  return {
    network,
    objective: objectiveWithoutStructure + config.reticulationPenalty * network.reticulations.length,
    objectiveWithoutStructure,
    dataParsimony,
    masks,
    maskPath,
    maskDisplays,
    forward,
    backward,
    maximumOverlap,
    occurrences,
    displaySetKey: [...occupiedDisplays].sort().join("|"),
  };
}

function boundaryGap(evaluation: NetworkEvaluation, boundary: number, config: NetworkConfig): number {
  const states = evaluation.masks.length;
  let stay = Number.POSITIVE_INFINITY;
  let change = Number.POSITIVE_INFINITY;
  for (let a = 0; a < states; a += 1) {
    stay = Math.min(stay, evaluation.forward[(boundary - 1) * states + a]! + evaluation.backward[boundary * states + a]!);
    for (let b = 0; b < states; b += 1) {
      if (a === b) continue;
      change = Math.min(change, evaluation.forward[(boundary - 1) * states + a]! + transitionCost(evaluation.masks[a]!, evaluation.masks[b]!, config) + evaluation.backward[boundary * states + b]!);
    }
  }
  const changed = evaluation.maskPath[boundary - 1] !== evaluation.maskPath[boundary];
  return Math.max(0, (changed ? stay : change) - evaluation.objectiveWithoutStructure);
}

function directionalEndpointGap(
  evaluation: NetworkEvaluation,
  boundary: number,
  bit: number,
  direction: "open" | "close",
  config: NetworkConfig,
): number {
  const states = evaluation.masks.length;
  let forced = Number.POSITIVE_INFINITY;
  const bitMask = 1 << bit;
  for (let from = 0; from < states; from += 1) {
    const fromActive = (evaluation.masks[from]! & bitMask) !== 0;
    if ((direction === "open" && fromActive) || (direction === "close" && !fromActive)) continue;
    for (let to = 0; to < states; to += 1) {
      const toActive = (evaluation.masks[to]! & bitMask) !== 0;
      if ((direction === "open" && !toActive) || (direction === "close" && toActive)) continue;
      forced = Math.min(forced, evaluation.forward[(boundary - 1) * states + from]! + transitionCost(evaluation.masks[from]!, evaluation.masks[to]!, config) + evaluation.backward[boundary * states + to]!);
    }
  }
  return Math.max(0, forced - evaluation.objectiveWithoutStructure);
}

function endpointInterval(
  alignment: JemsprAlignment,
  evaluation: NetworkEvaluation,
  bit: number,
  boundary: number,
  direction: "open" | "close",
  config: NetworkConfig,
  gapCache: Map<string, number>,
): { readonly low: number; readonly high: number } {
  const sites = evaluation.maskPath.length;
  if (boundary <= 0) return { low: 1, high: 1 };
  if (boundary >= sites) return { low: alignment.sites, high: alignment.sites };
  const gap = (candidate: number): number => {
    const key = `${bit}:${direction}:${candidate}`;
    const previous = gapCache.get(key);
    if (previous !== undefined) return previous;
    const value = directionalEndpointGap(evaluation, candidate, bit, direction, config);
    gapCache.set(key, value);
    return value;
  };
  const threshold = gap(boundary) + config.uncertaintyTolerance + 1e-9;
  let left = boundary;
  let right = boundary;
  while (left > 1 && gap(left - 1) <= threshold) left -= 1;
  while (right + 1 < sites && gap(right + 1) <= threshold) right += 1;
  return {
    low: left,
    high: right,
  };
}

function temporalCheck(network: SwitchingNetwork): JemsprTemporalCheck {
  const parent = Int32Array.from({ length: network.nodes.length }, (_value, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[value] !== value) {
      const next = parent[value]!;
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const x = find(a);
    const y = find(b);
    if (x !== y) parent[y] = x;
  };
  for (const event of network.reticulations) union(event.alternateParentNode, event.reticulationNode);
  const arcs = new Map<number, Set<number>>();
  const conflicts: string[] = [];
  for (const node of network.nodes) {
    for (const child of node.children) {
      const horizontal = network.reticulations.some((event) => event.alternateParentNode === node.id && event.reticulationNode === child);
      if (horizontal) continue;
      const a = find(node.id);
      const b = find(child);
      if (a === b) conflicts.push(`N${node.id}→N${child}`);
      else {
        const targets = arcs.get(a) ?? new Set<number>();
        targets.add(b);
        arcs.set(a, targets);
      }
    }
  }
  if (conflicts.length > 0) return { status: "infeasible", message: "Donor–recipient equality contracts a strict ancestry edge.", conflictingTemplates: conflicts };
  const classes = new Set(Array.from({ length: network.nodes.length }, (_value, index) => find(index)));
  const indegree = new Map([...classes].map((value) => [value, 0]));
  for (const targets of arcs.values()) for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  const queue = [...classes].filter((value) => indegree.get(value) === 0);
  let seen = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]!;
    seen += 1;
    for (const target of arcs.get(node) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  if (seen !== classes.size) return { status: "infeasible", message: "The reticulation time equalities create a directed rank cycle.", conflictingTemplates: network.reticulations.map((event) => `R${event.bit + 1}`) };
  return { status: "rank-feasible", message: "The compiled switching DAG satisfies donor–recipient equality and strict ancestry constraints under an unconstrained rank assignment.", conflictingTemplates: [] };
}

function publicNetwork(
  alignment: JemsprAlignment,
  evaluation: NetworkEvaluation,
  path: InternalPathSearchResult,
  search: readonly JemsprNetworkSearchStep[],
  frontier: readonly NetworkEvaluation[],
  config: NetworkConfig,
): JemsprNetworkResult {
  const masks = evaluation.masks;
  const maskIndex = new Map(masks.map((mask, index) => [mask, index]));
  const bitContexts = evaluation.network.reticulations.map((_event, bit) => {
    const contexts = new Set<string>();
    const silent: number[] = [];
    for (const mask of masks) {
      if ((mask & (1 << bit)) !== 0) continue;
      const alternate = mask | (1 << bit);
      const a = maskIndex.get(mask);
      const b = maskIndex.get(alternate);
      if (a === undefined || b === undefined) continue;
      contexts.add(evaluation.maskDisplays[a]!.signature);
      if (evaluation.maskDisplays[a]!.signature === evaluation.maskDisplays[b]!.signature) silent.push(mask);
    }
    return { contexts: [...contexts], silent };
  });
  const templates: JemsprEventTemplate[] = evaluation.network.reticulations.map((event, index) => ({
    id: `R${index + 1}`,
    bit: index,
    move: publicMove(event.move, alignment.names),
    sourceContexts: bitContexts[index]!.contexts,
    topologicallySilentMasks: bitContexts[index]!.silent,
    reticulationNode: `N${event.reticulationNode}`,
    backgroundParentNode: `N${event.backgroundParentNode}`,
    alternateParentNode: `N${event.alternateParentNode}`,
    recipientChildNode: `N${event.recipientChildNode}`,
    donorChildNode: `N${event.donorChildNode}`,
  }));
  const gaps = new Map<number, number>();
  for (let site = 1; site < evaluation.maskPath.length; site += 1) {
    if (evaluation.maskPath[site - 1] !== evaluation.maskPath[site]) gaps.set(site, boundaryGap(evaluation, site, config));
  }
  const occurrences: JemsprEventOccurrence[] = [];
  const endpointGapCache = new Map<string, number>();
  for (let bit = 0; bit < templates.length; bit += 1) {
    let start: number | undefined;
    for (let site = 0; site <= evaluation.maskPath.length; site += 1) {
      const active = site < evaluation.maskPath.length && (evaluation.maskPath[site]! & (1 << bit)) !== 0;
      if (active && start === undefined) start = site;
      if (!active && start !== undefined) {
        let maximumConcurrentEvents = 0;
        for (let cursor = start; cursor < site; cursor += 1) maximumConcurrentEvents = Math.max(maximumConcurrentEvents, popcount(evaluation.maskPath[cursor]!));
        const openingInterval = endpointInterval(alignment, evaluation, bit, start, "open", config, endpointGapCache);
        const closingInterval = endpointInterval(alignment, evaluation, bit, site, "close", config, endpointGapCache);
        occurrences.push({
          id: `E${occurrences.length + 1}`,
          templateId: templates[bit]!.id,
          start: alignment.cellStarts[start]! + 1,
          end: alignment.cellEnds[site - 1]!,
          leftCensored: start === 0 && config.boundaryConvention !== "closed",
          rightCensored: site === evaluation.maskPath.length && config.boundaryConvention !== "closed",
          maximumConcurrentEvents,
          openingGap: start === 0 ? 0 : gaps.get(start) ?? 0,
          closingGap: site === evaluation.maskPath.length ? 0 : gaps.get(site) ?? 0,
          openingIntervalLow: openingInterval.low,
          openingIntervalHigh: openingInterval.high,
          closingIntervalLow: closingInterval.low,
          closingIntervalHigh: closingInterval.high,
        });
        start = undefined;
      }
    }
  }
  const treeBySignature = new Map<string, { tree: RootedNode; masks: Set<number>; span: number }>();
  for (let site = 0; site < evaluation.maskPath.length; site += 1) {
    const mask = evaluation.maskPath[site]!;
    const state = maskIndex.get(mask)!;
    const display = evaluation.maskDisplays[state]!;
    const entry = treeBySignature.get(display.signature) ?? { tree: display.tree, masks: new Set<number>(), span: 0 };
    entry.masks.add(mask);
    entry.span += alignment.cellEnds[site]! - alignment.cellStarts[site]!;
    treeBySignature.set(display.signature, entry);
  }
  if (evaluation.maskPath.length === 0) {
    const display = evaluation.maskDisplays[maskIndex.get(0)!]!;
    treeBySignature.set(display.signature, { tree: display.tree, masks: new Set([0]), span: alignment.sites });
  }
  const networkTrees: JemsprNetworkTree[] = [...treeBySignature.entries()].map(([signature, entry], index) => ({
    id: `NTree${index + 1}`,
    signature,
    tree: treeToNewick(entry.tree, alignment.names),
    masks: [...entry.masks].sort((a, b) => a - b),
    occupiedSpan: entry.span,
    color: COLORS[index % COLORS.length]!,
  }));
  const treeIndex = new Map(networkTrees.map((tree, index) => [tree.signature, index]));
  const runs: JemsprMaskRun[] = [];
  if (evaluation.maskPath.length > 0) {
    let first = 0;
    for (let site = 1; site <= evaluation.maskPath.length; site += 1) {
      if (site < evaluation.maskPath.length && evaluation.maskPath[site] === evaluation.maskPath[first]) continue;
      const mask = evaluation.maskPath[first]!;
      const display = evaluation.maskDisplays[maskIndex.get(mask)!]!;
      let parsimony = 0;
      for (let cursor = first; cursor < site; cursor += 1) parsimony += display.scores[cursor]!;
      const index = treeIndex.get(display.signature)!;
      runs.push({ id: `B${runs.length + 1}`, start: alignment.cellStarts[first]! + 1, end: alignment.cellEnds[site - 1]!, mask, activeTemplateIds: templates.filter((_template, bit) => (mask & (1 << bit)) !== 0).map((template) => template.id), treeId: networkTrees[index]!.id, treeIndex: index, dataParsimony: parsimony });
      first = site;
    }
  } else {
    runs.push({ id: "B1", start: 1, end: alignment.sites, mask: 0, activeTemplateIds: [], treeId: networkTrees[0]!.id, treeIndex: 0, dataParsimony: 0 });
  }
  const breakpointGaps = [...gaps].map(([site, gap]) => ({
    afterSite: alignment.cellStarts[site]!,
    intervalLow: site,
    intervalHigh: site,
    gap,
  }));
  const paretoFrontier = frontier.filter(allReticulationsUsed).map((entry) => ({ reticulations: entry.network.reticulations.length, occurrences: entry.occurrences, dataParsimony: entry.dataParsimony, objective: entry.objective, maximumOverlap: entry.maximumOverlap }))
    .sort((a, b) => a.reticulations - b.reticulations || a.objective - b.objective)
    .filter((entry, index, values) => index === 0 || !values.slice(0, index).some((other) => other.reticulations <= entry.reticulations && other.dataParsimony <= entry.dataParsimony && other.objective <= entry.objective));
  return {
    status: "complete",
    objective: evaluation.objective,
    dataParsimony: evaluation.dataParsimony,
    masterTree: treeToNewick(evaluation.maskDisplays[maskIndex.get(0)!]!.tree, alignment.names),
    masterStateId: (() => {
      const signature = evaluation.maskDisplays[maskIndex.get(0)!]!.signature;
      for (const start of path.rootStarts) {
        const state = start.graph.bySignature.get(signature);
        if (state !== undefined) return `R${start.rootStart}:T${state + 1}`;
      }
      return `M:${signature.slice(0, 12)}`;
    })(),
    boundaryConvention: config.boundaryConvention,
    overlapCap: config.overlapCap,
    uncertaintyTolerance: config.uncertaintyTolerance,
    maximumOverlapUsed: evaluation.maximumOverlap,
    templates,
    occurrences,
    trees: networkTrees,
    runs,
    breakpointGaps,
    search,
    paretoFrontier,
    temporal: temporalCheck(evaluation.network),
    certificate: "Every retained switching DAG was scored by an exact mask dynamic program over all masks within the selected overlap cap. Distinct master candidates from every inferred root start seed the joint network beam, and donor-time/strict-ancestry infeasibility is enforced as a hard lazy cut. The outer rooted-network beam and event-template pool remain budgeted; no global network-space optimum is claimed.",
  };
}

function allReticulationsUsed(evaluation: NetworkEvaluation): boolean {
  if (evaluation.network.reticulations.length === 0) return true;
  let used = 0;
  for (const mask of evaluation.maskPath) used |= mask;
  return used === (1 << evaluation.network.reticulations.length) - 1;
}

export function searchSwitchingNetwork(alignment: JemsprAlignment, path: InternalPathSearchResult, options: JemsprOptions = {}): InternalNetworkSearchResult {
  const minimumWindow = Math.max(16, Math.round(options.minimumWindow ?? Math.max(64, Math.min(250, alignment.sites / 8))));
  const config: NetworkConfig = {
    method: options.scoreMethod ?? "fitch",
    transition: Math.max(0, options.transitionCost ?? 1),
    transversion: Math.max(0, options.transversionCost ?? 1),
    maximumReticulations: Math.max(0, Math.min(10, Math.round(options.maximumReticulations ?? 5))),
    overlapCap: Math.max(0, Math.min(6, Math.round(options.overlapCap ?? 2))),
    beamWidth: Math.max(1, Math.round(options.networkBeamWidth ?? 6)),
    poolSize: Math.max(1, Math.round(options.eventPoolSize ?? 14)),
    openPenalty: options.eventOpenPenalty !== undefined && options.eventOpenPenalty >= 0 ? options.eventOpenPenalty : Math.log2(alignment.sites + 1) / 2,
    closePenalty: options.eventClosePenalty !== undefined && options.eventClosePenalty >= 0 ? options.eventClosePenalty : 0,
    breakpointPenalty: options.networkBreakpointPenalty !== undefined && options.networkBreakpointPenalty >= 0 ? options.networkBreakpointPenalty : Math.log2(alignment.sites + 1) / 2,
    spanPenalty: options.eventSpanPenalty !== undefined && options.eventSpanPenalty >= 0 ? options.eventSpanPenalty : 1 / Math.max(80, minimumWindow),
    reticulationPenalty: options.reticulationPenalty !== undefined && options.reticulationPenalty >= 0 ? options.reticulationPenalty : Math.max(1, Math.log2(alignment.taxa)),
    boundaryConvention: options.boundaryConvention ?? "open",
    censorPenalty: options.boundaryCensorPenalty !== undefined && options.boundaryCensorPenalty >= 0 ? options.boundaryCensorPenalty : Math.log2(alignment.sites + 1) / 4,
    uncertaintyTolerance: options.uncertaintyTolerance !== undefined && options.uncertaintyTolerance >= 0 ? options.uncertaintyTolerance : 2,
  };
  const masterStarts = topMasterStarts(path, Math.max(1, config.beamWidth));
  const pool = eventPool(alignment, masterStarts, config.poolSize);
  const cache = new Map<string, DisplayScore>();
  const initialStarted = performance.now();
  const initial = new Map<string, NetworkEvaluation>();
  for (const candidate of masterStarts) {
    const base = treeNetwork(candidate.path.graph.states[candidate.master]!.tree);
    const evaluation = evaluateNetwork(base, alignment, config, cache);
    if (evaluation !== undefined) initial.set(networkHash(base), evaluation);
  }
  let beam = [...initial.values()].sort((a, b) => a.objective - b.objective || networkHash(a.network).localeCompare(networkHash(b.network))).slice(0, config.beamWidth);
  if (beam.length === 0) throw new Error("No inferred rooted master could be represented as a switching network.");
  let best = beam[0]!;
  const allBest: NetworkEvaluation[] = [...beam];
  const search: JemsprNetworkSearchStep[] = [{ reticulations: 0, candidatesScored: initial.size, temporallyRejected: 0, beamRetained: beam.length, bestObjective: best.objective, bestDataParsimony: best.dataParsimony, bestOverlap: 0, elapsedMs: performance.now() - initialStarted }];
  options.onProgress?.("jemspr-network-search", 0.02, {
    message: `Joint network search initialized from ${beam.length} distinct inferred master candidate${beam.length === 1 ? "" : "s"}.`,
    current: 0,
    total: config.maximumReticulations,
    metricLabel: "network objective",
    metricValue: best.objective,
  });
  let staleRounds = 0;
  for (let q = 1; q <= config.maximumReticulations; q += 1) {
    checkAbort(options.signal);
    const started = performance.now();
    const children = new Map<string, NetworkEvaluation>();
    let scored = 0;
    let temporallyRejected = 0;
    for (let parentIndex = 0; parentIndex < beam.length; parentIndex += 1) {
      const parent = beam[parentIndex]!;
      const contextSpans = new Map<number, number>();
      for (let site = 0; site < parent.maskPath.length; site += 1) contextSpans.set(parent.maskPath[site]!, (contextSpans.get(parent.maskPath[site]!) ?? 0) + alignment.cellEnds[site]! - alignment.cellStarts[site]!);
      const contexts = parent.masks.slice().sort((a, b) => (contextSpans.get(b) ?? 0) - (contextSpans.get(a) ?? 0) || popcount(a) - popcount(b) || a - b);
      for (const candidate of pool) {
        for (const context of contexts) {
          const child = compileReticulation(parent.network, context, candidate.move);
          if (child === undefined) continue;
          const hash = networkHash(child);
          if (children.has(hash)) continue;
          if (temporalCheck(child).status !== "rank-feasible") {
            temporallyRejected += 1;
            continue;
          }
          const evaluation = evaluateNetwork(child, alignment, config, cache);
          if (evaluation !== undefined) {
            scored += 1;
            children.set(hash, evaluation);
          }
        }
      }
      options.onProgress?.("jemspr-network-search", Math.min(0.99, (q - 1 + (parentIndex + 1) / beam.length) / Math.max(1, config.maximumReticulations)), {
        message: `Compiling reticulation layer ${q}: ${parentIndex + 1}/${beam.length} parent networks; ${scored} exact mask-DP scores; ${temporallyRejected} temporal rejects.`,
        current: parentIndex + 1,
        total: beam.length,
        metricLabel: "compiled networks",
        metricValue: scored,
      });
    }
    const ranked = [...children.values()].sort((a, b) => a.objective - b.objective || a.network.reticulations.length - b.network.reticulations.length || networkHash(a.network).localeCompare(networkHash(b.network)));
    const diverse: NetworkEvaluation[] = [];
    const displayCounts = new Map<string, number>();
    for (const candidate of ranked) {
      const count = displayCounts.get(candidate.displaySetKey) ?? 0;
      if (count >= 2) continue;
      diverse.push(candidate);
      displayCounts.set(candidate.displaySetKey, count + 1);
      if (diverse.length >= config.beamWidth) break;
    }
    beam = diverse;
    if (beam.length === 0) {
      search.push({ reticulations: q, candidatesScored: scored, temporallyRejected, beamRetained: 0, bestObjective: best.objective, bestDataParsimony: best.dataParsimony, bestOverlap: best.maximumOverlap, elapsedMs: performance.now() - started });
      break;
    }
    const roundBest = beam[0]!;
    allBest.push(...beam);
    const roundBestUsed = beam.find(allReticulationsUsed);
    if (roundBestUsed !== undefined && roundBestUsed.objective < best.objective - 1e-8) {
      best = roundBestUsed;
      staleRounds = 0;
    } else staleRounds += 1;
    search.push({ reticulations: q, candidatesScored: scored, temporallyRejected, beamRetained: beam.length, bestObjective: roundBest.objective, bestDataParsimony: roundBest.dataParsimony, bestOverlap: roundBest.maximumOverlap, elapsedMs: performance.now() - started });
    options.onProgress?.("jemspr-network-search", q / Math.max(1, config.maximumReticulations), {
      message: `Exact mask DP for ${q} reticulation${q === 1 ? "" : "s"}: ${scored} compiled networks scored; ${temporallyRejected} failed the temporal lazy cut; ${beam.length} retained.`,
      current: q,
      total: config.maximumReticulations,
      metricLabel: "network objective",
      metricValue: roundBest.objective,
    });
    if (staleRounds >= 2) break;
  }
  const publicResult = publicNetwork(alignment, best, path, search, allBest, config);
  return { public: publicResult, network: best.network, candidateTemplates: pool.length, serializableNetwork: networkToSerializable(best.network) };
}
