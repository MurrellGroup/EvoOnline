import { parseNewick } from "@phylo-workbench/model-diffubar/browser-source";

interface GraphEdge {
  readonly node: GraphNode;
  readonly length: number;
}

interface GraphNode {
  readonly id: number;
  readonly name: string;
  edges: GraphEdge[];
}

export interface ComparisonTreeNode {
  readonly id: string;
  readonly name: string;
  readonly branchLength: number;
  readonly children: readonly ComparisonTreeNode[];
  readonly tipNames: readonly string[];
}

export interface ComparisonTreeLayout {
  readonly root: ComparisonTreeNode;
  readonly tipOrder: readonly string[];
  readonly rerootedOn: readonly [number, number];
  readonly alignmentScore: number;
}

function connect(first: GraphNode, second: GraphNode, length: number): void {
  first.edges.push({ node: second, length });
  second.edges.push({ node: first, length });
}

function disconnect(first: GraphNode, second: GraphNode): void {
  first.edges = first.edges.filter((edge) => edge.node !== second);
  second.edges = second.edges.filter((edge) => edge.node !== first);
}

function graphFromNewick(newick: string): GraphNode[] {
  const tree = parseNewick(newick);
  const byId = new Map<number, GraphNode>();
  for (const node of tree.nodes) byId.set(node.id, { id: node.id, name: node.name, edges: [] });
  for (const node of tree.nodes) {
    if (node.parent === null) continue;
    connect(byId.get(node.id)!, byId.get(node.parent.id)!, node.branchLength);
  }
  // Newick's arbitrary degree-two root is not an unrooted phylogenetic node.
  // Suppress it before enumerating display roots so rerooting cannot create a
  // spurious unary-looking split.
  let changed = true;
  while (changed) {
    changed = false;
    const suppress = Array.from(byId.values()).find((node) => node.name.length === 0 && node.edges.length === 2);
    if (suppress === undefined) break;
    const [first, second] = suppress.edges;
    disconnect(suppress, first!.node);
    disconnect(suppress, second!.node);
    connect(first!.node, second!.node, first!.length + second!.length);
    byId.delete(suppress.id);
    changed = true;
  }
  return Array.from(byId.values());
}

