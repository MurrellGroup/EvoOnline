import type { JemsprAlignment } from "./types.js";
import { canonicalTree, treeSignature, type RootedNode } from "./tree.js";
import { siteMask } from "./alignment.js";

interface Cluster {
  readonly node: RootedNode;
  readonly key: string;
}

function correctedDistance(mismatches: number, comparable: number): number {
  if (comparable === 0) return 1;
  const p = Math.min(0.74, mismatches / comparable);
  return -0.75 * Math.log(Math.max(1e-8, 1 - 4 * p / 3));
}

export function alignmentDistances(alignment: JemsprAlignment, start = 0, end = alignment.sites): Float64Array {
  const n = alignment.taxa;
  const distances = new Float64Array(n * n);
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      let mismatches = 0;
      let comparable = 0;
      for (let site = start; site < end; site += 1) {
        const x = siteMask(alignment, site, a);
        const y = siteMask(alignment, site, b);
        if (x === 0 || y === 0) continue;
        comparable += 1;
        if ((x & y) === 0) mismatches += 1;
      }
      const value = correctedDistance(mismatches, comparable);
      distances[a * n + b] = value;
      distances[b * n + a] = value;
    }
  }
  return distances;
}

export function neighbourJoining(distancesInput: Float64Array, taxa: number): RootedNode {
  if (taxa < 2 || distancesInput.length !== taxa * taxa) throw new Error("Invalid distance matrix for neighbour joining.");
  let clusters: Cluster[] = Array.from({ length: taxa }, (_value, leaf) => ({ node: { leaf }, key: `L${leaf}` }));
  let distances = distancesInput.slice();
  while (clusters.length > 2) {
    const n = clusters.length;
    const rows = new Float64Array(n);
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) rows[i] = rows[i]! + distances[i * n + j]!;
    let bestI = 0;
    let bestJ = 1;
    let bestQ = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const q = (n - 2) * distances[i * n + j]! - rows[i]! - rows[j]!;
        const tie = `${clusters[i]!.key}\u0001${clusters[j]!.key}`;
        const bestTie = `${clusters[bestI]!.key}\u0001${clusters[bestJ]!.key}`;
        if (q < bestQ - 1e-12 || (Math.abs(q - bestQ) <= 1e-12 && tie < bestTie)) {
          bestQ = q;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const joined = canonicalTree({ children: [clusters[bestI]!.node, clusters[bestJ]!.node] });
    const keep = Array.from({ length: n }, (_value, index) => index).filter((index) => index !== bestI && index !== bestJ);
    const nextClusters: Cluster[] = keep.map((index) => clusters[index]!);
    nextClusters.push({ node: joined, key: treeSignature(joined) });
    const nextN = nextClusters.length;
    const nextDistances = new Float64Array(nextN * nextN);
    for (let a = 0; a < keep.length; a += 1) {
      for (let b = a + 1; b < keep.length; b += 1) {
        const value = distances[keep[a]! * n + keep[b]!]!;
        nextDistances[a * nextN + b] = value;
        nextDistances[b * nextN + a] = value;
      }
      const k = keep[a]!;
      const value = Math.max(0, (distances[bestI * n + k]! + distances[bestJ * n + k]! - distances[bestI * n + bestJ]!) / 2);
      nextDistances[a * nextN + nextN - 1] = value;
      nextDistances[(nextN - 1) * nextN + a] = value;
    }
    clusters = nextClusters;
    distances = nextDistances;
  }
  return canonicalTree({ children: [clusters[0]!.node, clusters[1]!.node] });
}

export function inferNjTree(alignment: JemsprAlignment, start = 0, end = alignment.sites): RootedNode {
  return neighbourJoining(alignmentDistances(alignment, start, end), alignment.taxa);
}

export interface MultiscaleSeed {
  readonly start: number;
  readonly end: number;
  readonly scale: number;
  readonly tree: RootedNode;
  readonly signature: string;
}

export function multiscaleNjSeeds(alignment: JemsprAlignment, minimumWindow: number, maximumTrees: number): readonly MultiscaleSeed[] {
  const seeds = new Map<string, MultiscaleSeed>();
  const add = (start: number, end: number, scale: number): void => {
    if (seeds.size >= maximumTrees || end - start < Math.min(minimumWindow, alignment.sites)) return;
    const tree = inferNjTree(alignment, start, end);
    const signature = treeSignature(tree);
    if (!seeds.has(signature)) seeds.set(signature, { start, end, scale, tree, signature });
  };
  add(0, alignment.sites, alignment.sites);
  let window = 2 ** Math.floor(Math.log2(Math.max(minimumWindow, alignment.sites / 2)));
  while (window >= minimumWindow && seeds.size < maximumTrees) {
    const step = Math.max(1, Math.floor(window / 2));
    for (let start = 0; start < alignment.sites && seeds.size < maximumTrees; start += step) {
      const end = Math.min(alignment.sites, start + window);
      if (end - start >= minimumWindow) add(start, end, window);
      if (end === alignment.sites) break;
    }
    window = Math.floor(window / 2);
  }
  return [...seeds.values()];
}
