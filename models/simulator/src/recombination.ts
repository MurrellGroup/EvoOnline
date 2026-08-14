import { cloneMutableTree, finalizeMutableTree, pruneTreeToTips, treeTopologyKey } from "./coalescent.js";
import { Random } from "./random.js";
import type { LocalTreeTruth, RecombinationConfig, RecombinationEventTruth, SimulatedTree } from "./types.js";

interface DraftEvent {
  id: number;
  age: number;
  recipientBranch: number;
  donorBranch: number;
  intervals: Array<{ startCodon: number; endCodon: number }>;
  breakpoints: number[];
}

interface MutableTreeNode {
  id: number;
  name?: string;
  time: number;
  parent: number | null;
  children: number[];
}

function branchLengths(tree: SimulatedTree): { ids: number[]; weights: number[]; total: number } {
  const ids: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    const length = tree.nodes[node.parent]!.time - node.time;
    if (!(length > 1e-10)) continue;
    ids.push(node.id);
    weights.push(length);
    total += length;
  }
  return { ids, weights, total };
}

export function buildHotspotWeights(sites: number, config: RecombinationConfig, rng: Random): { weights: number[]; centers: number[] } {
  const length = Math.max(0, sites - 1);
  const weights = new Array<number>(length).fill(1);
  if (length === 0 || config.hotspotMode === "none") return { weights, centers: [] };
  const centers = config.hotspotMode === "manual"
    ? config.manualHotspots.filter((value) => Number.isFinite(value)).map((value) => Math.max(1, Math.min(length, Math.round(value))))
    : Array.from({ length: Math.max(0, Math.round(config.hotspotCount)) }, () => 1 + rng.integer(length));
  const width = Math.max(0.5, config.hotspotWidth);
  const intensity = Math.max(0, config.hotspotIntensity);
  for (let breakpoint = 1; breakpoint <= length; breakpoint += 1) {
    for (const center of centers) weights[breakpoint - 1] = weights[breakpoint - 1]! + intensity * Math.exp(-0.5 * ((breakpoint - center) / width) ** 2);
  }
  return { weights, centers };
}

function drawDistinctBreakpoints(count: number, weightsInput: readonly number[], rng: Random): number[] {
  const weights = [...weightsInput];
  const output: number[] = [];
  for (let draw = 0; draw < Math.min(count, weights.length); draw += 1) {
    const index = rng.weighted(weights);
    output.push(index + 1);
    weights[index] = 0;
  }
  return output.sort((a, b) => a - b);
}

function intervalsFromBreakpoints(sites: number, breakpoints: readonly number[], startsOnDonor: boolean): Array<{ startCodon: number; endCodon: number }> {
  const boundaries = [0, ...breakpoints, sites];
  const intervals: Array<{ startCodon: number; endCodon: number }> = [];
  for (let segment = 0; segment < boundaries.length - 1; segment += 1) {
    if ((segment % 2 === 0) !== startsOnDonor) continue;
    const startCodon = boundaries[segment]! + 1;
    const endCodon = boundaries[segment + 1]!;
    if (startCodon <= endCodon) intervals.push({ startCodon, endCodon });
  }
  return intervals;
}

function drawEventGenome(sites: number, config: RecombinationConfig, hotspotWeights: readonly number[], rng: Random): Pick<DraftEvent, "intervals" | "breakpoints"> {
  if (sites < 2) return { intervals: [{ startCodon: 1, endCodon: sites }], breakpoints: [] };
  if (config.mode === "single-crossover") {
    const breakpoint = drawDistinctBreakpoints(1, hotspotWeights, rng)[0]!;
    return { breakpoints: [breakpoint], intervals: rng.uniform() < 0.5 ? [{ startCodon: 1, endCodon: breakpoint }] : [{ startCodon: breakpoint + 1, endCodon: sites }] };
  }
  if (config.mode === "single-tract") {
    const start = drawDistinctBreakpoints(1, hotspotWeights, rng)[0]!;
    const length = Math.max(1, Math.round(rng.exponential(1 / Math.max(1, config.meanTractCodons))));
    let left = start;
    let right = Math.min(sites - 1, start + length);
    if (right === left) left = Math.max(1, left - 1);
    return { breakpoints: [left, right].sort((a, b) => a - b), intervals: [{ startCodon: left + 1, endCodon: right }] };
  }
  const baseline = config.mode === "template-switching" ? Math.max(3, config.meanBreakpoints) : Math.max(2, config.meanBreakpoints);
  const count = Math.max(2, Math.min(24, rng.poisson(baseline)));
  const breakpoints = drawDistinctBreakpoints(count, hotspotWeights, rng);
  return { breakpoints, intervals: intervalsFromBreakpoints(sites, breakpoints, rng.uniform() < 0.5) };
}