function buildSide(node: GraphNode, parent: GraphNode, branchLength: number): ComparisonTreeNode {
  const children = node.edges
    .filter((edge) => edge.node !== parent)
    .map((edge) => buildSide(edge.node, node, edge.length));
  const tipNames = children.length === 0
    ? [node.name]
    : children.flatMap((child) => child.tipNames);
  return {
    id: `n${node.id}`,
    name: node.name,
    branchLength,
    children,
    tipNames,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function crossBlockInversions(
  first: readonly string[],
  second: readonly string[],
  target: ReadonlyMap<string, number>,
): number {
  let crossings = 0;
  for (const firstName of first) {
    const firstRank = target.get(firstName) ?? Number.POSITIVE_INFINITY;
    for (const secondName of second) {
      if (firstRank > (target.get(secondName) ?? Number.POSITIVE_INFINITY)) crossings += 1;
    }
  }
  return crossings;
}

function orderNode(node: ComparisonTreeNode, target: ReadonlyMap<string, number> | undefined): ComparisonTreeNode {
  if (node.children.length === 0) return node;
  const children = node.children.map((child) => orderNode(child, target));
  if (target !== undefined && children.length === 2) {
    // For a bifurcating node this is the exact local choice: internal-child
    // crossings and between-child crossings are separable, so the bottom-up
    // decisions minimize crossings for this root against the target order.
    const forward = crossBlockInversions(children[0]!.tipNames, children[1]!.tipNames, target);
    const reverse = crossBlockInversions(children[1]!.tipNames, children[0]!.tipNames, target);
    if (reverse < forward || (reverse === forward && (
      children[1]!.tipNames.length > children[0]!.tipNames.length
      || (children[1]!.tipNames.length === children[0]!.tipNames.length
        && children[1]!.tipNames.join("\u0000").localeCompare(children[0]!.tipNames.join("\u0000")) < 0)
    ))) children.reverse();
  } else {
    children.sort((first, second) => {
      if (target !== undefined) {
        const firstMedian = median(first.tipNames.map((name) => target.get(name) ?? Number.POSITIVE_INFINITY));
        const secondMedian = median(second.tipNames.map((name) => target.get(name) ?? Number.POSITIVE_INFINITY));
        if (Math.abs(firstMedian - secondMedian) > 0.2) return firstMedian - secondMedian;
      }
      // Mild deterministic ladder preference: larger descendant clades first,
      // but only after the alignment objective is effectively tied.
      return second.tipNames.length - first.tipNames.length
        || first.tipNames.join("\u0000").localeCompare(second.tipNames.join("\u0000"));
    });
  }
  return { ...node, children, tipNames: children.flatMap((child) => child.tipNames) };
}

function rootOnEdge(first: GraphNode, second: GraphNode, length: number, target?: ReadonlyMap<string, number>): ComparisonTreeNode {
  const halves = length / 2;
  const raw: ComparisonTreeNode = {
    id: `root-${first.id}-${second.id}`,
    name: "",
    branchLength: 0,
    children: [buildSide(first, second, halves), buildSide(second, first, length - halves)],
    tipNames: [],
  };
  return orderNode({ ...raw, tipNames: raw.children.flatMap((child) => child.tipNames) }, target);
}

function inversions(order: readonly string[], targetOrder: readonly string[]): number {
  const rank = new Map(targetOrder.map((name, index) => [name, index]));
  const values = order.map((name) => rank.get(name)).filter((value): value is number => value !== undefined);
  const bit = new Uint32Array(Math.max(1, targetOrder.length + 1));
  let total = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    let at = values[index]!;
    while (at > 0) { total += bit[at]!; at -= at & -at; }
    at = values[index]! + 1;
    while (at < bit.length) { bit[at] = bit[at]! + 1; at += at & -at; }
  }
  return total;
}

export function countOrderCrossings(first: readonly string[], second: readonly string[]): number {
  return inversions(first, second);
}

function ladderPenalty(root: ComparisonTreeNode): number {
  let penalty = 0;
  const visit = (node: ComparisonTreeNode): void => {
    for (let index = 1; index < node.children.length; index += 1) {
      penalty += Math.max(0, node.children[index]!.tipNames.length - node.children[index - 1]!.tipNames.length);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return penalty;
}

function bestRooted(nodes: readonly GraphNode[], targetOrder?: readonly string[]): ComparisonTreeLayout {
  const target = targetOrder === undefined ? undefined : new Map(targetOrder.map((name, index) => [name, index]));
  const edges: { readonly first: GraphNode; readonly second: GraphNode; readonly length: number }[] = [];
  for (const first of nodes) {
    for (const edge of first.edges) if (first.id < edge.node.id) edges.push({ first, second: edge.node, length: edge.length });
  }
  if (edges.length === 0) throw new Error("A comparison tree must contain at least one edge.");
  let best: ComparisonTreeLayout | undefined;
  for (const edge of edges) {
    for (let orientation = 0; orientation < 2; orientation += 1) {
      let root = rootOnEdge(edge.first, edge.second, edge.length, target);
      if (orientation === 1) {
        const children = root.children.slice().reverse();
        root = { ...root, children, tipNames: children.flatMap((child) => child.tipNames) };
      }
      const crossing = targetOrder === undefined ? 0 : inversions(root.tipNames, targetOrder);
      const maximumCrossings = Math.max(1, root.tipNames.length * (root.tipNames.length - 1) / 2);
      const score = crossing / maximumCrossings + 0.015 * ladderPenalty(root) / Math.max(1, root.tipNames.length);
      if (best === undefined || score < best.alignmentScore - 1e-12
        || (Math.abs(score - best.alignmentScore) < 1e-12 && root.id < best.root.id)) {
        best = { root, tipOrder: root.tipNames, rerootedOn: [edge.first.id, edge.second.id], alignmentScore: score };
      }
    }
  }
  return best!;
}

function consensusOrder(layouts: readonly ComparisonTreeLayout[], names: readonly string[]): string[] {
  const average = new Map<string, number>();
  const ranks = layouts.map((layout) => new Map(layout.tipOrder.map((name, index) => [name, index])));
  for (const name of names) {
    let total = 0;
    let count = 0;
    for (const layoutRanks of ranks) {
      const rank = layoutRanks.get(name) ?? -1;
      if (rank >= 0) { total += rank; count += 1; }
    }
    average.set(name, count === 0 ? Number.POSITIVE_INFINITY : total / count);
  }
  return names.slice().sort((first, second) => average.get(first)! - average.get(second)! || first.localeCompare(second));
}

function setScore(layouts: readonly ComparisonTreeLayout[]): number {
  let total = layouts.reduce((sum, layout) => sum + 0.02 * layout.alignmentScore, 0);
  for (let first = 0; first < layouts.length; first += 1) {
    for (let second = first + 1; second < layouts.length; second += 1) {
      total += countOrderCrossings(layouts[first]!.tipOrder, layouts[second]!.tipOrder);
    }
  }
  return total;
}

/**
 * Alternating multi-start tanglegram heuristic. Every display root edge and
 * every legal child flip remain available; Borda consensus updates align all
 * panels jointly instead of greedily forcing tree i to match only tree i-1.
 */
export function alignComparisonTrees(newicks: readonly string[]): readonly ComparisonTreeLayout[] {
  if (newicks.length === 0) return [];
  const graphs = newicks.map(graphFromNewick);
  const names = graphs[0]!.filter((node) => node.edges.length === 1).map((node) => node.name).sort();
  if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
    throw new Error("Linked tree comparison requires uniquely named taxa in every tree.");
  }
  for (const graph of graphs) {
    const current = graph.filter((node) => node.edges.length === 1).map((node) => node.name).sort();
    if (current.length !== names.length || current.some((name, index) => name !== names[index])) {
      throw new Error("Linked tree comparison requires the same uniquely named taxa in every tree.");
    }
  }
  const seeds: string[][] = [];
  for (let index = 0; index < Math.min(graphs.length, 8); index += 1) {
    const order = bestRooted(graphs[index]!).tipOrder.slice();
    seeds.push(order, order.slice().reverse());
  }
  let bestLayouts: readonly ComparisonTreeLayout[] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const seed of seeds) {
    let target = seed;
    let layouts = graphs.map((graph) => bestRooted(graph, target));
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const nextTarget = consensusOrder(layouts, names);
      if (nextTarget.every((name, index) => name === target[index])) break;
      target = nextTarget;
      layouts = graphs.map((graph) => bestRooted(graph, target));
    }
    const score = setScore(layouts);
    if (score < bestScore) { bestScore = score; bestLayouts = layouts; }
  }
  return bestLayouts ?? graphs.map((graph) => bestRooted(graph));
}
