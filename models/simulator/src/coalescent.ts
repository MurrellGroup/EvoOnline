import { integrateCurve } from "./curves.js";
import { Random } from "./random.js";
import type { SimulatedTree, SimTreeNode, TreeSimulationConfig } from "./types.js";

interface MutableNode {
  id: number;
  name?: string;
  time: number;
  parent: number | null;
  children: number[];
}

function quoteName(name: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
}

function makeTree(nodesInput: readonly MutableNode[], root: number, branchScale: number): SimulatedTree {
  const nodes = nodesInput.map((node) => ({ ...node, children: [...node.children] }));
  const tips = nodes.filter((node) => node.children.length === 0).map((node) => node.id);
  if (tips.length === 0) throw new Error("A simulated tree has no tips.");
  const newest = Math.min(...tips.map((id) => nodes[id]!.time));
  if (newest !== 0) for (const node of nodes) node.time -= newest;
  const rootTime = nodes[root]!.time;
  let totalTimeLength = 0;
  for (const node of nodes) if (node.parent !== null) totalTimeLength += nodes[node.parent]!.time - node.time;
  const render = (id: number, scale: number): string => {
    const node = nodes[id]!;
    const body = node.children.length === 0
      ? quoteName(node.name ?? `tax${id + 1}`)
      : `(${node.children.map((child) => render(child, scale)).join(",")})`;
    if (node.parent === null) return `${body};`;
    const length = Math.max(0, nodes[node.parent]!.time - node.time) * scale;
    return `${body}:${length.toPrecision(10)}`;
  };
  return {
    nodes: nodes.map((node): SimTreeNode => ({ id: node.id, ...(node.name === undefined ? {} : { name: node.name }), time: node.time, parent: node.parent, children: node.children })),
    root,
    tips,
    height: rootTime - newest,
    totalTimeLength,
    branchScale,
    timeNewick: render(root, 1),
    newick: render(root, branchScale),
  };
}

function combinedHazardAt(
  time: number,
  lineagePairs: number,
  samplingEnabled: boolean,
  coalescent: ReturnType<typeof integrateCurve>,
  sampling: ReturnType<typeof integrateCurve>,
): number {
  return lineagePairs * coalescent.integralAt(time) + (samplingEnabled ? sampling.integralAt(time) : 0);
}