function isDescendant(nodes: readonly MutableTreeNode[], candidate: number, ancestor: number): boolean {
  let current: number | null = candidate;
  while (current !== null) {
    if (current === ancestor) return true;
    current = nodes[current]!.parent;
  }
  return false;
}

function edgeAtAge(nodes: readonly MutableTreeNode[], start: number, age: number): number | undefined {
  let current = start;
  for (let guard = 0; guard < nodes.length + 4; guard += 1) {
    const node = nodes[current];
    if (node === undefined) return undefined;
    const parent = node.parent;
    if (parent === null) return undefined;
    if (node.time < age - 1e-10 && nodes[parent]!.time > age + 1e-10) return current;
    if (nodes[parent]!.time <= age + 1e-10) current = parent;
    else return current;
  }
  return undefined;
}

function suppressUnary(nodes: MutableTreeNode[], start: number, rootRef: { value: number }): void {
  let current: number | null = start;
  while (current !== null) {
    const node: MutableTreeNode = nodes[current]!;
    if (node.children.length !== 1) return;
    const child = node.children[0]!;
    const parent: number | null = node.parent;
    if (parent === null) {
      rootRef.value = child;
      nodes[child]!.parent = null;
      node.children = [];
      return;
    }
    const position = nodes[parent]!.children.indexOf(current);
    if (position < 0) return;
    nodes[parent]!.children[position] = child;
    nodes[child]!.parent = parent;
    node.children = [];
    node.parent = null;
    current = parent;
  }
}

/**
 * Time-preserving rooted SPR on a persistent mutable carrier tree.  In
 * particular, do not compact node ids between edits: later events refer to
 * branches of the original carrier genealogy, and those identities must
 * survive a whole multi-event mosaic.
 */
function applyTimedSprMutable(mutable: { nodes: MutableTreeNode[]; root: number }, event: DraftEvent): boolean {
  const backupNodes = mutable.nodes.map((node) => ({ ...node, children: [...node.children] }));
  const backupRoot = mutable.root;
  const rollback = (): false => {
    mutable.nodes = backupNodes;
    mutable.root = backupRoot;
    return false;
  };
  const rootRef = { value: mutable.root };
  const recipient = edgeAtAge(mutable.nodes, event.recipientBranch, event.age);
  if (recipient === undefined) return rollback();
  const recipientParent = mutable.nodes[recipient]!.parent;
  if (recipientParent === null) return rollback();
  const donorBefore = edgeAtAge(mutable.nodes, event.donorBranch, event.age);
  if (donorBefore === undefined || donorBefore === recipient || isDescendant(mutable.nodes, donorBefore, recipient) || isDescendant(mutable.nodes, recipient, donorBefore)) return rollback();
  mutable.nodes[recipientParent]!.children = mutable.nodes[recipientParent]!.children.filter((child) => child !== recipient);
  mutable.nodes[recipient]!.parent = null;
  suppressUnary(mutable.nodes, recipientParent, rootRef);
  const donor = edgeAtAge(mutable.nodes, event.donorBranch, event.age);
  if (donor === undefined || donor === recipient || isDescendant(mutable.nodes, donor, recipient) || isDescendant(mutable.nodes, recipient, donor)) return rollback();
  const donorParent = mutable.nodes[donor]!.parent;
  if (donorParent === null || !(mutable.nodes[donor]!.time < event.age && event.age < mutable.nodes[donorParent]!.time)) return rollback();
  const attachment = mutable.nodes.length;
  mutable.nodes.push({ id: attachment, time: event.age, parent: donorParent, children: [donor, recipient] });
  const position = mutable.nodes[donorParent]!.children.indexOf(donor);
  if (position < 0) return rollback();
  mutable.nodes[donorParent]!.children[position] = attachment;
  mutable.nodes[donor]!.parent = attachment;
  mutable.nodes[recipient]!.parent = attachment;
  mutable.root = rootRef.value;
  return true;
}

function eventActive(event: DraftEvent, codon: number): boolean {
  return event.intervals.some((interval) => interval.startCodon <= codon && codon <= interval.endCodon);
}