function nextCompetingEvent(
  currentTime: number,
  lineagePairs: number,
  samplingEnabled: boolean,
  coalescent: ReturnType<typeof integrateCurve>,
  sampling: ReturnType<typeof integrateCurve>,
  rng: Random,
): number {
  const base = combinedHazardAt(currentTime, lineagePairs, samplingEnabled, coalescent, sampling);
  const target = base + rng.exponential();
  let upper = Math.max(currentTime, coalescent.horizon);
  if (combinedHazardAt(upper, lineagePairs, samplingEnabled, coalescent, sampling) < target) {
    const tailRate = lineagePairs * coalescent.evaluate(upper) + (samplingEnabled ? sampling.evaluate(upper) : 0);
    if (!(tailRate > 0)) throw new Error("Both coalescent and sampling hazards vanish before the requested sample is complete.");
    return upper + (target - combinedHazardAt(upper, lineagePairs, samplingEnabled, coalescent, sampling)) / tailRate;
  }
  let lower = currentTime;
  for (let iteration = 0; iteration < 52; iteration += 1) {
    const middle = (lower + upper) / 2;
    if (combinedHazardAt(middle, lineagePairs, samplingEnabled, coalescent, sampling) < target) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

/**
 * Heterochronous Kingman simulator with an independently specified sampling
 * point process.  Given k extant ancestral lineages, the hazards are
 *
 *   lambda_coal(t) = choose(k,2) / (ploidy * Ne(t))
 *   lambda_sample(t) = s(t).
 *
 * The next event is sampled by inverting the sum of their integrated hazards;
 * this avoids the dimensional bug in MolecularEvolution.jl's stepping code.
 */
export function simulateCoalescentTree(config: TreeSimulationConfig, rng: Random, targetTips = config.observedTips): SimulatedTree {
  if (!Number.isInteger(targetTips) || targetTips < 2 || targetTips > 5000) throw new RangeError("Tree simulation requires 2–5000 tips.");
  const initialTips = Math.max(1, Math.min(targetTips, Math.trunc(config.initialTips)));
  const coalescent = integrateCurve(config.population, config.horizon, config.hazardBins, (ne) => {
    if (!(ne > 0) || !Number.isFinite(ne)) throw new RangeError("Effective population size must be finite and positive.");
    return 1 / (config.ploidy * ne);
  });
  const sampling = integrateCurve(config.sampling, config.horizon, config.hazardBins, (rate) => Math.max(0, rate));
  const nodes: MutableNode[] = [];
  const active: number[] = [];
  for (let tip = 0; tip < initialTips; tip += 1) {
    const id = nodes.length;
    nodes.push({ id, name: `tax${tip + 1}`, time: 0, parent: null, children: [] });
    active.push(id);
  }
  let sampled = initialTips;
  let time = 0;
  while (active.length > 1 || sampled < targetTips) {
    const pairs = active.length * (active.length - 1) / 2;
    const samplingEnabled = sampled < targetTips;
    if (pairs === 0 && !samplingEnabled) break;
    time = nextCompetingEvent(time, pairs, samplingEnabled, coalescent, sampling, rng);
    const coalRate = pairs * coalescent.evaluate(time);
    const sampleRate = samplingEnabled ? sampling.evaluate(time) : 0;
    if (!(coalRate + sampleRate > 0)) throw new Error("The total event hazard became zero.");
    if (sampleRate > 0 && rng.uniform() * (coalRate + sampleRate) < sampleRate) {
      const id = nodes.length;
      sampled += 1;
      nodes.push({ id, name: `tax${sampled}`, time, parent: null, children: [] });
      active.push(id);
      continue;
    }
    if (active.length < 2) continue;
    const firstIndex = rng.integer(active.length);
    const first = active[firstIndex]!;
    active.splice(firstIndex, 1);
    const secondIndex = rng.integer(active.length);
    const second = active[secondIndex]!;
    active.splice(secondIndex, 1);
    const parent = nodes.length;
    nodes[first]!.parent = parent;
    nodes[second]!.parent = parent;
    nodes.push({ id: parent, time, parent: null, children: [first, second] });
    active.push(parent);
  }
  if (active.length !== 1 || sampled !== targetTips) throw new Error("Coalescent simulation did not reach the requested sample and MRCA.");
  return makeTree(nodes, active[0]!, config.branchScale);
}

export function cloneMutableTree(tree: SimulatedTree): { nodes: MutableNode[]; root: number } {
  return { nodes: tree.nodes.map((node) => ({ id: node.id, ...(node.name === undefined ? {} : { name: node.name }), time: node.time, parent: node.parent, children: [...node.children] })), root: tree.root };
}

export function finalizeMutableTree(nodes: readonly MutableNode[], root: number, branchScale: number): SimulatedTree {
  const reachable = new Set<number>();
  const visit = (id: number): void => { if (reachable.has(id)) return; reachable.add(id); for (const child of nodes[id]!.children) visit(child); };
  visit(root);
  const oldToNew = new Map<number, number>();
  const ordered = [...reachable].sort((a, b) => a - b);
  for (const old of ordered) oldToNew.set(old, oldToNew.size);
  const compact: MutableNode[] = ordered.map((old) => {
    const node = nodes[old]!;
    return { id: oldToNew.get(old)!, ...(node.name === undefined ? {} : { name: node.name }), time: node.time, parent: node.parent === null || !reachable.has(node.parent) ? null : oldToNew.get(node.parent)!, children: node.children.filter((child) => reachable.has(child)).map((child) => oldToNew.get(child)!) };
  });
  return makeTree(compact, oldToNew.get(root)!, branchScale);
}

export function pruneTreeToTips(tree: SimulatedTree, selectedTipIds: ReadonlySet<number>): SimulatedTree {
  const source = tree.nodes;
  interface Kept { oldId: number; children: Kept[] }
  const retain = (id: number): Kept | undefined => {
    const node = source[id]!;
    if (node.children.length === 0) return selectedTipIds.has(id) ? { oldId: id, children: [] } : undefined;
    const children = node.children.map(retain).filter((child): child is Kept => child !== undefined);
    if (children.length === 0) return undefined;
    if (children.length === 1) return children[0];
    return { oldId: id, children };
  };
  const keptRoot = retain(tree.root);
  if (keptRoot === undefined) throw new Error("Tip pruning removed the entire tree.");
  const nodes: MutableNode[] = [];
  const materialize = (kept: Kept, parent: number | null): number => {
    const old = source[kept.oldId]!;
    const id = nodes.length;
    nodes.push({ id, ...(old.name === undefined ? {} : { name: old.name }), time: old.time, parent, children: [] });
    nodes[id]!.children = kept.children.map((child) => materialize(child, id));
    return id;
  };
  const root = materialize(keptRoot, null);
  return makeTree(nodes, root, tree.branchScale);
}

export function sampleObservedTips(tree: SimulatedTree, count: number, rng: Random): { tree: SimulatedTree; carrierTipIds: readonly number[] } {
  if (count > tree.tips.length || count < 2) throw new RangeError("Observed-tip count is outside the carrier tree.");
  const shuffled = [...tree.tips];
  rng.shuffle(shuffled);
  const carrierTipIds = shuffled.slice(0, count).sort((a, b) => a - b);
  return { tree: pruneTreeToTips(tree, new Set(carrierTipIds)), carrierTipIds };
}

export function treeTopologyKey(tree: SimulatedTree): string {
  const clade = (id: number): string => {
    const node = tree.nodes[id]!;
    if (node.children.length === 0) return node.name ?? `tax${id + 1}`;
    return `(${node.children.map(clade).sort().join(",")})`;
  };
  return clade(tree.root);
}