export interface RecombinationSimulation {
  readonly localTrees: readonly LocalTreeTruth[];
  readonly events: readonly RecombinationEventTruth[];
  readonly hotspotWeights: readonly number[];
  readonly hotspotCenters: readonly number[];
}

export function simulateRecombination(
  carrierTree: SimulatedTree,
  observedTipNames: ReadonlySet<string>,
  sites: number,
  config: RecombinationConfig,
  rng: Random,
): RecombinationSimulation {
  const observedCarrierTipIds = new Set(carrierTree.tips.filter((tip) => observedTipNames.has(carrierTree.nodes[tip]!.name!)));
  const master = pruneTreeToTips(carrierTree, observedCarrierTipIds);
  const { weights: hotspotWeights, centers } = buildHotspotWeights(sites, config, rng);
  if (!config.enabled || config.eventRate <= 0 || sites < 2) return { localTrees: [{ startCodon: 1, endCodon: sites, tree: master, activeEventIds: [] }], events: [], hotspotWeights, hotspotCenters: centers };
  const branches = branchLengths(carrierTree);
  const requestedEvents = Math.min(512, rng.poisson(Math.max(0, config.eventRate) * branches.total));
  const drafts: DraftEvent[] = [];
  for (let attempt = 0; attempt < requestedEvents * 12 + 20 && drafts.length < requestedEvents; attempt += 1) {
    const recipient = branches.ids[rng.weighted(branches.weights)]!;
    const parent = carrierTree.nodes[recipient]!.parent!;
    const low = carrierTree.nodes[recipient]!.time;
    const high = carrierTree.nodes[parent]!.time;
    const margin = Math.min((high - low) * 1e-6, 1e-8);
    const age = low + margin + rng.uniform() * Math.max(0, high - low - 2 * margin);
    const donorCandidates = branches.ids.filter((candidate) => candidate !== recipient && carrierTree.nodes[candidate]!.time < age && age < carrierTree.nodes[carrierTree.nodes[candidate]!.parent!]!.time);
    if (donorCandidates.length === 0) continue;
    const donor = donorCandidates[rng.integer(donorCandidates.length)]!;
    const genome = drawEventGenome(sites, config, hotspotWeights, rng);
    if (genome.intervals.length === 0) continue;
    drafts.push({ id: drafts.length + 1, age, recipientBranch: recipient, donorBranch: donor, ...genome });
  }
  const boundaries = new Set<number>([0, sites]);
  for (const event of drafts) for (const breakpoint of event.breakpoints) boundaries.add(breakpoint);
  const ordered = [...boundaries].sort((a, b) => a - b);
  const runs: LocalTreeTruth[] = [];
  const observedTreeCache = new Map<string, SimulatedTree>();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const startCodon = ordered[index]! + 1;
    const endCodon = ordered[index + 1]!;
    if (startCodon > endCodon) continue;
    const midpoint = (startCodon + endCodon) / 2;
    const active = drafts.filter((event) => eventActive(event, midpoint)).sort((a, b) => a.age - b.age || a.id - b.id);
    const mutable = cloneMutableTree(carrierTree) as { nodes: MutableTreeNode[]; root: number };
    const applied: number[] = [];
    for (const event of active) {
      if (applyTimedSprMutable(mutable, event)) applied.push(event.id);
    }
    const full = finalizeMutableTree(mutable.nodes, mutable.root, carrierTree.branchScale);
    const selected = new Set(full.tips.filter((tip) => observedTipNames.has(full.nodes[tip]!.name!)));
    const pruned = pruneTreeToTips(full, selected);
    const observed = observedTreeCache.get(pruned.newick) ?? pruned;
    observedTreeCache.set(observed.newick, observed);
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous.endCodon + 1 === startCodon && previous.tree.newick === observed.newick && previous.activeEventIds.join(",") === applied.join(",")) runs[runs.length - 1] = { ...previous, endCodon };
    else runs.push({ startCodon, endCodon, tree: observed, activeEventIds: applied });
  }
  const masterKey = treeTopologyKey(master);
  const events: RecombinationEventTruth[] = drafts.filter((event) => runs.some((run) => run.activeEventIds.includes(event.id))).map((event) => ({
    ...event,
    visibleAfterSubsampling: runs.some((run) => run.activeEventIds.includes(event.id) && treeTopologyKey(run.tree) !== masterKey),
  }));
  return { localTrees: runs.length > 0 ? runs : [{ startCodon: 1, endCodon: sites, tree: master, activeEventIds: [] }], events, hotspotWeights, hotspotCenters: centers };
}
